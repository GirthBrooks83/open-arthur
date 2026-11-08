import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  decideIncident,
  INCIDENT_REMINDER_MS,
  isSilentOutput,
  normalizeErrorSignature,
  preflightMonitorJob,
} from "../apps/server/src/engine/cron.ts";
import type { AgentNotification, AgentTask, Monitor } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

// Cron semantics for scheduled runs (Hermes cherry-picks, MAP
// Tier 1 item #4): preflight -> blocked_config with no model call,
// execution != delivery (delivered only on positive evidence;
// delivery_failed vs delivery_unverified), crashed attempts ->
// unknown and never auto-rerun, incident dedup by normalized error
// signature, and [SILENT] suppressing success delivery only.

const owner = "cron-user";

async function makeServer(t: { after: (fn: () => Promise<void>) => void }, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-cron-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    ...extra,
  });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, server };
}

async function setSamplePage(db: Store, text: string) {
  await db.put(owner, "sample-pages", { id: "availability", text });
}

async function noticesFor(db: Store, taskId: string) {
  return (await db.list<AgentNotification>(owner, "notifications")).filter(
    (notice) => notice.taskId === taskId,
  );
}

async function forceDue(db: Store, taskId: string) {
  await db.compareAndSwap(
    owner,
    "tasks",
    taskId,
    { status: "scheduled" },
    { nextRunAt: "2020-01-01T00:00:00.000Z" },
  );
}

test("error signatures fold away the parts that change between ticks of one failure", () => {
  const a = normalizeErrorSignature(
    "Fetch failed for https://example.com/page at 12:03 after 500 ms (request 123e4567-e89b-12d3-a456-426614174000)",
  );
  const b = normalizeErrorSignature(
    "fetch failed for https://example.com/other at 13:45 after 2500 ms (request 123e4567-e89b-12d3-a456-426614174999)",
  );
  assert.equal(a, b);
  assert.notEqual(a, normalizeErrorSignature("Browser worker unavailable"));
});

test("incident decisions alert once, suppress repeats, remind after ~6h, and re-arm on a new signature", () => {
  const now = 1_000_000;
  const first = decideIncident(null, "sig-a", "hash-a", now);
  assert.equal(first.action, "alert");
  const repeat = decideIncident(first.incident, "sig-a", "hash-a", now + 60_000);
  assert.equal(repeat.action, "suppress");
  assert.equal(repeat.incident.count, 2);
  const reminded = decideIncident(
    repeat.incident,
    "sig-a",
    "hash-a",
    now + INCIDENT_REMINDER_MS + 1,
  );
  assert.equal(reminded.action, "remind");
  assert.equal(reminded.incident.reminders, 1);
  // A different signature is a new incident and alerts immediately.
  const other = decideIncident(
    reminded.incident,
    "sig-b",
    "hash-b",
    now + INCIDENT_REMINDER_MS + 2,
  );
  assert.equal(other.action, "alert");
  assert.equal(other.incident.count, 1);
});

test("preflight validates the job definition, prerequisites and delivery target", () => {
  const task = {
    id: "task-1",
    prompt: "Watch https://example.com",
    kind: "monitor",
    input: { monitorId: "mon-1" },
  } as unknown as AgentTask;
  const monitor = {
    id: "mon-1",
    taskId: "task-1",
    title: "Watch",
    url: "https://example.com",
    condition: "change",
    value: "",
    intervalMinutes: 15,
    status: "active",
    nextCheckAt: new Date().toISOString(),
    checks: 0,
  } as Monitor;
  assert.deepEqual(preflightMonitorJob(task, monitor, { mode: "sample" }), []);
  assert.ok(preflightMonitorJob(task, null, { mode: "sample" }).length > 0);
  assert.ok(
    preflightMonitorJob(task, { ...monitor, url: "ftp://example.com" }, { mode: "sample" }).length >
      0,
  );
  assert.ok(
    preflightMonitorJob(task, { ...monitor, taskId: "other-task" }, { mode: "sample" }).length > 0,
  );
  assert.ok(
    preflightMonitorJob(task, { ...monitor, url: "sample://availability" }, { mode: "live" })
      .length > 0,
  );
  assert.ok(
    preflightMonitorJob(
      task,
      { ...monitor, condition: "price_below", value: "abc" },
      { mode: "sample" },
    ).length > 0,
  );
  assert.equal(isSilentOutput("Tables found [SILENT]"), true);
  assert.equal(isSilentOutput("Tables found"), false);
  assert.equal(isSilentOutput(undefined), false);
});

