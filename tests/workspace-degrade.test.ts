// Workspace snapshot degradation: one failing Google source must not
// take the whole /api/workspace load down, and the provider's raw
// error wording must never reach the owner. Reproduces the production
// failure of 2026-11-15, where a Gmail per-minute quota rejection
// surfaced verbatim as a fatal workspace error.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { Files } from "../apps/server/src/files.ts";
import type { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";

// The exact provider wording production showed the owner (2026-11-15).
const QUOTA_DETAIL =
  "Quota exceeded for quota metric 'Total Query Cost' and limit " +
  "'Units per minute per user' of service 'gmail.googleapis.com' for " +
  "consumer 'project_number:421760646652'.";

let db: Store;
let directory: string;
let service: WorkspaceService;
let gmailFails = false;
let calendarFails = false;
const realFetch = globalThis.fetch;

function googleJson(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-workspace-degrade-"));
  db = await createStore();
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  const files = { list: async () => [] } as unknown as Files;
  const googleAuth = {
    tokens: async () => ({
      connectionId: "conn-1",
      account: "owner@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    }),
    accessToken: async () => "test-access-token",
  } as unknown as GoogleAuth;
  service = new WorkspaceService(db, config, files, googleAuth);
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("https://gmail.googleapis.com/"))
      return gmailFails
        ? googleJson(403, { error: { message: QUOTA_DETAIL } })
        : googleJson(200, { messages: [] });
    if (url.startsWith("https://www.googleapis.com/calendar/"))
      return calendarFails
        ? googleJson(403, { error: { message: QUOTA_DETAIL } })
        : googleJson(200, { items: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("a Gmail quota failure degrades mail only — the workspace still loads", async () => {
  gmailFails = true;
  calendarFails = false;
  const snapshot = await service.snapshot("owner-1");
  assert.deepEqual(snapshot.mail, []);
  assert.deepEqual(snapshot.events, []);
  assert.equal(snapshot.notices.length, 1);
  assert.equal(snapshot.notices[0]?.source, "mail");
  const message = snapshot.notices[0]?.message ?? "";
  assert.match(message, /Gmail is temporarily unavailable/);
  // The provider's raw wording never crosses into the snapshot.
  assert.doesNotMatch(JSON.stringify(snapshot), /Quota exceeded|project_number|Total Query Cost/);
});

test("a Calendar failure degrades events only — mail is unaffected", async () => {
  gmailFails = false;
  calendarFails = true;
  const snapshot = await service.snapshot("owner-1");
  assert.deepEqual(snapshot.mail, []);
  assert.deepEqual(snapshot.events, []);
  assert.equal(snapshot.notices.length, 1);
  assert.equal(snapshot.notices[0]?.source, "events");
  assert.match(snapshot.notices[0]?.message ?? "", /Calendar is temporarily unavailable/);
  assert.doesNotMatch(JSON.stringify(snapshot), /Quota exceeded|project_number/);
});

test("when both Google sources answer, the snapshot carries no notices", async () => {
  gmailFails = false;
  calendarFails = false;
  const snapshot = await service.snapshot("owner-1");
  assert.deepEqual(snapshot.notices, []);
});

// The degrade hides the provider's wording from the owner, but the
// failure must not vanish: it is recorded server-side (providerFailure
// writes through console.error) with the operation, the HTTP status and
// the provider's own detail — and never the access token.
async function captureErrorLog(run: () => Promise<unknown>): Promise<string> {
  const records: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    records.push(...args);
  };
  try {
    await run();
  } finally {
    console.error = originalError;
  }
  return JSON.stringify(records);
}

test("a Gmail failure is logged server-side with the provider detail", async () => {
  gmailFails = true;
  calendarFails = false;
  const logged = await captureErrorLog(() => service.snapshot("owner-1"));
  assert.match(logged, /workspace mail load/);
  assert.match(logged, /Quota exceeded/);
  assert.match(logged, /"status":403/);
  assert.doesNotMatch(logged, /test-access-token/);
});

test("a Calendar failure is logged server-side with the provider detail", async () => {
  gmailFails = false;
  calendarFails = true;
  const logged = await captureErrorLog(() => service.snapshot("owner-1"));
  assert.match(logged, /workspace events load/);
  assert.match(logged, /Quota exceeded/);
  assert.match(logged, /"status":403/);
  assert.doesNotMatch(logged, /test-access-token/);
});
