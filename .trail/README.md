# .trail

What coding sessions on this repo worked out, kept next to the code so the
next session, yours or a teammate's, starts from it instead of digging again.

- learnings/   one file per learning someone asked their agent to save: what
               was decided, what was tried and ruled out, and what to watch
               out for, plus what it took to work out
- hook.cjs     what Claude Code runs at session start (`.claude/settings.json`).
               With trail installed it hands over to trail. Without it, it
               shows Claude these learnings and offers to set trail up.

Commit this folder and `.claude/settings.json` once. After that, commit new
learnings with the change they came from. Learnings are short summaries, never
transcripts, and plain markdown without trail installed. What
`.trail/.gitignore` lists stays on each machine.
