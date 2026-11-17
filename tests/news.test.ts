import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  addNewsBriefing,
  buildNewsBriefing,
  listNewsBriefings,
  NEWS_BRIEFING_KIND,
} from "../apps/server/src/engine/news.ts";
import type { NewsBriefing } from "../packages/domain/src/index.ts";

// News (engine/news.ts): editions filed off to the side through
// POST /api/agent/news, read back newest first through
// GET /api/agent/news — the storage + shape lane only. Nothing
// here fetches news; the tests file fixed editions and read them
// back, exactly as the filing lane and the News page will.

let db: Store, app: Awaited<ReturnType<typeof createApp>>["app"], token: string, directory: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-news-"));
  db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app } = await createApp(db, config));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = ((await response.json()) as { token: string }).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const edition = (title: string) => ({
  title,
  items: [
    { headline: "First headline", source: "Wire Service", url: "https://example.com/story" },
    { headline: "Second headline" },
  ],
});

test("news routes require a session and start empty", async () => {
  const denied = await app.request("/api/agent/news");
  assert.equal(denied.status, 401);
  const response = await app.request("/api/agent/news", { headers: headers() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test("filing an edition stores it and reads it back in full", async () => {
  const filed = await app.request("/api/agent/news", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(edition("News — Sunday morning")),
  });
  assert.equal(filed.status, 201);
  const briefing = (await filed.json()) as NewsBriefing;
  assert.ok(briefing.id.length > 0);
  assert.equal(briefing.title, "News — Sunday morning");
  assert.equal(briefing.items.length, 2);
  assert.deepEqual(briefing.items[0], {
    headline: "First headline",
    source: "Wire Service",
    url: "https://example.com/story",
  });
  // Omitted optional fields normalize to null on the stored record.
  assert.deepEqual(briefing.items[1], { headline: "Second headline", source: null, url: null });
  assert.ok(!Number.isNaN(Date.parse(briefing.createdAt)));

  const listed = await app.request("/api/agent/news", { headers: headers() });
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), [briefing]);
});

test("editions list newest first and honor the limit", async () => {
  const filed = await app.request("/api/agent/news", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(edition("News — Sunday afternoon")),
  });
  assert.equal(filed.status, 201);
  const newest = (await filed.json()) as NewsBriefing;

  const listed = await app.request("/api/agent/news", { headers: headers() });
  const briefings = (await listed.json()) as NewsBriefing[];
  assert.equal(briefings.length, 2);
  assert.equal(briefings[0]?.id, newest.id);
  assert.equal(briefings[1]?.title, "News — Sunday morning");

  const limited = await app.request("/api/agent/news?limit=1", { headers: headers() });
  assert.deepEqual(
    ((await limited.json()) as NewsBriefing[]).map((b) => b.id),
    [newest.id],
  );
});

test("malformed editions are refused, never filed", async () => {
  const bad: unknown[] = [
    { title: "No items", items: [] },
    { items: [{ headline: "Missing the title" }] },
    { title: "Empty headline", items: [{ headline: "  " }] },
    { title: "Bad link", items: [{ headline: "H", url: "ftp://example.com/x" }] },
    { title: "Not a link", items: [{ headline: "H", url: "example.com/x" }] },
  ];
  for (const body of bad) {
    const response = await app.request("/api/agent/news", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    // The app's error handler maps ZodError to 422 (app.ts onError).
    assert.equal(response.status, 422, JSON.stringify(body));
  }
  const listed = await app.request("/api/agent/news", { headers: headers() });
  assert.equal(((await listed.json()) as NewsBriefing[]).length, 2);
});

test("the store helpers keep owners apart and clamp the limit", async () => {
  const store = await createStore();
  try {
    const older = await addNewsBriefing(
      store,
      "owner-a",
      edition("Older"),
      new Date("2026-11-15T08:00:00.000Z"),
    );
    await addNewsBriefing(store, "owner-a", edition("Newer"), new Date("2026-11-15T12:00:00.000Z"));
    await addNewsBriefing(store, "owner-b", edition("Someone else's"));

    const mine = await listNewsBriefings(store, "owner-a");
    assert.deepEqual(
      mine.map((b) => b.title),
      ["Newer", "Older"],
    );
    assert.equal(mine[1]?.id, older.id);
    assert.deepEqual(
      (await listNewsBriefings(store, "owner-a", 1)).map((b) => b.title),
      ["Newer"],
    );
    assert.deepEqual(
      (await listNewsBriefings(store, "owner-b")).map((b) => b.title),
      ["Someone else's"],
    );
    const raw = await store.list("owner-a", NEWS_BRIEFING_KIND);
    assert.equal(raw.length, 2);
  } finally {
    await store.close();
  }
});

test("buildNewsBriefing stamps the filing time and normalizes items", () => {
  const briefing = buildNewsBriefing(edition("Stamped"), new Date("2026-11-15T20:00:00.000Z"));
  assert.equal(briefing.createdAt, "2026-11-15T20:00:00.000Z");
  assert.equal(briefing.items[1]?.source, null);
  assert.equal(briefing.items[1]?.url, null);
});
