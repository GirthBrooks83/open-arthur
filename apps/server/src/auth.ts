import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();
const DAY_MS = 24 * 60 * 60 * 1000;
// Cookie that carries a bookmark-link session token (see linkSession).
export const LINK_COOKIE = "openmuse_session";
// A bookmark-link session lasts long enough that opening the saved
// bookmark "just works" for months. The cookie holds this session
// token, never the access key itself, so it can be revoked by
// deleting the session record without rotating the key.
export const LINK_SESSION_TTL_MS = 90 * DAY_MS;
// Sign-in codes (see mintSigninCode): EVERY code — one-time or
// durable — is single-use and expires; the long-lived session cookie
// the exchange sets is what keeps a bookmark visit signed in, never
// the code itself. (Pre-fix, a durable code never expired and was
// never consumed: a replayable bearer credential. Claude's security
// review of PR #46 failed that design, and the epoch below kills
// every code minted under it.) A one-time code dies in minutes; a
// durable code (minted with durable: true) gets a generous 30 days —
// long enough to tap the bookmark once, after which the cookie
// carries the session for months.
export const SIGNIN_CODE_TTL_MS = 10 * 60 * 1000;
export const DURABLE_SIGNIN_CODE_TTL_MS = 30 * DAY_MS;
// Sign-in code format epoch. Records minted before the PR #46 fix
// carry no epoch (and durable ones never expire and replay forever),
// so they are treated as exposed: exchange accepts only records
// stamped with the current epoch, which invalidates every pre-fix
// code the moment this code deploys — no manual cleanup step.
export const SIGNIN_CODE_EPOCH = 2;
const SIGNIN_CODE_KIND = "signin-codes";
type SigninCodeRecord = { owner: string; expiresAt: number; durable?: boolean; epoch?: number };
export class Auth {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly signingKey: string,
  ) {}
  async session(accessKey?: string, cookieToken?: string) {
    if (!this.keyAccepted(accessKey) && !(await this.tokenAccepted(cookieToken)))
      throw new AppError("Access key is incorrect", 401);
    return this.issue(DAY_MS);
  }
  // One-time sign-in from a bookmark link (/?key=…): the same key
  // check as the typed path, but it mints the long-lived token the
  // cookie carries so later visits need no typing.
  async linkSession(accessKey?: string) {
    if (!this.keyAccepted(accessKey)) throw new AppError("Access key is incorrect", 401);
    return this.issue(LINK_SESSION_TTL_MS);
  }
  // Mint a sign-in code for a tap-to-sign-in link (/?signin=<code>).
  // Authenticated with the access key, exactly like the typed
  // sign-in. Only the code's SHA-256 digest is stored (as the record
  // id), so a database read never yields a usable code. Every code
  // is stamped with the current epoch and an expiry — 10 minutes, or
  // 30 days with durable: true — and every code is single-use (see
  // exchangeSigninCode). Revoke an outstanding code with
  // revokeSigninCode — the link dies immediately, no key rotation
  // needed.
  async mintSigninCode(accessKey?: string, durable = false) {
    if (!this.keyAccepted(accessKey)) throw new AppError("Access key is incorrect", 401);
    const code = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + (durable ? DURABLE_SIGNIN_CODE_TTL_MS : SIGNIN_CODE_TTL_MS);
    await this.db.put("system", SIGNIN_CODE_KIND, {
      id: digest(code).toString("hex"),
      owner: "local-user",
      expiresAt,
      epoch: SIGNIN_CODE_EPOCH,
      ...(durable ? { durable: true } : {}),
    });
    return { code, expiresAt };
  }
  // Trade a sign-in code for a session. The record is taken
  // (deleted) atomically as it is read, so EVERY code — durable
  // included — can be exchanged exactly once, never twice, not even
  // by two requests racing. The exchange sets the long-lived session
  // cookie, which is what keeps later bookmark visits signed in.
  // Records from before the PR #46 fix (no current epoch — including
  // the old never-expiring durable records) are refused, as are
  // expired codes; every failure reads the same: no hint about which.
  async exchangeSigninCode(code?: string) {
    if (!code) throw new AppError("Sign-in link is invalid or has expired", 401);
    const id = digest(code).toString("hex");
    const record = await this.db.take<SigninCodeRecord>("system", SIGNIN_CODE_KIND, id);
    if (!record || record.epoch !== SIGNIN_CODE_EPOCH || record.expiresAt < Date.now())
      throw new AppError("Sign-in link is invalid or has expired", 401);
    return this.issue(LINK_SESSION_TTL_MS);
  }
  // Revoke an outstanding sign-in code (the admin path behind
  // POST /api/session/signin-codes/revoke). Accepts the code itself
  // or its SHA-256 fingerprint — the record id — since the
  // fingerprint is all an operator ever sees. Returns whether a
  // record was actually removed; unknown codes are a quiet false,
  // so the endpoint is no oracle for which codes exist.
  async revokeSigninCode(codeOrFingerprint?: string) {
    if (!codeOrFingerprint) return false;
    const id = /^[0-9a-f]{64}$/.test(codeOrFingerprint)
      ? codeOrFingerprint
      : digest(codeOrFingerprint).toString("hex");
    const existing = await this.db.get("system", SIGNIN_CODE_KIND, id);
    if (!existing) return false;
    await this.db.remove("system", SIGNIN_CODE_KIND, id);
    return true;
  }
  // Revoke one session token (explicit sign-out). Unknown or already
  // expired tokens are a no-op: sign-out never fails.
  async revokeSession(token?: string) {
    if (!token) return;
    await this.db.remove("system", "sessions", digest(token).toString("hex"));
  }
  private keyAccepted(accessKey?: string) {
    if (this.config.mode !== "live") return true;
    return Boolean(
      accessKey &&
        this.config.accessKey &&
        timingSafeEqual(digest(accessKey), digest(this.config.accessKey)),
    );
  }
  private async tokenAccepted(token?: string) {
    if (!token) return false;
    const existing = await this.db.get<{ owner: string; expiresAt: number }>(
      "system",
      "sessions",
      digest(token).toString("hex"),
    );
    return Boolean(existing && existing.expiresAt >= Date.now());
  }
  private async issue(ttlMs: number) {
    const token = randomBytes(32).toString("base64url");
    await this.db.put("system", "sessions", {
      id: digest(token).toString("hex"),
      owner: "local-user",
      expiresAt: Date.now() + ttlMs,
    });
    return { token, mode: this.config.mode };
  }
  async owner(authorization?: string) {
    if (!authorization?.startsWith("Bearer ")) throw new AppError("Sign in to OpenMuse", 401);
    const session = await this.db.get<{ owner: string; expiresAt: number }>(
      "system",
      "sessions",
      digest(authorization.slice(7)).toString("hex"),
    );
    if (!session || session.expiresAt < Date.now())
      throw new AppError("Session expired. Sign in again.", 401);
    return session.owner;
  }
  sign(owner: string, path: string) {
    const expires = String(Date.now() + 15 * 60 * 1000);
    const signature = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${path}\n${expires}`)
      .digest("hex");
    return `${this.config.publicUrl}${path}?owner=${encodeURIComponent(owner)}&expires=${expires}&signature=${signature}`;
  }
  verify(url: URL) {
    const owner = url.searchParams.get("owner") ?? "";
    const expires = url.searchParams.get("expires") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    if (
      !owner ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() ||
      !/^\w{64}$/.test(signature)
    )
      throw new AppError("Document link expired; refresh the workspace", 401);
    const expected = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${url.pathname}\n${expires}`)
      .digest("hex");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new AppError("Invalid access link", 403);
    return owner;
  }
}
export async function createAuth(db: Store, config: Config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, "session-signing-key");
  let key: string;
  try {
    key = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    key = randomBytes(32).toString("base64");
    await writeFile(path, key, { mode: 0o600, flag: "wx" });
  }
  return new Auth(db, config, key);
}
