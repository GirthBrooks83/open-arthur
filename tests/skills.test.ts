import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  approvePendingSkillWrite,
  listPendingSkillWrites,
  rejectPendingSkillWrite,
  runSkillReviewPass,
  SKILL_PENDING_KIND,
  type SkillReviewer,
} from "../apps/server/src/engine/skill-review.ts";
import {
  applySkillManage,
  lintSkill,
  listSkills,
  parseSkillMarkdown,
  readSkillFile,
  readSkillMarkdown,
  SKILLS_KIND,
  type SkillManageOp,
  skillManageOpSchema,
} from "../apps/server/src/engine/skills.ts";
import { AppError } from "../apps/server/src/errors.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

// Skill machinery (Hermes skill_manage shape, MAP items #6 + #7,
// Design Note B): per-action schema slots rejected before anything
// applies, patch-preferred edits with read-before-write enforced,
// the advisory linter (warnings, never failures), SKILL.md storage
// with agentskills.io frontmatter and 3-level progressive
// disclosure, and the background review in nightly-batch mode —
// write-approval ON (proposals stage in a pending area and apply
// only on approval), provenance `created_by: background_review`,
// no save-bias (a no-op pass is a correct outcome), the twice-rule
// as the new-skill trigger and the Pitfalls match as the patch
// trigger.

const owner = "epsilon-user";
const DAY = "2026-11-06";

