/**
 * The learnings a repo's committed HEAD has, read through git: what the
 * workspace may get of the repo's own `.trail/learnings/`.
 *
 * Never the working tree. An edit not yet committed, a file only staged or
 * never added, and a committed link to a file outside the repo (a personal
 * learning, say) stay on this machine: what goes up is what anyone who clones
 * the repo would read.
 */
import { execFileSync } from "node:child_process";
import { LEARNINGS_DIR } from "../notes/repo-trail.js";

/** Regular files only: a committed link (120000) or a submodule is no learning. */
const FILE_MODES = new Set(["100644", "100755"]);

function git(checkout: string, args: string[], input?: string): Buffer | null {
  try {
    // Never a credential prompt: this runs detached, where nobody could answer it.
    return execFileSync("git", args, {
      cwd: checkout,
      input,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * Every `.md` file directly in `.trail/learnings/` at HEAD, with its committed
 * text, in git's order. [] when HEAD has no learnings. Null when git couldn't
 * say: no git, no commit yet, a timeout, a repo git refuses (safe.directory)
 * or can't read. A caller must not take null for "none": sending an empty set
 * would tell the workspace the repo's learnings are gone. Two git calls: one
 * listing, one batch read. Never throws.
 */
export function headLearnings(checkout: string): Array<{ name: string; text: string }> | null {
  // One call answers both: exit 0 when HEAD resolves (empty when the folder
  // isn't there), an error otherwise. `--full-tree` keeps paths from the top.
  const prefix = `${LEARNINGS_DIR}/`;
  const listed = git(checkout, ["ls-tree", "-z", "--full-tree", "HEAD", "--", prefix]);
  if (!listed) return null;
  const blobs: Array<{ name: string; oid: string }> = [];
  for (const entry of listed.toString("utf8").split("\0")) {
    // `<mode> <type> <oid>\t<path>`
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    if (type === "blob" && FILE_MODES.has(mode ?? "") && oid && name.endsWith(".md") && !name.includes("/")) blobs.push({ name, oid });
  }
  if (blobs.length === 0) return [];
  const out = git(checkout, ["cat-file", "--batch"], `${blobs.map((b) => b.oid).join("\n")}\n`);
  if (!out) return null;
  // Each answer is `<oid> blob <size>\n<content>\n`, or `<oid> missing\n`, in the order asked.
  const found: Array<{ name: string; text: string }> = [];
  let at = 0;
  for (const b of blobs) {
    const nl = out.indexOf(0x0a, at);
    if (nl < 0) return null;
    const [, type, sizeText] = out.subarray(at, nl).toString("utf8").split(" ");
    at = nl + 1;
    // A blob HEAD lists but git can't find: the repo is damaged, so HEAD wasn't read.
    if (type !== "blob") return null;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || at + size > out.length) return null;
    found.push({ name: b.name, text: out.subarray(at, at + size).toString("utf8") });
    at += size + 1;
  }
  return found;
}
