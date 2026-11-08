import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  acceptancePlanSchema,
  checkVerdictSchema,
  countsAsEvidence,
  createPlan,
  critiqueAnswer,
  INSUFFICIENT_EVIDENCE,
  insufficientEvidenceAnswer,
  stageTraceSchema,
  survivingMatches,
  VERIFICATION_FAILED,
  verifyAnswer,
  verifyCompletionCitations,
} from "../apps/server/src/engine/verifier.ts";
import { modelFixture } from "./helpers/model.ts";

// Verifier spine (Design Note A, Agent-Me port): the Critic gate
// grounds a completion on >=1 surviving evidence match or >=1
// successful tool result; ungrounded completions park blocked with
// the fixed insufficient-evidence refusal instead of shipping the
// model's claim; write-task completions pass the Verifier's
// invariants (non-empty, no fabricated citations, save_memory
// read-back) or are replaced with the verification-failed status.
// Every run leaves a StageTrace on the task record.

test("contracts parse the pipeline and Acceptance shapes, and provenance gates evidence", () => {
  const plan = createPlan("  Where is the workshop?  ");
  assert.equal(plan.retrievalQuery, "Where is the workshop?");
  assert.equal(plan.tasks.length, 3);
  assert.ok(plan.queryTermCount > 0);
  const trace = stageTraceSchema.parse({
    sequence: 3,
    agent: "critic",
    outcome: "blocked",
    summary: "Blocked unsupported completion.",
    metrics: { approved: false, query_coverage: 0 },
  });
  assert.equal(trace.agent, "critic");
  assert.throws(() => stageTraceSchema.parse({ ...trace, outcome: "skipped" }));
  const acceptance = acceptancePlanSchema.parse({
    taskId: "task-1",
    frozenAt: "2026-11-07T00:00:00.000Z",
    criteria: [{ id: "c1", description: "The save is stored", evidenceKind: "execution" }],
  });
  assert.equal(acceptance.criteria.length, 1);
  // A plan with no frozen timestamp is a draft, not an acceptance plan.
  assert.throws(() =>
    acceptancePlanSchema.parse({ taskId: "task-1", criteria: acceptance.criteria }),
  );
  assert.deepEqual(
    checkVerdictSchema.parse({
      criterionId: "c1",
      verdict: "pass",
      score: 1,
      evidenceId: "ev-1",
    }).verdict,
    "pass",
  );
  // Only captured/imported executions count as evidence; authored
  // examples and bare pasted logs do not.
  assert.equal(countsAsEvidence({ kind: "run", provenance: "captured", ref: "r1" }), true);
  assert.equal(countsAsEvidence({ kind: "run", provenance: "imported", ref: "r2" }), true);
  assert.equal(countsAsEvidence({ kind: "example", provenance: "authored", ref: "r3" }), false);
  assert.equal(countsAsEvidence({ kind: "log", provenance: "pasted_log", ref: "r4" }), false);
});

test("the researcher keeps only recall facts clearing the 0.75 coverage threshold", () => {
  const matches = survivingMatches("Where is the workshop of Gareth Venn in Astoria", [
    {
      id: "mem-1",
      source: "User asked the agent to remember this",
      text: "The workshop of Gareth Venn is located in Astoria.",
    },
    { id: "mem-2", source: "User", text: "Lunch is usually at noon." },
  ]);
  assert.deepEqual(
    matches.map((match) => match.id),
    ["mem-1"],
  );
  assert.ok(matches[0].score >= 0.75);
});

test("the critic grounds on a match or a tool result, and on nothing else", () => {
  const bundle = {
    matches: [{ id: "mem-1", source: "memory", excerpt: "The workshop is in Astoria.", score: 1 }],
  };
  assert.equal(critiqueAnswer("Where is the workshop?", bundle, 0).grounded, true);
  assert.equal(critiqueAnswer("Where is the workshop?", { matches: [] }, 1).grounded, true);
  const ungrounded = critiqueAnswer("Where is the workshop?", { matches: [] }, 0);
  assert.equal(ungrounded.grounded, false);
  assert.equal(ungrounded.queryCoverage, 0);
});

test("the donor verifier checks citation presence, count and non-emptiness", () => {
  const bundle = {
    matches: [{ id: "mem-1", source: "memory", excerpt: "The workshop is in Astoria.", score: 1 }],
  };
  const grounded = { grounded: true, queryCoverage: 1 };
  assert.equal(
    verifyAnswer(bundle, grounded, { content: "It is in Astoria. [mem-1]", citationCount: 1 })
      .approved,
    true,
  );
  // A claim with no citation fails, however confident it sounds.
  assert.equal(
    verifyAnswer(bundle, grounded, { content: "It is in Astoria.", citationCount: 0 }).approved,
    false,
  );
  assert.equal(verifyAnswer(bundle, grounded, { content: "", citationCount: 1 }).approved, false);
  // Ungrounded, only the exact insufficient-evidence refusal verifies.
  const refusal = insufficientEvidenceAnswer();
  assert.equal(refusal.content, INSUFFICIENT_EVIDENCE);
  assert.equal(
    verifyAnswer({ matches: [] }, { grounded: false, queryCoverage: 0 }, refusal).approved,
    true,
  );
  assert.equal(
    verifyAnswer(
      { matches: [] },
      { grounded: false, queryCoverage: 0 },
      { content: "It is in Astoria.", citationCount: 0 },
    ).approved,
    false,
  );
});

