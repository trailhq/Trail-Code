/**
 * `node refresh-run.js '<json>'`: the query-time rebuild (`graph/refresh.ts`) in a
 * process of its own. A rebuild of a big repo reads the whole extract cache and
 * writes the graph back, ~2.5 GB at its peak on assign; run inside the MCP server,
 * V8 kept most of that for the rest of the session. A child gives it all back to
 * the OS the moment it exits. Plain `graphOnly` build: structural, $0, offline.
 */
import { pathToFileURL } from "node:url";
import { buildGraph } from "./build.js";

export interface RefreshRunArgs {
  dir: string;
  contextDir?: string;
  onlyDirs?: string[];
}

export async function main(arg: string): Promise<void> {
  const { dir, contextDir, onlyDirs } = JSON.parse(arg) as RefreshRunArgs;
  await buildGraph(dir, { contextDir, graphOnly: true, onlyDirs });
}

// Run only when executed directly, not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2] ?? "{}").then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
