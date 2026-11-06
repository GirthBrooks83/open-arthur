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
