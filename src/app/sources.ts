/**
 * Everything in a repository that is already a rule, or nearly one.
 *
 * Commit messages and pull-request discussion say what a team decided in
 * passing. These are the places where they wrote it down on purpose: the
 * instruction files they hand their own agents, the decision records, the linter
 * config, the ownership rules. Higher precision per byte than any amount of
 * history, and most of it is a file read.
 *
 * Every reader returns text, never source code, and every one is best-effort:
 * a repo with none of these still builds a brain from its history.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { ghHeaders, type Fetch } from "./identity.js";

/** What kind of thing a source is, so extraction can weigh it. */
export type SourceKind =
  | "agent_instructions"
  | "decision_doc"
  | "lint_config"
  | "ci_config"
  | "codeowners"
  | "branch_protection"
  | "revert"
  | "test_name"
  | "declined_issue";

/** One rule-bearing artefact. */
export interface HistorySource {
  kind: SourceKind;
  /** Repo-relative path, or an API-ish label like "branch protection: main". */
  path: string;
  text: string;
  /** Deep link, where one exists (an issue, a reverted commit). */
  url?: string;
}

/** Per-file and total caps, so one enormous doc cannot crowd out everything. */
const MAX_FILE_CHARS = 24_000;
const MAX_TOTAL_CHARS = 300_000;
const MAX_SOURCES = 120;

