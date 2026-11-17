// Standalone calendar route degradation: when Google rejects the
// calendar list or event list calls, the provider's raw error wording
// must never reach the owner. The /api/workspace snapshot already
// degrades per source (workspace-degrade.test.ts), but the standalone
// routes — GET /api/calendars and GET /api/calendar/events — call the
// same Google methods uncaught, and the API layer passes
// GoogleApiError messages through verbatim, so the raw string landed
// on the Calendar screen. These tests reproduce that leak against a
// stubbed Google backend and pin the human-worded replacement.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import type { Files } from "../apps/server/src/files.ts";
import type { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";

// Raw provider wording in the shape Google returns it: quota metric,
// service name and the consumer project number are provider internals,
// not something the owner should ever read on the Calendar screen.
const QUOTA_DETAIL =
  "Quota exceeded for quota metric 'Requests' and limit " +
  "'Requests per minute per user' of service 'calendar-json.googleapis.com' for " +
  "consumer 'project_number:421760646652'.";

let db: Store;
let directory: string;
let service: WorkspaceService;
let calendarFails = false;
const realFetch = globalThis.fetch;

function googleJson(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-calendar-degrade-"));
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
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    }),
    accessToken: async () => "test-access-token",
  } as unknown as GoogleAuth;
  service = new WorkspaceService(db, config, files, googleAuth);
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList"))
      return calendarFails
        ? googleJson(403, { error: { message: QUOTA_DETAIL } })
        : googleJson(200, {
            items: [
              {
                id: "primary",
                summary: "Personal",
                timeZone: "America/Los_Angeles",
                accessRole: "owner",
              },
            ],
          });
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/"))
      return calendarFails
        ? googleJson(403, { error: { message: QUOTA_DETAIL } })
        : googleJson(200, {
            items: [
              {
                id: "evt-1",
                summary: "Pool night",
                start: { dateTime: "2026-11-16T02:00:00Z" },
                end: { dateTime: "2026-11-16T03:00:00Z" },
              },
            ],
            timeZone: "UTC",
          });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the call to reject");
}

test("a Calendar quota failure on /api/calendars degrades to a human message", async () => {
  calendarFails = true;
  const error = await rejection(service.calendars("owner-1"));
  assert.ok(error instanceof AppError, `expected AppError, got ${error.name}: ${error.message}`);
  assert.equal(error.status, 502);
  assert.match(error.message, /Calendar is temporarily unavailable/);
  // The provider's raw wording never crosses into the error.
  assert.doesNotMatch(error.message, /Quota exceeded|project_number|calendar-json/);
});

test("a Calendar quota failure on /api/calendar/events degrades to a human message", async () => {
  calendarFails = true;
  const error = await rejection(service.events("owner-1", { calendarId: "primary" }));
  assert.ok(error instanceof AppError, `expected AppError, got ${error.name}: ${error.message}`);
  assert.equal(error.status, 502);
  assert.match(error.message, /Calendar is temporarily unavailable/);
  assert.doesNotMatch(error.message, /Quota exceeded|project_number|calendar-json/);
});

test("when Google answers, calendars and events load normally", async () => {
  calendarFails = false;
  const calendars = await service.calendars("owner-1");
  assert.equal(calendars.length, 1);
  assert.equal(calendars[0]?.id, "primary");
  assert.equal(calendars[0]?.name, "Personal");
  const events = await service.events("owner-1", { calendarId: "primary" });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.title, "Pool night");
});
