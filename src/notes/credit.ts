/**
 * How trail credits a learning in what an agent says: a token count short
 * enough to say aloud, or a faster PR when the count is too small to impress,
 * and the lines that close a reply after a team learning is saved.
 */
import type { Note } from "./notes.js";

/** `~9.6k tokens`, `~600 tokens`. */
export function tokensLabel(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k tokens`;
  return `~${n} tokens`;
}

/** `Anay`, `Anay and Rushil`, `Anay, Rushil and 3 others`. */
export function namesLabel(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** `48k`, `3.8k`, `600`. */
function tokensShort(n: number): string {
  return tokensLabel(n).replace(/^~/, "").replace(" tokens", "");
}

/** What starting from a teammate's learning is worth when its tokens are too few to say: time to a PR. */
export const PR_SPEEDUP = "3x faster";

/**
 * Below this many tokens, what a learning saves is too small a number to
 * impress, so trail credits it as a faster PR instead.
 */
export const TOKEN_CREDIT_FLOOR = 80_000;

/** Whether a token count is big enough to be the credit. */
export function tokensWorthSaying(tokens: number | undefined): boolean {
  return (tokens ?? 0) >= TOKEN_CREDIT_FLOOR;
}

/**
 * The lines that close a reply after a team learning is saved, one for each
 * way the turn can end, since only the agent knows whether it committed the
 * learning by then. Uncommitted, it makes the case for committing: who else
 * works on the same files, and the head start their agents would get, which
 * is what the learning took to work out, or a faster PR when that's small.
 */
export function commitLines(
  note: Pick<Note, "cost">,
  teammates: string[],
  where: "files" | "repo" = "files",
): { committed: string; uncommitted: string } {
  const tokens = note.cost?.tokens;
  const short = tokensWorthSaying(tokens) ? tokensShort(tokens!) : null;
  // "an 80k-token", "an 11k-token": said aloud, they start with a vowel.
  const start = short ? `${/^8|^1[18]k$/.test(short) ? "an" : "a"} ${short}-token head start` : null;
  const place = where === "files" ? "this part of the codebase" : "this repo";
  if (!teammates.length) {
    return start
      ? {
          committed: `📝 Committed · your teammates' agents now get ${start}`,
          uncommitted: `🌱 Commit what you learned and give your teammates' agents ${start}`,
        }
      : {
          committed: `📝 Committed · your teammates' agents now get to a PR ${PR_SPEEDUP}`,
          uncommitted: `🌱 Commit what you learned and your teammates' agents get to a PR ${PR_SPEEDUP}`,
        };
  }
  const who = namesLabel(teammates);
  const work = teammates.length === 1 ? "works" : "work";
  return start
    ? {
        committed: `📝 Committed · ${who} ${work} in ${place}, and their agents now get ${start}`,
        uncommitted: `🌱 ${who} ${work} in ${place}. Commit what you learned and give their agents ${start}`,
      }
    : {
        committed: `📝 Committed · ${who} ${work} in ${place}, and their agents now get to a PR ${PR_SPEEDUP}`,
        uncommitted: `🌱 ${who} ${work} in ${place}. Commit what you learned and their agents get to a PR ${PR_SPEEDUP}`,
      };
}

/**
 * The line asking for trail's shared setup to be committed, once: `.trail/`
 * and the SessionStart entry in `.claude/settings.json` are what let a
 * teammate's Claude read the learnings before they install anything.
 */
export function setupCommitLine(teammates: string[]): string {
  const ask = "Commit .trail/ and .claude/settings.json once";
  if (!teammates.length) return `🌱 ${ask}, and your teammates' Claude starts from your learnings, even before they install trail`;
  const work = teammates.length === 1 ? "works" : "work";
  return `🌱 ${namesLabel(teammates)} ${work} in this repo. ${ask}, and their Claude starts from your learnings, even before they install trail`;
}
