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
 */
import grayMatter from "gray-matter";

export type FrontMatterFile = grayMatter.GrayMatterFile<string>;

const nothing = (): object => ({});
// gray-matter looks an engine up by the fence's own spelling, then by its alias.
const CODE_ENGINES = { js: nothing, javascript: nothing, coffee: nothing, coffeescript: nothing, cson: nothing };

/** gray-matter's parse with YAML only, and its `stringify`, which writes YAML. */
export const matter = Object.assign((text: string): FrontMatterFile => grayMatter(text, { engines: CODE_ENGINES }), {
  stringify: grayMatter.stringify,
});
