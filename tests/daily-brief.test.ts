import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  chunkBriefText,
  classifyBriefTasks,
  DAILY_BRIEF_KIND,
  type DailyBriefSlack,
  deriveLessonsViolated,
  nextDailyBriefRunAt,
  runDailyBriefPass,
  SlackBriefPoster,
  scheduledBriefDate,
} from "../apps/server/src/engine/daily-brief.ts";
import {
  DISTILLATION_RUN_KIND,
  DREAM_DIARY_KIND,
  type DreamDiary,
} from "../apps/server/src/engine/distillation.ts";
import { SKILL_REVIEW_RUN_KIND } from "../apps/server/src/engine/skill-review.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

// Daily Brief (LobeHub operator-reporting pattern, MAP item #8):
// three buckets (finished / running / needs-decision) computed from
// the day's task records, the distillation dream diary embedded,
// lessons-violated derived from the verifier spine's verdicts,
// self-review proposals for repeated lessons, in-app delivery with
// gamma evidence semantics, a per-date-gated Slack post, and the
// scheduled job riding the worker machinery.

const owner = "zeta-user";
const DAY = "2026-11-06";
const NOW = new Date("2026-11-07T15:17:00.000Z");
const WINDOW = { start: `${DAY}T00:00:00.000Z`, end: "2026-11-07T00:00:00.000Z" };

function taskRecord(patch: Partial<AgentTask> & { id: string }): AgentTask {
  return {
    title: patch.id,
    prompt: "test prompt",
    kind: "agent",
    status: "succeeded",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: `${DAY}T01:00:00.000Z`,
    updatedAt: `${DAY}T02:00:00.000Z`,
    attempts: 1,
    artifactIds: [],
    ...patch,
  };
}

function slackDouble(options: { configured?: boolean; fail?: boolean } = {}) {
  const state = { fail: options.fail ?? false };
  const posts: string[] = [];
  const slack: DailyBriefSlack & { posts: string[]; state: typeof state } = {
    posts,
    state,
    configured: options.configured ?? true,
    async post(text: string) {
      posts.push(text);
      return !state.fail;
    },
  };
  return slack;
}

async function seedTask(db: Store, task: AgentTask, taskOwner = owner): Promise<void> {
  await db.put(taskOwner, "tasks", task);
}

test("scheduling helpers are deterministic: morning slot, yesterday's brief", () => {
  assert.equal(scheduledBriefDate(new Date("2026-11-07T15:17:00.000Z")), DAY);
  // Before today's 15:00 UTC slot, the next run is today's.
  assert.equal(
    nextDailyBriefRunAt(new Date("2026-11-07T10:00:00.000Z")),
    "2026-11-07T15:00:00.000Z",
  );
  // After it, the next run is tomorrow's — never twice in a day.
  assert.equal(
    nextDailyBriefRunAt(new Date("2026-11-07T15:00:00.000Z")),
    "2026-11-08T15:00:00.000Z",
  );
  assert.equal(
    nextDailyBriefRunAt(new Date("2026-11-07T23:59:00.000Z")),
    "2026-11-08T15:00:00.000Z",
  );
  // Long Slack text chunks within the bridge's limits.
  const chunks = chunkBriefText("line\n".repeat(3000));
  assert.ok(chunks.length >= 2 && chunks.length <= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 3900));
});

test("buckets split the day's tasks and the brief job never lists itself", () => {
  const tasks = [
    taskRecord({ id: "done", status: "succeeded", result: "Shipped it." }),
    taskRecord({ id: "old", status: "succeeded", updatedAt: "2026-11-05T02:00:00.000Z" }),
    taskRecord({ id: "live", status: "running", updatedAt: "2026-11-07T09:00:00.000Z" }),
    taskRecord({ id: "queued", status: "queued", updatedAt: "2026-11-07T09:00:00.000Z" }),
    taskRecord({ id: "waiting", status: "waiting_input", question: "Which hall?" }),
    taskRecord({ id: "approval", status: "waiting_approval" }),
    taskRecord({
      id: "blocked",
      status: "paused",
      state: { criticBlocked: true },
      error: "Insufficient evidence",
    }),
    taskRecord({ id: "paused-plain", status: "paused" }),
    taskRecord({
      id: "self",
      status: "running",
      input: { dailyBrief: true },
      updatedAt: "2026-11-07T09:00:00.000Z",
    }),
  ];
  const buckets = classifyBriefTasks(tasks, WINDOW);
  assert.deepEqual(
    buckets.finished.map((item) => item.taskId),
    ["done"],
  );
  assert.equal(buckets.finished[0].detail, "Shipped it.");
  assert.deepEqual(
    buckets.running.map((item) => item.taskId),
    ["live", "queued"],
  );
  assert.deepEqual(
    buckets.needsDecision.map((item) => item.taskId),
    ["waiting", "approval", "blocked"],
  );
  assert.equal(buckets.needsDecision[0].detail, "Which hall?");
});

