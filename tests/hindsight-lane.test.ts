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
import { HindsightLane } from "../apps/server/src/engine/hindsight.ts";
import type { AgentWorkspace } from "../packages/domain/src/agent.ts";

// The Hindsight lane adapter, proven against a stub that speaks the
// exact NATIVE contract of the real Hindsight server (the lab service
// on :8931 — unlike Mem0/Graphiti it has no /add//search wrapper):
//   POST /v1/default/banks/arthur-service/memories
//        { items: [{ content }], async: false }
//        -> { success: true, bank_id, items_count, async: false }
//   POST /v1/default/banks/arthur-service/memories/recall { query }
//        -> { results: [{ id, text, type }] }
//   GET  /health -> { status: "healthy", database: "connected" }
// The point of the app-level tests: with HINDSIGHT_URL set, a save
// through the real API reaches the lane (mirrored alongside Mem0 and
// Graphiti when all are configured), recall merges lane facts labeled
// as the third lane — after Mem0 and Graphiti in merge order — and a
// dead lane changes nothing (internal store canonical).

const hindsightRetained: string[] = [];
const hindsightRetainPaths: string[] = [];
const mem0Added: string[] = [];
const graphitiAdded: string[] = [];
let hindsightFacts: string[] = [];
let mem0Facts: string[] = [];
let graphitiFacts: string[] = [];
let hindsightStub: Server, hindsightStubUrl: string;
let mem0Stub: Server, mem0StubUrl: string;
let graphitiStub: Server, graphitiStubUrl: string;
let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
let allDb: Store,
  allServer: Awaited<ReturnType<typeof createApp>>,
  allDirectory: string,
  allToken: string;
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

