/**
 * A minimal LSP client for the opt-in `--lsp` enrichment pass — just enough to
 * pull compiler-grade call edges out of a language server: spawn it over stdio,
 * initialize, open documents, and run the call-hierarchy requests. Built on
 * `vscode-jsonrpc` (we don't hand-roll the framing). Everything is best-effort:
 * a server that is missing, slow, or errors degrades to "no enrichment", never a
 * crash — the AST graph stands on its own.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";

export interface LspPosition { line: number; character: number } // 0-indexed
export interface LspRange { start: LspPosition; end: LspPosition }
export interface CallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}

const uriOf = (abs: string): string => pathToFileURL(abs).toString();

/** The JavaScript entry point an npm Windows shim (`<bin>.cmd`) runs: its last line is
 * `"%_prog%" "%dp0%\<entry>.js" %*` (older npm: `"%~dp0\<entry>.js"`). Null for anything
 * else. */
export function npmShimEntry(shimPath: string, shimText: string): string | null {
  const m = /"%(?:dp0%|~dp0)\\([^"]+\.[cm]?js)"\s+%\*/i.exec(shimText);
  return m ? win32.join(win32.dirname(shimPath), m[1]) : null;
}

/** How to spawn a server. npm-installed servers (typescript-language-server,
 * pyright-langserver) are `.cmd` shims on Windows, which Node refuses to spawn without a
 * shell (EINVAL since the CVE-2024-27980 fix). Going through cmd.exe would let the repo
 * being mapped supply the `node` the shim runs (it searches the cwd and any relative PATH
 * entry) and breaks on `&`/`%`/`^` in the install path, so instead run the shim's entry
 * point with Node directly: the node.exe beside the shim, as the shim itself prefers, else
 * the Node running graft, without NODE_OPTIONS: graft loads the cwd's `.env` into its own
 * environment, so a checkout could set `NODE_OPTIONS=--require ./x.js` and have that Node
 * run its code. Any other `.cmd` is spawned as before (and fails cleanly: no enrichment). */