test("lessons are derived from the verifier spine's verdicts, windowed to the day", () => {
  const tasks = [
    taskRecord({ id: "v1", status: "failed", state: { verificationFailed: true } }),
    taskRecord({ id: "v2", status: "failed", state: { verificationFailed: true } }),
    taskRecord({ id: "c1", status: "paused", state: { criticBlocked: true } }),
    taskRecord({
      id: "u1",
      status: "failed",
      stageTrace: [
        {
          sequence: 3,
          agent: "critic",
          outcome: "blocked",
          summary: "Blocked the run because it ended without confirming completion.",
          metrics: { approved: false, unconfirmed: true },
        },
      ],
    }),
    // Yesterday's violation is not today's lesson.
    taskRecord({
      id: "old",
      status: "failed",
      state: { verificationFailed: true },
      updatedAt: "2026-11-05T02:00:00.000Z",
    }),
  ];
  const lessons = deriveLessonsViolated(tasks, WINDOW);
  assert.equal(lessons.length, 3);
  assert.equal(lessons[0].lesson, "verification_failed");
  assert.equal(lessons[0].count, 2);
  assert.deepEqual(lessons[0].taskIds, ["v1", "v2"]);
  assert.equal(lessons.find((lesson) => lesson.lesson === "critic_blocked")?.count, 1);
  assert.equal(lessons.find((lesson) => lesson.lesson === "unconfirmed_run")?.count, 1);
});