async function readBody(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

before(async () => {
  hindsightStub = createServer(async (request, response) => {
    const raw = await readBody(request as AsyncIterable<Buffer>);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const bankBase = "/v1/default/banks/arthur-service";
    if (request.method === "POST" && url.pathname === `${bankBase}/memories`) {
      const body = JSON.parse(raw || "{}") as {
        items?: { content?: string }[];
        async?: boolean;
      };
      hindsightRetainPaths.push(url.pathname);
      assert.equal(body.async, false);
      for (const item of body.items ?? []) if (item.content) hindsightRetained.push(item.content);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          bank_id: "arthur-service",
          items_count: body.items?.length ?? 0,
          async: false,
        }),
      );
    } else if (request.method === "POST" && url.pathname === `${bankBase}/memories/recall`) {
      const body = JSON.parse(raw || "{}") as { query?: string };
      assert.equal(typeof body.query, "string");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          results: hindsightFacts.map((text, index) => ({
            id: `stub-${index}`,
            text,
            type: "world",
          })),
        }),
      );
    } else if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "healthy", database: "connected" }));
    } else {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "not found" }));
    }
  });
  hindsightStubUrl = await listen(hindsightStub);

  mem0Stub = createServer(async (request, response) => {
    const raw = await readBody(request as AsyncIterable<Buffer>);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "POST" && url.pathname === "/add") {
      const body = JSON.parse(raw || "{}") as { text?: string };
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

  graphitiStub = createServer(async (request, response) => {
    const raw = await readBody(request as AsyncIterable<Buffer>);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "POST" && url.pathname === "/add") {
      const body = JSON.parse(raw || "{}") as { text?: string };
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

  directory = await mkdtemp(join(tmpdir(), "openmuse-hindsight-lane-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, baseConfig(directory, { hindsightUrl: hindsightStubUrl }));
  token = await sessionToken(server.app);

  // Second app: ALL THREE lanes configured.
  allDirectory = await mkdtemp(join(tmpdir(), "openmuse-all-lanes-"));
  allDb = await createStore({ dataDir: join(allDirectory, "db") });
  allServer = await createApp(
    allDb,
    baseConfig(allDirectory, {
      mem0Url: mem0StubUrl,
      graphitiUrl: graphitiStubUrl,
      hindsightUrl: hindsightStubUrl,
    }),
  );
  allToken = await sessionToken(allServer.app);

  // Third app: HINDSIGHT_URL points at a port where nothing listens.
  deadDirectory = await mkdtemp(join(tmpdir(), "openmuse-hindsight-dead-"));
  deadDb = await createStore({ dataDir: join(deadDirectory, "db") });
  deadServer = await createApp(
    deadDb,
    baseConfig(deadDirectory, { hindsightUrl: "http://127.0.0.1:1" }),
  );
});

after(async () => {
  await server?.agent?.stop();
  await allServer?.agent?.stop();
  await deadServer?.agent?.stop();
  await db?.close();
  await allDb?.close();
  await deadDb?.close();
  for (const stub of [hindsightStub, mem0Stub, graphitiStub]) {
    stub?.closeAllConnections();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  if (allDirectory) await rm(allDirectory, { recursive: true, force: true });
  if (deadDirectory) await rm(deadDirectory, { recursive: true, force: true });
});

test("health distinguishes configured from wired for the Hindsight lane", async () => {
  const health = (await (await server.app.request("/api/health")).json()) as {
    integrations: {
      hindsight: boolean;
      hindsightWired: boolean;
      mem0: boolean;
      mem0Wired: boolean;
      graphiti: boolean;
      graphitiWired: boolean;
    };
  };
  assert.equal(health.integrations.hindsight, true);
  assert.equal(health.integrations.hindsightWired, true);
  // Mem0 and Graphiti are not configured in this app.
  assert.equal(health.integrations.mem0, false);
  assert.equal(health.integrations.mem0Wired, false);
  assert.equal(health.integrations.graphiti, false);
  assert.equal(health.integrations.graphitiWired, false);
});

test("a memory saved through the API is retained to the Hindsight bank", async () => {
  const before = hindsightRetained.length;
  const response = await server.app.request("/api/agent/memories", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "The user's home hall is Sunset Billiards", source: "Test" }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  // The lane received the same text via a native retain to the
  // arthur-service bank.
  assert.equal(hindsightRetained.length, before + 1);
  assert.equal(
    hindsightRetained[hindsightRetained.length - 1],
    "The user's home hall is Sunset Billiards",
  );
  assert.equal(
    hindsightRetainPaths[hindsightRetainPaths.length - 1],
    "/v1/default/banks/arthur-service/memories",
  );
  // And the internal store (canonical) holds it too.
  const snapshot = (await (
    await server.app.request("/api/agent", { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as AgentWorkspace;
  assert.ok(snapshot.memories.some((m) => m.text === "The user's home hall is Sunset Billiards"));
});

test("recall merges Hindsight results and never duplicates internal memories", async () => {
  hindsightFacts = [
    "The user's home hall is Sunset Billiards",
    "The user's cue is a Pechauer P09-R",
  ];
  const recalled = await server.agent.recallMemories("local-user", "which cue");
  const texts = recalled.map((m) => m.text);
  // Internal memory present exactly once (the lane's copy of it dedupes).
  assert.equal(texts.filter((t) => t === "The user's home hall is Sunset Billiards").length, 1);
  // Lane-only result merged in, labeled as the third lane.
  const laneFact = recalled.find((m) => m.text === "The user's cue is a Pechauer P09-R");
  assert.ok(laneFact);
  assert.equal(laneFact.source, "Hindsight (third memory lane)");
  assert.ok(laneFact.id.startsWith("hindsight-"));
  // No query -> no lane call, internal list only.
  hindsightFacts = ["Should not appear without a query"];
  const noQuery = await server.agent.recallMemories("local-user");
  assert.ok(!noQuery.some((m) => m.text === "Should not appear without a query"));
});

test("with all three lanes configured, saves mirror to all and recall merges in lane order", async () => {
  const mem0Before = mem0Added.length;
  const graphitiBefore = graphitiAdded.length;
  const hindsightBefore = hindsightRetained.length;
  const response = await allServer.app.request("/api/agent/memories", {
    method: "POST",
    headers: { Authorization: `Bearer ${allToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "League night is Wednesday", source: "Test" }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(mem0Added.length, mem0Before + 1);
  assert.equal(graphitiAdded.length, graphitiBefore + 1);
  assert.equal(hindsightRetained.length, hindsightBefore + 1);

  // A fact returned by several lanes surfaces once, contributed by the
  // earliest lane in merge order (Mem0 main, Graphiti side, Hindsight
  // third); lane-unique facts from each appear with their own labels.
  mem0Facts = ["Shared fact from all lanes", "Mem0-only fact"];
  graphitiFacts = [
    "Shared fact from all lanes",
    "Shared Graphiti Hindsight fact",
    "Graphiti-only fact",
  ];
  hindsightFacts = [
    "Shared fact from all lanes",
    "Shared Graphiti Hindsight fact",
    "Hindsight-only fact",
  ];
  const recalled = await allServer.agent.recallMemories("local-user", "league");
  const texts = recalled.map((m) => m.text);
  assert.equal(texts.filter((t) => t === "Shared fact from all lanes").length, 1);
  assert.equal(
    recalled.find((m) => m.text === "Shared fact from all lanes")?.source,
    "Mem0 (main memory lane)",
  );
  assert.equal(texts.filter((t) => t === "Shared Graphiti Hindsight fact").length, 1);
  assert.equal(
    recalled.find((m) => m.text === "Shared Graphiti Hindsight fact")?.source,
    "Graphiti (side memory lane)",
  );
  assert.ok(texts.includes("Mem0-only fact"));
  assert.ok(texts.includes("Graphiti-only fact"));
  assert.equal(
    recalled.find((m) => m.text === "Hindsight-only fact")?.source,
    "Hindsight (third memory lane)",
  );
});

test("a dead Hindsight lane changes nothing: saves and recall use the internal store", async () => {
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

test("the lane client speaks the native contract and reports failure by value", async () => {
  // Native request shapes: retain posts items to the bank path; recall
  // posts the query to the bank recall path and reads results[].text.
  const calls: { url: string; body: unknown }[] = [];
  const native = new HindsightLane("http://lane.invalid", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    if (String(url).endsWith("/memories/recall"))
      return new Response(
        JSON.stringify({
          results: [{ id: "1", text: "a fact" }, { id: "2", text: 42 }, { id: "3" }],
        }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({ success: true, bank_id: "arthur-service", items_count: 1, async: false }),
      { status: 200 },
    );
  });
  assert.equal(await native.add("hello bank"), true);
  assert.equal(calls[0]?.url, "http://lane.invalid/v1/default/banks/arthur-service/memories");
  assert.deepEqual(calls[0]?.body, { items: [{ content: "hello bank" }], async: false });
  // Non-string / missing texts in results are dropped, not surfaced.
  assert.deepEqual(await native.search("anything"), ["a fact"]);
  assert.equal(
    calls[1]?.url,
    "http://lane.invalid/v1/default/banks/arthur-service/memories/recall",
  );
  assert.deepEqual(calls[1]?.body, { query: "anything" });

  const failing = new HindsightLane(
    "http://lane.invalid",
    async () => new Response("nope", { status: 500 }),
  );
  assert.equal(await failing.add("x"), false);
  assert.deepEqual(await failing.search("x"), []);

  const badShape = new HindsightLane(
    "http://lane.invalid",
    async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  );
  assert.deepEqual(await badShape.search("x"), []);

  const throwing = new HindsightLane("http://lane.invalid", async () => {
    throw new Error("network down");
  });
  assert.equal(await throwing.add("x"), false);
  assert.deepEqual(await throwing.search("x"), []);

  const unconfigured = new HindsightLane(undefined);
  assert.equal(unconfigured.configured, false);
  assert.equal(await unconfigured.add("x"), false);
  assert.deepEqual(await unconfigured.search("x"), []);
});
