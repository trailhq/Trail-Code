/**
 * Getting a digest to Trail quickly, and getting it there at all.
 *
 * A busy repository's digest is several megabytes of JSON — a thousand commit
 * messages, two hundred threads of discussion, four thousand symbols — and it
 * used to go up as one uncompressed POST with no retry. On a hotel connection
 * that is a minute of upload and one dropped packet from starting over.
 *
 * JSON compresses about tenfold, so the body is gzipped whenever the server
 * says it takes gzip. When it also says it takes chunked uploads, the gzip is
 * cut into 1 MiB pieces and sent four at a time, each retried on its own: a
 * blip costs one chunk, not the push. Against an older Trail neither flag is
 * set and the upload is exactly the single POST it always was.
 */
import { gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";
import type { RepoDigest } from "../app/history.js";
import { baseUrlFor, type BrainLink } from "./link.js";

const gzipAsync = promisify(gzipCb);

/** The size of one chunk: the index-th slice of the gzip is bytes [i*CHUNK, (i+1)*CHUNK). */
export const CHUNK_BYTES = 1024 * 1024;
/** Chunks in flight at once. */
export const CHUNK_CONCURRENCY = 4;
/** Waits before each retry. Four retries, so five attempts in all. */
export const RETRY_DELAYS_MS = [500, 1000, 2000, 4000] as const;

/** What the server said it accepts, from GET /repo. */
export interface UploadCaps {
  /** `gzip_upload: true` — POST /repo takes `Content-Encoding: gzip`. */
  gzip?: boolean;
  /** `chunked_upload: true` — the /repo/uploads routes exist. */
  chunked?: boolean;
}

export interface UploadOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  chunkBytes?: number;
  concurrency?: number;
}