function skillDoc(name: string, body: string, createdBy?: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: Playbook for ${name}.`,
    ...(createdBy ? ["metadata:", `  created_by: ${createdBy}`] : []),
    "---",
    "",
    body,
    "",
  ].join("\n");
}

const deployBody = [
  "## When to Use",
  "",
  "When deploying the app.",
  "",
  "## Procedure",
  "",
  "1. Run the checks.",
  "2. Ship it.",
  "",
  "## Pitfalls",
  "",
  "- The deploy token expires silently; a stale token fails the publish step with no warning.",
  "",
  "## Verification",
  "",
  "- Confirm the live page answers.",
].join("\n");

async function seedSkill(db: Store, name: string, body: string): Promise<void> {
  await applySkillManage(
    db,
    owner,
    { action: "create", name, content: skillDoc(name, body) },
    { createdBy: "operator" },
  );
}

function makeTask(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    title: "Task",
    prompt: "Do the task",
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
    ...overrides,
  };
}

test("schema slots: a call carrying another action's fields is rejected before anything applies", async () => {
  const db = await createStore();
  try {
    // create carrying patch's slot.
    assert.equal(
      skillManageOpSchema.safeParse({
        action: "create",
        name: "alpha",
        content: skillDoc("alpha", "Body."),
        old_string: "x",
      }).success,
      false,
    );
    // patch carrying create's slot.
    assert.equal(
      skillManageOpSchema.safeParse({
        action: "patch",
        name: "alpha",
        old_string: "a",
        new_string: "b",
        content: "full text",
      }).success,
      false,
    );
    // write_file carrying create's slot, and write_file outside references/.
    assert.equal(
      skillManageOpSchema.safeParse({
        action: "write_file",
        name: "alpha",
        file_path: "references/a.md",
        file_content: "x",
        content: "y",
      }).success,
      false,
    );
    assert.equal(
      skillManageOpSchema.safeParse({
        action: "write_file",
        name: "alpha",
        file_path: "SKILL.md",
        file_content: "x",
      }).success,
      false,
    );
    assert.equal(
      skillManageOpSchema.safeParse({
        action: "write_file",
        name: "alpha",
        file_path: "references/../escape.md",
        file_content: "x",
      }).success,
      false,
    );
    // The valid shapes pass.
    assert.equal(
      skillManageOpSchema.safeParse({
        action: "create",
        name: "alpha",
        content: skillDoc("alpha", "Body."),
      }).success,
      true,
    );
    // Nothing was applied by the rejected calls.
    assert.deepEqual(await listSkills(db, owner), []);
  } finally {
    await db.close();
  }
});

test("create stores the SKILL.md with provenance stamped by the caller, and disclosure levels read back", async () => {
  const db = await createStore();
  try {
    // The document claims a forged provenance; the caller's tag wins.
    const result = await applySkillManage(
      db,
      owner,
      {
        action: "create",
        name: "deploy-checklist",
        content: skillDoc("deploy-checklist", deployBody, "operator"),
      },
      { createdBy: "background_review" },
    );
    assert.equal(result.skill.createdBy, "background_review");
    // Level 1: summaries carry frontmatter only.
    const summaries = await listSkills(db, owner);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].name, "deploy-checklist");
    assert.equal(summaries[0].description, "Playbook for deploy-checklist.");
    assert.deepEqual(summaries[0].references, []);
    // Level 2: the full document round-trips.
    const markdown = await readSkillMarkdown(db, owner, "deploy-checklist");
    assert.ok(markdown);
    assert.match(markdown, /created_by: background_review/);
    assert.match(markdown, /## Procedure/);
    // Level 3: a references file, written and read back.
    await applySkillManage(
      db,
      owner,
      {
        action: "write_file",
        name: "deploy-checklist",
        file_path: "references/notes.md",
        file_content: "Extra detail.",
      },
      { createdBy: "operator" },
    );
    assert.equal(
      await readSkillFile(db, owner, "deploy-checklist", "references/notes.md"),
      "Extra detail.",
    );
    const after = await listSkills(db, owner);
    assert.deepEqual(after[0].references, ["references/notes.md"]);
    // Recreating an existing skill is a conflict, not an overwrite.
    await assert.rejects(
      applySkillManage(
        db,
        owner,
        {
          action: "create",
          name: "deploy-checklist",
          content: skillDoc("deploy-checklist", "Other."),
        },
        { createdBy: "operator" },
      ),
      (error: unknown) => error instanceof AppError && error.status === 409,
    );
    // Malformed frontmatter is a hard failure.
    await assert.rejects(
      applySkillManage(
        db,
        owner,
        { action: "create", name: "broken", content: "no frontmatter here" },
        { createdBy: "operator" },
      ),
      (error: unknown) => error instanceof AppError && error.status === 400,
    );
  } finally {
    await db.close();
  }
});

test("patch enforces read-before-write: blind and stale patches are rejected, a fresh read patches", async () => {
  const db = await createStore();
  try {
    await seedSkill(db, "deploy-checklist", deployBody);
    const op: SkillManageOp = {
      action: "patch",
      name: "deploy-checklist",
      old_string: "2. Ship it.",
      new_string: "2. Ship it and watch the deploy.",
    };
    // No read seam at all: rejected.
    await assert.rejects(
      applySkillManage(db, owner, op, { createdBy: "operator" }),
      /read-before-write/,
    );
    // A read seam that was never consulted (returns null): rejected.
    await assert.rejects(
      applySkillManage(db, owner, op, { createdBy: "operator", readSkill: async () => null }),
      /not found/,
    );
    // A stale read (text that is not the current document): rejected.
    await assert.rejects(
      applySkillManage(db, owner, op, {
        createdBy: "operator",
        readSkill: async () => "some older text",
      }),
      /stale/,
    );
    // Nothing changed under the rejections.
    const before = await readSkillMarkdown(db, owner, "deploy-checklist");
    assert.match(before ?? "", /2\. Ship it\./);
    // A fresh read patches cleanly, and provenance is preserved.
    const result = await applySkillManage(db, owner, op, {
      createdBy: "operator",
      readSkill: (name) => readSkillMarkdown(db, owner, name),
    });
    assert.equal(result.skill.createdBy, "operator");
    const after = await readSkillMarkdown(db, owner, "deploy-checklist");
    assert.match(after ?? "", /Ship it and watch the deploy/);
    // An old_string that matches twice is rejected as ambiguous.
    await assert.rejects(
      applySkillManage(
        db,
        owner,
        { action: "patch", name: "deploy-checklist", old_string: "the", new_string: "THE" },
        { createdBy: "operator", readSkill: (name) => readSkillMarkdown(db, owner, name) },
      ),
      /more than once/,
    );
  } finally {
    await db.close();
  }
});

test("the linter warns (oversized body, references sprawl, incident-log shape) and never blocks a write", async () => {
  const bigBody = `## Procedure\n\n${"x".repeat(25_000)}`;
  assert.deepEqual(
    lintSkill({ body: bigBody, referencesCount: 0 }).map((warning) => warning.rule),
    ["oversized_body"],
  );
  assert.deepEqual(
    lintSkill({ body: "short", referencesCount: 61 }).map((warning) => warning.rule),
    ["references_sprawl"],
  );
  const logBody = [
    "## Log",
    "",
    "- 2026-11-01 something failed",
    "- 2026-11-02 it failed again",
    "- 2026-11-03 still failing",
  ].join("\n");
  assert.deepEqual(
    lintSkill({ body: logBody, referencesCount: 0 }).map((warning) => warning.rule),
    ["incident_log_shape"],
  );
  assert.deepEqual(lintSkill({ body: deployBody, referencesCount: 2 }), []);
  // A write that trips a warning still applies, with the warning
  // returned to the caller.
  const db = await createStore();
  try {
    const result = await applySkillManage(
      db,
      owner,
      { action: "create", name: "big-skill", content: skillDoc("big-skill", bigBody) },
      { createdBy: "operator" },
    );
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].rule, "oversized_body");
    assert.equal((await listSkills(db, owner)).length, 1);
  } finally {
    await db.close();
  }
});

