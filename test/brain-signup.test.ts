/**
 * The terminal half of signing up for a brain.
 *
 * Two of these are security-relevant rather than merely correct. The listener
 * must refuse a handoff that does not echo the state it generated, because it
 * is an open port on the developer's machine and any page they have open can
 * reach loopback. And it must bind to loopback only, so the handoff is not
 * offered to the network the laptop is sitting on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALLBACK_PATH, claimSignup, newSignupState, signupUrl, startHandoff, waitForSignup } from "../src/brain/signup.js";
import { clearPendingSignup, readPendingSignup, writePendingSignup } from "../src/brain/link.js";

/** Drive the callback the way the browser would. */
async function callback(port: number, q: Record<string, string>): Promise<number> {
  const url = `http://127.0.0.1:${port}${CALLBACK_PATH}?${new URLSearchParams(q).toString()}`;
  const res = await fetch(url);
  await res.text();
  return res.status;
}

test("handoff: the browser's answer becomes the link", async () => {
  const h = await startHandoff();
  const waiting = h.wait(5000);

  const status = await callback(h.port, { state: h.state, brain: "brain-123", token: "gbt_1.abc" });
  assert.equal(status, 200);

  const got = await waiting;
  assert.deepEqual(got, { link: { brainId: "brain-123", token: "gbt_1.abc" } });
});

test("handoff: a wrong state is refused and never settles the wait", async () => {
  const h = await startHandoff();
  const waiting = h.wait(300);

  const status = await callback(h.port, { state: "not-the-state", brain: "brain-123", token: "gbt_1.abc" });
  assert.equal(status, 400, "a mismatched state is rejected outright");

  const got = await waiting;
  assert.ok("error" in got, "the push must not proceed on a handoff it did not ask for");
});

test("handoff: the right state without a brain and token is an error, not a link", async () => {
  const h = await startHandoff();
  const waiting = h.wait(5000);

  const status = await callback(h.port, { state: h.state, brain: "", token: "" });
  assert.equal(status, 400);

  const got = await waiting;
  assert.ok("error" in got);
});

test("handoff: anything but the callback path is a 404", async () => {
  const h = await startHandoff();
  const res = await fetch(`http://127.0.0.1:${h.port}/`);
  await res.text();
  assert.equal(res.status, 404);
  h.close();
});

test("handoff: the wait gives up rather than hanging forever", async () => {
  const h = await startHandoff();
  const got = await h.wait(150);
  assert.ok("error" in got);
  assert.match((got as { error: string }).error, /no sign-up after .* · nothing was sent — run graft trail push again/);
});

test("signup url: carries the repo, the port and the state", () => {
  const url = new URL(signupUrl({ repo: "NanoNets/Graft", port: 51234, state: "s-t-a-t-e" }));
  // Trail's front end, not the shared agents host link.ts calls for the API:
  // the signup a person walks through has to be the Trail-branded build.
  assert.equal(url.origin, "https://app.trailhq.com");
  assert.equal(url.pathname, "/get-started");
  assert.equal(url.searchParams.get("graft_repo"), "NanoNets/Graft");
  assert.equal(url.searchParams.get("graft_port"), "51234");
  assert.equal(url.searchParams.get("graft_state"), "s-t-a-t-e");
  assert.equal(url.searchParams.get("step"), "repo");
});

test("signup url: GRAFT_BRAIN_URL points signup at staging too", () => {
  const before = process.env.GRAFT_BRAIN_URL;
  process.env.GRAFT_BRAIN_URL = "https://staging-agents.nanonets.com/";
  try {
    const url = new URL(signupUrl({ repo: "a/b", port: 1, state: "s" }));
    assert.equal(url.origin, "https://staging-agents.nanonets.com", "a trailing slash must not double up");
  } finally {
    if (before === undefined) delete process.env.GRAFT_BRAIN_URL;
    else process.env.GRAFT_BRAIN_URL = before;
  }
});