test("the completion verifier rejects fabricated citations and empty completions", () => {
  const bundle = {
    matches: [{ id: "mem-1", source: "memory", excerpt: "The workshop is in Astoria.", score: 1 }],
  };
  assert.equal(
    verifyCompletionCitations(bundle, { content: "Saved. [mem-1]", citationCount: 1 }).approved,
    true,
  );
  const fabricated = verifyCompletionCitations(bundle, {
    content: "Saved. [no-such-source]",
    citationCount: 1,
  });
  assert.equal(fabricated.approved, false);
  assert.equal(fabricated.citationPathsValid, false);
  assert.equal(
    verifyCompletionCitations(bundle, { content: "  ", citationCount: 0 }).approved,
    false,
  );
});

async function startTask(
  t: Parameters<typeof modelFixture>[0],
  reply: Parameters<typeof modelFixture>[1],
  prompt: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-verifier-"));
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

test("a grounded write task succeeds, with the full StageTrace persisted on the task record", async (t) => {
  const calls: { name: string; arguments: object }[] = [
    {
      name: "save_memory",
      arguments: { text: "The workshop of Gareth Venn is located in Astoria." },
    },
    { name: "finish_task", arguments: { summary: "Saved the workshop location." } },
  ];
  const run = await startTask(
    t,
    (index) => calls[index],
    "Remember this: the workshop of Gareth Venn is located in Astoria.",
  );
  try {
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
    assert.equal(detail.task.result, "Saved the workshop location.");
    const trace = detail.task.stageTrace;
    assert.ok(trace, "the run left a StageTrace on the task record");
    assert.deepEqual(
      trace.map((entry) => entry.agent),
      ["planner", "researcher", "critic", "writer", "verifier"],
    );
    assert.ok(trace.every((entry) => entry.outcome === "completed"));
    const critic = trace.find((entry) => entry.agent === "critic");
    assert.equal(critic?.metrics.approved, true);
    assert.equal(critic?.metrics.tool_result_count, 1);
    const verifier = trace.find((entry) => entry.agent === "verifier");
    assert.equal(verifier?.metrics.approved, true);
    // The save_memory write was read back once and compared.
    assert.equal(verifier?.metrics.read_back_verified, true);
  } finally {
    await run.done();
  }
});

test("a completion grounded by a surviving recall match succeeds with no tool results", async (t) => {
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
    const researcher = detail.task.stageTrace?.find((entry) => entry.agent === "researcher");
    assert.ok((researcher?.metrics.evidence_count as number) >= 1);
    const critic = detail.task.stageTrace?.find((entry) => entry.agent === "critic");
    assert.equal(critic?.outcome, "completed");
    assert.equal(critic?.metrics.tool_result_count, 0);
    // No mutating tool ran, so there is no verifier stage.
    assert.equal(
      detail.task.stageTrace?.some((entry) => entry.agent === "verifier"),
      false,
    );
  } finally {
    await run.done();
  }
});

test("an ungrounded completion parks blocked with the refusal, never the model's claim", async (t) => {
  const run = await startTask(
    t,
    (index) =>
      index === 0
        ? { name: "finish_task", arguments: { summary: "The capital of France is Paris." } }
        : { text: "Done." },
    "What is the capital of France?",
  );
  try {
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    assert.equal(detail.task.status, "paused", "the task parks blocked, not succeeded");
    assert.equal(detail.task.result, INSUFFICIENT_EVIDENCE);
    assert.equal(detail.task.error, INSUFFICIENT_EVIDENCE);
    assert.equal(detail.task.state.criticBlocked, true);
    const critic = detail.task.stageTrace?.find((entry) => entry.agent === "critic");
    assert.equal(critic?.outcome, "blocked");
    assert.equal(critic?.metrics.approved, false);
    assert.ok(
      detail.events.some(
        (event) => event.kind === "error" && event.title === "Insufficient evidence",
      ),
      "an event records the block",
    );
    // A blocked task is resumable by the user, like any paused task.
    const resumed = await run.server.agent.control("owner", run.task.id, "resume");
    assert.equal(resumed.status, "queued");
  } finally {
    await run.done();
  }
});

test("a write task whose completion cites a fabricated source is replaced with verification-failed", async (t) => {
  const calls: { name: string; arguments: object }[] = [
    {
      name: "save_memory",
      arguments: { text: "The workshop of Gareth Venn is located in Astoria." },
    },
    {
      name: "finish_task",
      arguments: { summary: "Saved the workshop location. [no-such-source]" },
    },
  ];
  const run = await startTask(
    t,
    (index) => calls[index],
    "Remember this: the workshop of Gareth Venn is located in Astoria.",
  );
  try {
    await run.server.agent.worker.tick();
    const detail = await run.server.agent.detail("owner", run.task.id);
    assert.equal(detail.task.status, "failed");
    assert.equal(detail.task.result, VERIFICATION_FAILED);
    assert.equal(detail.task.error, VERIFICATION_FAILED);
    assert.equal(detail.task.state.verificationFailed, true);
    const verifier = detail.task.stageTrace?.find((entry) => entry.agent === "verifier");
    assert.equal(verifier?.outcome, "blocked");
    assert.equal(verifier?.metrics.citation_paths_valid, false);
  } finally {
    await run.done();
  }
});

test("an unconfirmed run records a blocked critic stage on its trace", async (t) => {
  const run = await startTask(t, () => ({ text: "Thinking out loud." }), "What model are you?");
  try {
    await run.server.agent.worker.tick();
    const task = await run.server.agent.getTask("owner", run.task.id);
    // The bounded auto-continue owns the outcome (requeued once); the
    // spine only records that this run's Critique failed.
    assert.equal(task.status, "queued");
    assert.equal(task.state.autoContinued, true);
    const critic = task.stageTrace?.find((entry) => entry.agent === "critic");
    assert.equal(critic?.outcome, "blocked");
    assert.equal(critic?.metrics.unconfirmed, true);
  } finally {
    await run.done();
  }
});