export type UploadResult = { jobId: string } | { error: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The digest as the exact bytes a single POST would carry, gzipped. */
export async function gzipDigest(digest: RepoDigest): Promise<Buffer> {
  return gzipAsync(Buffer.from(JSON.stringify(digest), "utf8"));
}

/** Retry on what a retry can fix: the network, the server, the rate limit. */
function retryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * One request, retried with backoff on network errors, 5xx and 429.
 *
 * Returns the last response when retries run out on a status (so the caller
 * can print the server's own words), or throws the last network error.
 */
async function withRetry(
  send: () => Promise<Response>,
  sleep: (ms: number) => Promise<void>,
): Promise<{ res: Response; attempts: number; sawNetworkError: boolean }> {
  let sawNetworkError = false;
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const res = await send();
      if (!retryable(res.status) || attempt === RETRY_DELAYS_MS.length) {
        return { res, attempts: attempt + 1, sawNetworkError };
      }
      // Drain it so the connection is released before the next attempt.
      await res.arrayBuffer().catch(() => undefined);
    } catch (e) {
      sawNetworkError = true;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function authHeaders(link: BrainLink, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${link.token}`, accept: "application/json", ...extra };
}

/** Today's response to an ingest, read the same way for every route that returns it. */
async function ingestResult(res: Response): Promise<UploadResult> {
  const text = await res.text();
  if (!res.ok) return { error: `Trail refused the upload: ${res.status} ${text.slice(0, 200)}` };
  try {
    return { jobId: String((JSON.parse(text) as { job_id?: string }).job_id ?? "") };
  } catch {
    return { jobId: "" };
  }
}

/**
 * The single POST to /repo — gzipped when the server takes it, plain otherwise.
 * Not retried: a repeated POST of a whole ingest is not idempotent, and a 409
 * for "already running" on the retry would read as a refusal.
 */
export async function postDigestOnce(
  link: BrainLink,
  digest: RepoDigest,
  opts: { gzip?: boolean; fetchImpl?: typeof fetch; query?: string; timeoutMs?: number } = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/repo${opts.query ?? ""}`;
  const json = JSON.stringify(digest);
  const body = opts.gzip ? await gzipAsync(Buffer.from(json, "utf8")) : json;
  const headers = authHeaders(link, { "content-type": "application/json" });
  if (opts.gzip) headers["content-encoding"] = "gzip";
  return fetchImpl(url, {
    method: "POST",
    headers,
    body: body as unknown as RequestInit["body"],
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
}

/**
 * Upload the full digest by whichever route the server advertises.
 *
 * Chunked when `caps.chunked`; if the upload session cannot even be opened
 * (a 404 from a server that advertised the flag but not the route), it falls
 * back to the single POST rather than failing a push that would otherwise work.
 */
export async function uploadDigest(
  link: BrainLink,
  digest: RepoDigest,
  caps: UploadCaps,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  if (caps.chunked) {
    const chunked = await uploadChunked(link, digest, opts);
    if (!("fallback" in chunked)) return chunked;
  }
  try {
    return await ingestResult(await postDigestOnce(link, digest, { gzip: caps.gzip, fetchImpl: opts.fetchImpl }));
  } catch (e) {
    return { error: `could not reach Trail: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * The chunked route:
 *
 *   POST /repo/uploads                       {stage, auto_approve, chunks, bytes} → {upload_id}
 *   PUT  /repo/uploads/:id/chunks/:index     raw gzip slice, idempotent        → 204
 *   POST /repo/uploads/:id/complete                                            → today's /repo response
 *
 * `{fallback: true}` means the session could not be opened and nothing was
 * sent, so the caller may use the single POST instead.
 */
export async function uploadChunked(
  link: BrainLink,
  digest: RepoDigest,
  opts: UploadOptions = {},
): Promise<UploadResult | { fallback: true }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const base = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/repo/uploads`;

  const gz = await gzipDigest(digest);
  const chunks = Math.max(1, Math.ceil(gz.length / chunkBytes));

  let uploadId = "";
  try {
    const { res } = await withRetry(
      () =>
        fetchImpl(base, {
          method: "POST",
          headers: authHeaders(link, { "content-type": "application/json" }),
          body: JSON.stringify({ stage: "full", auto_approve: digest.auto_approve, chunks, bytes: gz.length }),
        }),
      sleep,
    );
    const text = await res.text();
    if (res.status === 404 || res.status === 405) return { fallback: true };
    if (!res.ok) {
      // 409 is the one refusal worth passing on as-is: an ingest is already
      // running, and a single POST would be told the same.
      if (res.status === 409) return { error: `Trail refused the upload: ${res.status} ${text.slice(0, 200)}` };
      return { fallback: true };
    }
    uploadId = String((JSON.parse(text) as { upload_id?: string }).upload_id ?? "");
  } catch {
    return { fallback: true };
  }
  if (!uploadId) return { fallback: true };

  // Chunks, four at a time, each retried on its own.
  const concurrency = Math.max(1, opts.concurrency ?? CHUNK_CONCURRENCY);
  let next = 0;
  let failure: string | null = null;
  const worker = async () => {
    for (;;) {
      if (failure) return;
      const i = next++;
      if (i >= chunks) return;
      const slice = gz.subarray(i * chunkBytes, Math.min(gz.length, (i + 1) * chunkBytes));
      try {
        const { res } = await withRetry(
          () =>
            fetchImpl(`${base}/${encodeURIComponent(uploadId)}/chunks/${i}`, {
              method: "PUT",
              headers: authHeaders(link, { "content-type": "application/octet-stream" }),
              body: slice as unknown as RequestInit["body"],
            }),
          sleep,
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          failure = `Trail refused part ${i + 1} of ${chunks}: ${res.status} ${text.slice(0, 200)}`;
          return;
        }
        await res.arrayBuffer().catch(() => undefined);
      } catch (e) {
        failure = `could not send part ${i + 1} of ${chunks} to Trail: ${e instanceof Error ? e.message : e}`;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks) }, worker));
  if (failure) return { error: failure };

  try {
    const { res, sawNetworkError } = await withRetry(
      () =>
        fetchImpl(`${base}/${encodeURIComponent(uploadId)}/complete`, {
          method: "POST",
          headers: authHeaders(link, { "content-type": "application/json" }),
          body: "{}",
        }),
      sleep,
    );
    // A complete that was lost on the way back may have started the ingest, so
    // its retry being told "already running" means it worked. The watcher that
    // follows reads the build either way.
    if (res.status === 409 && sawNetworkError) {
      await res.arrayBuffer().catch(() => undefined);
      return { jobId: "" };
    }
    return await ingestResult(res);
  } catch (e) {
    return { error: `could not reach Trail to finish the upload: ${e instanceof Error ? e.message : e}` };
  }
}
