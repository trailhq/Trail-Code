/**
 * Entry point: read the environment, refuse to start half-configured, listen.
 *
 * Every misconfiguration is fatal at boot rather than at the first webhook. A
 * server that starts without a webhook secret looks healthy and silently rejects
 * every delivery; one that starts without a private key looks healthy and fails
 * every review. Both are worth a loud death on line one.
 */
import { createApp } from "./server.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✗ ${name} is required`);
    process.exit(1);
  }
  return value;
}

/**
 * GitHub hands the private key over as a PEM file. Env vars cannot hold newlines
 * comfortably, so both spellings are accepted: the raw PEM, or one with `\n`
 * escaped — the shape you get from pasting a key into a hosting provider's UI.
 */
function privateKey(): string {
  const raw = required("GRAFT_APP_PRIVATE_KEY");
  const pem = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  if (!pem.includes("BEGIN") || !pem.includes("PRIVATE KEY")) {
    console.error("✗ GRAFT_APP_PRIVATE_KEY does not look like a PEM private key");
    process.exit(1);
  }
  return pem;
}

const port = Number(process.env.PORT ?? 3000);
const { server, queue } = createApp({
  appId: required("GRAFT_APP_ID"),
  privateKey: privateKey(),
  webhookSecret: required("GRAFT_WEBHOOK_SECRET"),
  publicUrl: required("GRAFT_PUBLIC_URL"),
  port,
  concurrency: Number(process.env.GRAFT_CONCURRENCY ?? 2),
  // Optional, unlike the four above, and deliberately so: point it at a mounted
  // volume and the pages already linked from pull requests survive a restart;
  // leave it unset and they do not. Neither is worth refusing to boot over — a
  // server that will not start reviews nothing at all, which is strictly worse
  // than one whose old links go stale.
  pageDir: process.env.GRAFT_PAGE_DIR,
});

/**
 * Finish what is in flight before dying.
 *
 * A container gets a TERM and a grace period on every deploy. Dropping a review
 * mid-clone leaves a stale comment on a pull request and no retry, because the
 * delivery was acknowledged long ago.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal}: draining ${queue.size} job(s)`);
    server.close();
    void queue.drain().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 25_000).unref();
  });
}
