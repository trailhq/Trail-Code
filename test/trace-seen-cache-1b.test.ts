/**
 * The merge pass's fix for b5's replay cost: `foldEvents` parsed `st.seen` (up to 6,000 hashes) on every fold, so
 * init's replay, which folds one in-memory state turn by turn, took about 8 s for a 10,000-turn session. The parsed
 * set is now kept across folds of the same state object, and stays exactly the parse of `st.seen`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keepSeen, takeSeenSet } from '../src/trace/seen-cache.js';

const HEX = 10;
const MAX = 6000;
const h = (i: number) => createHash('sha256').update(`key-${i}`).digest('hex').slice(0, HEX);
const parse = (s: string) => new Set(s.match(/.{10}/g) ?? []);
const cpuMs = (fn: () => void) => {
  const a = process.cpuUsage();
  fn();
  const d = process.cpuUsage(a);
  return (d.user + d.system) / 1000;
};

/** One fold as runs.ts does it: take the set, check and add `keys`, keep what is new. */
function fold(st: { seen?: string }, keys: number[]): boolean[] {
  const set = takeSeenSet(st, HEX);
  const fresh: string[] = [];
  const out = keys.map((k) => {
    const x = h(k);
    if (set.has(x)) return true;
    set.add(x);
    fresh.push(x);
    return false;
  });
  keepSeen(st, set, fresh, HEX, MAX);
  return out;
}

test('the kept set is always exactly the parse of st.seen, through the 6,000 cap and its trims', () => {
  const st: { seen?: string } = {};
  let k = 0;
  for (let turn = 0; turn < 700; turn++) {
    const keys = [k++, k++, k++, k++, k++, k++, k++, k++, k++, k++];
    assert.deepEqual(fold(st, keys), keys.map(() => false));
    if (turn % 97 === 0) assert.deepEqual(fold(st, [k - 1, k - 3]), [true, true], 'the newest are still seen');
  }
  assert.equal(st.seen!.length, MAX * HEX);
  const set = takeSeenSet(st, HEX);
  assert.deepEqual([...set].sort(), [...parse(st.seen!)].sort());
  keepSeen(st, set, [], HEX, MAX);
  assert.deepEqual(fold(st, [0, k - 1]), [false, true], 'one trimmed off is new again, as a fresh parse says');
});

test('a state changed from outside (another hook wrote it, a hand edit) is parsed again, never the old set', () => {
  const st: { seen?: string } = {};
  fold(st, [1, 2, 3]);
  st.seen = h(7) + h(8);
  assert.deepEqual(fold(st, [1, 7]), [false, true]);
  const other: { seen?: string } = { seen: st.seen };
  assert.deepEqual(fold(other, [7, 9]), [true, false], 'another object parses its own');
});

test('a fold that throws after taking the set leaves no set behind that st.seen does not say', () => {
  const st: { seen?: string } = {};
  fold(st, [1]);
  const set = takeSeenSet(st, HEX);
  set.add(h(2));   // a fold took it, added a key, then threw before keepSeen
  assert.deepEqual(fold(st, [2]), [false], 'the next fold parses again');
});

test('10,000 folds on a full seen take a fraction of what parsing each time took', () => {
  const st: { seen?: string } = { seen: Array.from({ length: MAX }, (_, i) => h(1_000_000 + i)).join('') };
  const naive = cpuMs(() => { for (let i = 0; i < 2000; i++) parse(st.seen!); }) * 5;
  const kept = cpuMs(() => { for (let i = 0; i < 10_000; i++) fold(st, [i]); });
  assert.ok(kept * 4 < naive, `kept ${kept.toFixed(0)} ms vs parsing each fold about ${naive.toFixed(0)} ms of CPU`);
});
