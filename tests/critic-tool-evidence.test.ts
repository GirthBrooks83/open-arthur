import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { INSUFFICIENT_EVIDENCE } from "../apps/server/src/engine/verifier.ts";
import { modelFixture } from "./helpers/model.ts";

// Critic grounding for the two newest agent tools (PR-iota
// consult_team, PR-mu recall_arthur_record). Production, 2026-11-13:
// a task whose only work was a SUCCESSFUL consult_team post still
// ended criticBlocked with the insufficient-evidence refusal, and a
// task whose only evidence was a recall_arthur_record result was
// parked the same way. These tests pin the contract at the critic
// level: a successful result from either tool is a successful tool
// result in the run and grounds the completion, while a FAILED tool
// result (and no tool work at all) still does not.

const CONSULT_TS = "1794571946.688659";

type Reply = Parameters<typeof modelFixture>[1];

async function startTask(
  t: TestContext,
  reply: Reply,
  prompt: string,
  config: { slack?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-critic-tools-"));
  const db = await createStore();
  await modelFixture(t, reply);
  // The Slack bridge posts through the global fetch; stub only the
  // Slack API origin and pass everything else (the model fixture)
  // through untouched.
  const originalFetch = globalThis.fetch;
  if (config.slack) {
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url = typeof input === "string" ? input : ((input as { url?: string })?.url ?? "");
      if (url.startsWith("https://slack.com/"))
        return new Response(JSON.stringify({ ok: true, ts: CONSULT_TS }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      return originalFetch(input as never, init as never);
    }) as typeof fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
  }
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
    ...(config.slack ? { slackBotToken: "xoxb-fixture", slackBriefChannel: "C0CEJ24DUNR" } : {}),
  });
  const task = await server.agent.createTask("owner", { prompt, kind: "agent" });
  return {
    server,
    task,
    done: async () => {
      await server.agent.stop();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a completion whose only work is a posted consult is grounded, not critic-blocked", async (t) => {
  const calls: { name: string; arguments: object }[] = [
    {
      name: "consult_team",
      arguments: {
        question:
          "For the voice feature, should we build Pipecat plus Groq streaming first, or the browser Web Speech API first?",
        audience: "team",
      },
    },
    {
      name: "finish_task",
      arguments: {
        summary:
          "Posted the voice-route question to the team channel. The consult is open; the answer will arrive as a follow-up task.",
      },
    },
  ];
  const run = await startTask(
    t,
    (index) => calls[index] ?? { text: "Done." },
    "Ask the team in Slack whether the voice feature should use Pipecat plus Groq streaming or the browser Web Speech API first, and finish once the consult is posted.",
    { slack: true },
  );
  try {
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
    assert.match(detail.task.result ?? "", /Posted the voice-route question/);
    assert.notEqual(detail.task.state.criticBlocked, true);
    // The consult really was recorded open, with the stub's ts.
    const consults = detail.task.state.consults as { status: string; postedTs: string }[];
    assert.equal(consults?.length, 1);
    assert.equal(consults[0].status, "open");
    assert.equal(consults[0].postedTs, CONSULT_TS);
    const critic = detail.task.stageTrace?.find((entry) => entry.agent === "critic");
    assert.equal(critic?.outcome, "completed");
    assert.equal(critic?.metrics.tool_result_count, 1);
  } finally {
    await run.done();
  }
});

test("a completion whose only evidence is a recall_arthur_record result is grounded", async (t) => {
  const calls: { name: string; arguments: object }[] = [
    { name: "recall_arthur_record", arguments: { query: "Mem0 memory lane" } },
    {
      name: "finish_task",
      arguments: {
        summary:
          "Arthur's synced record (snapshot 2026-11-12) names Mem0 as the chosen memory lane, wired in Open Arthur.",
      },
    },
  ];
  const run = await startTask(
    t,
    (index) => calls[index] ?? { text: "Done." },
    "Use recall_arthur_record to look up what Arthur's synced record says about the memory lanes, and quote the key facts it returns, including the snapshot date.",
  );
  try {
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
    assert.match(detail.task.result ?? "", /Mem0 as the chosen memory lane/);
    assert.notEqual(detail.task.state.criticBlocked, true);
    const critic = detail.task.stageTrace?.find((entry) => entry.agent === "critic");
    assert.equal(critic?.outcome, "completed");
    assert.equal(critic?.metrics.tool_result_count, 1);
  } finally {
    await run.done();
  }
});

test("a FAILED consult (Slack unconfigured) does not ground a completion", async (t) => {
  const calls: { name: string; arguments: object }[] = [
    {
      name: "consult_team",
      arguments: {
        question:
          "For the voice feature, should we build Pipecat plus Groq streaming first, or the browser Web Speech API first?",
        audience: "team",
      },
    },
    {
      name: "finish_task",
      arguments: { summary: "The team recommends Pipecat plus Groq streaming first." },
    },
  ];
  const run = await startTask(
    t,
    (index) => calls[index] ?? { text: "Done." },
    "Ask the team in Slack whether the voice feature should use Pipecat plus Groq streaming or the browser Web Speech API first.",
    // No slack config: postForTs returns undefined and the tool
    // returns its error result, which must not count as evidence.
  );
  try {
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    assert.equal(detail.task.status, "paused");
    assert.equal(detail.task.result, INSUFFICIENT_EVIDENCE);
    assert.equal(detail.task.state.criticBlocked, true);
  } finally {
    await run.done();
  }
});

test("a completion with no tool evidence at all stays blocked (planning is not evidence)", async (t) => {
  const calls: { name: string; arguments: object }[] = [
    { name: "set_plan", arguments: { steps: ["Answer the question."] } },
    {
      name: "finish_task",
      arguments: { summary: "The capital of France is Paris." },
    },
  ];
  const run = await startTask(
    t,
    (index) => calls[index] ?? { text: "Done." },
    "What is the capital of France?",
  );
  try {
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    assert.equal(detail.task.status, "paused");
    assert.equal(detail.task.result, INSUFFICIENT_EVIDENCE);
    assert.equal(detail.task.state.criticBlocked, true);
  } finally {
    await run.done();
  }
});
