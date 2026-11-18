import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { modelFixture } from "./helpers/model.ts";

// The chat_knowledge_workspace agent tool, proven end to end through
// the real conversation agent: a stub model asks for the tool, the
// SDK executes it against a stub AnythingLLM speaking the developer
// API contract, and the tool result carries the workspace's answer.
// The point of the tool is that it is the ONLY call site of
// AnythingLlmLane.chat() — before it, the adapter existed and
// answered probes, but the in-app agent had no way to reach it.
// Gating is proven too: with no ANYTHINGLLM_URL configured, the tool
// is not registered at all, so the model never sees it.

const QUESTION = "What do my stored notes say about the backup plan?";

let workspaceSlugs: string[] = ["knowledge"];
let chatRequests: { slug: string; message: string; mode: string }[] = [];
let stub: Server, stubUrl: string;

test.before(async () => {
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
      json(200, { workspaces: workspaceSlugs.map((slug) => ({ name: slug, slug })) });
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
      json(200, {
        id: "chat-1",
        type: "textResponse",
        textResponse: `Answer from ${slug}.`,
        sources: [],
        close: true,
        error: null,
      });
    } else {
      json(404, { error: "not found" });
    }
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const address = stub.address();
  assert.ok(address && typeof address !== "string");
  stubUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  stub?.closeAllConnections();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

async function knowledgeFixture(t: TestContext, integrations?: Config["integrations"]) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-knowledge-tool-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    ...(integrations ? { integrations } : {}),
  };
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, conversation: new ConversationAgent(config, server.agent, "local-user") };
}

function runInput(): RunAgentInput {
  return {
    threadId: "knowledge-chat",
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: QUESTION }],
    tools: [],
    context: [],
    state: {},
  };
}

async function runToolCall(fixture: Awaited<ReturnType<typeof knowledgeFixture>>) {
  const events = (await lastValueFrom(fixture.conversation.run(runInput()).pipe(toArray()))).map(
    (event) => EventSchemas.parse(event),
  );
  const start = events.find((event) => event.type === EventType.TOOL_CALL_START);
  assert.ok(start && start.type === EventType.TOOL_CALL_START);
  assert.equal(start.toolCallName, "chat_knowledge_workspace");
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  return { events, result: JSON.parse(result.content) as Record<string, unknown> };
}

test("chat agent reaches the AnythingLLM workspace through chat_knowledge_workspace", async (t) => {
  workspaceSlugs = ["knowledge"];
  chatRequests = [];
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "chat_knowledge_workspace", arguments: { message: QUESTION } }
      : undefined,
  );
  const fixture = await knowledgeFixture(t, {
    anythingLlmUrl: stubUrl,
    anythingLlmApiKey: "test-api-key",
    anythingLlmWorkspace: "knowledge",
  });
  const { result } = await runToolCall(fixture);
  assert.deepEqual(result, { workspace: "knowledge", answer: "Answer from knowledge." });
  assert.deepEqual(chatRequests, [{ slug: "knowledge", message: QUESTION, mode: "chat" }]);
  assert.ok(requests[0].body.includes('"name":"chat_knowledge_workspace"'));
  assert.match(requests[0].body, /chat_knowledge_workspace/);
  assert.ok(requests[1].body.includes("Answer from knowledge."));
});

test("without a configured default, the only visible workspace is used", async (t) => {
  workspaceSlugs = ["knowledge"];
  chatRequests = [];
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "chat_knowledge_workspace", arguments: { message: QUESTION } }
      : undefined,
  );
  const fixture = await knowledgeFixture(t, {
    anythingLlmUrl: stubUrl,
    anythingLlmApiKey: "test-api-key",
  });
  const { result } = await runToolCall(fixture);
  assert.deepEqual(result, { workspace: "knowledge", answer: "Answer from knowledge." });
  assert.deepEqual(chatRequests, [{ slug: "knowledge", message: QUESTION, mode: "chat" }]);
});

test("several workspaces and no default is an honest error, not a guess", async (t) => {
  workspaceSlugs = ["alpha", "beta"];
  chatRequests = [];
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "chat_knowledge_workspace", arguments: { message: QUESTION } }
      : undefined,
  );
  const fixture = await knowledgeFixture(t, {
    anythingLlmUrl: stubUrl,
    anythingLlmApiKey: "test-api-key",
  });
  const { result } = await runToolCall(fixture);
  assert.match(String(result.error), /More than one AnythingLLM workspace/);
  assert.deepEqual(result.workspaces, ["alpha", "beta"]);
  assert.deepEqual(chatRequests, []);
});

test("the tool is not registered when the AnythingLLM lane is unconfigured", async (t) => {
  workspaceSlugs = ["knowledge"];
  chatRequests = [];
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { text: "Hello." } : undefined,
  );
  const fixture = await knowledgeFixture(t);
  const events = (await lastValueFrom(fixture.conversation.run(runInput()).pipe(toArray()))).map(
    (event) => EventSchemas.parse(event),
  );
  assert.equal(
    events.some((event) => event.type === EventType.TOOL_CALL_START),
    false,
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.ok(!requests[0].body.includes("chat_knowledge_workspace"));
  assert.deepEqual(chatRequests, []);
});
