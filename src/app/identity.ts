/**
 * Who the App is, to GitHub.
 *
 * A GitHub App authenticates twice over: it signs a short JWT with its private
 * key to prove it is the App, then trades that for an *installation* token scoped
 * to one repository owner. The installation token is what matters here — it is
 * the reason this exists at all. A workflow on a fork's pull request gets a
 * read-only token and cannot comment; an App's installation token belongs to the
 * base repository, so a fork PR is no different from any other.
 *
 * `node:crypto` signs the JWT, so there is no dependency to audit for something
 * that handles a private key.
 */
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/** GitHub rejects a JWT older than 60s or more than 10 minutes in the future. */
const JWT_TTL_S = 540; // 9 minutes, inside the limit with room for clock skew
/** Renew this long before expiry rather than racing it. */
const RENEW_MARGIN_MS = 60_000;

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export interface AppCredentials {
  appId: string;
  /** PEM, as GitHub hands it over. */
  privateKey: string;
}

/**
 * A signed App JWT.
 *
 * `iat` is backdated a minute: GitHub compares against ITS clock, and a server
 * running even slightly fast has its tokens rejected as "issued in the future" —
 * a failure that looks like a bad key and is not.
 */
export function appJwt(creds: AppCredentials, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + JWT_TTL_S, iss: creds.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(creds.privateKey))}`;
}

export interface TokenResponse {
  token: string;
  expires_at: string;
}

/** Minimal shape of `fetch`, so tests need no network and no mocking library. */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

interface CacheEntry {
  token: string;
  expiresMs: number;
}

/**
 * Installation tokens, fetched once and reused until they are nearly expired.
 *
 * Tokens last an hour and a busy repository can fire a dozen webhooks a minute;
 * without the cache every one of them spends a round trip and a signature.
 */
export class InstallationTokens {
  private readonly cache = new Map<number, CacheEntry>();

  constructor(
    private readonly creds: AppCredentials,
    private readonly fetchImpl: Fetch,
    private readonly now: () => number = Date.now,
    private readonly api = "https://api.github.com",
  ) {}

  async get(installationId: number): Promise<string> {
    const hit = this.cache.get(installationId);
    if (hit && hit.expiresMs - RENEW_MARGIN_MS > this.now()) return hit.token;

    const res = await this.fetchImpl(`${this.api}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt(this.creds, this.now())}`,
        accept: "application/vnd.github+json",
        "user-agent": "graft-app",
      },
    });
    const body = await res.text();
    if (!res.ok) {
      // The body carries GitHub's reason ("integration not found", a key that does
      // not match the app id); losing it turns every setup mistake into "401".
      throw new Error(`installation token for ${installationId} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const parsed = JSON.parse(body) as TokenResponse;
    this.cache.set(installationId, { token: parsed.token, expiresMs: Date.parse(parsed.expires_at) });
    return parsed.token;
  }

  /** Drop a token GitHub has rejected, so the next call fetches a fresh one. */
  invalidate(installationId: number): void {
    this.cache.delete(installationId);
  }
}

/**
 * Is this delivery really from GitHub?
 *
 * The webhook endpoint is public, and everything downstream — cloning a repo,
 * posting as the App — happens on its say-so. Compared in constant time because
 * a byte-at-a-time comparison leaks the expected digest to anyone willing to
 * measure, and forging a signature is a total compromise of the endpoint.
 */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
