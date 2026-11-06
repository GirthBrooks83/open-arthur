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
import { GraphitiLane } from "../apps/server/src/engine/graphiti.ts";
import type { AgentWorkspace } from "../packages/domain/src/agent.ts";

// The Graphiti lane adapter, proven against a stub that speaks the
// exact contract of the self-hosted memory-lane service (the lab
// wrapper on :8972):
//   POST /add { text } -> { ok: true }   GET /search?q= -> { facts: string[] }
// The point of the app-level tests: with GRAPHITI_URL set, a save
// through the real API reaches the lane (mirrored alongside Mem0 when
// both are configured), recall merges lane facts labeled as the side
// lane, and a dead lane changes nothing (internal store canonical).

const graphitiAdded: string[] = [];
const mem0Added: string[] = [];
let graphitiFacts: string[] = [];
let mem0Facts: string[] = [];
let graphitiStub: Server, graphitiStubUrl: string;
let mem0Stub: Server, mem0StubUrl: string;
let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
let bothDb: Store,
  bothServer: Awaited<ReturnType<typeof createApp>>,
  bothDirectory: string,
  bothToken: string;
let deadDb: Store, deadServer: Awaited<ReturnType<typeof createApp>>, deadDirectory: string;

const baseConfig = (dataDir: string, integrations?: Config["integrations"]): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  ...(integrations ? { integrations } : {}),
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

