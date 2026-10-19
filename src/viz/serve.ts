/**
 * The `graft viz` local server. Zero runtime dependencies: node:http serves
 * the prebuilt viewer bundle, two JSON endpoints, and an SSE channel that
 * pings the browser whenever the context dir changes on disk.
 *
 *   GET /                  viewer (index.html, app.js, style.css from viewerDir)
 *   GET /api/context-graph assembled from .context/*.md on every request
 *   GET /api/code-graph    .context/graph.json passthrough (404 until generated)
 *   GET /events            SSE; fs.watch on the context dir, debounced 300ms
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { assembleContextGraph } from "./assemble.js";
import { cmd } from "../brand.js";

export interface VizServerOptions {
  contextDir: string;
  viewerDir: string;
  port: number;
  repoName: string;
}

export interface VizServer {
  url: string;
  close(): Promise<void>;
}

const PORT_ATTEMPTS = 10;
const WATCH_DEBOUNCE_MS = 300;

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(false);
      else reject(err);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve(true);
    });
  });
}

export async function startVizServer(opts: VizServerOptions): Promise<VizServer> {
  const sseClients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const asset = STATIC_FILES[path];
    if (asset) {
      const file = join(opts.viewerDir, asset.file);
      if (!existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("viewer bundle missing — run the package build");
        return;
      }
      res.writeHead(200, { "content-type": asset.type });
      res.end(readFileSync(file));
      return;
    }

    if (path === "/api/context-graph") {
      const graph = assembleContextGraph(opts.contextDir);
      sendJson(res, 200, { ...graph, meta: { ...graph.meta, repoName: opts.repoName } });
      return;
    }

    if (path === "/api/code-graph") {
      const file = join(opts.contextDir, ".graph", "wiring.json");
      if (!existsSync(file)) {
        sendJson(res, 404, { error: `no wiring graph in this context dir — run \`${cmd("graft build")}\` first` });
        return;
      }
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed?.meta?.version !== 1) {
          sendJson(res, 404, { error: `wiring.json has an unsupported version — regenerate with \`${cmd("graft build")}\`` });
          return;
        }
        sendJson(res, 200, parsed);
      } catch {
        sendJson(res, 404, { error: `wiring.json is unreadable — regenerate with \`${cmd("graft build")}\`` });
      }
      return;
    }

    if (path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  let port = opts.port;
  let bound = false;
  for (let i = 0; i < PORT_ATTEMPTS && !bound; i++) {
    port = opts.port + i;
    bound = await listen(server, port);
  }
  if (!bound) {
    throw new Error(`no free port in ${opts.port}–${opts.port + PORT_ATTEMPTS - 1}`);
  }

  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  if (existsSync(opts.contextDir)) {
    watcher = watch(opts.contextDir, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        for (const client of sseClients) client.write("data: change\n\n");
      }, WATCH_DEBOUNCE_MS);
    });
  }

  return {
    url: `http://127.0.0.1:${port}`,
    close(): Promise<void> {
      clearTimeout(debounce);
      watcher?.close();
      for (const client of sseClients) client.end();
      sseClients.clear();
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