function readText(root: string, rel: string): string | null {
  try {
    const p = join(root, rel);
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    const raw = readFileSync(p, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_FILE_CHARS ? `${trimmed.slice(0, MAX_FILE_CHARS)}\n[…truncated]` : trimmed;
  } catch {
    return null;
  }
}

/** Files directly under `rel`, one level deep, matching `test`. */
function filesIn(root: string, rel: string, test: (name: string) => boolean): string[] {
  try {
    const dir = join(root, rel);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter(test)
      .map((n) => join(rel, n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Instruction files the team already wrote for coding agents.
 *
 * The single highest-precision source in a repository: someone sat down and
 * wrote imperative rules for a machine to follow. Nothing has to be inferred.
 *
 * Graft's own managed blocks are stripped first. Without that the brain reads
 * back graft's instructions about using graft, and then graft carries them into
 * the same file — a loop that fills the rulebook with itself.
 */
export function readAgentInstructions(root: string): HistorySource[] {
  const candidates = [
    "CLAUDE.md",
    "AGENTS.md",
    "GEMINI.md",
    ".github/copilot-instructions.md",
    ".windsurf/rules/graft.md",
    ...filesIn(root, ".cursor/rules", (n) => n.endsWith(".mdc") || n.endsWith(".md")),
    // The same files one folder down: a monorepo keeps its frontend's rules in
    // web/CLAUDE.md, and those are as deliberate as the root's.
    ...folderInstructionFiles(root),
    // Skills a team wrote for its agents. Graft's own is left out for the same
    // reason its managed blocks are: the brain must not learn graft from graft.
    ...skillFiles(root),
  ];
  const out: HistorySource[] = [];
  const seen = new Set<string>();
  for (const rel of candidates) {
    const key = rel.replace(/\\/g, "/");
    if (seen.has(key)) continue;
    seen.add(key);
    const text = stripManagedBlocks(readText(root, rel) ?? "");
    if (text.trim()) out.push({ kind: "agent_instructions", path: key, text });
  }
  return out;
}

/** Instruction files below the root that are worth reading as instructions. */
const FOLDER_INSTRUCTION_NAMES = new Set(["CLAUDE.md", "AGENTS.md"]);
/** How deep below the root a folder instruction file may sit (a/b/c/d/CLAUDE.md). */
const MAX_FOLDER_DEPTH = 4;
/** Most folder instruction files, and most skills, carried per push. */
export const MAX_FOLDER_FILES = 30;
export const MAX_SKILL_FILES = 30;

/** Directories never searched for instruction files: dependencies, build
 * output, graft's own cache. Dot-directories are skipped as a class. */
const SKIP_INSTRUCTION_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "vendor",
  "graft",
  "target",
  "coverage",
  "__pycache__",
  "venv",
  "bower_components",
]);

function skippedSegment(seg: string): boolean {
  return seg.startsWith(".") || SKIP_INSTRUCTION_DIRS.has(seg);
}

/**
 * `**\/CLAUDE.md` and `**\/AGENTS.md` below the root, shallowest first.
 *
 * Asked of git first, because git already knows what the repository ignores:
 * a CLAUDE.md inside an ignored folder is someone's scratch, not the team's.
 * The walk is the fallback for a checkout git cannot answer for.
 */
export function folderInstructionFiles(root: string, max = MAX_FOLDER_FILES): string[] {
  const keep = (rel: string): boolean => {
    const parts = rel.split("/");
    const name = parts[parts.length - 1] ?? "";
    const dirs = parts.slice(0, -1);
    if (!FOLDER_INSTRUCTION_NAMES.has(name)) return false;
    if (dirs.length === 0 || dirs.length > MAX_FOLDER_DEPTH) return false;
    return !dirs.some(skippedSegment);
  };
  let found: string[] | null = null;
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*CLAUDE.md", "*AGENTS.md"]);
  if (listed !== null) found = [...new Set(listed.split("\0").filter(Boolean))].filter(keep);
  if (found === null) found = walkFor(root, keep);
  const depth = (p: string) => p.split("/").length;
  return found
    .filter((rel) => existsSync(join(root, rel)))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, max);
}

/** The filesystem walk behind folderInstructionFiles, for a tree git cannot list. */
function walkFor(root: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (rel: string, depth: number) => {
    if (depth > MAX_FOLDER_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const child = rel ? `${rel}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(join(root, child)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!skippedSegment(name)) visit(child, depth + 1);
      } else if (depth > 0 && keep(child)) {
        out.push(child);
      }
    }
  };
  visit("", 0);
  return out;
}

/** `.claude/skills/<name>/SKILL.md`, graft's own skill excluded. */
export function skillFiles(root: string, max = MAX_SKILL_FILES): string[] {
  const dir = join(root, ".claude", "skills");
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name === "graft" || name.startsWith(".")) continue;
    const rel = `.claude/skills/${name}/SKILL.md`;
    try {
      if (!statSync(join(root, rel)).isFile()) continue;
    } catch {
      continue;
    }
    out.push(rel);
    if (out.length >= max) break;
  }
  return out;
}

/** Remove graft's own fenced regions, so the brain never learns graft from graft. */
function stripManagedBlocks(text: string): string {
  return text
    .replace(/<!--\s*graft:(brain:)?start\s*-->[\s\S]*?<!--\s*graft:(brain:)?end\s*-->/g, "")
    .trim();
}

/** Architecture decision records and the docs that read like them. */
export function readDecisionDocs(root: string): HistorySource[] {
  const mdIn = (dir: string) => filesIn(root, dir, (n) => n.endsWith(".md"));
  const candidates = [
    "ARCHITECTURE.md",
    "CONTRIBUTING.md",
    "docs/ARCHITECTURE.md",
    "docs/CONTRIBUTING.md",
    ...mdIn("docs/adr"),
    ...mdIn("docs/decisions"),
    ...mdIn("adr"),
  ];
  const out: HistorySource[] = [];
  for (const rel of candidates) {
    const text = readText(root, rel);
    if (text) out.push({ kind: "decision_doc", path: rel, text });
  }
  return out;
}

/**
 * Rules the team already encoded for a machine: linters, formatters, and the
 * checks CI insists on. Nothing to infer — extraction only has to phrase them.
 */
export function readCodifiedRules(root: string): HistorySource[] {
  const lint = [
    ".golangci.yml",
    ".golangci.yaml",
    ".eslintrc.json",
    ".eslintrc.js",
    "eslint.config.js",
    "eslint.config.mjs",
    "ruff.toml",
    ".ruff.toml",
    ".prettierrc",
    ".prettierrc.json",
    "commitlint.config.cjs",
    "commitlint.config.js",
    ".editorconfig",
  ];
  const out: HistorySource[] = [];
  for (const rel of lint) {
    const text = readText(root, rel);
    if (text) out.push({ kind: "lint_config", path: rel, text });
  }
  for (const rel of filesIn(root, ".github/workflows", (n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    const text = readText(root, rel);
    if (text) out.push({ kind: "ci_config", path: rel, text });
  }
  return out;
}

/** Who must approve what. A hard constraint, stated as a file. */
export function readCodeowners(root: string): HistorySource[] {
  for (const rel of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const text = readText(root, rel);
    if (text) return [{ kind: "codeowners", path: rel, text }];
  }
  return [];
}

/** Run git in `root`, or null when it fails. */
function git(root: string, args: string[]): string | null {
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout;
}

/** How many reverts to carry. */
const MAX_REVERTS = 40;

/**
 * Commits that undid another commit.
 *
 * "We tried this and took it back" is a rule available from nowhere else, and
 * it is the one kind of history that says what NOT to do. The body of a revert
 * usually names the commit it undoes and, when the author bothered, why.
 */
export function readReverts(root: string, max = MAX_REVERTS): HistorySource[] {
  const out = git(root, ["log", "--grep=^Revert", "-n", String(max), "--format=%H%x02%s%x02%b%x01"]);
  if (!out) return [];
  const sources: HistorySource[] = [];
  for (const record of out.split("\x01")) {
    if (!record.trim()) continue;
    const [sha = "", subject = "", body = ""] = record.split("\x02");
    if (!sha.trim() || !subject.trim()) continue;
    sources.push({
      kind: "revert",
      path: `revert ${sha.trim().slice(0, 12)}`,
      text: [subject.trim(), body.trim()].filter(Boolean).join("\n"),
    });
  }
  return sources;
}

/** How many test names to carry. */
const MAX_TEST_NAMES = 300;

/**
 * Test names, which are invariants someone wrote deliberately.
 *
 * `never retries on a card decline` is a rule stated as an assertion. Read from
 * the graph's own symbols rather than by re-parsing, so this costs nothing:
 * a test function is already a node.
 *
 * Only names that read like a sentence are kept. `TestFoo` is a label;
 * `rejects an expired token` is a claim about how the system must behave.
 */
export function readTestNames(symbolNames: Array<{ name: string; path: string }>, max = MAX_TEST_NAMES): HistorySource[] {
  const out: HistorySource[] = [];
  for (const s of symbolNames) {
    if (!/(^|[/.])(test|spec)[s]?[/.]|_test\.|\.test\.|\.spec\./i.test(s.path)) continue;
    const sentence = humanizeTestName(s.name);
    if (!sentence) continue;
    out.push({ kind: "test_name", path: s.path, text: sentence });
    if (out.length === max) break;
  }
  return out;
}

/**
 * A test's name as a claim, or null when it is only a label.
 *
 * Requires three words after the prefix is stripped: fewer than that
 * ("TestParse", "handles errors") states no invariant worth a rule, and letting
 * those through fills the brain with noise that reads like content.
 */
function humanizeTestName(name: string): string | null {
  let s = name.replace(/^(Test|it|test|should|describe)[_\s]*/i, "");
  // TestRetriesThreeTimes → Retries Three Times
  if (/^[A-Za-z]+$/.test(s) && /[a-z][A-Z]/.test(s)) s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  s = s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.split(" ").length < 3) return null;
  return s.toLowerCase();
}

/** How many declined issues to carry. */
const MAX_DECLINED = 40;

/**
 * Issues closed as not planned.
 *
 * A decision NOT to build something, which is half of what a codebase's rules
 * are and is invisible everywhere else — nothing was committed, so no commit
 * message records it.
 */
export async function readDeclinedIssues(
  owner: string,
  repo: string,
  token: string,
  fetchImpl: Fetch,
  api = "https://api.github.com",
  max = MAX_DECLINED,
): Promise<HistorySource[]> {
  try {
    const res = await fetchImpl(`${api}/repos/${owner}/${repo}/issues?state=closed&per_page=100&sort=updated`, {
      headers: ghHeaders(token),
    });
    if (!res.ok) return [];
    const items = JSON.parse(await res.text()) as Array<{
      number?: number;
      title?: string;
      body?: string | null;
      html_url?: string;
      state_reason?: string | null;
      pull_request?: unknown;
    }>;
    if (!Array.isArray(items)) return [];
    const out: HistorySource[] = [];
    for (const i of items) {
      // The issues endpoint returns pull requests too; they are already mined as
      // threads and would be counted twice.
      if (i.pull_request) continue;
      if (i.state_reason !== "not_planned") continue;
      if (!i.title?.trim()) continue;
      out.push({
        kind: "declined_issue",
        path: `issue #${i.number}`,
        text: [i.title.trim(), (i.body ?? "").trim()].filter(Boolean).join("\n").slice(0, MAX_FILE_CHARS),
        url: i.html_url,
      });
      if (out.length === max) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Required checks and reviewers on the default branch. */
export async function readBranchProtection(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  fetchImpl: Fetch,
  api = "https://api.github.com",
): Promise<HistorySource[]> {
  if (!branch) return [];
  try {
    const res = await fetchImpl(`${api}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`, {
      headers: ghHeaders(token),
    });
    // 404 simply means the branch is not protected, which is not a failure.
    if (!res.ok) return [];
    const p = JSON.parse(await res.text()) as {
      required_status_checks?: { contexts?: string[] };
      required_pull_request_reviews?: { required_approving_review_count?: number; require_code_owner_reviews?: boolean };
      allow_force_pushes?: { enabled?: boolean };
    };
    const lines: string[] = [];
    const checks = p.required_status_checks?.contexts ?? [];
    if (checks.length) lines.push(`Checks that must pass before merging to ${branch}: ${checks.join(", ")}.`);
    const reviews = p.required_pull_request_reviews;
    if (reviews?.required_approving_review_count) {
      lines.push(`${reviews.required_approving_review_count} approving review(s) required to merge to ${branch}.`);
    }
    if (reviews?.require_code_owner_reviews) lines.push(`A code owner must approve changes to ${branch}.`);
    if (p.allow_force_pushes?.enabled === false) lines.push(`Force pushes to ${branch} are not allowed.`);
    if (!lines.length) return [];
    return [{ kind: "branch_protection", path: `branch protection: ${branch}`, text: lines.join("\n") }];
  } catch {
    return [];
  }
}

/**
 * Trim the collected sources to a budget, best kinds first.
 *
 * The order is the argument of this whole module: a file the team wrote to
 * instruct an agent outranks a decision doc, which outranks a config, which
 * outranks anything inferred. When the budget runs out it should run out on the
 * weakest evidence.
 */
const KIND_RANK: SourceKind[] = [
  "agent_instructions",
  "decision_doc",
  "codeowners",
  "branch_protection",
  "lint_config",
  "ci_config",
  "revert",
  "declined_issue",
  "test_name",
];

export function budgetSources(sources: HistorySource[], maxChars = MAX_TOTAL_CHARS, maxCount = MAX_SOURCES): HistorySource[] {
  const ranked = [...sources].sort((a, b) => KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind));
  const out: HistorySource[] = [];
  let spent = 0;
  for (const s of ranked) {
    if (out.length >= maxCount) break;
    if (spent + s.text.length > maxChars) continue;
    out.push(s);
    spent += s.text.length;
  }
  return out;
}

/** Repo-relative path, for readers handed an absolute one. */
export function relPath(root: string, abs: string): string {
  return relative(root, abs) || abs;
}
