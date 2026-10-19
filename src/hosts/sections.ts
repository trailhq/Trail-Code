/**
 * Marker-fenced section upsert. Graft owns exactly the region between the
 * markers; everything else in the file belongs to the user and is preserved.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Brand } from '../brand.js';

export const START = '<!-- graft:start -->';
export const END = '<!-- graft:end -->';

/** The same block in a repo wired by trail. */
export const TRAIL_START = '<!-- trail:start -->';
export const TRAIL_END = '<!-- trail:end -->';

/**
 * A brain's rules go in their OWN fenced block, not inside the instruction
 * block above.
 *
 * They have to be separately addressable: the instruction body is static and
 * rewritten by `init`, while rules change whenever the brain does and are
 * refreshed on their own. One pair of markers for both would mean every rules
 * refresh rewrites the instructions too, and `graft uninstall` could not remove
 * one without the other.
 */
export const BRAIN_START = '<!-- graft:brain:start -->';
export const BRAIN_END = '<!-- graft:brain:end -->';

/** One addressable managed region in a file the user owns. */
export interface Markers {
  start: string;
  end: string;
}

export const GRAFT_MARKERS: Markers = { start: START, end: END };
export const TRAIL_MARKERS: Markers = { start: TRAIL_START, end: TRAIL_END };
export const BRAIN_MARKERS: Markers = { start: BRAIN_START, end: BRAIN_END };

/** Every managed region graft may own in a user-owned file. */
export const ALL_MARKERS: Markers[] = [GRAFT_MARKERS, TRAIL_MARKERS, BRAIN_MARKERS];

/** The instruction block's markers under each name. */
export function markersFor(name: Brand): Markers {
  return name === 'trail' ? TRAIL_MARKERS : GRAFT_MARKERS;
}

export type UpsertAction = 'created' | 'appended' | 'replaced' | 'unchanged';

type LineEnding = '\n' | '\r\n';

export function fencedBlock(body: string, eol: LineEnding = '\n', markers: Markers = GRAFT_MARKERS): string {
  // Normalize any pre-existing '\r' out of the body first so callers passing
  // a CRLF (or stray-CR) body never get doubled '\r' when eol is '\r\n'.
  const normalizedBody = body.replace(/\r/g, '');
  const block = `${markers.start}\n${normalizedBody.replace(/\s+$/, '')}\n${markers.end}`;
  return eol === '\n' ? block : block.replace(/\n/g, '\r\n');
}

/** The file's dominant line ending: CRLF if any '\r\n' is present, else LF. */
function detectEol(text: string): LineEnding {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Index of a marker that sits alone on its own line, or -1. */
function markerLineIndex(lines: string[], marker: string, from = 0): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() === marker) return i;
  }
  return -1;
}

interface Span {
  s: number;
  e: number;
}

/** The start and end line of the block fenced by `markers`, or null. */
function blockSpan(lines: string[], markers: Markers): Span | null {
  const s = markerLineIndex(lines, markers.start);
  const e = s === -1 ? -1 : markerLineIndex(lines, markers.end, s + 1);
  return s !== -1 && e !== -1 ? { s, e } : null;
}

/**
 * `lines` without the block at `sp`, and the blank line that set it off: the
 * one after it, or else the one before it. The file's final newline stays.
 */
function withoutBlock(lines: string[], sp: Span): string[] {
  const blank = (i: number) => i >= 0 && i < lines.length && lines[i].trim() === '';
  let { s, e } = sp;
  if (blank(e + 1) && e + 1 < lines.length - 1) e++;
  else if (blank(s - 1)) s--;
  return [...lines.slice(0, s), ...lines.slice(e + 1)];
}

/**
 * Write `body` into the block fenced by `markers`, keeping the rest of the file.
 *
 * `replaces` names blocks this one supersedes: a repo moving from graft's
 * names to trail's has a `graft:start` block where the `trail:start` one
 * goes. The block takes the place of its own markers if they're there, or of
 * the first superseded block, and any other superseded block goes, so the
 * file never ends up with both.
 */
export function upsertSection(filePath: string, body: string, markers: Markers = GRAFT_MARKERS, replaces: Markers[] = []): { action: UpsertAction } {
  if (!existsSync(filePath)) {
    const block = fencedBlock(body, '\n', markers);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${block}\n`);
    return { action: 'created' };
  }
  const text = readFileSync(filePath, 'utf8');
  const eol = detectEol(text);
  // Split on either eol so lines never carry an embedded '\r' — that keeps
  // the marker/content comparison clean and lets us rejoin deliberately with
  // the detected eol instead of relying on '\r' characters riding along
  // inside array elements (which broke down whenever the block-with-no-
  // trailing-'\r' element sat next to a '\n' join, e.g. right after END, or
  // when the block was the entire file).
  const lines = text.split(/\r\n|\n/);
  const s = markerLineIndex(lines, markers.start);
  const e = s === -1 ? -1 : markerLineIndex(lines, markers.end, s + 1);
  const superseded = replaces.map((m) => blockSpan(lines, m)).filter((sp): sp is Span => sp !== null);
  if (superseded.length > 0) {
    const own = s !== -1 && e !== -1 ? { s, e } : null;
    const at = own ?? superseded[0];
    // Bottom up, so the line numbers of the blocks above stay true.
    let next = lines;
    for (const sp of [...(own ? [own] : []), ...superseded].sort((a, b) => b.s - a.s)) {
      next = sp === at
        ? [...next.slice(0, sp.s), ...fencedBlock(body, '\n', markers).split('\n'), ...next.slice(sp.e + 1)]
        : withoutBlock(next, sp);
    }
    writeFileSync(filePath, next.join(eol));
    return { action: 'replaced' };
  }
  if (s !== -1 && e !== -1) {
    const current = lines.slice(s, e + 1).join('\n');
    if (current === fencedBlock(body, '\n', markers)) return { action: 'unchanged' };
    const block = fencedBlock(body, eol, markers);
    const next = [...lines.slice(0, s), ...block.split(eol), ...lines.slice(e + 1)];
    writeFileSync(filePath, next.join(eol));
    return { action: 'replaced' };
  }
  const block = fencedBlock(body, eol, markers);
  const doubleEol = eol + eol;
  const sep = text.endsWith(doubleEol) ? '' : text.endsWith(eol) ? eol : doubleEol;
  writeFileSync(filePath, `${text}${sep}${block}${eol}`);
  return { action: 'appended' };
}