test("review no-op pass: a quiet day stages nothing and records a clean run", async () => {
  const db = await createStore();
  try {
    // One success only (below the twice-rule) and nothing failed.
    await db.put(
      owner,
      "tasks",
      makeTask({ id: "t1", title: "Water the plants", status: "succeeded" }),
    );
    const outcome = await runSkillReviewPass({ db, owner, date: DAY, trigger: "manual" });
    assert.equal(outcome.run.status, "succeeded");
    assert.equal(outcome.run.tasksReviewed, 1);
    assert.equal(outcome.run.proposals, 0);
    assert.equal(outcome.pending.length, 0);
    assert.deepEqual(await listPendingSkillWrites(db, owner), []);
    assert.deepEqual(await db.list(owner, SKILLS_KIND), []);
    // A day with no tasks at all is also a clean no-op.
    const empty = await runSkillReviewPass({ db, owner, date: "2026-11-05", trigger: "manual" });
    assert.equal(empty.run.tasksReviewed, 0);
    assert.equal(empty.run.proposals, 0);
  } finally {
    await db.close();
  }
});

test("twice-rule: a workflow that succeeded twice earns a pending create, and only an approval makes it live", async () => {
  const db = await createStore();
  try {
    await db.put(
      owner,
      "tasks",
      makeTask({
        id: "t1",
        title: "File the league scores",
        status: "succeeded",
        updatedAt: "2026-11-04T09:00:00.000Z",
        plan: [
          { id: "0", title: "Collect the scoresheets", status: "succeeded" },
          { id: "1", title: "Enter them in the sheet", status: "succeeded" },
        ],
      }),
    );
    await db.put(
      owner,
      "tasks",
      makeTask({
        id: "t2",
        title: "File the league scores",
        status: "succeeded",
        updatedAt: `${DAY}T09:00:00.000Z`,
        plan: [
          { id: "0", title: "Collect the scoresheets", status: "succeeded" },
          { id: "1", title: "Enter them in the sheet", status: "succeeded" },
        ],
      }),
    );
    // A single success of another workflow earns nothing.
    await db.put(
      owner,
      "tasks",
      makeTask({ id: "t3", title: "Book a court", status: "succeeded" }),
    );
    const outcome = await runSkillReviewPass({ db, owner, date: DAY, trigger: "manual" });
    assert.equal(outcome.run.status, "succeeded");
    assert.equal(outcome.run.proposals, 1);
    assert.equal(outcome.run.creates, 1);
    const [pending] = outcome.pending;
    assert.equal(pending.status, "pending");
    assert.equal(pending.action, "create");
    assert.equal(pending.skillName, "file-the-league-scores");
    assert.equal(pending.provenance, "background_review");
    assert.match(pending.rationale, /Twice-rule/);
    // Write-approval ON: nothing is live yet.
    assert.deepEqual(await listSkills(db, owner), []);
    // A re-run over the same day does not duplicate the proposal.
    const rerun = await runSkillReviewPass({ db, owner, date: DAY, trigger: "manual" });
    assert.equal(rerun.run.proposals, 0);
    assert.equal((await listPendingSkillWrites(db, owner, true)).length, 1);
    // Approval applies it — with the review's provenance tag.
    const { pending: decided } = await approvePendingSkillWrite(db, owner, pending.id);
    assert.equal(decided.status, "approved");
    const skills = await listSkills(db, owner);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "file-the-league-scores");
    assert.equal(skills[0].createdBy, "background_review");
    const markdown = await readSkillMarkdown(db, owner, "file-the-league-scores");
    assert.match(markdown ?? "", /Collect the scoresheets/);
    assert.match(markdown ?? "", /created_by: background_review/);
    // Approving twice is a conflict.
    await assert.rejects(
      approvePendingSkillWrite(db, owner, pending.id),
      (error: unknown) => error instanceof AppError && error.status === 409,
    );
  } finally {
    await db.close();
  }
});

