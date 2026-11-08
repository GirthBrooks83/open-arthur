import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  AUTO_CONTINUE_INSTRUCTION,
  UNCONFIRMED_RUN_FAILURE,
} from "../apps/server/src/engine/service.ts";
import { fixture as computerFixture } from "./helpers/computer.ts";
import { modelFixture } from "./helpers/model.ts";

// Silent waiting_input stall (ATLAS audit 2026-11-06, Priority 1): a
// trivial task ("what model are you?") ran, produced no confirmed
// answer, and parked in waiting_input with the canned unconfirmed-run
// message — indefinitely, no answer and no failure. The fix: the
// FIRST unconfirmed end for a task automatically issues ONE follow-up
// run carrying a system instruction to confirm/complete (recorded as
// an "Auto-continue" run event, spend tracked as state.autoContinued).
// A second unconfirmed end fails the task honestly with the reason on
// the record — never parked forever. Hard bound of one auto-continue
// per task. Genuine agent questions (ask_user) are never auto-continued.

async function startFixtureTask(
  t: Parameters<typeof modelFixture>[0],
  reply: Parameters<typeof modelFixture>[1],
  prompt: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-autocontinue-"));
  const db = await createStore();
  const fixture = await modelFixture(t, reply);
  const server = await createApp(
    db,
    {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: directory,
      agentBackend: "model",
      model: "openai/fixture",
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
      computerEnabled: true,
    },
    { docker: computerFixture().runner },
  );
  const task = await server.agent.createTask("owner", { prompt, kind: "agent" });
  return {
    fixture,
    tick: () => server.agent.worker.tick(),
    getTask: () => server.agent.getTask("owner", task.id),
    detail: () => server.agent.detail("owner", task.id),
    done: async () => {
      await server.agent.stop();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const autoContinueEvents = (detail: { events: { kind: string; title: string }[] }) =>
  detail.events.filter((event) => event.title === "Auto-continue");

test("an unconfirmed end issues exactly one auto-continue run, which can then succeed", async (t) => {
  const run = await startFixtureTask(
    t,
    (index) =>
      index === 0
        ? // First run: the agent answers in plain text but never
          // confirms completion — the audit's stall.
          { text: "I am the fixture model." }
        : index === 1
          ? // Continuation run: a real tool result grounds the
            // completion for the Critic gate (verifier spine).
            { name: "read_workspace", arguments: { section: "files" } }
          : index === 2
            ? { name: "finish_task", arguments: { summary: "I am the fixture model." } }
            : { text: "Done." },
    "What model are you?",
  );
  try {
    await run.tick();
    const afterFirst = await run.getTask();
    assert.equal(afterFirst.status, "queued", "the task is requeued, not parked");
    assert.equal(afterFirst.state.autoContinued, true);
    assert.equal(run.fixture.requests.length, 1, "one model run so far");

    await run.tick();
    const detail = await run.detail();
    assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
    assert.equal(detail.task.result, "I am the fixture model.");
    assert.equal(detail.task.state.autoContinued, true);
    assert.equal(
      run.fixture.requests.length,
      4,
      "exactly one continuation run was issued (its tool call + finish_task call + closing call)",
    );
    assert.ok(
      run.fixture.requests[1]?.body.includes(AUTO_CONTINUE_INSTRUCTION),
      "the continuation run's prompt carries the system follow-up instruction",
    );
    const events = autoContinueEvents(detail);
    assert.equal(events.length, 1, "one Auto-continue event in the task log");
    assert.equal(events[0]?.kind, "status");
  } finally {
    await run.done();
  }
});

test("a second unconfirmed end fails the task honestly, with no third run", async (t) => {
  const run = await startFixtureTask(
    t,
    () => ({ text: "Still thinking out loud." }),
    "What model are you?",
  );
  try {
    await run.tick();
    assert.equal((await run.getTask()).status, "queued");
    await run.tick();
    const detail = await run.detail();
    assert.equal(detail.task.status, "failed", "the task is failed, not parked forever");
    assert.equal(detail.task.error, UNCONFIRMED_RUN_FAILURE);
    assert.equal(detail.task.question, null, "the canned question is cleared");
    assert.equal(detail.task.state.autoContinued, true);
    assert.equal(autoContinueEvents(detail).length, 1);
    assert.ok(
      detail.events.some(
        (event) => event.kind === "error" && event.title === "Task needs attention",
      ),
      "an error event records the honest failure",
    );
    assert.equal(run.fixture.requests.length, 2, "two runs total: original + one auto-continue");

    await run.tick();
    assert.equal((await run.getTask()).status, "failed");
    assert.equal(run.fixture.requests.length, 2, "no third run is ever issued");
  } finally {
    await run.done();
  }
});

test("a confirmed completion never auto-continues", async (t) => {
  const summary = "The capital of France is Paris.";
  const run = await startFixtureTask(
    t,
    // A read_workspace tool result grounds the completion for the
    // Critic gate (verifier spine); finish_task alone never grounds
    // its own claim.
    (index) =>
      index === 0
        ? { name: "read_workspace", arguments: { section: "files" } }
        : index === 1
          ? { name: "finish_task", arguments: { summary } }
          : { text: "Done." },
    "What is the capital of France?",
  );
  try {
    await run.tick();
    const settled = await run.detail();
    assert.equal(settled.task.status, "succeeded", settled.task.error ?? settled.task.question);
    assert.equal(settled.task.result, summary);
    assert.equal(settled.task.state.autoContinued, undefined);
    assert.equal(autoContinueEvents(settled).length, 0);
    const calls = run.fixture.requests.length;
    await run.tick();
    assert.equal(run.fixture.requests.length, calls, "no extra run after success");
  } finally {
    await run.done();
  }
});

test("a genuine ask_user question parks for the user and is never auto-continued", async (t) => {
  const run = await startFixtureTask(
    t,
    (index) =>
      index === 0
        ? { name: "ask_user", arguments: { question: "Which city should I plan for?" } }
        : { text: "Paused for the user." },
    "Plan a weekend trip for me",
  );
  try {
    await run.tick();
    const waiting = await run.detail();
    assert.equal(waiting.task.status, "waiting_input");
    assert.equal(waiting.task.question, "Which city should I plan for?");
    assert.equal(waiting.task.state.autoContinued, undefined);
    assert.equal(autoContinueEvents(waiting).length, 0);
    const calls = run.fixture.requests.length;
    await run.tick();
    assert.equal((await run.getTask()).status, "waiting_input");
    assert.equal(run.fixture.requests.length, calls, "no continuation run for a genuine question");
  } finally {
    await run.done();
  }
});
