/**
 * The old spellings of renamed commands, still accepted.
 *
 * `graft brain …` became `graft trail …`, and `init --brain` became
 * `init --trail`, to match the product's name. The old ones are in docs, in
 * scripts, in shell history and on Trail pages already open in someone's
 * browser, so they keep working. They are rewritten before parsing rather than
 * registered as aliases, so help lists only the new names.
 */

/** Global options that take a value: their value is never the command. */
const VALUE_OPTIONS = new Set(["--dir", "--provider", "--model", "--api-key", "--base-url"]);

/** `process.argv` with the old spellings replaced by the new ones. */
export function withLegacyNames(argv: readonly string[]): string[] {
  const out = [...argv];
  // The command is the first word after the global options.
  for (let i = 2; i < out.length; i++) {
    const a = out[i]!;
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (VALUE_OPTIONS.has(a)) i++;
      continue;
    }
    if (a === "brain") out[i] = "trail";
    break;
  }
  return out.map((a) => (a === "--brain" ? "--trail" : a.startsWith("--brain=") ? `--trail=${a.slice("--brain=".length)}` : a));
}
