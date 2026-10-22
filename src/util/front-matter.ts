/**
 * Front matter, YAML only.
 *
 * gray-matter picks its parser from the opening fence: `---js` or
 * `---javascript` front matter is run through `eval`. Every file read here
 * comes from a repo — a learning committed by a teammate or sitting on their
 * pushed branch, a skill, a graft/ card — so a file that opened with `---js`
 * would run its code on whoever reads it. Here those fences parse as empty
 * front matter instead: nothing runs, and the file reads as having none (a
 * learning without a title, a card without a slug), which every caller
 * already skips.
 *
 * YAML anchors and aliases are refused the same way. An alias is a reference,
 * so a few hundred bytes of nested ones (`b: &b [*a,*a,*a,...]`, nine deep)
 * parse at once and then become hundreds of millions of strings the moment
 * anything reads the value as text: seconds and gigabytes per read, then a
 * crash. Nothing trail writes has one (`stringify` writes with `noRefs`), so a
 * file that does reads as having no front matter, with `refused` saying why.
 * So does a list or a map under a key the caller names in `scalars`, where
 * one value belongs.
 */
import grayMatter from "gray-matter";

export type FrontMatterFile = grayMatter.GrayMatterFile<string> & {
  /** Why the front matter wasn't read, when it wasn't. `data` is then `{}`. */
  refused?: string;
};

export interface FrontMatterOptions {
  /** Keys that hold one value each (text, a number, true/false, a date), when present. */
  scalars?: readonly string[];
}

const nothing = (): object => ({});
// gray-matter looks an engine up by the fence's own spelling, then by its alias.
const CODE_ENGINES = { js: nothing, javascript: nothing, coffee: nothing, coffeescript: nothing, cson: nothing };

const NO_REFS = "YAML anchors and aliases aren't read";

/** Thrown from inside the YAML reader to stop it at the first anchor or alias. */
class Refused extends Error {}

/** A stand-in for js-yaml's table of anchors: naming an anchor, or looking one up for an alias, stops the read. */
const NO_ANCHORS: ProxyHandler<object> = {
  set: () => { throw new Refused(NO_REFS); },
  defineProperty: () => { throw new Refused(NO_REFS); },
  getOwnPropertyDescriptor: () => { throw new Refused(NO_REFS); },
  has: () => { throw new Refused(NO_REFS); },
};
const guarded = new WeakSet<object>();

/**
 * js-yaml calls this as it opens and closes each node; gray-matter hands its
 * options on to it. Each document gets a fresh anchor table, swapped for one
 * that refuses on the document's first node, before any anchor can be read.
 */
function listener(event: string, state: { anchorMap?: object; anchor?: string | null }): void {
  if (event === "open" && state.anchorMap && !guarded.has(state.anchorMap)) {
    state.anchorMap = new Proxy({}, NO_ANCHORS);
    guarded.add(state.anchorMap);
  }
  // Should js-yaml ever keep anchors somewhere else: a node closing with one still stops the read.
  if (event === "close" && state.anchor) throw new Refused(NO_REFS);
}

const READ = { engines: CODE_ENGINES, listener };
const UNREAD = { engines: { ...CODE_ENGINES, yaml: nothing, json: nothing } };
// `noRefs` reaches js-yaml's dump through gray-matter: an object used twice is written out twice, never as an alias.
const WRITE = { language: "yaml", noRefs: true };

function isScalar(v: unknown): boolean {
  return v === undefined || v === null || ["string", "number", "boolean"].includes(typeof v) || v instanceof Date;
}

/** The file with its front matter left unread: the body as usual, `data` empty, and why. */
function refuse(text: string, why: string): FrontMatterFile {
  return Object.assign(grayMatter(text, UNREAD), { data: {}, refused: why });
}

/** gray-matter's parse with YAML only, no anchors or aliases, and its `stringify`, which writes YAML. */
export const matter = Object.assign(
  (text: string, opts: FrontMatterOptions = {}): FrontMatterFile => {
    let file: FrontMatterFile;
    try {
      file = grayMatter(text, READ);
    } catch (e) {
      if (e instanceof Refused) return refuse(text, e.message);
      throw e;
    }
    const listed = opts.scalars?.find((k) => !isScalar(file.data[k]));
    return listed ? refuse(text, `${listed} holds a list or a map where one value belongs`) : file;
  },
  {
    stringify: (content: string, data: object): string => grayMatter.stringify(content, data, WRITE),
  },
);

/**
 * The strings in `value` that fit on one line in at most `maxChars`, the
 * first `max` of them. Anything else in the list is dropped; a value that
 * isn't a list gives none.
 */
export function textList(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (out.length >= max) break;
    if (typeof v === "string" && v && v.length <= maxChars && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) out.push(v);
  }
  return out;
}

const warned = new Set<string>();

/**
 * Say once per process, on stderr, that `what` was skipped and why: one bad
 * file costs only itself, and whoever runs the command can find it.
 */
export function warnSkipped(what: string, place: string, why: string): void {
  const key = `${what}\u0000${place}`;
  if (warned.has(key)) return;
  warned.add(key);
  try {
    process.stderr.write(`⚠ skipped ${what} in ${JSON.stringify(place)}: ${why.replace(/\s+/g, " ").slice(0, 200)}\n`);
  } catch {
    /* nowhere to say it */
  }
}
