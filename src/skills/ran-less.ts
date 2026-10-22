/**
 * D138 (2): a call that ran a skill's step but made it do less is not that step for credit: it added a flag that
 * stops the work (`--dry-run`, `-n`, a `-qn` bundle, `--no-...`) the step lacked, or a trailing `; exit 0`,
 * `|| true`, `|| :` (or `|| exit 0`) that hides the step's failure. Output-only `--no-` flags (colour, progress,
 * pager, fund, audit, update notices) change nothing the step does, so they still count. Pure.
 */
import { simpleCommands } from '../trace/shell.js';
import { unquote, words } from '../trace/shell-scan.js';

const LESS = /^(?:--dry-?run|-n|--no-[\w-]+)$/i;
const OUTPUT_ONLY = /^--no-(?:colou?rs?|progress|pager|fund|audit|update-notifier|emoji|spin(?:ner)?|banner)$/i;
const HIDES_FAILURE = /(?:;\s*exit\s+0|\|\|\s*(?:true|:|exit\s+0))\s*;?\s*$/;

/** The do-less flags in one simple command: `--x=y` as `--x`, a short bundle letter by letter. */
function lessIn(simple: string): string[] {
  return words(simple).map((w) => unquote(w)).flatMap((w) => {
    const f = /^-[A-Za-z]{2,}$/.test(w) ? [...w.slice(1)].map((c) => `-${c}`) : w.startsWith('-') ? [w.split('=')[0]!] : [];
    return f.filter((x) => LESS.test(x) && !OUTPUT_ONLY.test(x));
  });
}

/** What a simple command runs: its program and first word that isn't a flag (`npm run`, `git push`), env assignments off. */
function head(simple: string): string {
  const ws = words(simple).map((w) => unquote(w)).filter((w) => !/^[A-Za-z_]\w*=/.test(w));
  const verb = ws.slice(1).find((w) => !w.startsWith('-'));
  return ws.length ? `${ws[0]} ${verb ?? ''}` : '';
}

/** Whether `ran` did less than `step`: see the header. Reads only the simple commands running the step's own (program and verb). */
export function doesLess(step: string, ran: string): boolean {
  try {
    const s = String(step ?? '').trim();
    const r = String(ran ?? '').trim();
    if (HIDES_FAILURE.test(r) && !HIDES_FAILURE.test(s)) return true;
    const stepParts = simpleCommands(s);
    const progs = new Set(stepParts.map(head).filter(Boolean));
    const had = new Set(stepParts.flatMap(lessIn));
    return simpleCommands(r).filter((x) => progs.has(head(x))).flatMap(lessIn).some((f) => !had.has(f));
  } catch {
    return false;
  }
}

/** A call that can't be a step of its own for a fold: it hides its failure, or only rehearsed (`--dry-run`, `-n`). */
export function onlyRehearsed(ran: string): boolean {
  try {
    const r = String(ran ?? '').trim();
    return HIDES_FAILURE.test(r) || simpleCommands(r).flatMap(lessIn).some((f) => !/^--no-/i.test(f));
  } catch {
    return false;
  }
}
