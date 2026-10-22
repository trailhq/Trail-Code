/**
 * Parameters in a skill's steps (design 4.5 step 10).
 *
 * A step copied from a run carries last time's values: the version it
 * published, the commit it pushed, the PR it merged, the port the server ran
 * on. Replayed as they are, they would publish the old version again or push
 * an old commit. So values of a known shape become `{name}`, every occurrence
 * of one value under one name, in this order: version, sha, pr, port, branch,
 * date. A sha defaults to `$(git rev-parse HEAD)` (when it is the only one) and a date to today; a port
 * or a branch defaults to the value seen; a version and a PR come from the ask.
 * With the last run of the same job beside this one, a token that differed
 * between the two (the package a test run named) becomes a parameter too.
 *
 * Pure: no files, no clock.
 */
import type { PromptParams } from '../trace/types.js';
import type { ParamDef } from './types.js';
import { programOf } from '../trace/shell.js';
import { secretReason } from '../notes/secrets.js';

export const STABLE_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'beta', 'prod', 'production', 'dev', 'develop', 'staging', 'trunk']);

type Shape = Exclude<ParamDef['shape'], 'varied'>;
type Hit = { s: number; e: number; v: string };

const SHA_TOKEN = /^[0-9a-f]{7,40}$/;
const isSha = (t: string) => SHA_TOKEN.test(t) && /\d/.test(t) && /[a-f]/.test(t);
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME = /^[A-Za-z_]\w*$/;

/** Every match of `re`, as the span of its last group. */
function groupHits(text: string, re: RegExp, keep: (v: string, at: number) => boolean = () => true): Hit[] {
  const out: Hit[] = [];
  for (const m of text.matchAll(re)) {
    const v = m[m.length - 1];
    if (v === undefined) continue;
    const s = m.index! + m[0].length - v.length;
    if (keep(v, s)) out.push({ s, e: s + v.length, v });
  }
  return out;
}

const VERSION = /(?<![\w.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.(?!tgz\b)[0-9A-Za-z-]+)*)?)(?![\w-]|\.\d)/g;
const INSTALL = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|i|install)|yarn\s+(?:global\s+)?add|bun\s+add)\b/;

