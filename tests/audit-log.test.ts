import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AuditEvent } from "../apps/server/src/engine/audit.ts";
import {
  AUDIT_LOG_CAP,
  AuditLog,
  auditEventSchema,
  auditPayloadSchema,
} from "../apps/server/src/engine/audit.ts";
import { modelFixture } from "./helpers/model.ts";

// Content-free audit log (Agent-Me port, MAP Tier 1 item #3): the
// schema forbids content by construction — operation is a lowercase
// dotted name, outcome is a 3-value enum, and the payload carries
// integer counts only (<=10 keys). The log self-trims at its cap.

const validEvent = {
  id: "event-1",
  at: "2026-11-07T00:00:00.000Z",
  operation: "task.created",
  outcome: "succeeded",
  payload: { tasks: 1 },
} as const;

test("the schema accepts donor-shaped events and defaults an empty payload", () => {
  const parsed = auditEventSchema.parse(validEvent);
  assert.equal(parsed.operation, "task.created");
  assert.deepEqual(parsed.payload, { tasks: 1 });
  const bare = auditEventSchema.parse({
    id: "event-2",
    at: "2026-11-07T00:00:00.000Z",
    operation: "memory.saved",
    outcome: "denied",
  });
  assert.deepEqual(bare.payload, {});
  assert.equal(AUDIT_LOG_CAP, 10000);
});

test("the schema rejects bad operation names and outcomes", () => {
  for (const operation of [
    "Task.created",
    "task created",
    "task-created",
    "1task.created",
    ".task.created",
    "",
    `a${"b".repeat(80)}`,
  ])
    assert.throws(() => auditEventSchema.parse({ ...validEvent, operation }), Error, operation);
  for (const outcome of ["completed", "blocked", "ok", "SUCCEEDED", ""])
    assert.throws(() => auditEventSchema.parse({ ...validEvent, outcome }), Error, outcome);
});

test("the payload schema rejects anything that is not integer counts", () => {
  // Strings, floats, negatives, booleans and nulls can never be
  // recorded — this is the content-freeness guarantee.
  for (const payload of [
    { tasks: "one" },
    { tasks: 1.5 },
    { tasks: -1 },
    { tasks: true },
    { tasks: null },
    { error: "some exception text" },
  ])
    assert.throws(() => auditPayloadSchema.parse(payload), Error, JSON.stringify(payload));
  assert.throws(() => auditEventSchema.parse({ ...validEvent, payload: { tasks: "1" } }));
  // More than 10 keys is rejected, exactly 10 parses. (Donor count
  // keys are letters/underscores only, so the keys here use letters.)
  const letters = "abcdefghijk";
  const eleven: Record<string, number> = {};
  for (let index = 0; index < 11; index++) eleven[`count_${letters[index]}`] = index;
  assert.throws(() => auditPayloadSchema.parse(eleven));
  const ten: Record<string, number> = {};
  for (let index = 0; index < 10; index++) ten[`count_${letters[index]}`] = index;
  assert.deepEqual(auditPayloadSchema.parse(ten), ten);
  assert.throws(() => auditPayloadSchema.parse({ count_0: 1 }));
  // Count keys follow the donor's lowercase snake pattern.
  assert.throws(() => auditPayloadSchema.parse({ Tasks: 1 }));
  assert.throws(() => auditPayloadSchema.parse({ "task count": 1 }));
});

test("append and read round-trip through the store, newest first", async () => {
  const db = await createStore();
  try {
    const log = new AuditLog(db);
    const first = await log.record("owner", "task.created", "succeeded", { tasks: 1 });
    assert.ok(first.id);
    assert.ok(first.at);
    await log.record("owner", "task.started", "succeeded", { tasks: 1, attempts: 1 });
    await log.record("owner", "task.failed", "failed", { tasks: 1 });
    // Another owner's events are never mixed in.
    await log.record("other-owner", "task.created", "succeeded", { tasks: 1 });
    const events = await log.events("owner");
    assert.deepEqual(
      events.map((event) => event.operation),
      ["task.failed", "task.started", "task.created"],
    );
    assert.deepEqual(events[0].payload, { tasks: 1 });
    assert.equal(events[2].id, first.id);
    // The read limit is bounded like the donor's (1..1000).
    assert.equal((await log.events("owner", 2)).length, 2);
    await assert.rejects(() => log.events("owner", 0));
    await assert.rejects(() => log.events("owner", 1001));
    // record() itself validates: content-shaped payloads throw.
    await assert.rejects(() =>
      log.record("owner", "task.created", "succeeded", { note: "text" } as never),
    );
    await assert.rejects(() => log.record("owner", "Task.Created"));
  } finally {
    await db.close();
  }
});

