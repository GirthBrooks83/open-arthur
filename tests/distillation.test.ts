import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  contentHash,
  DISTILLATION_SETTLED_KIND,
  type DistillationLane,
  distillCandidates,
  findSupersessionCandidates,
  isValidDay,
  nextDistillationRunAt,
  normalizeFact,
  runDistillationPass,
  scheduledDistillationDate,
  subjectKey,
} from "../apps/server/src/engine/distillation.ts";
import type { AgentMemory } from "../packages/domain/src/agent.ts";

// Nightly distillation (CowAgent Deep Dream shape, MAP Design Note
// C): deterministic distillation over the day's memories/task
// outcomes, content-hash settle into Mem0 (re-run = no-op),
// supersession candidates handed to Graphiti through its adapter,
// a dated dream diary per run, a manual trigger running the real
// pipeline, the scheduled job riding the worker machinery, and
// lane-down degrading to a recorded partial failure, never a throw.

const owner = "delta-user";
const DAY = "2026-11-06";
const NOW = new Date("2026-11-07T02:17:00.000Z");

function laneDouble(options: { configured?: boolean; fail?: boolean } = {}) {
  const state = { fail: options.fail ?? false };
  const calls: string[] = [];
  const lane: DistillationLane & { calls: string[]; state: typeof state } = {
    calls,
    state,
    configured: options.configured ?? true,
    async add(text: string) {
      calls.push(text);
      return !state.fail;
    },
  };
  return lane;
}

async function seedMemory(
  db: Store,
  text: string,
  createdAt: string,
  memOwner = owner,
): Promise<void> {
  const memory: AgentMemory = {
    id: `mem-${contentHash(text).slice(0, 12)}-${createdAt}`,
    text,
    source: "Test",
    createdAt,
  };
  await db.put(memOwner, "memories", memory);
}

test("normalization, hashing and the subject heuristic are deterministic", () => {
  assert.equal(
    normalizeFact("  The user   plays pool on Wednesdays. "),
    normalizeFact("the user plays pool on wednesdays"),
  );
  assert.equal(
    contentHash("The user plays pool on Wednesdays."),
    contentHash("the user plays pool on wednesdays"),
  );
  assert.notEqual(contentHash("Fact one"), contentHash("Fact two"));
  assert.equal(subjectKey("The user's home hall is Sunset Billiards"), "the user's home hall");
  assert.equal(subjectKey("League night: Wednesday"), "league night");
  assert.equal(subjectKey("Ate lunch"), null);
  assert.equal(isValidDay(DAY), true);
  assert.equal(isValidDay("2026-02-30"), false);
  assert.equal(isValidDay("11/06/2026"), false);
  const next = nextDistillationRunAt(new Date("2026-11-07T10:00:00.000Z"));
  assert.equal(next, "2026-11-08T02:17:00.000Z");
  // Candidates dedupe by normalized content and respect the window.
  const { facts, duplicates, sources } = distillCandidates({
    memories: [
      { id: "1", text: "Fact A", source: "t", createdAt: `${DAY}T01:00:00.000Z` },
      { id: "2", text: "fact a.", source: "t", createdAt: `${DAY}T02:00:00.000Z` },
      { id: "3", text: "Old fact", source: "t", createdAt: "2026-11-01T02:00:00.000Z" },
    ],
    tasks: [],
    window: { start: `${DAY}T00:00:00.000Z`, end: "2026-11-07T00:00:00.000Z" },
  });
  assert.deepEqual(facts, ["Fact A"]);
  assert.equal(duplicates, 1);
  assert.equal(sources, 2);
  const candidates = findSupersessionCandidates(
    ["The user's home hall is Riverside Billiards"],
    ["The user's home hall is Sunset Billiards", "Unrelated older fact"],
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].subject, "the user's home hall");
});

