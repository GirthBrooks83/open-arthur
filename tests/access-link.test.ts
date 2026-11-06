import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { LINK_COOKIE } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

const KEY = "a-private-test-key-with-enough-characters";
let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;

const postSession = (body: unknown, cookie?: string) =>
  server.app.request("/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-access-link-"));
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

test("live mode refuses a fresh keyless session and a wrong typed key", async () => {
  assert.equal((await postSession({})).status, 401);
  assert.equal((await postSession({ accessKey: "not-the-key" })).status, 401);
  assert.equal((await postSession({}, `${LINK_COOKIE}=bogus-token`)).status, 401);
});

test("the typed access key still opens a session", async () => {
  const response = await postSession({ accessKey: KEY });
  assert.equal(response.status, 200);
  const { token } = (await response.json()) as { token: string };
  assert.ok(token);
  const workspace = await server.app.request("/api/workspace", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(workspace.status, 200);
});

test("a bookmark link trades the key for a long-lived cookie that opens later visits", async () => {
  const link = await server.app.request(`/?key=${encodeURIComponent(KEY)}`);
  assert.equal(link.status, 302);
  assert.equal(link.headers.get("location"), "/");
  const setCookie = link.headers.get("set-cookie") ?? "";
  assert.match(setCookie, new RegExp(`^${LINK_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Max-Age=7776000/i);
  const cookie = setCookie.split(";")[0];

  // The visit after the bookmark click: no key typed, no key in the
  // URL — the cookie alone opens a session.
  const session = await postSession({}, cookie);
  assert.equal(session.status, 200);
  const { token } = (await session.json()) as { token: string };
  const workspace = await server.app.request("/api/workspace", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(workspace.status, 200);
});

test("a wrong bookmark key sets no cookie and opens nothing", async () => {
  const link = await server.app.request("/?key=not-the-key");
  assert.equal(link.status, 302);
  assert.equal(link.headers.get("location"), "/");
  assert.equal(link.headers.get("set-cookie"), null);
  assert.equal((await postSession({})).status, 401);
});
