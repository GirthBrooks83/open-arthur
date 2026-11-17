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
import { AnythingLlmLane } from "../apps/server/src/engine/anythingllm.ts";

// The AnythingLLM adapter, proven against a stub that speaks the
// self-hosted service's developer-API contract:
//   GET  /api/ping                       -> { online: true }
//   GET  /api/v1/workspaces              -> { workspaces: [{ slug }] }
//   POST /api/v1/workspace/:slug/chat    -> { textResponse }
// The point: liveness is a real request succeeding (the ping shape),
// not any HTTP response; chat round-trips through the adapter; and
// every failure — including the API's HTTP-200-with-error shape,
// whose error string is the raw provider error — degrades to a human
// message that never leaks the service's raw error text.

const RAW_PROVIDER_ERROR =
  "Ollama::getChatCompletion failed: connect ECONNREFUSED 127.0.0.1:11434 sk-live-SECRET";

let stubMode: "ok" | "provider-error" = "ok";
let chatRequests: { slug: string; message: string; mode: string }[] = [];
let stub: Server, stubUrl: string;
let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;

const baseConfig = (dataDir: string, anythingLlmUrl?: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  ...(anythingLlmUrl
    ? { integrations: { anythingLlmUrl, anythingLlmApiKey: "test-api-key" } }
    : {}),
});

before(async () => {
  stub = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && url.pathname === "/api/ping") {
      json(200, { online: true });
    } else if (request.method === "GET" && url.pathname === "/api/v1/workspaces") {
      if (request.headers.authorization !== "Bearer test-api-key")
        return json(403, { error: "Invalid API key" });
      json(200, { workspaces: [{ name: "Knowledge", slug: "knowledge" }] });
    } else if (request.method === "POST" && url.pathname.startsWith("/api/v1/workspace/")) {
      if (request.headers.authorization !== "Bearer test-api-key")
        return json(403, { error: "Invalid API key" });
      const slug = decodeURIComponent(
        url.pathname.slice("/api/v1/workspace/".length, -"/chat".length),
      );
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
        message?: string;
        mode?: string;
      };
      chatRequests.push({ slug, message: body.message ?? "", mode: body.mode ?? "" });
      if (stubMode === "provider-error") {
        // The real API's failure shape: HTTP 200, error string set,
        // textResponse null — and the error is provider-raw.
        json(200, {
          id: "chat-1",
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: RAW_PROVIDER_ERROR,
        });
      } else {
        json(200, {
          id: "chat-1",
          type: "textResponse",
          textResponse: "PONG",
          sources: [],
          close: true,
          error: null,
        });
      }
    } else {
      json(404, { error: "not found" });
    }
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const address = stub.address();
  assert(address && typeof address !== "string");
  stubUrl = `http://127.0.0.1:${address.port}`;

  directory = await mkdtemp(join(tmpdir(), "openmuse-anythingllm-lane-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, baseConfig(directory, stubUrl));
});

after(async () => {
  await server?.agent?.stop();
  await db?.close();
  stub?.closeAllConnections();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("health distinguishes configured from wired for the AnythingLLM lane", async () => {
  const health = (await (await server.app.request("/api/health")).json()) as {
    integrations: { anythingllm: boolean; anythingllmWired: boolean };
  };
  assert.equal(health.integrations.anythingllm, true);
  assert.equal(health.integrations.anythingllmWired, true);
});

test("health reports the lane live only after the real ping answer lands", async () => {
  await server.laneProbe.refresh();
  const health = (await (await server.app.request("/api/health")).json()) as {
    integrationsLive: { anythingllm: boolean | null };
  };
  assert.equal(health.integrationsLive.anythingllm, true);
});

test("the lane pings, lists workspaces, and completes a chat round trip", async () => {
  const lane = server.agent.anythingllm;
  assert.equal(lane.configured, true);
  assert.equal(await lane.ping(), true);
  assert.deepEqual(await lane.workspaces(), ["knowledge"]);

  chatRequests = [];
  const result = await lane.chat("knowledge", "Reply with exactly this word: PONG");
  assert.deepEqual(result, { ok: true, text: "PONG" });
  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].slug, "knowledge");
  assert.equal(chatRequests[0].message, "Reply with exactly this word: PONG");
  assert.equal(chatRequests[0].mode, "chat");
});

test("a provider failure inside a 200 reply degrades to a human message, never the raw error", async () => {
  stubMode = "provider-error";
  try {
    const result = await server.agent.anythingllm.chat("knowledge", "hello");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(!result.error.includes("Ollama"), "raw provider text must not leak");
      assert.ok(!result.error.includes("sk-live-SECRET"), "no credential-shaped text");
      assert.ok(!result.error.includes("ECONNREFUSED"), "no transport internals");
    }
  } finally {
    stubMode = "ok";
  }
});

test("a dead AnythingLLM lane reports not-live and degrades chat by value", async () => {
  const dead = new AnythingLlmLane("http://127.0.0.1:1", "test-api-key", fetch, 500, 500);
  assert.equal(dead.configured, true);
  assert.equal(await dead.ping(), false, "connection refused is not live");
  assert.deepEqual(await dead.workspaces(), []);
  const result = await dead.chat("knowledge", "hello");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /didn't answer/);
});

test("the lane client reports failure by value on HTTP errors and bad replies", async () => {
  const failing = new AnythingLlmLane(
    "http://lane.invalid",
    "k",
    async () => new Response("nope", { status: 500 }),
  );
  assert.equal(await failing.ping(), false);
  assert.deepEqual(await failing.workspaces(), []);
  const rejected = await failing.chat("knowledge", "hello");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.ok(!rejected.error.includes("nope"), "raw body must not leak");

  // Ping answered 200 but with the wrong shape: not the service.
  const wrongShape = new AnythingLlmLane(
    "http://lane.invalid",
    "k",
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  assert.equal(await wrongShape.ping(), false);

  const throwing = new AnythingLlmLane("http://lane.invalid", "k", async () => {
    throw new Error("network down");
  });
  assert.equal(await throwing.ping(), false);
  assert.deepEqual(await throwing.workspaces(), []);
  const unreachable = await throwing.chat("knowledge", "hello");
  assert.equal(unreachable.ok, false);
  if (!unreachable.ok) assert.match(unreachable.error, /didn't answer/);

  const unconfigured = new AnythingLlmLane(undefined);
  assert.equal(unconfigured.configured, false);
  assert.equal(await unconfigured.ping(), false);
  assert.deepEqual(await unconfigured.workspaces(), []);
  const notSetUp = await unconfigured.chat("knowledge", "hello");
  assert.equal(notSetUp.ok, false);
  if (!notSetUp.ok) assert.match(notSetUp.error, /isn't set up/);

  // URL set but no API key: ping still works (it needs no auth),
  // key-gated calls degrade by value.
  const keyless = new AnythingLlmLane(stubUrl, undefined);
  assert.equal(await keyless.ping(), true);
  assert.deepEqual(await keyless.workspaces(), []);
  const keylessChat = await keyless.chat("knowledge", "hello");
  assert.equal(keylessChat.ok, false);
});
