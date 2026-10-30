/**
 * What `trail note` checks before it saves a learning for the team: that a
 * teammate's Claude would act differently for reading it. A learning that
 * names no code never reaches anyone (learnings arrive when Claude opens the
 * files they name), one about setting trail up isn't about the repo, status
 * ("PR is open") is wrong by next week, a decision without its reason can't be
 * weighed, and a second copy of a learning buries the first.
 *
 * Each check that fails says how to fix it, and the agent saves again. A long
 * learning only gets a warning. `--anyway` saves past the checks, for when
 * one of them is wrong.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { trailOwnPath } from "./git-facts.js";
import { noteName, notePlace, SECTIONS, shortDate, type Note } from "./notes.js";

/** Past this many words a learning gets skimmed: a warning, never a refusal. */
export const LONG_NOTE_WORDS = 250;

export interface GateInput {
  title: string;
  body: string;
  /** Kept in ~/.trail for this person, not the team: only the status and repeat checks apply. */
  personal: boolean;
  /** Repo files the note names that exist (from `mentionedFiles`), relative to the checkout. */
  files: string[];
  /** Whether the note names a function, type or other symbol that's in the repo's code. */
  namesSymbol: boolean;
  /** What it will touch, for the repeat check. */
  touches: string[];
  /** The id of the learning it says it replaces (`--replaces`). */
  replaces?: string;
}

export interface GateResult {
  /** Why it can't be saved as it is, each with how to fix it. Empty: it passes. */
  problems: string[];
  warnings: string[];
}

/** Setting trail (or graft) up, said in a title or body. */
const SETUP_TALK =
  /\b(?:trail|graft)\b[^.\n]{0,40}\b(?:init|setup|set up|install(?:ed|ing)?|hooks?|wiring|wired)\b|\b(?:setting up|set up|install(?:ed|ing)?|wiring)\b[^.\n]{0,20}\b(?:trail|graft)\b/i;

/** Status: true when written, wrong a week later. */
const STATUS: RegExp[] = [
  /\b(?:PR|pull request|MR)\s*#?\d*\s+(?:is|was|got|has been|now)\s+(?:open|opened|merged|closed|approved|up|green|fixed|pushed)\b/i,
  /\bnot (?:merged|pushed|released|published|deployed|reviewed) yet\b/i,
  /\bpushed and not merged\b/i,
  /\b(?:today|tomorrow|yesterday|tonight|this (?:morning|afternoon|evening|week))\b/i,
  /\b(?:waiting on|blocked on|still open|awaiting review|in review)\b/i,
];

/** A reason: a cause, an error, a number, or a word that brings one. */
const WHY =
  /\b(?:because|since|so that|so|otherwise|or else|else|due to|caused?|causes|causing|means|meant|breaks?|broke|broken|fails?|failed|failing|errors?|exceptions?|crash(?:es|ed)?|hangs?|leaks?|slow(?:er)?|faster|cheaper|costs?|instead|to avoid|to keep|to stop|to prevent|in order to|unless|only if|rejects?|refuses?|blocks?|loses?|lost|drops?|wipes?|overwrites?|but|though|doubles?|twice|half|latency|memory|wrong|incorrect|missing|stale|races?|timeouts?|times out|deadlocks?|conflicts?|regress(?:es|ion)?|can't|cannot|won't|doesn't|don't|isn't|aren't|never)\b|\d|["“][^"”]{4,}["”]|→|=>/i;

const STOP = new Set(
  "the and for with from that this what when where which into does how why are was were not but you your our out its it's can should would could about after before over under use using used fix find make".split(" "),
);

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3 && !STOP.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / (a.size + b.size - both);
}

/** The body without fenced code, which quotes errors and commands rather than saying status. */
function prose(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "");
}