test("hash-settle: a re-run over the same window writes nothing new", async () => {
  const db = await createStore();
  try {
    await seedMemory(db, "The user plays pool on Wednesdays", `${DAY}T10:00:00.000Z`);
    await seedMemory(db, "the user plays pool on wednesdays.", `${DAY}T11:00:00.000Z`);
    await seedMemory(db, "The user's cue is a Pechauer P09-R", `${DAY}T12:00:00.000Z`);
    const mem0 = laneDouble();
    const graphiti = laneDouble();
    const first = await runDistillationPass({
      db,
      owner,
      mem0,
      graphiti,
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.equal(first.run.status, "succeeded");
    assert.equal(first.run.distilled, 2);
    assert.equal(first.run.duplicates, 1);
    assert.equal(first.run.settled, 2);
    assert.equal(first.run.alreadySettled, 0);
    // Exactly one surface form of the duplicated fact settled (the
    // store lists newest first, so the later variant wins), plus the
    // unique fact — two writes for three source memories.
    assert.equal(mem0.calls.length, 2);
    assert.deepEqual(
      mem0.calls.map((call) => normalizeFact(call)).sort(),
      [
        normalizeFact("The user plays pool on Wednesdays"),
        normalizeFact("The user's cue is a Pechauer P09-R"),
      ].sort(),
    );
    assert.equal((await db.list(owner, DISTILLATION_SETTLED_KIND)).length, 2);
    const diaryAfterFirst = first.diary;
    assert.ok(diaryAfterFirst);

    const second = await runDistillationPass({
      db,
      owner,
      mem0,
      graphiti,
      date: DAY,
      trigger: "manual",
      now: new Date("2026-11-07T03:00:00.000Z"),
    });
    assert.equal(second.run.status, "succeeded");
    assert.equal(second.run.settled, 0, "the re-run must settle nothing new");
    assert.equal(second.run.alreadySettled, 2);
    assert.equal(mem0.calls.length, 2, "Mem0 received no second write");
    assert.equal(graphiti.calls.length, 0);
    assert.equal((await db.list(owner, DISTILLATION_SETTLED_KIND)).length, 2);
    // The diary is untouched by the no-op re-run.
    assert.equal(second.diary?.markdown, diaryAfterFirst.markdown);
    assert.equal(second.diary?.runId, diaryAfterFirst.runId);
  } finally {
    await db.close();
  }
});

test("supersession candidates are handed to Graphiti once, with the newer fact", async () => {
  const db = await createStore();
  try {
    await seedMemory(db, "The user's home hall is Sunset Billiards", "2026-11-05T10:00:00.000Z");
    await seedMemory(db, "The user's home hall is Riverside Billiards", `${DAY}T09:00:00.000Z`);
    const mem0 = laneDouble();
    const graphiti = laneDouble();
    const first = await runDistillationPass({
      db,
      owner,
      mem0,
      graphiti,
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.equal(first.run.supersessionCandidates, 1);
    assert.equal(first.run.superseded, 1);
    // The handoff is the adapter's add with exactly the newer fact —
    // Graphiti's own invalidation semantics do the retiring.
    assert.deepEqual(graphiti.calls, ["The user's home hall is Riverside Billiards"]);
    const second = await runDistillationPass({
      db,
      owner,
      mem0,
      graphiti,
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.equal(second.run.superseded, 0);
    assert.equal(second.run.alreadySuperseded, 1);
    assert.equal(graphiti.calls.length, 1, "the candidate is never handed off twice");
  } finally {
    await db.close();
  }
});

test("the dream diary is written with the run's date and counts", async () => {
  const db = await createStore();
  try {
    await seedMemory(db, "The user prefers oat milk", `${DAY}T08:00:00.000Z`);
    const outcome = await runDistillationPass({
      db,
      owner,
      mem0: laneDouble(),
      graphiti: laneDouble(),
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.ok(outcome.diary);
    assert.equal(outcome.diary.date, DAY);
    assert.equal(outcome.diary.id, DAY);
    assert.match(outcome.diary.markdown, new RegExp(`# Dream Diary: ${DAY}`));
    assert.match(outcome.diary.markdown, /Facts distilled: 1/);
    assert.match(outcome.diary.markdown, /Newly settled into Mem0: 1/);
    assert.match(outcome.diary.markdown, /The user prefers oat milk/);
    assert.equal(outcome.run.diaryDate, DAY);
  } finally {
    await db.close();
  }
});

test("a lane being down degrades the run to a recorded partial failure, never a throw", async () => {
  const db = await createStore();
  try {
    await seedMemory(db, "The user is learning Spanish", `${DAY}T08:00:00.000Z`);
    const mem0 = laneDouble({ fail: true });
    const first = await runDistillationPass({
      db,
      owner,
      mem0,
      graphiti: laneDouble(),
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.equal(first.run.status, "partial");
    assert.equal(first.run.settled, 0);
    assert.ok(first.run.issues.length > 0);
    assert.equal(first.run.failureSignature, "distillation lane failure");
    // Nothing was settled, so the fact stays retryable.
    assert.equal((await db.list(owner, DISTILLATION_SETTLED_KIND)).length, 0);
    // The partial run is recorded and still leaves a diary.
    assert.equal((await db.list(owner, "distillation-runs")).length, 1);
    assert.ok(first.diary);
    mem0.state.fail = false;
    const retry = await runDistillationPass({
      db,
      owner,
      mem0,
      graphiti: laneDouble(),
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.equal(retry.run.status, "succeeded");
    assert.equal(retry.run.settled, 1);
  } finally {
    await db.close();
  }
});

test("preflight blocks a run with no lane configured: blocked_config, zero lane calls, no diary", async () => {
  const db = await createStore();
  try {
    await seedMemory(db, "Some fact", `${DAY}T08:00:00.000Z`);
    const mem0 = laneDouble({ configured: false });
    const graphiti = laneDouble({ configured: false });
    const outcome = await runDistillationPass({
      db,
      owner,
      mem0,
      graphiti,
      date: DAY,
      trigger: "scheduled",
      now: NOW,
    });
    assert.equal(outcome.run.status, "blocked_config");
    assert.equal(mem0.calls.length, 0, "preflight runs before any lane call");
    assert.equal(graphiti.calls.length, 0);
    assert.equal(outcome.diary, null);
    assert.equal((await db.list(owner, "distillation-runs")).length, 1, "the block is recorded");
  } finally {
    await db.close();
  }
});

// --- App-level: stub memory lanes speaking the wrapper contract ---

const mem0Adds: string[] = [];
const graphitiAdds: string[] = [];
let mem0Stub: Server, graphitiStub: Server, mem0StubUrl: string, graphitiStubUrl: string;

function laneStub(adds: string[]): Server {
  return createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/add") {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { text?: string };
      if (body.text) adds.push(body.text);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    } else if (request.method === "GET" && url.pathname === "/search") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ facts: [] }));
    } else if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
}

async function listen(stub: Server): Promise<string> {
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const address = stub.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

before(async () => {
  mem0Stub = laneStub(mem0Adds);
  graphitiStub = laneStub(graphitiAdds);
  mem0StubUrl = await listen(mem0Stub);
  graphitiStubUrl = await listen(graphitiStub);
});

after(async () => {
  for (const stub of [mem0Stub, graphitiStub]) {
    stub?.closeAllConnections();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

async function makeServer(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-distillation-"));
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
    integrations: { mem0Url: mem0StubUrl, graphitiUrl: graphitiStubUrl },
  });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, server };
}

async function sessionToken(app: Awaited<ReturnType<typeof createApp>>["app"]): Promise<string> {
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  return (await session.json()).token as string;
}

const appOwner = "local-user";

test("the manual trigger runs the real pipeline and the diary is served authenticated", async (t) => {
  const { db, server } = await makeServer(t);
  const token = await sessionToken(server.app);
  const today = new Date().toISOString().slice(0, 10);
  await seedMemory(db, "The user shoots with a Pechauer cue", `${today}T08:00:00.000Z`, appOwner);
  const unauthenticated = await server.app.request("/api/agent/distillation/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthenticated.status, 401);
  const mem0Before = mem0Adds.length;
  const response = await server.app.request("/api/agent/distillation/run", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = (await response.json()) as {
    run: { status: string; settled: number; deliveryStatus: string };
    diary: { date: string; markdown: string } | null;
  };
  assert.equal(payload.run.status, "succeeded");
  assert.equal(payload.run.settled, 1);
  assert.equal(payload.run.deliveryStatus, "delivered");
  assert.equal(payload.diary?.date, today);
  assert.equal(mem0Adds.length, mem0Before + 1);
  assert.equal(mem0Adds[mem0Adds.length - 1], "The user shoots with a Pechauer cue");
  // The diary read surface serves the entry to the owner.
  const diaryResponse = await server.app.request(`/api/agent/distillation/diary?date=${today}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(diaryResponse.status, 200);
  const diary = (await diaryResponse.json()) as { markdown: string };
  assert.match(diary.markdown, new RegExp(`# Dream Diary: ${today}`));
  // A second manual run is a no-op against the lanes.
  const again = await server.app.request("/api/agent/distillation/run", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const againPayload = (await again.json()) as { run: { settled: number; alreadySettled: number } };
  assert.equal(againPayload.run.settled, 0);
  assert.equal(againPayload.run.alreadySettled, 1);
  assert.equal(mem0Adds.length, mem0Before + 1, "the re-run wrote nothing new to Mem0");
  const audit = await server.agent.auditEvents(appOwner);
  assert.ok(audit.some((event) => event.operation === "distillation.completed"));
});

test("a memory mirrored by remember() is already settled, so distillation never re-writes it", async (t) => {
  const { server } = await makeServer(t);
  const token = await sessionToken(server.app);
  const mem0Before = mem0Adds.length;
  const saved = await server.app.request("/api/agent/memories", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "The user banks with Chime", source: "Test" }),
  });
  assert.equal(saved.status, 201, await saved.clone().text());
  assert.equal(mem0Adds.length, mem0Before + 1, "the save itself mirrored to Mem0 once");
  const outcome = await server.agent.runDistillation(appOwner);
  assert.equal(outcome.run.settled, 0);
  assert.equal(outcome.run.alreadySettled, 1);
  assert.equal(mem0Adds.length, mem0Before + 1, "distillation added no duplicate");
});

test("the scheduled distillation job rides the worker and reschedules nightly", async (t) => {
  const { db, server } = await makeServer(t);
  const token = await sessionToken(server.app);
  const day = scheduledDistillationDate(new Date());
  await seedMemory(
    db,
    "The user practices bank shots on Fridays",
    `${day}T12:00:00.000Z`,
    appOwner,
  );
  const created = await server.app.request("/api/agent/distillation/schedule", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const job = (await created.json()) as { id: string; status: string; nextRunAt?: string };
  assert.equal(job.status, "scheduled");
  assert.ok(job.nextRunAt && Date.parse(job.nextRunAt) > Date.now());
  // Idempotent: ensuring the job again returns the same task.
  const again = await server.agent.ensureDistillationJob(appOwner);
  assert.equal(again.id, job.id);
  // Force it due and let the worker run it.
  await db.compareAndSwap(
    appOwner,
    "tasks",
    job.id,
    { status: "scheduled" },
    { nextRunAt: "2020-01-01T00:00:00.000Z" },
  );
  const mem0Before = mem0Adds.length;
  await server.agent.worker.tick();
  const task = await server.agent.getTask(appOwner, job.id);
  assert.equal(task.status, "scheduled", "the job reschedules instead of finishing");
  assert.ok(task.nextRunAt && Date.parse(task.nextRunAt) > Date.now());
  assert.equal(mem0Adds.length, mem0Before + 1);
  const diary = await server.agent.dreamDiary(appOwner, day);
  assert.ok(diary, "the scheduled run wrote the dream diary");
  assert.match(diary.markdown, /Practices bank shots/i);
  const runs = await server.agent.distillationRuns(appOwner);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, "scheduled");
  assert.equal(runs[0].status, "succeeded");
  const audit = await server.agent.auditEvents(appOwner);
  assert.ok(audit.some((event) => event.operation === "distillation.completed"));
});