function versionHits(text: string): Hit[] {
  return groupHits(text, VERSION, (_v, s) => {
    const before = text.slice(0, s).replace(/v$/, '');
    if (/(?:^|[^\w-])(?:node|python|go)@$/.test(before) || /\bnvm\s+(?:use|install)\s+$/.test(before)) return false;
    if (!before.endsWith('@')) return true;
    const simple = before.split(/&&|\|\||[;|\n(]/).pop() ?? '';
    return !INSTALL.test(simple);
  });
}

function shaHits(text: string): Hit[] {
  const out: Hit[] = [];
  const add = (v: string, s: number) => { if (isSha(v)) out.push({ s, e: s + v.length, v }); };
  for (const h of groupHits(text, /(?<![0-9A-Za-z])([0-9a-f]{7,40}):refs\//g)) add(h.v, h.s);
  for (const h of groupHits(text, /\bgit\s+push\b[^;&|\n]*?\s\+?([0-9a-f]{7,40}):/g)) add(h.v, h.s);
  for (const h of groupHits(text, /\bcommits\/([0-9a-f]{7,40})(?![0-9A-Za-z])/g)) add(h.v, h.s);
  for (const m of text.matchAll(/\bmerge-base\s+--is-ancestor\s+(\S+)\s+(\S+)/dg)) {
    add(m[1]!, m.indices![1]![0]);
    add(m[2]!, m.indices![2]![0]);
  }
  const verbs = /\bgit(?:\s+-[Cc]\s+\S+|\s+--[\w-]+=\S+)*\s+(?:checkout|switch|reset|show|revert|cherry-pick|tag|merge|rebase|branch|worktree\s+add|update-ref|format-patch|bisect\s+(?:start|good|bad)|restore)\b([^;&|\n]*)/g;
  for (const m of text.matchAll(verbs)) {
    const base = m.index! + m[0].length - m[1]!.length;
    for (const t of m[1]!.matchAll(/(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/g)) add(t[0], base + t.index!);
  }
  // A full 40-hex commit anywhere (a CI link, an API query) is a commit.
  for (const t of text.matchAll(/(?<![0-9A-Za-z])[0-9a-f]{40}(?![0-9A-Za-z])/g)) add(t[0], t.index!);
  return out.filter((h, i) => out.findIndex((x) => x.s === h.s) === i);
}

const PR_CONTEXTS = [/(\bgh\s+pr\s+(?:view|checks|merge|diff|ready|edit|close|checkout|reopen|comment|review|update-branch|lock|unlock)\s+#?)(\d+)\b/g, /(\/pulls?\/)(\d+)\b/g];
const PORT_CONTEXTS = [
  /(\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):)(\d{2,5})\b/g,
  /(--port[= ])(\d{2,5})\b/g,
  /(\bPORT=)(\d{2,5})\b/g,
  /(\b(?:next\s+(?:dev|start)|vite(?:\s+preview)?|serve|http-server)\b[^;&|\n]*?\s-p\s?)(\d{2,5})\b/g,
  /(\blsof\b[^;&|\n]*?:)(\d{2,5})\b/g,
  /(\bhttp\.server\s+)(\d{2,5})\b/g,
];
const BRANCH_CONTEXTS = [/(refs\/heads\/)([\w./-]+)/g, /(\bgit\s+(?:checkout|switch)\s+-[bcB]\s+)([\w./-]+)/g, /(\bgit\s+push\s+-u\s+\S+\s+)([\w./-]+)/g];
const DATE = /\b(20\d\d-\d\d-\d\d)\b/g;

const contextHits = (text: string, res: RegExp[], keep?: (v: string) => boolean) =>
  res.flatMap((re) => groupHits(text, re, keep ? (v) => keep(v) : undefined));

const SHAPES: Array<{ shape: Shape; hits: (t: string) => Hit[]; everywhere?: (v: string) => RegExp | null; def?: (v: string) => string }> = [
  // A version the run named elsewhere is the same param in an install pin too (the release, installed to try it).
  { shape: 'version', hits: versionHits, everywhere: (v) => new RegExp(`(?<=@)${escapeRe(v)}(?![\\w-]|\\.\\d)`, 'g') },
  { shape: 'sha', hits: shaHits, everywhere: (v) => new RegExp(`(?<![0-9A-Za-z])${v}(?![0-9A-Za-z])`, 'g'), def: () => '$(git rev-parse HEAD)' },
  { shape: 'pr', hits: (t) => contextHits(t, PR_CONTEXTS) },
  { shape: 'port', hits: (t) => contextHits(t, PORT_CONTEXTS), def: (v) => v },
  {
    shape: 'branch',
    hits: (t) => contextHits(t, BRANCH_CONTEXTS, (v) => !STABLE_BRANCHES.has(v) && !isSha(v) && /[A-Za-z]/.test(v)),
    everywhere: (v) => (/[/_-]/.test(v) ? new RegExp(`(?<![\\w./-])${escapeRe(v)}(?![\\w./-])`, 'g') : null),
    def: (v) => v,
  },
  { shape: 'date', hits: (t) => groupHits(t, DATE), everywhere: (v) => new RegExp(`\\b${escapeRe(v)}\\b`, 'g'), def: () => '$(date +%F)' },
];

const nextName = (base: string, used: Set<string>) => {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
};

/** Replace spans (no overlaps kept, earliest wins) with their placeholders. */
function replaceSpans(text: string, spans: Array<{ s: number; e: number; to: string }>): string {
  const sorted = [...spans].sort((a, b) => a.s - b.s || b.e - a.e);
  let out = '';
  let at = 0;
  for (const sp of sorted) {
    if (sp.s < at) continue;
    out += text.slice(at, sp.s) + sp.to;
    at = sp.e;
  }
  return out + text.slice(at);
}

/** One shape over every text: names by first appearance, then every hit (and, where safe, every occurrence) replaced. */
function applyShape(texts: string[], spec: (typeof SHAPES)[number], prompt: PromptParams, used: Set<string>, defs: ParamDef[]): string[] {
  const hits = texts.map((t) => spec.hits(t).filter((h) => !h.v.includes('{')));
  const values: string[] = [];
  for (const list of hits) for (const h of [...list].sort((a, b) => a.s - b.s)) if (!values.includes(h.v)) values.push(h.v);
  if (!values.length) return texts;
  const names = new Map<string, string>();
  const typed = spec.shape === 'version' ? prompt.version : undefined;
  const order = typed && values.includes(typed) ? [typed, ...values.filter((v) => v !== typed)] : values;
  for (const v of order) {
    const n = nextName(spec.shape, used);
    used.add(n);
    names.set(v, n);
  }
  for (const v of order) {
    const d: ParamDef = { name: names.get(v)!, shape: spec.shape, seen: [v] };
    // Two different commits can't both be HEAD: then no sha has a default, and the agent fills each from the ask.
    const def = spec.shape === 'sha' && order.length > 1 ? undefined : spec.def?.(v);
    defs.push(def === undefined ? d : { name: d.name, shape: d.shape, default: def, seen: d.seen });
  }
  return texts.map((t, i) => {
    const spans = hits[i]!.map((h) => ({ s: h.s, e: h.e, to: `{${names.get(h.v)!}}` }));
    for (const v of values) {
      const re = spec.everywhere?.(v);
      if (!re) continue;
      for (const m of t.matchAll(re)) spans.push({ s: m.index!, e: m.index! + m[0].length, to: `{${names.get(v)!}}` });
    }
    return replaceSpans(t, spans);
  });
}

const SEP = new Set(['/', '=', ':', '@', ',', '.', '-', '_', '"', "'"]);
const SHAPE_NAMES = new Set(['version', 'sha', 'pr', 'port', 'branch', 'date']);
const tokensOf = (cmd: string) => cmd.split(/(\s+)/);

/** The differing middle of two tokens, cut at separators: `./internal/workflow/...` vs `./internal/quickbooks/...` -> workflow. */
function middle(a: string, b: string): { pre: string; mid: string; post: string; other: string } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (p > 0 && !SEP.has(a[p - 1]!)) p--;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  while (s > 0 && !SEP.has(a[a.length - s]!)) s--;
  if (p + s >= a.length || p + s >= b.length) return { pre: '', mid: a, post: '', other: b };
  return { pre: a.slice(0, p), mid: a.slice(p, a.length - s), post: a.slice(a.length - s), other: b.slice(p, b.length - s) };
}

/** 4.5 step 10, `varied`: align by program and order; a pair that differs in 1 or 2 tokens (not already params) gives params. */
function applyVaried(cmds: string[], check: string | undefined, prior: string[], used: Set<string>, defs: ParamDef[]): { cmds: string[]; check: string | undefined } {
  const swaps = new Map<string, string>();
  let args = 0;
  let j = 0;
  for (const cmd of cmds) {
    const prog = programOf(cmd);
    let k = j;
    while (k < prior.length && programOf(prior[k]!) !== prog) k++;
    if (k >= prior.length) continue;
    j = k + 1;
    const a = tokensOf(cmd);
    const b = tokensOf(prior[k]!);
    if (a.length !== b.length) continue;
    const diff: number[] = [];
    for (let t = 0; t < a.length; t += 2) if (a[t] !== b[t] && !a[t]!.includes('{') && !b[t]!.includes('{')) diff.push(t);
    if (diff.length < 1 || diff.length > 2) continue;
    for (const t of diff) {
      if (swaps.has(a[t]!)) continue;
      // A different flag is a different command, not a value.
      if (/^-/.test(a[t]!) && !a[t]!.includes('=')) continue;
      // The shell around a word (a subshell's `)`, quotes, a `;`) stays outside the param.
      const wa = /^([("']*)([\s\S]*?)([)"';]*)$/.exec(a[t]!)!;
      const wb = /^([("']*)([\s\S]*?)([)"';]*)$/.exec(b[t]!)!;
      if (wa[1] !== wb[1] || wa[3] !== wb[3]) continue;
      const m = middle(wa[2]!, wb[2]!);
      const [pre, mid, post, other] = [wa[1] + m.pre, m.mid, m.post + wa[3], m.other];
      if (!mid || /[()`$;|&<>"']/.test(mid) || secretReason(mid) !== null) continue;
      const prev = t >= 2 ? a[t - 2]! : '';
      const inToken = /^-{1,2}([A-Za-z][\w-]*)=$/.exec(pre)?.[1];
      const flag = !pre.replace(/["']/g, '') && /^-{1,2}[A-Za-z][\w-]*$/.test(prev) ? prev.replace(/^-+/, '') : undefined;
      let base = inToken ?? (/(?:^|\/)(?:internal|packages|apps|services|cmd)\/$/.test(pre) ? 'pkg' : flag);
      base = base?.toLowerCase().replace(/-/g, '_');
      if (!base || !NAME.test(base) || SHAPE_NAMES.has(base)) base = `arg${++args}`;
      const name = nextName(base, used);
      used.add(name);
      defs.push({ name, shape: 'varied', default: mid, seen: [mid, other] });
      swaps.set(a[t]!, `${pre}{${name}}${post}`);
    }
  }
  const swap = (text: string) => tokensOf(text).map((tok, i) => (i % 2 === 0 && swaps.has(tok) ? swaps.get(tok)! : tok)).join('');
  return { cmds: cmds.map(swap), check: check === undefined ? undefined : swap(check) };
}

/** Finds shape and varied tokens in kept commands, replaces them with {name}, returns defs (4.5 step 10). */
export function findParams(cmds: string[], ctx: { prompt: PromptParams; prior?: string[] | null; check?: string }): { cmds: string[]; check?: string; params: ParamDef[] } {
  const hasCheck = ctx.check !== undefined;
  let texts = [...cmds.map(String), ...(hasCheck ? [String(ctx.check)] : [])];
  const used = new Set<string>();
  const defs: ParamDef[] = [];
  for (const spec of SHAPES) texts = applyShape(texts, spec, ctx.prompt ?? {}, used, defs);
  let out = { cmds: texts.slice(0, cmds.length), check: hasCheck ? texts[cmds.length] : undefined };
  if (ctx.prior?.length) {
    const prior = findParams(ctx.prior, { prompt: ctx.prompt ?? {} }).cmds;
    out = applyVaried(out.cmds, out.check, prior, used, defs);
  }
  return hasCheck ? { cmds: out.cmds, check: out.check, params: defs } : { cmds: out.cmds, params: defs };
}

/** Unknown {x} left as is. */
export function fillParams(text: string, values: Record<string, string>): string {
  return String(text ?? '').replace(/\{([A-Za-z_]\w*)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? values[k]! : m));
}

/** Values for a run block: prompt shapes first, then defaults, then last seen (with a note). */
export function resolveParams(defs: ParamDef[], prompt: PromptParams): { values: Record<string, string>; notes: string[] } {
  const values: Record<string, string> = {};
  const notes: string[] = [];
  for (const d of defs) {
    const typed = (prompt as Record<string, string | undefined>)[d.name];
    if (d.shape !== 'varied' && d.name === d.shape && typed) {
      values[d.name] = typed;
      notes.push(`{${d.name}} is ${typed}, from the ask.`);
    } else if (d.default !== undefined && d.default.startsWith('$(')) {
      values[d.name] = d.default;
    } else {
      const v = d.default ?? d.seen[0];
      if (v === undefined || v === '') continue;
      values[d.name] = v;
      notes.push(`{${d.name}} is ${v}, as last time; change it if the ask names another.`);
    }
  }
  return { values, notes };
}

/** 'version, sha=$(git rev-parse HEAD), pkg=workflow'. */
export function paramsToMeta(defs: ParamDef[]): string {
  return defs.map((d) => (d.default === undefined ? d.name : `${d.name}=${d.default}`)).join(', ');
}

export function metaToParams(s: string | undefined): ParamDef[] {
  if (typeof s !== 'string' || !s.trim()) return [];
  const out: ParamDef[] = [];
  for (const part of s.split(/,\s+/)) {
    const eq = part.indexOf('=');
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (!NAME.test(name) || out.some((d) => d.name === name)) continue;
    const base = name.replace(/_\d+$/, '');
    const shape: ParamDef['shape'] = SHAPE_NAMES.has(base) ? (base as Shape) : 'varied';
    out.push(eq < 0 ? { name, shape, seen: [] } : { name, shape, default: part.slice(eq + 1).trim(), seen: [] });
  }
  return out;
}
