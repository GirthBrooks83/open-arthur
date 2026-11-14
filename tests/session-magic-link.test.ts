import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { LINK_COOKIE, SIGNIN_CODE_TTL_MS } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

const KEY = "a-private-test-key-with-enough-characters";
let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;

const post = (path: string, body: unknown) =>
  server.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const mint = (body: unknown) => post("/api/session/signin-link", body);
const exchange = (body: unknown) => post("/api/session/signin-exchange", body);
const codeFromUrl = (url: string) => new URL(url).searchParams.get("signin") ?? "";
const digestOf = (code: string) => createHash("sha256").update(code).digest("hex");

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-magic-link-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    accessKey: KEY,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("minting a sign-in link requires the access key", async () => {
  assert.equal((await mint({})).status, 401);
  assert.equal((await mint({ accessKey: "not-the-key" })).status, 401);
});

test("a minted link carries a one-time code that is hashed at rest and expires in 10 minutes", async () => {
  const before = Date.now();
  const response = await mint({ accessKey: KEY });
  assert.equal(response.status, 200);
  const { url, expiresAt } = (await response.json()) as { url: string; expiresAt: string };
  const code = codeFromUrl(url);
  assert.ok(code.length >= 32);
  assert.ok(url.startsWith("http://localhost:8787/?signin="));
  const ttl = Date.parse(expiresAt) - before;
  assert.ok(ttl > SIGNIN_CODE_TTL_MS - 5000 && ttl <= SIGNIN_CODE_TTL_MS + 5000);
  // The raw code itself is never a storage key; only its digest is.
  assert.equal(await db.get("system", "signin-codes", code), null);
  const record = await db.get<{ expiresAt: number }>("system", "signin-codes", digestOf(code));
  assert.ok(record);
  assert.ok(record.expiresAt >= before + SIGNIN_CODE_TTL_MS - 5000);
});

test("exchanging a code opens a session that survives a reload, exactly once", async () => {
  const { url } = (await (await mint({ accessKey: KEY })).json()) as { url: string };
  const code = codeFromUrl(url);
  const response = await exchange({ code });
  assert.equal(response.status, 200);
  const { token } = (await response.json()) as { token: string };
  assert.ok(token);
  // The exchange also sets the long-lived cookie used by /api/session.
  assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`^${LINK_COOKIE}=`));
  // A "reload": a fresh workspace request carrying only the token.
  const workspace = await server.app.request("/api/workspace", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(workspace.status, 200);
  // Second exchange of the same code fails: the code is spent.
  assert.equal((await exchange({ code })).status, 401);
});

test("unknown and missing codes are refused", async () => {
  assert.equal((await exchange({ code: "no-such-code" })).status, 401);
  assert.equal((await exchange({})).status, 401);
});

test("an expired code is refused", async () => {
  const code = "an-expired-test-code-with-enough-characters";
  await db.put("system", "signin-codes", {
    id: digestOf(code),
    owner: "local-user",
    expiresAt: Date.now() - 1000,
  });
  assert.equal((await exchange({ code })).status, 401);
});

test("sign-out revokes the session token", async () => {
  const { url } = (await (await mint({ accessKey: KEY })).json()) as { url: string };
  const { token } = (await (await exchange({ code: codeFromUrl(url) })).json()) as {
    token: string;
  };
  const signOut = await server.app.request("/api/session/sign-out", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(signOut.status, 200);
  const workspace = await server.app.request("/api/workspace", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(workspace.status, 401);
});

test("minting a durable link still requires the access key", async () => {
  assert.equal((await mint({ durable: true })).status, 401);
  assert.equal((await mint({ accessKey: "not-the-key", durable: true })).status, 401);
});

test("a durable code has no expiry and is hashed at rest like a one-time code", async () => {
  const response = await mint({ accessKey: KEY, durable: true });
  assert.equal(response.status, 200);
  const { url, expiresAt } = (await response.json()) as { url: string; expiresAt: string | null };
  const code = codeFromUrl(url);
  assert.ok(code.length >= 32);
  assert.equal(expiresAt, null);
  // The raw code itself is never a storage key; only its digest is.
  assert.equal(await db.get("system", "signin-codes", code), null);
  const record = await db.get<{ expiresAt: number | null; durable?: boolean }>(
    "system",
    "signin-codes",
    digestOf(code),
  );
  assert.ok(record);
  assert.equal(record.durable, true);
  assert.equal(record.expiresAt, null);
});

test("a durable code exchanges successfully twice and stays on record", async () => {
  const { url } = (await (await mint({ accessKey: KEY, durable: true })).json()) as {
    url: string;
  };
  const code = codeFromUrl(url);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await exchange({ code });
    assert.equal(response.status, 200);
    const { token } = (await response.json()) as { token: string };
    assert.ok(token);
    assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`^${LINK_COOKIE}=`));
    // Each exchange yields a working session (a fresh signed-out
    // client opening the same link again).
    const workspace = await server.app.request("/api/workspace", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(workspace.status, 200);
  }
  // The code was not consumed: its record is still there.
  const record = await db.get("system", "signin-codes", digestOf(code));
  assert.ok(record);
});

test("a durable record seeded directly in the store (an old link) still exchanges", async () => {
  // Simulates a durable code minted long ago: the record is all that
  // survives, and nothing in it is time-based — no expiry is ever
  // consulted for a durable record with expiresAt: null.
  const code = "a-durable-test-code-minted-long-ago-000000";
  await db.put("system", "signin-codes", {
    id: digestOf(code),
    owner: "local-user",
    expiresAt: null,
    durable: true,
  });
  assert.equal((await exchange({ code })).status, 200);
  assert.equal((await exchange({ code })).status, 200);
});

test("a durable code stops working once its record is deleted", async () => {
  const { url } = (await (await mint({ accessKey: KEY, durable: true })).json()) as {
    url: string;
  };
  const code = codeFromUrl(url);
  assert.equal((await exchange({ code })).status, 200);
  await db.remove("system", "signin-codes", digestOf(code));
  assert.equal((await exchange({ code })).status, 401);
});

// Last on purpose: the limiter counts every exchange in the window,
// including the ones above, and this test drives it past the cap.
test("the exchange endpoint is rate-limited", async () => {
  let lastStatus = 0;
  for (let i = 0; i < 40 && lastStatus !== 429; i++)
    lastStatus = (await exchange({ code: `bogus-${i}` })).status;
  assert.equal(lastStatus, 429);
});
