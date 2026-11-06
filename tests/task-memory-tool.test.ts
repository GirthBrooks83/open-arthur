import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AgentMemory } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

test("model worker can save a memory the user asked it to remember", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-task-memory-"));
  const db = await createStore();
  const calls: { name: string; arguments: object }[] = [
    {
      name: "save_memory",
      arguments: { text: "The workshop of Gareth Venn is located in Astoria." },
    },
    { name: "finish_task", arguments: { summary: "Saved the workshop location." } },
  ];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    const task = await server.agent.createTask("owner", {
      prompt: "Remember this: the workshop of Gareth Venn is located in Astoria.",
      kind: "agent",
    });
    await server.agent.worker.tick();
    const result = await server.agent.detail("owner", task.id);
    assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
    assert.equal(result.task.result, "Saved the workshop location.");
    // The task engine advertises the memory tool to the model.
    assert.ok(requests[0].body.includes('"name":"save_memory"'));
    // The fact actually landed in the canonical memory store.
    const memories = await db.list<AgentMemory>("owner", "memories");
    assert.ok(
      memories.some((m) => m.text === "The workshop of Gareth Venn is located in Astoria."),
      `expected the saved memory, got: ${JSON.stringify(memories.map((m) => m.text))}`,
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