async function listen(stub: Server): Promise<string> {
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const address = stub.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

before(async () => {
  graphitiStub = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "POST" && url.pathname === "/add") {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { text?: string };
      if (body.text) graphitiAdded.push(body.text);
      response.end(JSON.stringify({ ok: true, seconds: 0.01 }));
    } else if (request.method === "GET" && url.pathname === "/search") {
      response.end(JSON.stringify({ facts: graphitiFacts }));
    } else if (url.pathname === "/health") {
      response.end(JSON.stringify({ lane: "graphiti", ok: true }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  graphitiStubUrl = await listen(graphitiStub);

  mem0Stub = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "POST" && url.pathname === "/add") {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { text?: string };
      if (body.text) mem0Added.push(body.text);
      response.end(JSON.stringify({ result: { status: "ok" } }));
    } else if (request.method === "GET" && url.pathname === "/search") {
      response.end(JSON.stringify({ facts: mem0Facts, scores: mem0Facts.map(() => 0.9) }));
    } else if (url.pathname === "/health") {
      response.end(JSON.stringify({ lane: "mem0", ok: true }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  mem0StubUrl = await listen(mem0Stub);

  directory = await mkdtemp(join(tmpdir(), "openmuse-graphiti-lane-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, baseConfig(directory, { graphitiUrl: graphitiStubUrl }));
  token = await sessionToken(server.app);

  // Second app: BOTH lanes configured.
  bothDirectory = await mkdtemp(join(tmpdir(), "openmuse-both-lanes-"));
  bothDb = await createStore({ dataDir: join(bothDirectory, "db") });
  bothServer = await createApp(
    bothDb,
    baseConfig(bothDirectory, { mem0Url: mem0StubUrl, graphitiUrl: graphitiStubUrl }),
  );
  bothToken = await sessionToken(bothServer.app);

  // Third app: GRAPHITI_URL points at a port where nothing listens.
  deadDirectory = await mkdtemp(join(tmpdir(), "openmuse-graphiti-dead-"));
  deadDb = await createStore({ dataDir: join(deadDirectory, "db") });
  deadServer = await createApp(
    deadDb,
    baseConfig(deadDirectory, { graphitiUrl: "http://127.0.0.1:1" }),
  );
});

after(async () => {
  await server?.agent?.stop();
  await bothServer?.agent?.stop();
  await deadServer?.agent?.stop();
  await db?.close();
  await bothDb?.close();
  await deadDb?.close();
  for (const stub of [graphitiStub, mem0Stub]) {
    stub?.closeAllConnections();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  if (bothDirectory) await rm(bothDirectory, { recursive: true, force: true });
  if (deadDirectory) await rm(deadDirectory, { recursive: true, force: true });
});

test("health distinguishes configured from wired for the Graphiti lane", async () => {
  const health = (await (await server.app.request("/api/health")).json()) as {
    integrations: { graphiti: boolean; graphitiWired: boolean; mem0: boolean; mem0Wired: boolean };
  };
  assert.equal(health.integrations.graphiti, true);
  assert.equal(health.integrations.graphitiWired, true);
  // Mem0 is not configured in this app, so neither of its flags is set.
  assert.equal(health.integrations.mem0, false);
  assert.equal(health.integrations.mem0Wired, false);
});

test("a memory saved through the API is mirrored to the Graphiti lane", async () => {
  const before = graphitiAdded.length;
  const response = await server.app.request("/api/agent/memories", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "The user's home hall is Sunset Billiards", source: "Test" }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  // The lane received the same text via POST /add.
  assert.equal(graphitiAdded.length, before + 1);
  assert.equal(graphitiAdded[graphitiAdded.length - 1], "The user's home hall is Sunset Billiards");
  // And the internal store (canonical) holds it too.
  const snapshot = (await (
    await server.app.request("/api/agent", { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as AgentWorkspace;
  assert.ok(snapshot.memories.some((m) => m.text === "The user's home hall is Sunset Billiards"));
});

test("recall merges Graphiti facts and never duplicates internal memories", async () => {
  graphitiFacts = [
    "The user's home hall is Sunset Billiards",
    "The user's cue is a Pechauer P09-R",
  ];
  const recalled = await server.agent.recallMemories("local-user", "which cue");
  const texts = recalled.map((m) => m.text);
  // Internal memory present exactly once (the lane's copy of it dedupes).
  assert.equal(texts.filter((t) => t === "The user's home hall is Sunset Billiards").length, 1);
  // Lane-only fact merged in, labeled as the side lane.
  const laneFact = recalled.find((m) => m.text === "The user's cue is a Pechauer P09-R");
  assert.ok(laneFact);
  assert.equal(laneFact.source, "Graphiti (side memory lane)");
  // No query -> no lane call, internal list only.
  graphitiFacts = ["Should not appear without a query"];
  const noQuery = await server.agent.recallMemories("local-user");
  assert.ok(!noQuery.some((m) => m.text === "Should not appear without a query"));
});

test("with both lanes configured, saves mirror to both and recall merges both", async () => {
  const mem0Before = mem0Added.length;
  const graphitiBefore = graphitiAdded.length;
  const response = await bothServer.app.request("/api/agent/memories", {
    method: "POST",
    headers: { Authorization: `Bearer ${bothToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "League night is Wednesday", source: "Test" }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(mem0Added.length, mem0Before + 1);
  assert.equal(graphitiAdded.length, graphitiBefore + 1);

  // The same fact returned by both lanes surfaces once (Mem0, the main
  // lane, contributes it first); lane-unique facts from both appear.
  mem0Facts = ["Shared fact from both lanes", "Mem0-only fact"];
  graphitiFacts = ["Shared fact from both lanes", "Graphiti-only fact"];
  const recalled = await bothServer.agent.recallMemories("local-user", "league");
  const texts = recalled.map((m) => m.text);
  assert.equal(texts.filter((t) => t === "Shared fact from both lanes").length, 1);
  assert.equal(
    recalled.find((m) => m.text === "Shared fact from both lanes")?.source,
    "Mem0 (main memory lane)",
  );
  assert.ok(texts.includes("Mem0-only fact"));
  assert.equal(
    recalled.find((m) => m.text === "Graphiti-only fact")?.source,
    "Graphiti (side memory lane)",
  );
});

test("a dead Graphiti lane changes nothing: saves and recall use the internal store", async () => {
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
  const failing = new GraphitiLane(
    "http://lane.invalid",
    async () => new Response("nope", { status: 500 }),
  );
  assert.equal(await failing.add("x"), false);
  assert.deepEqual(await failing.search("x"), []);

  const badShape = new GraphitiLane(
    "http://lane.invalid",
    async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  );
  assert.deepEqual(await badShape.search("x"), []);

  const throwing = new GraphitiLane("http://lane.invalid", async () => {
    throw new Error("network down");
  });
  assert.equal(await throwing.add("x"), false);
  assert.deepEqual(await throwing.search("x"), []);

  const unconfigured = new GraphitiLane(undefined);
  assert.equal(unconfigured.configured, false);
  assert.equal(await unconfigured.add("x"), false);
  assert.deepEqual(await unconfigured.search("x"), []);
});