export function spawnSpec(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  readText: (p: string) => string = (p) => readFileSync(p, "utf8"),
  exists: (p: string) => boolean = existsSync,
): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (platform === "win32" && /\.cmd$/i.test(command)) {
    let entry: string | null = null;
    try { entry = npmShimEntry(command, readText(command)); } catch { entry = null; }
    if (entry) {
      const beside = win32.join(win32.dirname(command), "node.exe");
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.toUpperCase() === "NODE_OPTIONS") delete env[k];
      return { command: exists(beside) ? beside : process.execPath, args: [entry, ...args], env };
    }
  }
  return { command, args };
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private conn: MessageConnection;
  private opened = new Set<string>();
  private ready = false;
  private spawnFailed = false;

  constructor(
    command: string,
    args: string[],
    private readonly root: string,
    private readonly languageId: string,
    private readonly callTimeoutMs = 15000,
  ) {
    const s = spawnSpec(command, args);
    this.proc = spawn(s.command, s.args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: s.env ?? process.env });
    // ENOENT (bad path) OR an immediate exit (e.g. a rustup shim whose component
    // isn't installed) must fail fast, not hang a request for the full timeout.
    this.proc.on("error", () => { this.spawnFailed = true; });
    // An immediate exit (shim without its component, crash on startup) must fail
    // fast so initialize bails instead of waiting out the timeout; once we've
    // marked !ready, in-flight queries no-op. Firing during dispose is harmless.
    this.proc.on("exit", () => { this.spawnFailed = true; this.ready = false; });
    this.proc.stderr.resume(); // drain; servers are chatty on stderr
    // Swallow write-after-destroy (EPIPE / ERR_STREAM_DESTROYED) when the server
    // closes its stdin during/after shutdown — otherwise it surfaces as an
    // unhandled stream error and taints the process exit code.
    this.proc.stdin.on("error", () => {});
    this.conn = createMessageConnection(
      new StreamMessageReader(this.proc.stdout),
      new StreamMessageWriter(this.proc.stdin),
    );
    // Answer the reverse-RPC requests every server makes during startup so it
    // doesn't block waiting on us; we take defaults for all of them.
    this.conn.onRequest("workspace/configuration", (p: { items: unknown[] }) => (p.items ?? []).map(() => ({})));
    this.conn.onRequest("client/registerCapability", () => null);
    this.conn.onRequest("window/workDoneProgress/create", () => null);
    this.conn.onRequest("workspace/applyEdit", () => ({ applied: false }));
    this.conn.onNotification(() => {}); // swallow all notifications (diagnostics, progress, logs)
    // The connection/streams can error or close asynchronously (server exits,
    // stdin destroyed) — absorb both so a late write never becomes an unhandled
    // exception that taints the build's exit code.
    this.conn.onError(() => { this.ready = false; });
    this.conn.onClose(() => { this.ready = false; });
    this.conn.listen();
  }

  /** Safe to write to the server's stdin right now? */
  private canWrite(): boolean {
    return this.ready && this.proc.stdin.writable && !this.proc.stdin.destroyed;
  }

  /** A request with a timeout so a wedged server can't hang the whole build. */
  private call<T>(method: string, params: unknown): Promise<T> {
    if (!this.canWrite()) return Promise.resolve(null as T);
    return new Promise<T>((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null as T); } }, this.callTimeoutMs);
      this.conn.sendRequest<T>(method, params).then(
        (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } },
        () => { if (!done) { done = true; clearTimeout(t); resolve(null as T); } },
      );
    });
  }

  async initialize(): Promise<boolean> {
    // Let a synchronous spawn failure (ENOENT) surface before we wait on a
    // response that will never come.
    await new Promise((r) => setTimeout(r, 50));
    if (this.spawnFailed || this.proc.pid === undefined) return false;
    const rootUri = uriOf(this.root);
    // Cold-workspace load (rust-analyzer/clangd index the project) can take a
    // while — give initialize a generous timeout, separate from per-request.
    const init = await new Promise<unknown>((resolve) => {
      const t = setTimeout(() => resolve(null), 120000);
      this.conn.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "root" }],
        capabilities: {
          textDocument: {
            callHierarchy: { dynamicRegistration: false },
            synchronization: { dynamicRegistration: false },
          },
          workspace: { workspaceFolders: true, configuration: true },
        },
      }).then((r) => { clearTimeout(t); resolve(r); }, () => { clearTimeout(t); resolve(null); });
    });
    if (!init) return false;
    this.conn.sendNotification("initialized", {});
    this.ready = true;
    return true;
  }

  /** Open a document (idempotent). Servers resolve cross-file refs from disk, but
   * the LSP spec wants the queried document opened first. */
  didOpen(abs: string): void {
    if (!this.canWrite() || this.opened.has(abs)) return;
    let text = "";
    try { text = readFileSync(abs, "utf8"); } catch { return; }
    this.opened.add(abs);
    try {
      this.conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri: uriOf(abs), languageId: this.languageId, version: 1, text },
      });
    } catch { /* stream closed mid-write */ }
  }

  /** Poll one probe position until call-hierarchy returns something — servers
   * like rust-analyzer/clangd index AFTER `initialized` and answer empty until
   * ready. Returns true once ready (or false at the cap). */
  async waitUntilReady(abs: string, pos: LspPosition, maxMs = 90000): Promise<boolean> {
    this.didOpen(abs);
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const items = await this.prepareCallHierarchy(abs, pos);
      if (items.length) return true;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepareCallHierarchy(abs: string, pos: LspPosition): Promise<CallHierarchyItem[]> {
    if (!this.ready) return [];
    const r = await this.call<CallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", {
      textDocument: { uri: uriOf(abs) },
      position: pos,
    });
    return r ?? [];
  }

  /** The callees of an item — returns each outgoing call's `to` target. */
  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyItem[]> {
    if (!this.ready) return [];
    const r = await this.call<Array<{ to: CallHierarchyItem }> | null>("callHierarchy/outgoingCalls", { item });
    return (r ?? []).map((c) => c.to).filter(Boolean);
  }

  async dispose(): Promise<void> {
    // Skip the graceful LSP shutdown/exit handshake: writing `exit` to a server
    // that has already closed its stdin throws ERR_STREAM_DESTROYED and taints
    // the exit code. The graph is already built; just tear the process down.
    this.ready = false;
    try { this.conn.dispose(); } catch { /* ignore */ }
    try { this.proc.stdin.destroy(); } catch { /* ignore */ }
    try { this.proc.kill("SIGKILL"); } catch { /* ignore */ }
  }
}