/** The lines a reason belongs on: under Decided and Tried and ruled out, or the whole body when it has neither. */
function decisionLines(body: string): string[] {
  const lines = prose(body).split(/\r?\n/);
  const wanted = new Set([SECTIONS[0].heading.toLowerCase(), SECTIONS[1].heading.toLowerCase()]);
  const out: string[] = [];
  let section: string | null = null;
  let sawSection = false;
  for (const raw of lines) {
    const l = raw.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    if (h) {
      section = h[1]!.trim().toLowerCase();
      if (wanted.has(section)) sawSection = true;
      continue;
    }
    if (l && section && wanted.has(section)) out.push(l);
  }
  if (sawSection) return out;
  return lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function clip(s: string, n = 70): string {
  const t = s.trim().replace(/^[-*]\s+/, "");
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** The learning this one repeats: same files, and much the same title or text. */
export function repeatOf(input: Pick<GateInput, "title" | "body" | "touches" | "replaces" | "personal">, existing: Note[]): Note | null {
  const files = new Set(input.touches.map((t) => t.split("#")[0]!));
  const title = words(input.title);
  const body = words(input.body);
  for (const n of existing) {
    if (input.replaces && n.id === input.replaces) continue;
    const shared = n.touches.some((t) => files.has(t.split("#")[0]!));
    const sameTitle = jaccard(title, words(n.title));
    const sameBody = jaccard(body, words(n.body));
    if (shared ? sameTitle >= 0.5 || sameBody >= 0.5 : (input.personal || !files.size) && sameTitle >= 0.6) return n;
  }
  return null;
}

/** The checks, on a learning about to be saved. `existing`: the learnings already there. */
export function gateNote(input: GateInput, existing: Note[]): GateResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const text = `${input.title}\n${prose(input.body)}`;

  if (!input.personal) {
    const code = input.files.filter((f) => !trailOwnPath(f));
    const onlyTrail = input.files.length > 0 && code.length === 0;
    if (!code.length && !input.namesSymbol) {
      problems.push(
        SETUP_TALK.test(text) || onlyTrail
          ? "It reads as a note about setting trail up, not this repo's code. Skip it, or keep it with --personal if it's about your machine."
          : "It names no file or function in this repo. Name what it's about (`src/x.ts`, `parseConfig`), so a teammate's Claude gets it when it opens that file.",
      );
    }
  }

  for (const line of text.split(/\r?\n/)) {
    if (STATUS.some((re) => re.test(line))) {
      problems.push(`"${clip(line)}" is status: true today, wrong next week. Keep what stays true (the cause, the choice, the why) and put status in the PR.`);
      break;
    }
  }

  if (!input.personal && !decisionLines(input.body).some((l) => WHY.test(l))) {
    problems.push('No line says why. Give each choice its reason: the cause, the error it hit, or the number that settled it ("because…", "otherwise…", "fails with…").');
  }

  const twin = repeatOf(input, existing);
  if (twin) {
    problems.push(
      `It repeats ${notePlace(twin)} ("${clip(twin.title, 50)}"${twin.author ? `, ${twin.author}` : ""}, ${shortDate(twin.date)}). If it updates that one, add --replaces ${noteName(twin)}: the old file stays as the record and yours is read instead. If it's different, say how in the title.`,
    );
  }

  const count = input.body.split(/\s+/).filter(Boolean).length;
  if (count > LONG_NOTE_WORDS) warnings.push(`long: ${count} words. Long learnings get skimmed; cut it to the fact and the why.`);
  return { problems, warnings };
}

/** `parseConfig`, `Client.Do`, `default_retry_max`, `retry()`: words in a note shaped like code. */
const BACKTICKED = /`([A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*)(?:\(\))?`/g;
const CODE_SHAPED = /\b([a-z]+[A-Z][\w]*|[A-Z][a-z0-9]+[A-Z][\w]*|[a-z][a-z0-9]*_[a-z0-9_]+|[A-Za-z_]\w*(?=\(\)))\b/g;

/** The names a note uses that might be symbols, most likely first: backticked, then code-shaped. At most `limit`. */
export function symbolCandidates(text: string, limit = 8): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const name = s.split(/\.|::|#/).pop()!;
    if (name.length < 3 || /\.[A-Za-z]{1,5}$/.test(s) || out.includes(name)) return;
    out.push(name);
  };
  for (const m of text.matchAll(BACKTICKED)) add(m[1]!);
  for (const m of text.matchAll(CODE_SHAPED)) add(m[1]!);
  return out.slice(0, limit);
}

/**
 * Whether any of `names` is in the repo's code: a whole-word `git grep` over
 * tracked files, leaving out trail's own files and markdown, which would find
 * the note's own words. Outside git, false: the files it names still count.
 */
export function namesRepoSymbol(repo: string, names: string[]): boolean {
  if (!names.length) return false;
  for (const name of names) {
    try {
      execFileSync("git", ["grep", "-q", "-w", "-F", "-e", name, "--", ".", ":(exclude).trail", ":(exclude).claude", ":(exclude)*.md"], {
        cwd: repo,
        stdio: "ignore",
        windowsHide: true,
      });
      return true;
    } catch {
      /* not found, or not a repo */
    }
  }
  return false;
}

/**
 * Of `files` (relative to the checkout at `repo`), the ones git tracks. A
 * learning's `touches:` lists these, plus files the session itself edited:
 * an untracked file that was already lying around (a token, a scratch file)
 * is never what a learning is about. Outside git, every file that exists.
 */
export function trackedFiles(repo: string, files: string[]): Set<string> {
  if (!files.length) return new Set();
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", ...files], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return new Set(files.filter((f) => existsSync(join(repo, f))));
  }
}