test("preflight blocks a misconfigured scheduled job with blocked_config, one alert and zero model calls", async (t) => {
  const fixture = await modelFixture(t, () => ({ text: "must never be called" }));
  const { db, server } = await makeServer(t, {
    agentBackend: "model",
    model: "openai/fixture",
  });
  await setSamplePage(db, "No tables available");
  const monitor = await server.agent.createMonitor(owner, {
    title: "Dinner availability",
    url: "sample://availability",
    condition: "change",
    intervalMinutes: 1,
  });
  // Corrupt the stored definition after creation (a config edit the
  // creation-time validation never saw): the source is no longer a
  // public HTTP(S) page.
  const stored = await db.get<Monitor>(owner, "monitors", monitor.id);
  assert.ok(stored);
  await db.put(owner, "monitors", { ...stored, url: "ftp://example.com/menu" });
  await server.agent.worker.tick();
  const task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.status, "blocked_config");
  assert.equal(task.attempts, 1);
  assert.match(task.error ?? "", /blocked by its configuration/);
  assert.equal(fixture.requests.length, 0, "preflight must run before any model call");
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "paused");
  // The alert fires once: the blocked state is terminal, so further
  // ticks never re-run or re-alert.
  await server.agent.worker.tick();
  const alerts = (await noticesFor(db, monitor.taskId)).filter(
    (notice) => notice.title === "Watch blocked — configuration needs attention",
  );
  assert.equal(alerts.length, 1);
  assert.equal((await server.agent.getTask(owner, monitor.taskId)).attempts, 1);
  const audit = await server.agent.auditEvents(owner);
  const blocked = audit.find((event) => event.operation === "cron.blocked_config");
  assert.ok(blocked, "the block was audited");
  assert.equal(blocked.outcome, "denied");
  assert.equal(blocked.payload.tasks, 1);
});

test("a delivered outcome is recorded only on positive evidence from the store", async (t) => {
  const { db, server } = await makeServer(t);
  await setSamplePage(db, "No tables available");
  const monitor = await server.agent.createMonitor(owner, {
    title: "Dinner availability",
    url: "sample://availability",
    condition: "change",
    intervalMinutes: 1,
  });
  await server.agent.worker.tick();
  assert.equal((await noticesFor(db, monitor.taskId)).length, 0);
  await setSamplePage(db, "One table at 7 pm");
  await server.agent.controlMonitor(owner, monitor.id, "check");
  await server.agent.worker.tick();
  const task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.status, "scheduled");
  assert.equal((await noticesFor(db, monitor.taskId)).length, 1);
  const delivery = task.state.delivery as { status: string; attempts: number } | undefined;
  assert.equal(delivery?.status, "delivered");
  assert.equal(delivery?.attempts, task.attempts);
});

test("delivery_failed and delivery_unverified are distinct terminal states", async (t) => {
  const { db, server } = await makeServer(t);
  await setSamplePage(db, "No tables available");
  const monitor = await server.agent.createMonitor(owner, {
    title: "Dinner availability",
    url: "sample://availability",
    condition: "change",
    intervalMinutes: 1,
  });
  await server.agent.worker.tick();
  const original = db.insertIfAbsent.bind(db);
  try {
    // The store rejects notification writes: delivery positively failed.
    (db as { insertIfAbsent: unknown }).insertIfAbsent = async (
      rowOwner: string,
      kind: string,
      value: { id: string },
    ) => {
      if (kind === "notifications") throw new Error("notification store unavailable");
      return original(rowOwner, kind, value);
    };
    await setSamplePage(db, "One table at 7 pm");
    await server.agent.controlMonitor(owner, monitor.id, "check");
    await server.agent.worker.tick();
    let task = await server.agent.getTask(owner, monitor.taskId);
    assert.equal(task.status, "delivery_failed");
    assert.equal((task.state.delivery as { status: string }).status, "delivery_failed");
    assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "paused");
    assert.equal((await noticesFor(db, monitor.taskId)).length, 0);
    let audit = await server.agent.auditEvents(owner);
    assert.ok(audit.some((event) => event.operation === "cron.delivery_failed"));

    // Resume, then a store that accepts the write call but never
    // persists it: no positive evidence can be read back, so the
    // outcome is unverified — a different terminal state.
    await server.agent.controlMonitor(owner, monitor.id, "resume");
    await server.agent.worker.tick();
    (db as { insertIfAbsent: unknown }).insertIfAbsent = async (
      rowOwner: string,
      kind: string,
      value: { id: string },
    ) => {
      if (kind === "notifications") return value; // claims success, stores nothing
      return original(rowOwner, kind, value);
    };
    await setSamplePage(db, "Two tables at 8 pm");
    await server.agent.controlMonitor(owner, monitor.id, "check");
    await server.agent.worker.tick();
    task = await server.agent.getTask(owner, monitor.taskId);
    assert.equal(task.status, "delivery_unverified");
    assert.equal((task.state.delivery as { status: string }).status, "delivery_unverified");
    audit = await server.agent.auditEvents(owner);
    assert.ok(audit.some((event) => event.operation === "cron.delivery_unverified"));
  } finally {
    (db as { insertIfAbsent: unknown }).insertIfAbsent = original;
  }
});

