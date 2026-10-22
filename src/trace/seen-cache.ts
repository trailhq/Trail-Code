/**
 * D56d's `st.seen` (10 hex a key, the newest 6,000) as a Set, kept across
 * folds of the same state object. Init's replay folds one in-memory state
 * turn by turn, and parsing 6,000 hashes on every fold made a 10,000-turn
 * session take about 8 s (b5 review). A hook reads its state from disk each
 * time, so it parses once, as before.
 *
 * The kept set is always exactly the parse of `st.seen`: it is taken out of
 * the cache while a fold changes it (a fold that throws leaves none behind),
 * put back with the string it matches, and a `st.seen` changed any other way
 * is parsed again.
 */
const CACHE = new WeakMap<object, { seen: string; set: Set<string> }>();

const parse = (s: string, hex: number) => new Set(s.match(new RegExp(`.{${hex}}`, 'g')) ?? []);

/** The set of `st.seen`, for one fold to check and add to; give it back with keepSeen. */
export function takeSeenSet(st: { seen?: string }, hex: number): Set<string> {
  const s = st.seen ?? '';
  const c = CACHE.get(st);
  CACHE.delete(st);
  return c && c.seen === s ? c.set : parse(s, hex);
}

/** Whether `h` sits in `s` at a key's boundary. */
function holds(s: string, h: string, hex: number): boolean {
  for (let i = s.indexOf(h); i >= 0; i = s.indexOf(h, i + 1)) if (i % hex === 0) return true;
  return false;
}

/** Appends `fresh` to `st.seen` (the newest `max` kept) and keeps `set` for the next fold of this state. */
export function keepSeen(st: { seen?: string }, set: Set<string> | null, fresh: string[], hex: number, max: number): void {
  if (fresh.length) {
    const all = (st.seen ?? '') + fresh.join('');
    const cut = all.length > max * hex ? all.length - max * hex : 0;
    st.seen = cut ? all.slice(cut) : all;
    if (set && cut) for (let i = 0; i < cut; i += hex) {
      const h = all.slice(i, i + hex);
      if (!holds(st.seen, h, hex)) set.delete(h);
    }
  }
  const s = st.seen ?? '';
  if (set && s.length % hex === 0) CACHE.set(st, { seen: s, set });
}