test("pitfalls patch: a failure matching an existing skill's Pitfalls stages a patch; rejecting it discards it", async () => {
  const db = await createStore();
  try {
    await seedSkill(db, "deploy-checklist", deployBody);
    await db.put(
      owner,
      "tasks",
      makeTask({
        id: "f1",
        title: "Deploy the app",
        status: "failed",
        error: "Publish failed: the deploy token was stale and expired",
        updatedAt: `${DAY}T10:00:00.000Z`,
      }),
    );
    // A failure no Pitfalls section speaks to earns nothing.
    await db.put(
      owner,
      "tasks",
      makeTask({
        id: "f2",
        title: "Water the plants",
        status: "failed",
        error: "The greenhouse door was locked",
        updatedAt: `${DAY}T11:00:00.000Z`,
      }),
    );
    const outcome = await runSkillReviewPass({ db, owner, date: DAY, trigger: "manual" });
    assert.equal(outcome.run.proposals, 1);
    assert.equal(outcome.run.patches, 1);
    const [pending] = outcome.pending;
    assert.equal(pending.action, "patch");
    assert.equal(pending.skillName, "deploy-checklist");
    assert.equal(pending.provenance, "background_review");
    // Not applied: the live skill has no review entry yet.
    const liveBefore = await readSkillMarkdown(db, owner, "deploy-checklist");
    assert.doesNotMatch(liveBefore ?? "", /Background review/);
    // Rejection discards it — the skill stays exactly as it was,
    // and the record remains as the rejected trail.
    const rejected = await rejectPendingSkillWrite(db, owner, pending.id);
    assert.equal(rejected.status, "rejected");
    const liveAfter = await readSkillMarkdown(db, owner, "deploy-checklist");
    assert.equal(liveAfter, liveBefore);
    assert.equal((await listPendingSkillWrites(db, owner)).length, 1);
    assert.equal((await listPendingSkillWrites(db, owner, true)).length, 0);
  } finally {
    await db.close();
  }
});

test("the reviewer seam is injectable: a stub reviewer's proposals stage identically, and a throwing reviewer degrades to a recorded partial", async () => {
  const db = await createStore();
  try {
    const stub: SkillReviewer = () => [
      {
        op: {
          action: "create",
          name: "stub-skill",
          content: skillDoc("stub-skill", "## Procedure\n\n1. Stub."),
        },
        rationale: "Stub proposal for the seam test.",
      },
      {
        // A malformed op (missing content) must be skipped, never staged.
        op: { action: "create", name: "broken-skill" } as unknown as SkillManageOp,
        rationale: "Broken on purpose.",
      },
    ];
    const outcome = await runSkillReviewPass({
      db,
      owner,
      date: DAY,
      trigger: "manual",
      reviewer: stub,
    });
    assert.equal(outcome.run.status, "partial");
    assert.equal(outcome.run.proposals, 1);
    assert.equal(outcome.run.skipped, 1);
    const pending = await listPendingSkillWrites(db, owner, true);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].skillName, "stub-skill");
    assert.equal(pending[0].provenance, "background_review");
    const failing: SkillReviewer = () => {
      throw new Error("reviewer exploded");
    };
    const partial = await runSkillReviewPass({
      db,
      owner,
      date: DAY,
      trigger: "manual",
      reviewer: failing,
    });
    assert.equal(partial.run.status, "partial");
    assert.equal(partial.run.proposals, 0);
    assert.equal(
      (await listPendingSkillWrites(db, owner, true)).length,
      1,
      "nothing new was staged",
    );
  } finally {
    await db.close();
  }
});

test("frontmatter parsing rejects a created_by outside the provenance enum (schema is a hard failure)", () => {
  assert.throws(
    () => parseSkillMarkdown(skillDoc("x-skill", "Body.", "someone_else")),
    /Invalid SKILL\.md/,
  );
  const parsed = parseSkillMarkdown(skillDoc("x-skill", "Body.", "background_review"));
  assert.equal(parsed.frontmatter.metadata?.created_by, "background_review");
  assert.equal(parsed.body.trim(), "Body.");
});

