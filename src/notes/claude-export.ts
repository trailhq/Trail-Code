/**
 * Learnings from a memory export pasted from Claude.ai, for `trail init
 * --claude-memory <file>`. Claude.ai remembers what a person tells it across
 * chats; asked to write its memories out, it answers with headed paragraphs
 * ("Work context", "Top of mind") or a list of dated lines. Claude Code never
 * sees any of it.
 *
 * No model reads the export: it is split into single facts (a list item, or
 * one sentence of a paragraph), and init offers only the ones about code,
 * never the person's private life. Each is offered just for the person; the
 * screen's r adds one to the repo. Facts the repo already says, and facts
 * offered before, are left out. Anything that looks like a secret is
 * scrubbed, and a fact that still looks like one is skipped.
 */
import { createHash } from "node:crypto";
import { scrub } from "./cold-start.js";
import { SECRETISH, type MemoryCandidate } from "./memory-notes.js";
import { alreadySaid, codeAnchors, knownText } from "./team-check.js";

/** One fact of an export, with the heading it was under and the day it was saved, when the export says. */
export interface ExportFact {
  text: string;
  section: string;
  date: string | null;
}

/** At most this many offered: init's screen is for picking, not for reading the whole export. */
const MAX_OFFERED = 8;

/** A line that is only a heading: `# Work`, `**Work context**`, `*Recent months*`, `Top of mind:`. */
const HEADING = /^(?:#{1,6}\s+(.+?)|\*\*([^*]+?):?\*\*:?|\*([^*]+)\*|_([^_]+)_|([A-Z][\w ,&/'-]{1,50}):)$/;
const ITEM = /^(?:[-*•·]|\d{1,3}[.)])\s+(.+)$/;
const DATED = /^\[?(\d{4}-\d{2}-\d{2})\]?\s*[-–—:]?\s*/;
/** After `.`, `!` or `?` and before a capital, but not after e.g., i.e. and the like. */
const SENTENCE_END = /(?<=[.!?])(?<!\b(?:e\.g|i\.e|etc|vs|incl|approx|Mr|Ms|Dr)\.)\s+(?=[A-Z0-9"'`(])/;

/** Languages, tools and the parts of shipping code: a fact naming none of them isn't about code. */
const CODE =
  /`[^`]+`|\b[\w-]+\.(?:ts|tsx|js|py|go|rs|java|rb|sql|json|ya?ml|sh)\b|\b(?:code(?:base)?|coding|repos?|repository|monorepo|pull requests?|PRs?|commits?|branch(?:es)?|git(?:hub|lab)?|tests?|testing|CI|deploy\w*|builds?|lint\w*|refactor\w*|APIs?|SDKs?|CLI|frameworks?|librar(?:y|ies)|databases?|SQL|quer(?:y|ies)|schemas?|migrations?|endpoints?|backend|frontend|TypeScript|JavaScript|Python|Golang|Rust|Kotlin|Ruby|PHP|React|Next\.js|Vue|Svelte|Node(?:\.js)?|npm|pnpm|yarn|Docker|Kubernetes|k8s|EKS|EC2|AWS|GCP|Terraform|Postgres(?:QL)?|MySQL|Redis|MongoDB|BigQuery|Metabase|terminal|shell|bash|zsh|scripts?|debug\w*|bugs?|stack traces?|Claude Code|Cursor|VS ?Code)\b/i;
/** The person's private life: never offered, whatever else the fact says. */
const PRIVATE =
  /\b(?:wife|husband|spouse|partner's|girlfriend|boyfriend|kids?|children|son|daughter|baby|mother|father|mom|dad|parents|family|health\w*|doctor|medical|medication|diagnos\w*|therapy|therapist|pregnan\w*|religio\w*|church|temple|mosque|salary|income|rent|mortgage|loan|debt|birthday|dating|divorce|wedding|home address|phone number|vacation|holiday|gym|workout|diet)\b/i;
const PRIVATE_SECTION = /\bpersonal\b/i;

/** The facts of a pasted export, in order: a list item whole (with its wrapped lines), a paragraph a sentence at a time. */
export function exportFacts(text: string): ExportFact[] {
  const out: ExportFact[] = [];
  let section = "";
  let para: string[] = [];
  let item: string | null = null;
  const push = (raw: string) => {
    let t = raw.replace(/\s+/g, " ").trim();
    const d = DATED.exec(t);
    if (d) t = t.slice(d[0].length);
    if (t) out.push({ text: t, section, date: d?.[1] ?? null });
  };
  const flush = () => {
    if (item !== null) push(item);
    if (para.length) for (const s of para.join(" ").split(SENTENCE_END)) push(s);
    item = null;
    para = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("```")) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      section = h.slice(1).find(Boolean)!.trim();
      continue;
    }
    const li = ITEM.exec(line);
    if (li) {
      flush();
      item = li[1]!;
    } else if (item !== null && /^\s/.test(raw)) item += ` ${line}`;
    else {
      if (item !== null) flush();
      para.push(line);
    }
  }
  flush();
  return out;
}

/** A fact as a title: its words, without the full stop, at most 90 characters. */
function factTitle(text: string): string {
  let t = text.replace(/\.$/, "");
  if (t.length > 90) t = `${t.slice(0, 89).replace(/\s+\S*$/, "")}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Where a fact is remembered as offered: its words, not the day, so a re-export doesn't offer it again. */
function factKey(text: string): string {
  return `claude.ai:${createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 16)}`;
}

/**
 * What `trail init` offers from a pasted Claude.ai export: its facts about
 * code, just for the person, the ones naming this repo's code first, at most
 * eight. `total` is every fact read, for init's line.
 */
export function exportCandidates(repo: string, text: string, opts: { offered?: Set<string>; today?: string } = {}): { total: number; candidates: MemoryCandidate[] } {
  const facts = exportFacts(text);
  const known = knownText(repo);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const found: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.text.split(" ").length < 4) continue;
    if (PRIVATE_SECTION.test(f.section) || PRIVATE.test(f.text) || !CODE.test(f.text)) continue;
    const fact = scrub(f.text);
    if (SECRETISH.test(fact)) continue;
    const path = factKey(fact);
    if (seen.has(path) || opts.offered?.has(path)) continue;
    seen.add(path);
    const title = factTitle(fact);
    const body = `## Decided\n${fact}`;
    if (alreadySaid(known, title, body)) continue;
    found.push({ title, body, forTeam: false, touches: codeAnchors(repo, fact), path, updated: f.date ?? today, from: "claude.ai" });
  }
  const ordered = [...found.filter((c) => c.touches.length), ...found.filter((c) => !c.touches.length)];
  return { total: facts.length, candidates: ordered.slice(0, MAX_OFFERED) };
}