// The browser's last stop is Trail, not a local page that is about to stop
// answering. Ending on "go back to your terminal" wasted the one moment the
// brain is actually being built and there is something on screen worth seeing.
//
// And specifically the BUILD screen, not `/brain/<id>`, which is where this went
// first: that route redirects to the brain's graph the instant the row exists,
// which is minutes before it holds a single rule. So every terminal signup was
// landing on an empty visualisation of a brain that was building perfectly well.
test('the accepted handoff sends the browser to the build screen, not an empty graph', async () => {
  process.env.GRAFT_BRAIN_URL = 'http://localhost:5173';
  const handoff = await startHandoff();
  try {
    const res = await fetch(
      `http://127.0.0.1:${handoff.port}${CALLBACK_PATH}?state=${encodeURIComponent(handoff.state)}&brain=abc-123&token=gbt_1.xyz`,
      { redirect: 'manual' },
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'http://localhost:5173/get-started?step=build&brain=abc-123');
    const got = await handoff.wait(1000);
    assert.deepEqual(got, { link: { brainId: 'abc-123', token: 'gbt_1.xyz' } });
  } finally {
    handoff.close();
    delete process.env.GRAFT_BRAIN_URL;
  }
});

// --- signing up when an agent runs the push ---

/** A fetch that answers each call with the next status in `script`. */
function scripted(script: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { impl, calls };
}

test("agent signup: the link carries no port, because nothing is listening", () => {
  const url = new URL(signupUrl({ repo: "acme/app", state: "st", baseUrl: "https://trail.example" }));
  assert.equal(url.searchParams.get("graft_port"), null);
  assert.equal(url.searchParams.get("graft_repo"), "acme/app");
  assert.equal(url.searchParams.get("graft_state"), "st");
});

test("agent signup: a fresh state is long enough for Trail to accept", () => {
  // Trail refuses anything under 32 characters of base64url.
  assert.match(newSignupState(), /^[A-Za-z0-9_-]{32,128}$/);
});

test("agent signup: the state goes in the body, not the URL", async () => {
  const f = scripted([{ status: 202, body: { status: "pending" } }]);
  const got = await claimSignup("secret-state", "https://api.example", f.impl);
  assert.deepEqual(got, { pending: true });
  assert.equal(f.calls[0].url, "https://api.example/api/public/graft-handoffs/claim");
  assert.ok(!f.calls[0].url.includes("secret-state"));
  assert.deepEqual(JSON.parse(f.calls[0].body), { state: "secret-state" });
});

test("agent signup: keeps asking until the sign-up finishes, then hands back the link", async () => {
  const f = scripted([
    { status: 202, body: { status: "pending" } },
    { status: 503 },
    { status: 200, body: { brain_id: "brain-1", token: "gbt_1.sig" } },
  ]);
  const got = await waitForSignup("st", "https://api.example", { timeoutMs: 5000, intervalMs: 1, fetchImpl: f.impl });
  assert.deepEqual(got, { link: { brainId: "brain-1", token: "gbt_1.sig" } });
  assert.equal(f.calls.length, 3, "a server error in the middle is not a reason to stop");
});

test("agent signup: stops at once on a used or expired link", async () => {
  const f = scripted([{ status: 410, body: { error: "gone" } }]);
  const got = await waitForSignup("st", "https://api.example", { timeoutMs: 5000, intervalMs: 1, fetchImpl: f.impl });
  assert.ok("error" in got && got.reason === "expired");
  assert.equal(f.calls.length, 1);
});

test("agent signup: an older Trail without the route is unsupported, not an endless wait", async () => {
  const f = scripted([{ status: 404 }]);
  const got = await waitForSignup("st", "https://api.example", { timeoutMs: 5000, intervalMs: 1, fetchImpl: f.impl });
  assert.ok("error" in got && got.reason === "unsupported");
});

test("agent signup: gives up as still pending when the wait runs out", async () => {
  const f = scripted([{ status: 202, body: { status: "pending" } }]);
  const got = await waitForSignup("st", "https://api.example", { timeoutMs: 30, intervalMs: 10, fetchImpl: f.impl });
  assert.deepEqual(got, { pending: true });
});

test("agent signup: the saved state is for one repo, for a while, and git-ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-pending-"));
  try {
    writePendingSignup(dir, { state: "st", repo: "acme/app", createdAt: 1_000 });
    assert.equal(readPendingSignup(dir, "acme/app", 60_000, 2_000)?.state, "st");
    assert.equal(readPendingSignup(dir, "acme/other", 60_000, 2_000), null, "a different remote starts over");
    assert.equal(readPendingSignup(dir, "acme/app", 60_000, 70_000), null, "too old to claim");
    assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /\.graft/);
    clearPendingSignup(dir);
    assert.equal(readPendingSignup(dir, "acme/app", 60_000, 2_000), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