async function makeServer(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-skills-"));
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

test("routes: pending list, approve applies, reject discards, audit stays content-free, scheduled job rides the worker", async (t) => {
  const { db, server } = await makeServer(t);
  const token = await sessionToken(server.app);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  // Seed two same-title successes for the app owner (one today).
  const today = new Date().toISOString().slice(0, 10);
  await db.put(
    appOwner,
    "tasks",
    makeTask({
      id: "a1",
      title: "File the league scores",
      status: "succeeded",
      updatedAt: "2026-11-01T09:00:00.000Z",
    }),
  );
  await db.put(
    appOwner,
    "tasks",
    makeTask({
      id: "a2",
      title: "File the league scores",
      status: "succeeded",
      updatedAt: `${today}T09:00:00.000Z`,
    }),
  );
  // Unauthenticated calls are refused.
  const unauthenticated = await server.app.request("/api/agent/skills/pending", { method: "GET" });
  assert.equal(unauthenticated.status, 401);
  // Run the review through the authenticated route.
  const run = await server.app.request("/api/agent/skills/review/run", {
    method: "POST",
    headers,
    body: JSON.stringify({ date: today }),
  });
  assert.equal(run.status, 200, await run.clone().text());
  const runPayload = (await run.json()) as {
    run: { proposals: number; tasksReviewed: number };
    pending: { id: string }[];
  };
  assert.equal(runPayload.run.proposals, 1, JSON.stringify(runPayload.run));
  const pendingId = runPayload.pending[0].id;
  // The pending list shows the staged write; the skill is NOT live.
  const list = await server.app.request("/api/agent/skills/pending", { headers });
  const listPayload = (await list.json()) as unknown[];
  assert.equal(listPayload.length, 1);
  const skillsBefore = await server.app.request("/api/agent/skills", { headers });
  assert.deepEqual(await skillsBefore.json(), []);
  // Approve through the route: the skill goes live.
  const approved = await server.app.request(`/api/agent/skills/pending/${pendingId}/approve`, {
    method: "POST",
    headers,
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  const skillsAfter = await server.app.request("/api/agent/skills", { headers });
  const summaries = (await skillsAfter.json()) as { name: string; createdBy: string }[];
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].name, "file-the-league-scores");
  assert.equal(summaries[0].createdBy, "background_review");
  // Level-2 read through the route.
  const doc = await server.app.request("/api/agent/skills/file-the-league-scores", { headers });
  assert.equal(doc.status, 200);
  assert.match(((await doc.json()) as { markdown: string }).markdown, /## Procedure/);
  // Audit: the whole flow recorded counts only.
  const audit = await server.agent.auditEvents(appOwner);
  const operations = audit.map((event) => event.operation);
  assert.ok(operations.includes("skill_review.completed"));
  assert.ok(operations.includes("skill.pending_approved"));
  for (const event of audit)
    for (const value of Object.values(event.payload))
      assert.equal(typeof value, "number", "audit payloads carry counts only");
  // Reject path: stage another write directly in the pending area
  // and reject it through the route.
  await db.put(appOwner, SKILL_PENDING_KIND, {
    id: "pending-manual",
    op: { action: "create", name: "never-live", content: skillDoc("never-live", "Body.") },
    action: "create",
    skillName: "never-live",
    provenance: "background_review",
    status: "pending",
    rationale: "Seeded for the reject route test.",
    fingerprint: "seeded",
    reviewRunId: null,
    warnings: [],
    createdAt: new Date().toISOString(),
    decidedAt: null,
  });
  const rejected = await server.app.request("/api/agent/skills/pending/pending-manual/reject", {
    method: "POST",
    headers,
  });
  assert.equal(rejected.status, 200, await rejected.clone().text());
  assert.equal(((await rejected.json()) as { status: string }).status, "rejected");
  const skillsFinal = await server.app.request("/api/agent/skills", { headers });
  assert.equal(
    ((await skillsFinal.json()) as unknown[]).length,
    1,
    "the rejected skill never went live",
  );
  // The scheduled job: ensured idempotently, parked scheduled.
  const scheduled = await server.app.request("/api/agent/skills/review/schedule", {
    method: "POST",
    headers,
  });
  assert.equal(scheduled.status, 201, await scheduled.clone().text());
  const job = (await scheduled.json()) as { id: string; status: string; nextRunAt?: string };
  assert.equal(job.status, "scheduled");
  assert.ok(job.nextRunAt && Date.parse(job.nextRunAt) > Date.now());
  const again = await server.agent.ensureSkillReviewJob(appOwner);
  assert.equal(again.id, job.id);
  // Force it due and let the worker run it: it reviews yesterday
  // (no completions) and reschedules — a no-op nightly pass.
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
  const runs = await server.agent.skillReviewRuns(appOwner);
  assert.ok(runs.some((entry) => entry.trigger === "scheduled"));
});