test("the log self-trims at its cap, dropping the oldest events", async () => {
  const db = await createStore();
  try {
    // A small injected cap stands in for the 10,000-row bound.
    const log = new AuditLog(db, 3);
    for (const operation of [
      "task.created",
      "task.started",
      "task.completed",
      "task.created",
      "task.started",
    ])
      await log.record("owner", operation, "succeeded", { tasks: 1 });
    const events = await log.events("owner", 100);
    assert.equal(events.length, 3);
    // The two oldest appends are gone; the newest three remain in
    // newest-first order (distinguished by their append order).
    const all = await db.list<AuditEvent>("owner", "audit-events");
    assert.equal(all.length, 3);
    assert.deepEqual(
      events.map((event) => event.operation),
      ["task.started", "task.created", "task.completed"],
    );
  } finally {
    await db.close();
  }
});

test("task lifecycle transitions emit audit events, served by the authenticated route", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-audit-"));
  const db = await createStore();
  const calls: { name: string; arguments: object }[] = [
    {
      name: "save_memory",
      arguments: { text: "The workshop of Gareth Venn is located in Astoria." },
    },
    { name: "finish_task", arguments: { summary: "Saved the workshop location." } },
  ];
  await modelFixture(t, (index) => calls[index]);
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
    const detail = await server.agent.detail("owner", task.id);
    assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
    const events = await server.agent.auditEvents("owner");
    const operations = events.map((event) => event.operation);
    // The full lifecycle of a grounded write task, counts only.
    for (const expected of [
      "task.created",
      "task.started",
      "memory.saved",
      "verifier.approved",
      "task.completed",
    ])
      assert.ok(operations.includes(expected), `missing ${expected} in ${operations.join(",")}`);
    const completed = events.find((event) => event.operation === "task.completed");
    assert.equal(completed?.outcome, "succeeded");
    assert.equal(completed?.payload.tasks, 1);
    // No event carries anything but integer counts.
    for (const event of events)
      for (const value of Object.values(event.payload))
        assert.ok(Number.isInteger(value) && value >= 0);

    // The read surface: unauthenticated is refused; the session
    // owner's own events come back newest first, capped by limit.
    assert.equal((await server.app.request("/api/agent/audit")).status, 401);
    const session = await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const token = (await session.json()).token as string;
    const headers = { Authorization: `Bearer ${token}` };
    const created = await server.app.request("/api/agent/tasks", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Plan the week" }),
    });
    assert.equal(created.status, 201);
    const response = await server.app.request("/api/agent/audit", { headers });
    assert.equal(response.status, 200);
    const served = (await response.json()) as AuditEvent[];
    assert.ok(served.some((event) => event.operation === "task.created"));
    assert.ok(served.every((event) => auditEventSchema.safeParse(event).success));
    const capped = await server.app.request("/api/agent/audit?limit=1", { headers });
    assert.equal(((await capped.json()) as AuditEvent[]).length, 1);
    // The page-size cap is enforced.
    assert.equal((await server.app.request("/api/agent/audit?limit=101", { headers })).status, 422);
    assert.equal((await server.app.request("/api/agent/audit?limit=0", { headers })).status, 422);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a critic-blocked task emits task.critic_blocked and no completion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-audit-blocked-"));
  const db = await createStore();
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "finish_task", arguments: { summary: "The capital of France is Paris." } }
      : { text: "Done." },
  );
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
      prompt: "What is the capital of France?",
      kind: "agent",
    });
    await server.agent.worker.tick();
    const detail = await server.agent.detail("owner", task.id);
    assert.equal(detail.task.status, "paused");
    assert.equal(detail.task.state.criticBlocked, true);
    const events = await server.agent.auditEvents("owner");
    const blocked = events.find((event) => event.operation === "task.critic_blocked");
    assert.ok(blocked, "the block was audited");
    assert.equal(blocked.outcome, "denied");
    assert.ok(!events.some((event) => event.operation === "task.completed"));
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
