/**
 * A parser child. `parse-pool.ts` forks N of these for a large cold build
 * (`graft build --workers`): each warms its own grammars (native addons and WASM
 * alike, in a fresh process), then answers `job` messages with the very
 * `extractOne` the in-thread loop uses. A child process rather than a worker
 * thread for the reasons `app/review-process.ts` spells out: the nine native
 * grammars load exactly as they do in production, a wedged parse is a process
 * to kill, and a crash (or a WASM abort, which poisons its Emscripten runtime
 * for good) costs one file instead of the build.
 */
import { extractOne, type ExtractOneResult } from "./extract-one.js";
import { warmGenericGrammars, wasmRuntimePoisoned } from "./generic.js";
import { warmContainerGrammars } from "./container.js";
import type { SourceStat } from "./source-files.js";

export type ToChild =
  | { type: "init"; generic: string[]; container: string[] }
  | { type: "job"; seq: number; f: SourceStat; cachedHash: string | null }
  | { type: "stop" };
/** `retire`: this child's WASM runtime is poisoned, so every later WASM parse in
 * it would fail. The pool answers with `stop` and replaces it. The child never
 * exits on its own: IPC is ordered, so the pool handles this `done` before the
 * `exit` its `stop` causes, and cannot mistake the retirement for a crash. */
export type FromChild = { type: "ready" } | { type: "done"; seq: number; result: ExtractOneResult; retire?: true };

function send(msg: FromChild): void {
  try { process.send?.(msg); } catch { /* parent gone; disconnect handler exits */ }
}

if (process.send) {
  process.on("message", (m: ToChild) => {
    if (m.type === "init") {
      void Promise.all([warmGenericGrammars(m.generic), warmContainerGrammars(m.container)])
        .then(() => send({ type: "ready" }), () => process.exit(3));
    } else if (m.type === "job") {
      const result = extractOne(m.f, m.cachedHash);
      send(wasmRuntimePoisoned() === null ? { type: "done", seq: m.seq, result } : { type: "done", seq: m.seq, result, retire: true });
    } else if (m.type === "stop") {
      process.exit(0);
    }
  });
  // The parent going away (killed, crashed) closes the channel: do not linger.
  process.on("disconnect", () => process.exit(0));
}
