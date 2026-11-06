import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  isLengthFinish,
  TRUNCATION_MARKER,
  withTruncationMarker,
} from "../apps/server/src/engine/model.ts";
import { fixture as computerFixture } from "./helpers/computer.ts";
import { modelFixture } from "./helpers/model.ts";

// Silent truncation (ATLAS audit 2026-11-06, Priority 1): a task asking
// for 10 houseplant tips "succeeded" with its result cut mid-sentence
// at the per-call output-token cap (MODEL_MAX_OUTPUT_TOKENS=512) —
// items 4–10 missing and no sign anywhere that the answer was cut.
// The provider signal for that cut, verified in the installed stack,
// is the AI SDK's unified finishReason "length": the fixture below
// ends a response with response.incomplete /
// incomplete_details.reason "max_output_tokens", which @ai-sdk/openai
// maps to "length" and CopilotKit's BuiltInAgent surfaces on the
// AG-UI RUN_FINISHED event. A capped finish must mark the stored
// result; a normal finish must not.

test("isLengthFinish matches only the length finish reason", () => {
  assert.equal(isLengthFinish("length"), true);
  for (const other of ["stop", "tool-calls", "content-filter", "error", "other", undefined, null])
    assert.equal(isLengthFinish(other), false, `finishReason ${String(other)}`);
});

test("withTruncationMarker appends the marker once, as the final line", () => {
  const marked = withTruncationMarker("1. Match the light.\n4. Water the bed");
  assert.equal(marked, `1. Match the light.\n4. Water the bed\n\n${TRUNCATION_MARKER}`);
  assert.equal(withTruncationMarker(marked), marked);
  assert.equal(withTruncationMarker(""), "");
});

async function runFixtureTask(
  t: Parameters<typeof modelFixture>[0],
  reply: Parameters<typeof modelFixture>[1],
  prompt: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-truncation-"));
  const db = await createStore();
  await modelFixture(t, reply);
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
  try {
    const task = await server.agent.createTask("owner", { prompt, kind: "agent" });
    await server.agent.worker.tick();
    return await server.agent.detail("owner", task.id);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const CUT_SUMMARY =
  "10 practical tips for keeping a houseplant alive indoors:\n\n1. Match the light.\n2. Use a pot with drainage holes.\n4. Water the bed";

test("a capped finish marks the stored result and records the truncation", async (t) => {
  const detail = await runFixtureTask(
    t,
    (index) =>
      index === 0
        ? { name: "finish_task", arguments: { summary: CUT_SUMMARY } }
        : // The run's final model call stops on the output-token cap.
          { text: "Here are the tips.", incomplete: true },
    "List 10 practical tips for keeping a houseplant alive indoors",
  );
  assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
  assert.equal(detail.task.result, `${CUT_SUMMARY}\n\n${TRUNCATION_MARKER}`);
  assert.equal(detail.task.state.truncated, true);
  assert.ok(
    detail.events.some(
      (event) => event.kind === "observation" && event.title === "Output truncated",
    ),
    "an observation event records the truncation",
  );
});

test("a capped run with no confirmed outcome marks the stored update text", async (t) => {
  const cutText = "1. Match the light.\n4. Water the bed";
  const detail = await runFixtureTask(
    t,
    () => ({ text: cutText, incomplete: true }),
    "List 10 practical tips for keeping a houseplant alive indoors",
  );
  assert.equal(detail.task.status, "waiting_input", detail.task.error ?? undefined);
  assert.equal(detail.task.state.lastUpdate, `${cutText}\n\n${TRUNCATION_MARKER}`);
  assert.equal(detail.task.state.truncated, true);
  assert.ok(
    detail.events.some(
      (event) => event.kind === "observation" && event.title === "Output truncated",
    ),
    "an observation event records the truncation",
  );
});

test("a normal finish stores the result with no marker and no truncation record", async (t) => {
  const summary = "All ten tips, complete and checked.";
  const detail = await runFixtureTask(
    t,
    (index) => (index === 0 ? { name: "finish_task", arguments: { summary } } : { text: "Done." }),
    "List 10 practical tips for keeping a houseplant alive indoors",
  );
  assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
  assert.equal(detail.task.result, summary);
  assert.equal(detail.task.state.truncated, undefined);
  assert.ok(
    !detail.events.some((event) => event.title === "Output truncated"),
    "no truncation event on a clean finish",
  );
});
