import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  CRITIC_BLOCKED_REASON,
  INSUFFICIENT_EVIDENCE,
  requiresEvidence,
} from "../apps/server/src/engine/verifier.ts";
import { modelFixture } from "./helpers/model.ts";

// D1 (2026-11-14): the Critic's evidence gate applied to EVERY
// completion, so general tasks with no memory evidence were blocked
// with the insufficient-evidence refusal and parked at paused with
// question=null (production task 18ee7f55: "Reply with exactly:
// PING OK", evidence_count 0). The gate is now scoped to claims
// that need backing — factual/recall prompts, and runs reporting
// work-tool outcomes — and a block inside that scope is a terminal
// "blocked" status carrying a human-readable reason.

test("requiresEvidence separates factual/recall claims from general instructions", () => {
  // Factual questions and recall of the user's stored state.
  assert.equal(requiresEvidence("What is the capital of France?"), true);
  assert.equal(requiresEvidence("Where is the workshop of Gareth Venn in Astoria?"), true);
  assert.equal(requiresEvidence("What is my name, and what are my three top priorities?"), true);
  assert.equal(requiresEvidence("When is my dentist appointment?"), true);
  assert.equal(requiresEvidence("Is my calendar free on Friday?"), true);
  assert.equal(requiresEvidence("Remind me what I saved about the workshop"), true);
  assert.equal(requiresEvidence("List my open tasks"), true);
  assert.equal(requiresEvidence("Summarize my latest email"), true);
  // Round 2 (ATLAS review of PR #47): factual imperatives assert
  // world facts like questions do — his five examples, verbatim.
  assert.equal(requiresEvidence("What is today's weather?"), true);
  assert.equal(requiresEvidence("Tell me today's weather."), true);
  assert.equal(requiresEvidence("Give me the current price of Bitcoin."), true);
  assert.equal(requiresEvidence("List my open tasks."), true);
  assert.equal(requiresEvidence("Reply exactly: PING OK"), false);
  // False-positive guards: creative imperatives carry no factual
  // signal and stay ungated, as do fetch verbs aimed at supplied
  // content.
  assert.equal(requiresEvidence("Tell me a joke"), false);
  assert.equal(requiresEvidence("Give me a poem about autumn"), false);
  assert.equal(requiresEvidence("Check this draft and tighten the second paragraph"), false);
  assert.equal(requiresEvidence("Get me a coffee order started"), false);
  // General instructions: the output is the work itself.
  assert.equal(requiresEvidence("Reply with exactly: PING OK"), false);
  assert.equal(requiresEvidence("Write a haiku about autumn"), false);
  assert.equal(requiresEvidence("Draft a polite follow-up note to the venue"), false);
  assert.equal(requiresEvidence("Remember this: the workshop is in Astoria."), false);
  assert.equal(
    requiresEvidence(
      "Ask the team in Slack whether the voice feature should use Pipecat or Web Speech first.",
    ),
    false,
  );
  assert.equal(requiresEvidence(""), false);
});

// Round 3 (Claude review of PR #47): the classifier's anchored
// patterns missed the request forms people actually type — polite
// and modal lead-ins ("Can you tell me…", "Please tell me…") put a
// wrapper word where the patterns expected the verb or question
// word. The gate now judges the request's core, and the tell-me
// form gates when it asks to be told a fact — while chit-chat and
// creative asks stay ungated.
test("requiresEvidence covers polite and modal request forms without gating chit-chat", () => {
  // Claude's named misses, verbatim forms.
  assert.equal(requiresEvidence("Can you tell me today's weather?"), true);
  assert.equal(requiresEvidence("Please tell me the latest news"), true);
  // The same wrappers over the other gated shapes.
  assert.equal(requiresEvidence("Please tell me when the meeting starts"), true);
  assert.equal(requiresEvidence("Can you tell me what time it is in Tokyo?"), true);
  assert.equal(requiresEvidence("Could you please tell me what my tasks are?"), true);
  assert.equal(requiresEvidence("Would you show me my calendar?"), true);
  assert.equal(requiresEvidence("Please list my open tasks"), true);
  assert.equal(requiresEvidence("Could you check the current price of Bitcoin?"), true);
  // Tell-me fact requests with no topic-signal word (round 3 rule).
  assert.equal(requiresEvidence("Can you tell me the capital of France?"), true);
  assert.equal(requiresEvidence("Please tell me about the meeting"), true);
  // Negative: politeness alone never gates — creative asks and
  // general instructions keep shipping ungated behind the wrapper.
  assert.equal(requiresEvidence("Can you tell me a joke?"), false);
  assert.equal(requiresEvidence("Please tell me a story about a dragon"), false);
  assert.equal(requiresEvidence("Can you write me a poem about autumn?"), false);
  assert.equal(requiresEvidence("Please help me draft an email to my landlord"), false);
  assert.equal(requiresEvidence("Can you help me fix this paragraph?"), false);
  // Negative: plain chit-chat stays ungated.
  assert.equal(requiresEvidence("Hello!"), false);
  assert.equal(requiresEvidence("Good morning"), false);
  assert.equal(requiresEvidence("How are you?"), false);
  assert.equal(requiresEvidence("Thanks!"), false);
});