test("a crashed scheduled attempt resolves to unknown and is never auto-rerun", async (t) => {
  const { db, server } = await makeServer(t);
  const now = new Date().toISOString();
  const task: AgentTask = {
    id: "crashed-task",
    title: "Crash watch",
    prompt: "Watch https://example.com",
    kind: "monitor",
    status: "running",
    plan: [],
    evidence: [],
    input: { monitorId: "crashed-monitor" },
    state: {},
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    leaseId: "dead-lease",
    leaseUntil: "2020-01-01T00:00:00.000Z",
    artifactIds: [],
  };
  await db.put(owner, "tasks", task);
  await db.put(owner, "monitors", {
    id: "crashed-monitor",
    taskId: task.id,
    title: "Crash watch",
    url: "https://example.com",
    condition: "change",
    value: "",
    intervalMinutes: 15,
    status: "active",
    nextCheckAt: now,
    checks: 0,
  } satisfies Monitor);
  await db.put(owner, "runs", {
    id: "dead-lease",
    taskId: task.id,
    startedAt: now,
    status: "running",
  });
  await server.agent.worker.tick();
  const settled = await server.agent.getTask(owner, task.id);
  assert.equal(settled.status, "unknown");
  assert.equal(settled.attempts, 1, "the crashed attempt must not be re-run");
  const ledger = await db.get<{ status: string }>(owner, "runs", "dead-lease");
  assert.equal(ledger?.status, "unknown");
  const notices = await noticesFor(db, task.id);
  assert.equal(notices.filter((n) => n.title === "Scheduled run outcome unknown").length, 1);
  const audit = await server.agent.auditEvents(owner);
  assert.ok(audit.some((event) => event.operation === "cron.unknown"));
  // Further ticks leave it unknown and un-attempted.
  await server.agent.worker.tick();
  const after = await server.agent.getTask(owner, task.id);
  assert.equal(after.status, "unknown");
  assert.equal(after.attempts, 1);
});

test("repeated failures with the same signature alert once, remind after ~6h, and re-arm after success", async (t) => {
  const { db, server } = await makeServer(t);
  const monitor = await server.agent.createMonitor(owner, {
    title: "Failing watch",
    url: "https://example.com",
    condition: "change",
    intervalMinutes: 1,
  });
  const attention = async () =>
    (await noticesFor(db, monitor.taskId)).filter((n) => n.title === "Watch needs attention");
  await server.agent.worker.tick();
  let task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.state.failures, 1);
  assert.equal((await attention()).length, 1);
  // Same failure again inside the window: recorded, not re-alerted.
  await forceDue(db, monitor.taskId);
  await server.agent.worker.tick();
  task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.state.failures, 2);
  assert.equal((await attention()).length, 1);
  // Age the open incident past the reminder window: the next failure
  // of the same signature reminds.
  const incident = task.state.incident as { lastAlertAt: number };
  await db.compareAndSwap(
    owner,
    "tasks",
    monitor.taskId,
    { status: "scheduled" },
    {
      state: {
        ...task.state,
        incident: { ...incident, lastAlertAt: Date.now() - INCIDENT_REMINDER_MS - 60000 },
      },
    },
  );
  await forceDue(db, monitor.taskId);
  await server.agent.worker.tick();
  task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.state.failures, 3);
  assert.equal((await attention()).length, 2);
  // A successful check re-arms: point the watch at the sample page.
  const stored = await db.get<Monitor>(owner, "monitors", monitor.id);
  assert.ok(stored);
  await db.put(owner, "monitors", { ...stored, url: "sample://availability" });
  await setSamplePage(db, "No tables available");
  await server.agent.controlMonitor(owner, monitor.id, "check");
  await server.agent.worker.tick();
  task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.state.failures, 0);
  assert.equal(task.state.incident, null);
  // Failing again after the success alerts fresh.
  await db.put(owner, "monitors", { ...stored, url: "https://example.com" });
  await server.agent.controlMonitor(owner, monitor.id, "check");
  await server.agent.worker.tick();
  task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.state.failures, 1);
  assert.equal((await attention()).length, 3);
});

test("[SILENT] suppresses success delivery but never failure delivery", async (t) => {
  const { db, server } = await makeServer(t);
  await setSamplePage(db, "No tables available");
  const monitor = await server.agent.createMonitor(owner, {
    title: "Quiet watch",
    url: "sample://availability",
    condition: "change",
    intervalMinutes: 1,
  });
  await server.agent.worker.tick();
  await setSamplePage(db, "One table at 7 pm [SILENT]");
  await server.agent.controlMonitor(owner, monitor.id, "check");
  await server.agent.worker.tick();
  let task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.status, "scheduled");
  assert.equal((await noticesFor(db, monitor.taskId)).length, 0, "silent success must not deliver");
  assert.equal((task.state.delivery as { status: string }).status, "suppressed_silent");
  // The same watch failing still delivers its failure alert.
  const stored = await db.get<Monitor>(owner, "monitors", monitor.id);
  assert.ok(stored);
  await db.put(owner, "monitors", { ...stored, url: "https://example.com" });
  await server.agent.controlMonitor(owner, monitor.id, "check");
  await server.agent.worker.tick();
  task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.state.failures, 1);
  const failures = (await noticesFor(db, monitor.taskId)).filter(
    (n) => n.title === "Watch needs attention",
  );
  assert.equal(failures.length, 1, "failures always deliver, silent or not");
});
