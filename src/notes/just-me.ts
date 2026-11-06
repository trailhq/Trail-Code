/**
 * Trail just for one person in a repo.
 *
 * `trail init` asks who trail is for in a repo whose team hasn't committed
 * `.trail/`, and enter picks the team. "Just me" means git sees nothing of
 * trail's there: `.trail/` goes in the clone's own `.git/info/exclude`,
 * `.claude/settings.json` is left out (the hooks in `~/.claude` run trail),
 * every learning is saved in ~/.trail, and nothing asks the person to commit
 * or share. `trail init --team` turns it off, and the person commits `.trail/`
 * then.
 *
 * The mark sits in the repo's folder in ~/.trail, so every clone and worktree
 * of the repo reads the same answer.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ensureRepoHome, repoPlace } from "./home.js";

const MARK = "just-me";

/** Trail is on in `dir`'s repo just for this person. Reads only; false outside git. */
export function isJustMe(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const place = repoPlace(dir, env);
    return place.git && existsSync(join(place.dir, MARK));
  } catch {
    return false;
  }
}

/** Mark `dir`'s repo as just for this person, or take the mark off. */
export function setJustMe(dir: string, on: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const mark = join(ensureRepoHome(dir, env).place.dir, MARK);
  if (on) writeFileSync(mark, "trail init: trail is just for you in this repo, so git sees none of it. trail init --team shares it with your team.\n");
  else rmSync(mark, { force: true });
}

/** What the session-start text tells the agent in a repo on trail just for this person. */
export const JUST_ME_DIRECTIVE =
  "Trail is on in this repo just for this user: git sees none of it, and every learning trail note saves stays with them in ~/.trail, never in .trail/learnings/. So never offer to commit or share a learning, and never check whether one is committed. If they ask to share with their team, the command is trail init --team.";

/**
 * `trail init`'s one question: true for just me, false for the team. Enter picks the team, because a learning only
 * reaches teammates once `.trail/` is committed; just me is one keypress away. Null when the input closed instead.
 */
export async function askJustMe(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stderr },
): Promise<boolean | null> {
  io.output.write("\nWho is trail for in this repo?\n");
  io.output.write("  1  my team: you commit .trail/ and .claude/settings.json once, and teammates' Claude reads your learnings\n");
  io.output.write("  2  just me: nothing in the repo changes, and your learnings stay in ~/.trail\n");
  const rl = createInterface({ input: io.input, output: io.output });
  // A question still waiting when the input ends never settles on its own.
  const closed = new Promise<null>((ok) => rl.once("close", () => ok(null)));
  try {
    for (;;) {
      const typed = await Promise.race([rl.question("1 or 2 (enter for 1): "), closed]);
      if (typed === null) return null;
      const answer = typed.trim();
      if (answer === "" || answer === "1") return false;
      if (answer === "2") return true;
    }
  } catch {
    return null;
  } finally {
    rl.close();
  }
}
