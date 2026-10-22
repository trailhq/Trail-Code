/**
 * The HTTP surface: one webhook in, one page out.
 *
 * Deliberately `node:http` and nothing else. This process handles a private key,
 * a webhook secret and other people's source code, so every dependency is one
 * more thing to trust; the whole server is a hundred lines and needs no
 * framework.
 *
 * GitHub retries a delivery it considers failed and gives up after ten seconds,
 * while a review takes tens of them — so the handler validates, queues, and
 * answers 202. Everything real happens on the queue.
 *
 * "On the queue" used to mean "on this event loop", and that was the whole of a
 * multi-minute outage: a review is synchronous end to end, so one in flight left
 * this server unable to answer /healthz or serve a page it had already produced.
 * The queue now runs each review in its own process (`./review-process.ts`) and
 * everything in here is I/O again.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { jobKey, reviewJobFor, type ReviewJob } from "./events.js";
import { InstallationTokens, verifySignature, type AppCredentials, type Fetch } from "./identity.js";
import { PageStore } from "./pages.js";
import { WorkQueue } from "./queue.js";
import { reviewInChildProcess } from "./review-process.js";
import type { reviewPullRequest } from "./review.js";

/** A webhook body larger than this is not a pull_request event we can use. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Seams for tests: nothing here has a default that touches the network. */
export interface AppSeams {
  fetch?: Fetch;
  /** Swapped out to assert what the queue was handed, without a clone — and, being
   * called in-process, without the fork the default reviewer does. */
  review?: typeof reviewPullRequest;
  now?: () => number;
}

export interface AppConfig extends AppCredentials {
  webhookSecret: string;
  /** Public origin, for the links put in comments, e.g. https://graft.example.com */
  publicUrl: string;
  /** Where pages are kept, so a restart does not strand the links already posted. */
  pageDir?: string;
  port?: number;
  concurrency?: number;
  api?: string;
  log?: (msg: string) => void;
}

export function createApp(
  config: AppConfig,
  seams: AppSeams = {},
): { server: Server; queue: WorkQueue<ReviewJob>; pages: PageStore } {
  const log = config.log ?? ((msg: string) => console.log(msg));
  const fetchImpl = seams.fetch ?? (globalThis.fetch as unknown as Fetch);
  const review = seams.review ?? reviewInChildProcess;
  const tokens = new InstallationTokens(config, fetchImpl, seams.now ?? Date.now, config.api);
  const pages = new PageStore({ secret: config.webhookSecret, dir: config.pageDir });
  const origin = config.publicUrl.replace(/\/$/, "");

  const queue = new WorkQueue<ReviewJob>(
    async (job) => {
      const started = Date.now();
      const res = await review(job, {
        token: (id) => tokens.get(id),
        fetch: fetchImpl,
        api: config.api,
        publish: async (j, html) => {
          const { id, token } = pages.put(j.owner, j.repo, j.number, html);
          return `${origin}/p/${id}?t=${token}`;
        },
        log,
      });
      log(`${jobKey(job)}: ${res.areas} changed → ${res.affected} affected in ${Date.now() - started}ms`);
    },
    {
      concurrency: config.concurrency,
      onError: (err, key) => {
        // A token GitHub rejected is worth forgetting: the next delivery for that
        // installation should mint a fresh one rather than fail the same way.
        log(`${key}: FAILED ${err instanceof Error ? err.message : String(err)}`);
      },
    },
  );

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, "text/plain", "internal error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", origin);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return send(res, 200, "application/json", JSON.stringify({ ok: true, queued: queue.size, pages: pages.size }));
    }

    if (req.method === "GET" && url.pathname.startsWith("/p/")) {
      const html = pages.get(url.pathname.slice(3), url.searchParams.get("t") ?? undefined);
      // A bad token and a missing page are the same answer on purpose: probing
      // for which pull requests exist is not something this should help with.
      if (!html) return send(res, 404, "text/plain", "not found");
      return send(res, 200, "text/html; charset=utf-8", html, { "cache-control": "private, max-age=600" });
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      const body = await readBody(req);
      if (body === null) return send(res, 413, "text/plain", "payload too large");
      if (!verifySignature(config.webhookSecret, body, header(req, "x-hub-signature-256"))) {
        return send(res, 401, "text/plain", "bad signature");
      }

      const event = header(req, "x-github-event") ?? "";
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return send(res, 400, "text/plain", "bad json");
      }

      const decided = reviewJobFor(event, payload);
      if ("skip" in decided) return send(res, 204, "text/plain", "");
      queue.push(jobKey(decided.job), decided.job);
      log(`${jobKey(decided.job)}: queued${decided.job.fromFork ? " (fork)" : ""}`);
      return send(res, 202, "application/json", JSON.stringify({ queued: true }));
    }

    return send(res, 404, "text/plain", "not found");
  }

  if (config.port !== undefined) server.listen(config.port, () => log(`graft app listening on :${config.port}`));
  return { server, queue, pages };
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, ...extra });
  res.end(body);
}

/** The raw body — needed verbatim, because the signature covers these bytes. */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
