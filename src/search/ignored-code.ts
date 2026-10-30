/**
 * Code the map leaves out because git ignores it, named when a search comes up
 * empty. A migration repo kept the old app's code in git-ignored dumps (they
 * held credentials); `trail grep` found nothing, said all indexed code was
 * searched, and the agent's own grep then found the file. After that the agent
 * stopped trusting trail for the session.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { supportedExtensions } from "../graph/source-files.js";
import { shouldSkipDir } from "../ingest/fs.js";

/** Most entries one ignored folder's walk looks at before giving up on it. */
const WALK_CAP = 2000;

function holdsCode(dir: string, exts: Set<string>): boolean {
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < WALK_CAP) {
    const at = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_CAP) break;
      if (e.isDirectory()) {
        if (!shouldSkipDir(e.name)) stack.push(join(at, e.name));
      } else if (exts.has(extname(e.name).toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Git-ignored folders and files under `root` holding code the map would
 * otherwise index, repo-relative, folders ending in `/`. Dependency, build and
 * dot folders are left out. Empty outside git, or when git can't say.
 */
export function ignoredCode(root: string, limit = 20): string[] {
  const r = spawnSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"], {
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  const exts = new Set(supportedExtensions());
  const out: string[] = [];
  for (const entry of r.stdout.split("\n")) {
    if (!entry) continue;
    if (entry.replace(/\/$/, "").split("/").some((p) => shouldSkipDir(p))) continue;
    const code = entry.endsWith("/") ? holdsCode(join(root, entry), exts) : exts.has(extname(entry).toLowerCase());
    if (code) out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** `a/, b/ and 3 more`. */
export function ignoredLabel(paths: string[], shown = 3): string {
  const head = paths.slice(0, shown).join(", ");
  return paths.length > shown ? `${head} and ${paths.length - shown} more` : head;
}
