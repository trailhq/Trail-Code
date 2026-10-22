/** A made-up checkout's `.git` shaped like a clone on its one remote's default branch, at the commit last fetched (c4 review). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLONE_OID = "a".repeat(40);

export function cloneShape(checkout: string, o: { branch?: string; head?: string; remotes?: string[]; oid?: string; fetched?: string } = {}): void {
  const g = join(checkout, ".git");
  const branch = o.branch ?? "main";
  mkdirSync(join(g, "refs", "heads"), { recursive: true });
  writeFileSync(join(g, "HEAD"), `ref: refs/heads/${o.head ?? branch}\n`);
  writeFileSync(join(g, "config"), (o.remotes ?? ["origin"]).map((r) => `[remote "${r}"]\n\turl = https://github.com/acme/${r}-shop.git\n`).join(""));
  writeFileSync(join(g, "refs", "heads", o.head ?? branch), `${o.oid ?? CLONE_OID}\n`);
  for (const r of o.remotes ?? ["origin"]) {
    mkdirSync(join(g, "refs", "remotes", r), { recursive: true });
    writeFileSync(join(g, "refs", "remotes", r, branch), `${o.fetched ?? CLONE_OID}\n`);
    writeFileSync(join(g, "refs", "remotes", r, "HEAD"), `ref: refs/remotes/${r}/${branch}\n`);
  }
}