type Reply = Parameters<typeof modelFixture>[1];

async function startTask(t: TestContext, reply: Reply, prompt: string) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-critic-scope-"));
  const db = await createStore();
  await modelFixture(t, reply);
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

test("a general task with zero memory evidence is NOT critic-blocked (the PING OK case)", async (t) => {
  const run = await startTask(
    t,
    (index) =>
      index === 0 ? { name: "finish_task", arguments: { summary: "PING OK" } } : { text: "Done." },
    "Reply with exactly: PING OK",
  );
  try {
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
    assert.equal(detail.task.result, "PING OK");
    assert.notEqual(detail.task.state.criticBlocked, true);
    const critic = detail.task.stageTrace?.find((entry) => entry.agent === "critic");
    assert.equal(critic?.outcome, "completed");
    assert.equal(critic?.metrics.approved, true);
    assert.equal(critic?.metrics.evidence_gate, false);
  } finally {
    await run.done();
  }
});

test("a recall task with surviving evidence still passes the critic", async (t) => {
  const run = await startTask(
    t,
    (index) =>
      index === 0
        ? { name: "finish_task", arguments: { summary: "The workshop is in Astoria." } }
        : { text: "Done." },
    "Where is the workshop of Gareth Venn in Astoria?",
  );
  try {
    await run.server.agent.remember("owner", {
      id: "mem-workshop",
      text: "The workshop of Gareth Venn is located in Astoria.",
      source: "User asked the agent to remember this",
      createdAt: new Date().toISOString(),
    });
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
    assert.equal(detail.task.result, "The workshop is in Astoria.");
    const critic = detail.task.stageTrace?.find((entry) => entry.agent === "critic");
    assert.equal(critic?.outcome, "completed");
    assert.equal(critic?.metrics.evidence_gate, true);
    assert.equal(critic?.metrics.approved, true);
  } finally {
    await run.done();
  }
});

test("a recall task with NO evidence ends terminally blocked, with a human-readable reason", async (t) => {
  const run = await startTask(
    t,
    (index) =>
      index === 0
        ? { name: "finish_task", arguments: { summary: "Your dentist appointment is Tuesday." } }
        : { text: "Done." },
    "When is my dentist appointment?",
  );
  try {
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    // Not the model's invented answer, not a silent park: a
    // terminal status, the fixed refusal as the result, and the
    // reason on the record.
    assert.equal(detail.task.status, "blocked");
    assert.equal(detail.task.result, INSUFFICIENT_EVIDENCE);
    assert.equal(detail.task.error, CRITIC_BLOCKED_REASON);
    assert.match(detail.task.error ?? "", /evidence check/);
    assert.equal(detail.task.question, null);
    assert.equal(detail.task.state.criticBlocked, true);
    const critic = detail.task.stageTrace?.find((entry) => entry.agent === "critic");
    assert.equal(critic?.outcome, "blocked");
    assert.equal(critic?.metrics.evidence_gate, true);
    // Terminal: the worker never picks it up again and resume
    // refuses — a new task is the remedy, as the reason says.
    await assert.rejects(
      run.server.agent.control("owner", run.task.id, "resume"),
      /Only paused tasks can be resumed/,
    );
    await run.server.agent.worker.tick();
    const after = await run.server.agent.getTask("owner", run.task.id);
    assert.equal(after.status, "blocked");
  } finally {
    await run.done();
  }
});