test("the brief carries buckets, diary, lessons and proposals — and posts to Slack once", async () => {
  const db = await createStore();
  try {
    await seedTask(db, taskRecord({ id: "done", status: "succeeded", result: "Shipped it." }));
    await seedTask(
      db,
      taskRecord({ id: "v1", status: "failed", state: { verificationFailed: true } }),
    );
    await seedTask(
      db,
      taskRecord({ id: "v2", status: "failed", state: { verificationFailed: true } }),
    );
    await seedTask(
      db,
      taskRecord({ id: "waiting", status: "waiting_input", question: "Which hall?" }),
    );
    const diary: DreamDiary = {
      id: DAY,
      date: DAY,
      runId: "run-1",
      markdown: `# Dream Diary: ${DAY}\n\nSettled one fact.`,
      createdAt: `${DAY}T02:17:00.000Z`,
    };
    await db.put(owner, DREAM_DIARY_KIND, diary);
    await db.put(owner, DISTILLATION_RUN_KIND, {
      id: "run-1",
      date: DAY,
      trigger: "scheduled",
      status: "partial",
      sources: 1,
      distilled: 1,
      duplicates: 0,
      settled: 0,
      alreadySettled: 0,
      supersessionCandidates: 0,
      superseded: 0,
      alreadySuperseded: 0,
      issues: ["Mem0 (the main lane) did not accept every fact; unsettled facts stay retryable"],
      failureSignature: "distillation lane failure",
      deliveryStatus: null,
      diaryDate: DAY,
      createdAt: `${DAY}T02:17:00.000Z`,
    });
    const slack = slackDouble();
    const outcome = await runDailyBriefPass({
      db,
      owner,
      slack,
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    const { brief } = outcome;
    assert.equal(brief.status, "succeeded");
    assert.equal(brief.finishedCount, 3);
    assert.equal(brief.needsDecisionCount, 1);
    assert.equal(brief.diaryDate, DAY);
    assert.match(brief.diaryMarkdown ?? "", /Dream Diary/);
    assert.equal(brief.lessonsViolated.length, 1);
    assert.equal(brief.lessonsViolated[0].lesson, "verification_failed");
    // Two proposals: the repeated lesson (twice-rule) and the
    // partial distillation run.
    assert.equal(brief.selfReviewProposals.length, 2);
    assert.deepEqual(brief.selfReviewProposals.map((proposal) => proposal.source).sort(), [
      "distillation",
      "lessons",
    ]);
    assert.match(brief.markdown, new RegExp(`# Daily Brief: ${DAY}`));
    assert.match(brief.markdown, /Needs your decision \(1\)/);
    assert.match(brief.markdown, /keeps breaking/);
    assert.match(brief.markdown, /Dream Diary/);
    // Slack: exactly one post, carrying the compact brief.
    assert.equal(brief.slackDeliveryStatus, "delivered");
    assert.equal(slack.posts.length, 1);
    assert.match(slack.posts[0], /Daily Brief/);
    assert.match(slack.posts[0], /Needs your decision: 1/);

    // The per-date gate: a re-run never posts the same date twice.
    const again = await runDailyBriefPass({
      db,
      owner,
      slack,
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.equal(again.brief.slackDeliveryStatus, "already_delivered");
    assert.equal(slack.posts.length, 1, "the re-run posted nothing new");
    // One record per date: the re-run updated the same brief
    // instead of piling up a duplicate.
    assert.equal((await db.list(owner, DAILY_BRIEF_KIND)).length, 1);
    assert.equal(again.brief.id, DAY);
  } finally {
    await db.close();
  }
});

test("pending skill writes from the background review land in needs-decision", async () => {
  const db = await createStore();
  try {
    await seedTask(
      db,
      taskRecord({ id: "waiting", status: "waiting_input", question: "Which hall?" }),
    );
    const pendingWrite = {
      id: "pending-1",
      op: { action: "create" as const, name: "bank-shot-drills", content: "# Bank shot drills" },
      action: "create" as const,
      skillName: "bank-shot-drills",
      provenance: "background_review" as const,
      status: "pending" as const,
      rationale: "The bank-shot workflow has now succeeded twice.",
      fingerprint: "abc123",
      reviewRunId: "review-1",
      warnings: [],
      createdAt: `${DAY}T03:17:00.000Z`,
      decidedAt: null,
    };
    await db.put(owner, "skill-pending-writes", pendingWrite);
    // A decided write is not a decision the operator still owes.
    await db.put(owner, "skill-pending-writes", {
      ...pendingWrite,
      id: "pending-2",
      status: "approved" as const,
      decidedAt: `${DAY}T04:00:00.000Z`,
    });
    const outcome = await runDailyBriefPass({
      db,
      owner,
      slack: slackDouble({ configured: false }),
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.equal(outcome.brief.needsDecisionCount, 2);
    const skillItem = outcome.brief.needsDecision.find(
      (item) => item.status === "pending_skill_write",
    );
    assert.ok(skillItem);
    assert.equal(skillItem.taskId, "pending-1");
    assert.match(skillItem.title, /bank-shot-drills/);
    assert.match(skillItem.detail ?? "", /succeeded twice/);
    assert.match(outcome.brief.markdown, /Skill proposal: create "bank-shot-drills"/);
  } finally {
    await db.close();
  }
});

test("the latest skill review run is summarised in the self-review proposals", async () => {
  const db = await createStore();
  try {
    await db.put(owner, SKILL_REVIEW_RUN_KIND, {
      id: "review-1",
      date: DAY,
      trigger: "scheduled",
      status: "succeeded",
      tasksReviewed: 4,
      succeededTasks: 3,
      failedTasks: 1,
      proposals: 2,
      creates: 1,
      patches: 1,
      files: 0,
      skipped: 0,
      issues: [],
      failureSignature: null,
      deliveryStatus: null,
      createdAt: `${DAY}T03:17:00.000Z`,
    });
    const outcome = await runDailyBriefPass({
      db,
      owner,
      slack: slackDouble({ configured: false }),
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    const reviewProposals = outcome.brief.selfReviewProposals.filter(
      (proposal) => proposal.source === "skill_review",
    );
    assert.equal(reviewProposals.length, 1);
    assert.match(reviewProposals[0].title, /2 staged proposal/);
    assert.match(reviewProposals[0].detail, /1 new skill\(s\), 1 patch\(es\)/);
    assert.match(outcome.brief.markdown, /Decide the skill review's 2 staged proposal\(s\)/);
    // A brief for a date with no review of its own falls back to
    // the latest run on record — its staged proposals are still
    // decisions owed.
    const other = await runDailyBriefPass({
      db,
      owner,
      slack: slackDouble({ configured: false }),
      date: "2026-11-05",
      trigger: "manual",
      now: NOW,
    });
    assert.equal(
      other.brief.selfReviewProposals.filter((proposal) => proposal.source === "skill_review")
        .length,
      1,
    );
  } finally {
    await db.close();
  }
});

test("Slack problems degrade the delivery record, never the brief", async () => {
  const db = await createStore();
  try {
    await seedTask(db, taskRecord({ id: "done", status: "succeeded" }));
    const unconfigured = await runDailyBriefPass({
      db,
      owner,
      slack: slackDouble({ configured: false }),
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.equal(unconfigured.brief.status, "succeeded");
    assert.equal(unconfigured.brief.slackDeliveryStatus, "not_configured");
    assert.equal(unconfigured.brief.diaryMarkdown, null);
    assert.match(unconfigured.brief.markdown, /No dream diary entry/);

    const failing = slackDouble({ fail: true });
    const failed = await runDailyBriefPass({
      db,
      owner,
      slack: failing,
      date: DAY,
      trigger: "manual",
      now: NOW,
    });
    assert.equal(failed.brief.status, "succeeded");
    assert.equal(failed.brief.slackDeliveryStatus, "delivery_failed");
    assert.equal(failing.posts.length, 1, "the post was attempted and its failure recorded");
  } finally {
    await db.close();
  }
});

test("an invalid day is a recorded blocked_config brief with no Slack attempt", async () => {
  const db = await createStore();
  try {
    const slack = slackDouble();
    const outcome = await runDailyBriefPass({
      db,
      owner,
      slack,
      date: "2026-02-30",
      trigger: "scheduled",
      now: NOW,
    });
    assert.equal(outcome.brief.status, "blocked_config");
    assert.equal(outcome.brief.slackDeliveryStatus, "not_attempted");
    assert.equal(outcome.preflightIssues.length, 1);
    assert.equal(slack.posts.length, 0);
    assert.equal((await db.list(owner, DAILY_BRIEF_KIND)).length, 1, "the block is recorded");
  } finally {
    await db.close();
  }
});

test("the Slack poster speaks chat.postMessage with the bot token, by value", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const poster = new SlackBriefPoster("xoxb-test", "C123", (async (
    url: string,
    init: RequestInit,
  ) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch);
  assert.equal(poster.configured, true);
  assert.equal(await poster.post("hello team"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer xoxb-test");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { channel: "C123", text: "hello team" });

  const rejected = new SlackBriefPoster(
    "xoxb-test",
    "C123",
    (async () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
      })) as typeof fetch,
  );
  assert.equal(
    await rejected.post("hello"),
    false,
    "a Slack rejection reports false, never throws",
  );
  const unconfigured = new SlackBriefPoster(undefined, "C123");
  assert.equal(unconfigured.configured, false);
  assert.equal(await unconfigured.post("hello"), false);
});

test("the Slack poster's postForTs returns the message ts, by value (PR-iota)", async () => {
  const poster = new SlackBriefPoster(
    "xoxb-test",
    "C123",
    (async () =>
      new Response(JSON.stringify({ ok: true, ts: "1794550000.000100" }), {
        status: 200,
      })) as typeof fetch,
  );
  assert.equal(await poster.postForTs("a consult question"), "1794550000.000100");

  const rejected = new SlackBriefPoster(
    "xoxb-test",
    "C123",
    (async () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
      })) as typeof fetch,
  );
  assert.equal(await rejected.postForTs("hello"), undefined, "a rejection reports undefined");

  const noTs = new SlackBriefPoster(
    "xoxb-test",
    "C123",
    (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
  );
  assert.equal(await noTs.postForTs("hello"), undefined, "no ts in the response reports undefined");

  const unconfigured = new SlackBriefPoster(undefined, "C123");
  assert.equal(await unconfigured.postForTs("hello"), undefined);
});

// --- App-level: manual trigger + scheduled job over HTTP ---

async function makeServer(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-daily-brief-"));
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
    integrations: {},
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

test("the manual trigger builds the brief and the brief is served authenticated", async (t) => {
  const { db, server } = await makeServer(t);
  const token = await sessionToken(server.app);
  const yesterday = scheduledBriefDate(new Date());
  await seedTask(
    db,
    taskRecord({
      id: "app-done",
      title: "Yesterday's finished task",
      status: "succeeded",
      result: "All done.",
      createdAt: `${yesterday}T09:00:00.000Z`,
      updatedAt: `${yesterday}T10:00:00.000Z`,
    }),
    appOwner,
  );
  const unauthenticated = await server.app.request("/api/agent/brief/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthenticated.status, 401);
  const response = await server.app.request("/api/agent/brief/run", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = (await response.json()) as {
    brief: {
      date: string;
      status: string;
      finishedCount: number;
      deliveryStatus: string;
      slackDeliveryStatus: string;
    };
  };
  assert.equal(payload.brief.date, yesterday);
  assert.equal(payload.brief.status, "succeeded");
  assert.equal(payload.brief.finishedCount, 1);
  assert.equal(payload.brief.deliveryStatus, "delivered");
  // No Slack env in the test app: recorded honestly, not hidden.
  assert.equal(payload.brief.slackDeliveryStatus, "not_configured");
  const served = await server.app.request(`/api/agent/brief?date=${yesterday}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(served.status, 200);
  const brief = (await served.json()) as { markdown: string };
  assert.match(brief.markdown, /Yesterday's finished task/);
  const list = await server.app.request("/api/agent/briefs", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(((await list.json()) as unknown[]).length, 1);
  // Idempotent generation: running the same date again updates
  // the one brief record instead of duplicating it.
  const rerun = await server.app.request("/api/agent/brief/run", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(rerun.status, 200);
  const listAfter = await server.app.request("/api/agent/briefs", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(((await listAfter.json()) as unknown[]).length, 1);
  const missing = await server.app.request("/api/agent/brief?date=1999-01-01", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(missing.status, 404);
  const audit = await server.agent.auditEvents(appOwner);
  assert.ok(audit.some((event) => event.operation === "brief.completed"));
});

test("the scheduled daily-brief job rides the worker and reschedules for the next morning", async (t) => {
  const { db, server } = await makeServer(t);
  const token = await sessionToken(server.app);
  const created = await server.app.request("/api/agent/brief/schedule", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const job = (await created.json()) as { id: string; status: string; nextRunAt?: string };
  assert.equal(job.status, "scheduled");
  assert.ok(job.nextRunAt && Date.parse(job.nextRunAt) > Date.now());
  // Idempotent: ensuring the job again returns the same task.
  const again = await server.agent.ensureDailyBriefJob(appOwner);
  assert.equal(again.id, job.id);
  // Force it due and let the worker run it.
  await db.compareAndSwap(
    appOwner,
    "tasks",
    job.id,
    { status: "scheduled" },
    { nextRunAt: "2020-01-01T00:00:00.000Z" },
  );
  await server.agent.worker.tick();
  const task = await server.agent.getTask(appOwner, job.id);
  assert.equal(task.status, "scheduled", "the job reschedules instead of finishing");
  assert.ok(task.nextRunAt && Date.parse(task.nextRunAt) > Date.now());
  const briefs = await server.agent.dailyBriefs(appOwner);
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0].trigger, "scheduled");
  assert.equal(briefs[0].date, scheduledBriefDate(new Date()));
  assert.equal(briefs[0].status, "succeeded");
  const audit = await server.agent.auditEvents(appOwner);
  assert.ok(audit.some((event) => event.operation === "brief.completed"));
});
