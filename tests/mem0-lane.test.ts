import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Mem0Lane } from "../apps/server/src/engine/mem0.ts";
import type { AgentWorkspace } from "../packages/domain/src/agent.ts";

// The Mem0 lane adapter, proven against a stub that speaks the exact
// contract of the self-hosted memory-lane service (the lab wrapper):
//   POST /add { text }   GET /search?q= -> { facts: string[] }
// The point of the app-level tests: with MEM0_URL set, a save through
// the real API reaches the lane, recall merges lane facts, and a dead
// lane changes nothing (internal store stays canonical).

const added: string[] = [];
let searchFacts: string[] = [];
let stub: Server, stubUrl: string;
let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
let deadDb: Store, deadServer: Awaited<ReturnType<typeof createApp>>, deadDirectory: string;

const baseConfig = (dataDir: string, mem0Url?: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  ...(mem0Url ? { integrations: { mem0Url } } : {}),
});

async function sessionToken(app: Awaited<ReturnType<typeof createApp>>["app"]): Promise<string> {
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  return (await session.json()).token as string;
}

before(async () => {
  stub = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "POST" && url.pathname === "/add") {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { text?: string };
      if (body.text) added.push(body.text);
      response.end(JSON.stringify({ result: { status: "ok" } }));
    } else if (request.method === "GET" && url.pathname === "/search") {
      response.end(JSON.stringify({ facts: searchFacts, scores: searchFacts.map(() => 0.9) }));
    } else if (url.pathname === "/health") {
      response.end(JSON.stringify({ lane: "mem0", ok: true }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const address = stub.address();
  assert(address && typeof address !== "string");
  stubUrl = `http://127.0.0.1:${address.port}`;

  directory = await mkdtemp(join(tmpdir(), "openmuse-mem0-lane-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, baseConfig(directory, stubUrl));
  token = await sessionToken(server.app);

  // Second app: MEM0_URL points at a port where nothing listens.
  deadDirectory = await mkdtemp(join(tmpdir(), "openmuse-mem0-dead-"));
  deadDb = await createStore({ dataDir: join(deadDirectory, "db") });
  deadServer = await createApp(deadDb, baseConfig(deadDirectory, "http://127.0.0.1:1"));
});

after(async () => {
  await server?.agent?.stop();
  await deadServer?.agent?.stop();
  await db?.close();
  await deadDb?.close();
  stub?.closeAllConnections();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  if (deadDirectory) await rm(deadDirectory, { recursive: true, force: true });
});

test("health distinguishes configured from wired for the Mem0 lane", async () => {
  const health = (await (await server.app.request("/api/health")).json()) as {
    integrations: { mem0: boolean; mem0Wired: boolean; graphiti: boolean };
  };
  assert.equal(health.integrations.mem0, true);
  assert.equal(health.integrations.mem0Wired, true);
  // The other lanes remain configuration-only booleans.
  assert.equal(health.integrations.graphiti, false);
});

test("a memory saved through the API is mirrored to the Mem0 lane", async () => {
  const before = added.length;
  const response = await server.app.request("/api/agent/memories", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "The user plays pool on Wednesdays", source: "Test" }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  // The lane received the same text via POST /add.
  assert.equal(added.length, before + 1);
  assert.equal(added[added.length - 1], "The user plays pool on Wednesdays");
  // And the internal store (canonical) holds it too.
  const snapshot = (await (
    await server.app.request("/api/agent", { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as AgentWorkspace;
  assert.ok(snapshot.memories.some((m) => m.text === "The user plays pool on Wednesdays"));
});

test("recall merges lane facts and never duplicates internal memories", async () => {
  searchFacts = ["The user plays pool on Wednesdays", "The user's dentist is Dr. Molar"];
  const recalled = await server.agent.recallMemories("local-user", "dentist appointment");
  const texts = recalled.map((m) => m.text);
  // Internal memory present exactly once (the lane's copy of it dedupes).
  assert.equal(texts.filter((t) => t === "The user plays pool on Wednesdays").length, 1);
  // Lane-only fact merged in, labeled as lane-sourced.
  const laneFact = recalled.find((m) => m.text === "The user's dentist is Dr. Molar");
  assert.ok(laneFact);
  assert.equal(laneFact.source, "Mem0 (main memory lane)");
  // No query -> no lane call, internal list only.
  searchFacts = ["Should not appear without a query"];
  const noQuery = await server.agent.recallMemories("local-user");
  assert.ok(!noQuery.some((m) => m.text === "Should not appear without a query"));
});

test("a dead Mem0 lane changes nothing: saves and recall use the internal store", async () => {
  const deadToken = await sessionToken(deadServer.app);
  const response = await deadServer.app.request("/api/agent/memories", {
    method: "POST",
    headers: { Authorization: `Bearer ${deadToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Saved while the lane is down", source: "Test" }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const recalled = await deadServer.agent.recallMemories("local-user", "anything");
  assert.deepEqual(
    recalled.map((m) => m.text),
    ["Saved while the lane is down"],
  );
});

test("the lane client reports failure by value on HTTP errors and bad replies", async () => {
  const failing = new Mem0Lane(
    "http://lane.invalid",
    async () => new Response("nope", { status: 500 }),
  );
  assert.equal(await failing.add("x"), false);
  assert.deepEqual(await failing.search("x"), []);

  const badShape = new Mem0Lane(
    "http://lane.invalid",
    async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  );
  assert.deepEqual(await badShape.search("x"), []);

  const throwing = new Mem0Lane("http://lane.invalid", async () => {
    throw new Error("network down");
  });
  assert.equal(await throwing.add("x"), false);
  assert.deepEqual(await throwing.search("x"), []);

  const unconfigured = new Mem0Lane(undefined);
  assert.equal(unconfigured.configured, false);
  assert.equal(await unconfigured.add("x"), false);
  assert.deepEqual(await unconfigured.search("x"), []);
});
