/**
 * The fold-time secret rule: a secret given a name becomes `${NAME:?set NAME}`
 * so the step still runs; one that can't be named makes the whole command
 * unusable (stored as null). And `cleanLine`, which drops any one-line text
 * with a secret in it before it reaches a session file, a run sheet or a skill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLine, redactSecrets } from "../src/trace/redact.js";
import { secretReason } from "../src/notes/secrets.js";

// Made-up values in the shapes secretReason knows; none is a real key.
const NPM = "npm_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5";
const GH = "ghp_" + "Zx81Qw72Er63Ty54Ui45Op36As27Df18";
const RAW = "abc123XYZ789qwe456rty012uio345";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

test("a command with no secret is kept as it is", () => {
  assert.deepEqual(redactSecrets("npm test"), { cmd: "npm test" });
  assert.deepEqual(redactSecrets("NPM_TOKEN=$NPM_TOKEN npm publish"), { cmd: "NPM_TOKEN=$NPM_TOKEN npm publish" });
  assert.deepEqual(redactSecrets("git push origin 9c8b7a6:refs/heads/beta"), { cmd: "git push origin 9c8b7a6:refs/heads/beta" });
});

test("a secret assigned to a NAME becomes ${NAME:?set NAME}", () => {
  assert.deepEqual(redactSecrets(`NPM_TOKEN=${NPM} npm publish`), { cmd: "NPM_TOKEN=${NPM_TOKEN:?set NPM_TOKEN} npm publish", secret: "named" });
  assert.deepEqual(redactSecrets(`export API_KEY="sk-abc123def456ghi789jkl012" && node x.js`),
    { cmd: 'export API_KEY="${API_KEY:?set API_KEY}" && node x.js', secret: "named" });
  assert.deepEqual(redactSecrets(`NODE_ENV=production DB_PASSWORD=hunter2hunter2 node migrate.js`),
    { cmd: "NODE_ENV=production DB_PASSWORD=${DB_PASSWORD:?set DB_PASSWORD} node migrate.js", secret: "named" });
});

test("a secret after --token, --password, --api-key… takes the flag's name", () => {
  assert.deepEqual(redactSecrets(`gh auth login --token ${GH}`), { cmd: 'gh auth login --token "${TOKEN:?set TOKEN}"', secret: "named" });
  assert.deepEqual(redactSecrets(`deploy --api-key=sk-abc123def456ghi789jkl012 --env prod`),
    { cmd: 'deploy --api-key="${API_KEY:?set API_KEY}" --env prod', secret: "named" });
  assert.deepEqual(redactSecrets(`mysql --password '${RAW}' -e "select 1"`), { cmd: 'mysql --password "${PASSWORD:?set PASSWORD}" -e "select 1"', secret: "named" });
  // A flag that already reads a variable is left alone.
  assert.deepEqual(redactSecrets('gh auth login --token "$GH_TOKEN"'), { cmd: 'gh auth login --token "$GH_TOKEN"' });
});

test("a Bearer token is named only through an earlier assignment; otherwise the command is refused", () => {
  assert.deepEqual(redactSecrets(`curl -H "Authorization: Bearer ${JWT}" https://api.example.com/x`), { cmd: null, secret: "refused" });
  assert.deepEqual(redactSecrets(`TOKEN=${RAW} curl -H "Authorization: Bearer ${RAW}" https://api.example.com/x`), {
    cmd: 'TOKEN=${TOKEN:?set TOKEN} curl -H "Authorization: Bearer ${TOKEN:?set TOKEN}" https://api.example.com/x',
    secret: "named",
  });
});

test("whatever is still secret after naming refuses the whole command", () => {
  const two = `NPM_TOKEN=${NPM} curl https://maps.example.com/api?key=${"AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"}`;
  assert.notEqual(secretReason(two), null);
  assert.deepEqual(redactSecrets(two), { cmd: null, secret: "refused" });
  assert.deepEqual(redactSecrets(`echo ${GH} | gh auth login --with-token`), { cmd: null, secret: "refused" });
  for (const cmd of [`NPM_TOKEN=${NPM} npm publish`, `gh auth login --token ${GH}`]) {
    const out = redactSecrets(cmd);
    assert.equal(secretReason(out.cmd ?? ""), null, "a named command passes the check again");
  }
});

test("cleanLine: one flat line, or nothing when a secret is anywhere in the text", () => {
  assert.equal(cleanLine("fatal: could not read\nUsername", 160), "fatal: could not read Username");
  assert.equal(cleanLine("[trail] run this", 160), "run this");
  assert.equal(cleanLine(`remote: token ${GH} rejected`, 160), undefined);
  // Cut short, the key would no longer look like one: the whole text is checked.
  assert.equal(cleanLine(`${"x ".repeat(75)}${GH}`, 160), undefined);
  assert.equal(cleanLine("a".repeat(300), 200)!.length, 200);
  assert.equal(cleanLine("", 160), "");
});

test("a named secret stops where the shell word stops: ; && | stay, and the command keeps its meaning", () => {
  assert.deepEqual(redactSecrets(`export GH_TOKEN=${GH}; gh pr list`), { cmd: "export GH_TOKEN=${GH_TOKEN:?set GH_TOKEN}; gh pr list", secret: "named" });
  assert.deepEqual(redactSecrets(`API_KEY=${RAW};npm publish`), { cmd: "API_KEY=${API_KEY:?set API_KEY};npm publish", secret: "named" });
  assert.deepEqual(redactSecrets(`NPM_TOKEN=${NPM}&&npm publish`), { cmd: "NPM_TOKEN=${NPM_TOKEN:?set NPM_TOKEN}&&npm publish", secret: "named" });
  assert.deepEqual(redactSecrets(`npm publish --token=${NPM};echo done`), { cmd: 'npm publish --token="${TOKEN:?set TOKEN}";echo done', secret: "named" });
  assert.deepEqual(redactSecrets(`npm publish --token ${NPM}|tee log`), { cmd: 'npm publish --token "${TOKEN:?set TOKEN}"|tee log', secret: "named" });
  // Inside double quotes a ; is part of the value.
  assert.deepEqual(redactSecrets(`API_KEY="${RAW};x" node a.js`), { cmd: 'API_KEY="${API_KEY:?set API_KEY}" node a.js', secret: "named" });
});

test("a placeholder always expands: single quotes become double quotes", () => {
  assert.deepEqual(redactSecrets(`NPM_TOKEN='${NPM}' npm publish`), { cmd: 'NPM_TOKEN="${NPM_TOKEN:?set NPM_TOKEN}" npm publish', secret: "named" });
  assert.deepEqual(redactSecrets(`TOKEN=${RAW}; curl -H "Authorization: Bearer ${RAW}" https://api.example.test/x`),
    { cmd: 'TOKEN=${TOKEN:?set TOKEN}; curl -H "Authorization: Bearer ${TOKEN:?set TOKEN}" https://api.example.test/x', secret: "named" });
});

test("a command over 2,000 characters is never compiled, so it is not scanned: stored as null", () => {
  // The secret check is slow on long runs of word characters (seconds at 40 KB); a hook can't wait for it.
  for (const [label, long] of [["dots", `echo ${"a.".repeat(20_000)}`], ["hex", `echo ${"0123456789abcdef".repeat(2_500)}`], ["named", `NPM_TOKEN=${NPM} ${"x ".repeat(1_100)}`]]) {
    const t0 = performance.now();
    const got = redactSecrets(long!);
    assert.equal(got.cmd, null, label);
    assert.equal(got.secret, "refused", label);
    assert.ok(performance.now() - t0 < 50, label);
  }
  const edge = `echo ${"y".repeat(1_995)}`;
  assert.equal(edge.length, 2_000);
  assert.deepEqual(redactSecrets(edge), { cmd: edge });
});
