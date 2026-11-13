// Background skill review — the Hermes background self-improvement
// review shape (MIT, (c) Nous Research — Hermes Agent, audited at
// HEAD 93dd2435; parts-scavenge MAP, Tier 2 item #7 and Design Note
// B steps 3–4) with the gates Hermes leaves OFF turned ON, which is
// the deliberate deviation this transplant exists to make:
//
// - NIGHTLY-BATCH mode (Design Note B's quota decision): the review
//   is a scheduled worker task on the gamma machinery — the same
//   shape as the distillation job (PR-delta) — not a per-task fork.
//   It reviews the day's completed task transcripts (the task
//   records' StageTrace + result/error text) in one pass.
// - Tool whitelist: the review reads memory + task records and may
//   only PROPOSE through skill_manage. It has no other write path,
//   and even its proposals do not apply directly (next point).
// - WRITE-APPROVAL ON: every proposal lands in a PENDING area as a
//   record. Nothing goes live until an authenticated approval
//   applies it through engine/skills.ts's applySkillManage; a
//   rejection discards it (the record stays, marked rejected, as
//   the reviewable trail). Hermes stages to pending/skills/ on
//   disk; here the pending area is a store kind, for the same
//   hosted-server reason as the skill store itself.
// - Provenance: everything the review stages carries
//   `created_by: background_review` (Hermes' skill_provenance tag),
//   stamped by the machinery at apply time — never trusted from
//   the proposed text.
// - NO SAVE-BIAS: Hermes' review prompt calls a do-nothing pass "a
//   missed learning opportunity". Rejected (Design Note B step 4):
//   a no-op pass is a CORRECT outcome when nothing reusable
//   happened. The deterministic default reviewer proposes only on
//   the two trigger criteria below, and a pass over a quiet day
//   stages nothing and records a clean no-op run.
//
// Trigger criteria (Joseph's twice-rule, AGENTS.md rule 3, as the
// new-skill trigger): propose a NEW skill only when a workflow has
// now succeeded twice; propose a PATCH when a run failed in a way an
// existing skill's Pitfalls section speaks to (the failure's terms
// appear in that section) — the LESSONS.md pattern, automated.
//
// The reviewer is an injectable seam: the default implementation is
// DETERMINISTIC (no model call — the distillation v1 discipline, so
// the nightly job costs zero tokens and tests need no live model).
// A model-backed reviewer can be injected later behind the same
// seam; it would call through the existing model router
// (engine/model.ts) and its output would land in the same pending
// area under the same approval gate.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentMemory, AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { type DeliveryStatus, deliveryStatusSchema } from "./cron.ts";
import { contentHash, dayWindow, isValidDay, normalizeFact } from "./distillation.ts";
import {
  applySkillManage,
  lintSkill,
  listSkills,
  parseSkillMarkdown,
  readSkillMarkdown,
  type SkillLintWarning,
  type SkillManageOp,
  type SkillManageResult,
  type SkillSummary,
  skillManageOpSchema,
  skillOpFingerprint,
} from "./skills.ts";

export const SKILL_REVIEW_RUN_KIND = "skill-review-runs";
export const SKILL_PENDING_KIND = "skill-pending-writes";

// The provenance tag every review write carries (Design Note B).
export const BACKGROUND_REVIEW_PROVENANCE = "background_review" as const;

export const skillReviewRunStatusSchema = z.enum(["succeeded", "partial", "blocked_config"]);
export type SkillReviewRunStatus = z.infer<typeof skillReviewRunStatusSchema>;

export const skillReviewRunSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  trigger: z.enum(["manual", "scheduled"]),
  status: skillReviewRunStatusSchema,
  // Completed (succeeded + failed) tasks whose transcripts fell in
  // the window and were reviewed.
  tasksReviewed: z.number().int().nonnegative(),
  succeededTasks: z.number().int().nonnegative(),
  failedTasks: z.number().int().nonnegative(),
  // Proposals staged into the pending area by this run, by action.
  proposals: z.number().int().nonnegative(),
  creates: z.number().int().nonnegative(),
  patches: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  // Proposals dropped before staging (already pending, target
  // missing, or failing validation) — a no-op pass has proposals 0
  // AND skipped 0; a nonzero skipped with a reason lands in issues.
  skipped: z.number().int().nonnegative(),
  issues: z.array(z.string()),
  failureSignature: z.string().nullable(),
  // Delivery of the run's outcome notice on the manual path (the
  // scheduled path records delivery on the task, like distillation).
  deliveryStatus: deliveryStatusSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export type SkillReviewRun = z.infer<typeof skillReviewRunSchema>;

const lintWarningSchema = z.object({
  rule: z.enum(["oversized_body", "references_sprawl", "incident_log_shape"]),
  message: z.string(),
});

export const pendingSkillWriteSchema = z.object({
  id: z.string().min(1),
  // The exact skill_manage op an approval would apply.
  op: skillManageOpSchema,
  action: z.enum(["create", "patch", "write_file"]),
  skillName: z.string().min(1),
  // Always background_review for records in this area — the schema
  // makes any other provenance unrepresentable here.
  provenance: z.literal(BACKGROUND_REVIEW_PROVENANCE),
  status: z.enum(["pending", "approved", "rejected"]),
  rationale: z.string(),
  fingerprint: z.string().min(1),
  reviewRunId: z.string().nullable(),
  // The linter's advisory warnings at proposal time (recomputed at
  // apply time by applySkillManage; these are the review surface's).
  warnings: z.array(lintWarningSchema),
  createdAt: z.iso.datetime(),
  decidedAt: z.string().nullable(),
});
export type PendingSkillWrite = z.infer<typeof pendingSkillWriteSchema>;

// One proposal out of a reviewer: a skill_manage op in PROPOSE mode
// (staged, never applied by the reviewer) plus the human-readable
// reason, which rides the pending record into the approval surface.
export interface SkillProposal {
  op: SkillManageOp;
  rationale: string;
}

// The context a reviewer sees — the review's whole world. It is
// exactly the whitelist: the day's transcripts, memory (read), and
// the skill library (read). There is no write handle here at all;
// proposals are the only output channel.
export interface SkillReviewContext {
  date: string;
  tasks: AgentTask[];
  memories: AgentMemory[];
  skills: SkillSummary[];
  readSkill: (name: string) => Promise<string | null>;
  pending: PendingSkillWrite[];
}

// The injectable reviewer seam. The default (below) is
// deterministic; a model-backed implementation must return the same
// shape and gets no extra powers — its proposals stage identically.
export type SkillReviewer = (
  context: SkillReviewContext,
) => Promise<SkillProposal[]> | SkillProposal[];

// The next nightly run: 03:17 UTC the following day — an hour
// after distillation's 02:17, so the review reads a settled day
// (and the two jobs never contend for the worker at once).
export function nextSkillReviewRunAt(from: Date): string {
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1, 3, 17, 0, 0),
  );
  return next.toISOString();
}

// The day a scheduled nightly run reviews: the UTC day that just
// ended when it fires (same convention as distillation).
export function scheduledSkillReviewDate(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Preflight (gamma semantics): the window must be a real day.
// Failure is blocked_config — terminal for the run, alerted once,
// and nothing is read or staged.
export function preflightSkillReview(input: { date: string }): string[] {
  const issues: string[] = [];
  if (!isValidDay(input.date)) issues.push("the skill review window is not a valid day");
  return issues;
}

// A workflow's identity across days: the normalized task title
// (createTask defaults a title from the prompt, so the title IS the
// workflow's name in practice). Two succeeded tasks sharing it are
// the same workflow run twice — Joseph's twice-rule.
export function workflowSignature(task: AgentTask): string {
  return contentHash(normalizeFact(task.title));
}

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "workflow";
}

function pitfallsSection(body: string): string | null {
  const match = body.match(/^##\s+Pitfalls\s*$/m);
  if (!match || match.index === undefined) return null;
  const rest = body.slice(match.index + match[0].length);
  const nextHeading = rest.search(/^##\s+/m);
  return (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
}

function failureTerms(task: AgentTask): string {
  const trace = (task.stageTrace ?? [])
    .filter((entry) => entry.outcome === "blocked")
    .map((entry) => entry.summary)
    .join(" ");
  return `${task.error ?? ""} ${trace}`.replace(/\s+/g, " ").trim();
}

function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4),
  );
}

// The deterministic default reviewer. Pure over the context: same
// transcripts in, same proposals out, no model call, no writes.
// Both trigger criteria are evaluated against the WHOLE task list
// (a workflow's first success may predate the window; the review
// fires when the second success lands in it) but only the window's
// own completions are counted as reviewed.
export async function proposeSkillChanges(context: SkillReviewContext): Promise<{
  proposals: SkillProposal[];
  tasksReviewed: number;
  succeeded: number;
  failed: number;
}> {
  const window = dayWindow(context.date);
  const inWindow = (task: AgentTask) =>
    task.updatedAt >= window.start && task.updatedAt < window.end;
  const completed = context.tasks.filter(
    (task) => (task.status === "succeeded" || task.status === "failed") && inWindow(task),
  );
  const succeededToday = completed.filter((task) => task.status === "succeeded");
  const failedToday = completed.filter((task) => task.status === "failed");
  const proposals: SkillProposal[] = [];
  const pendingNames = new Set(
    context.pending.filter((entry) => entry.status === "pending").map((entry) => entry.skillName),
  );
  const liveNames = new Set(context.skills.map((skill) => skill.name));

  // Trigger 1 — the twice-rule: a workflow that has now succeeded
  // twice (at least one of the successes in this window) with no
  // live skill and no pending create already covering it earns a
  // NEW skill proposal distilled from its latest successful run.
  const successesBySignature = new Map<string, AgentTask[]>();
  for (const task of context.tasks) {
    if (task.status !== "succeeded") continue;
    const signature = workflowSignature(task);
    const list = successesBySignature.get(signature) ?? [];
    list.push(task);
    successesBySignature.set(signature, list);
  }
  const firedSignatures = new Set(succeededToday.map((task) => workflowSignature(task)));
  for (const signature of firedSignatures) {
    const runs = (successesBySignature.get(signature) ?? []).sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
    );
    if (runs.length < 2) continue;
    const latest = runs[runs.length - 1];
    const name = slugifyTitle(latest.title);
    if (liveNames.has(name) || pendingNames.has(name)) continue;
    const steps = latest.plan.length
      ? latest.plan.map((step, index) => `${index + 1}. ${step.title}`).join("\n")
      : "1. Reproduce the approach of the recorded successful runs.";
    const description =
      `Procedure for the workflow "${latest.title.replace(/\s+/g, " ").slice(0, 120)}", distilled by the background review after ${runs.length} successful runs.`
        .replace(/\n/g, " ")
        .slice(0, 300);
    const content = [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "metadata:",
      `  created_by: ${BACKGROUND_REVIEW_PROVENANCE}`,
      "---",
      "",
      "## When to Use",
      "",
      `When a task matches this workflow: ${latest.title.replace(/\s+/g, " ")}.`,
      "",
      "## Procedure",
      "",
      steps,
      "",
      "## Pitfalls",
      "",
      "- None recorded yet. The background review proposes a patch here when a run fails in a way this section would have prevented.",
      "",
      "## Verification",
      "",
      "- Confirm the outcome matches what the successful runs produced before finishing.",
      "",
    ].join("\n");
    proposals.push({
      op: { action: "create", name, content },
      rationale: `Twice-rule: the workflow "${latest.title}" has succeeded ${runs.length} times (latest on ${context.date}) and no skill covers it yet.`,
    });
    pendingNames.add(name);
  }

  // Trigger 2 — the Pitfalls patch: a run in the window failed, and
  // an existing skill's Pitfalls section already speaks to that
  // failure (shared significant terms) — the failure is evidence
  // the pitfall needs the concrete instance recorded. The proposal
  // appends the dated instance to that section (the LESSONS.md
  // entry shape), staged for approval like everything else.
  for (const task of failedToday) {
    const terms = significantTokens(failureTerms(task));
    if (!terms.size) continue;
    for (const skill of context.skills) {
      const markdown = await context.readSkill(skill.name);
      if (!markdown) continue;
      const { body } = parseSkillMarkdown(markdown);
      const pitfalls = pitfallsSection(body);
      if (!pitfalls) continue;
      const pitfallTokens = significantTokens(pitfalls);
      const shared = [...terms].filter((token) => pitfallTokens.has(token));
      if (!shared.length) continue;
      if (pendingNames.has(skill.name)) continue;
      const excerpt = failureTerms(task).slice(0, 160);
      const lines = pitfalls.split("\n").filter((line) => line.trim().length > 0);
      const anchor = lines.length ? lines[lines.length - 1] : "## Pitfalls";
      const addition = lines.length
        ? `${anchor}\n- Background review ${context.date}: a run failed with "${excerpt}" — the pitfall above applies; check for it before repeating that step.`
        : `${anchor}\n\n- Background review ${context.date}: a run failed with "${excerpt}" — check for this before repeating that step.`;
      proposals.push({
        op: { action: "patch", name: skill.name, old_string: anchor, new_string: addition },
        rationale: `Pitfalls patch: the failed run "${task.title}" on ${context.date} matches the Pitfalls section of ${skill.name} (shared terms: ${shared.slice(0, 3).join(", ")}).`,
      });
      pendingNames.add(skill.name);
      break; // One patch proposal per failed run — the first skill whose Pitfalls speak to it.
    }
  }

  return {
    proposals: proposals.slice(0, 10),
    tasksReviewed: completed.length,
    succeeded: succeededToday.length,
    failed: failedToday.length,
  };
}

export interface SkillReviewOutcome {
  run: SkillReviewRun;
  pending: PendingSkillWrite[];
  preflightIssues: string[];
}

type ReviewStore = Pick<Store, "get" | "list" | "put">;

// Run one nightly-batch review pass over a day window. Never throws
// for a reviewer problem: a reviewer that fails (or returns a
// malformed proposal) degrades the run to a recorded partial, and
// nothing it half-produced is staged. The run record is always
// persisted — a no-op pass is a recorded clean run with zero
// proposals, not an absence.
export async function runSkillReviewPass(input: {
  db: ReviewStore;
  owner: string;
  date: string;
  trigger: "manual" | "scheduled";
  reviewer?: SkillReviewer;
  now?: Date;
}): Promise<SkillReviewOutcome> {
  const now = input.now ?? new Date();
  const runId = randomUUID();
  const preflightIssues = preflightSkillReview({ date: input.date });
  const base = {
    id: runId,
    date: input.date,
    trigger: input.trigger,
    tasksReviewed: 0,
    succeededTasks: 0,
    failedTasks: 0,
    proposals: 0,
    creates: 0,
    patches: 0,
    files: 0,
    skipped: 0,
    deliveryStatus: null,
    createdAt: now.toISOString(),
  } satisfies Partial<SkillReviewRun>;
  if (preflightIssues.length) {
    const run = skillReviewRunSchema.parse({
      ...base,
      status: "blocked_config",
      issues: preflightIssues,
      failureSignature: "skill review blocked by configuration",
    });
    await input.db.put(input.owner, SKILL_REVIEW_RUN_KIND, run);
    return { run, pending: [], preflightIssues };
  }

  const tasks = await input.db.list<AgentTask>(input.owner, "tasks");
  const memories = await input.db.list<AgentMemory>(input.owner, "memories");
  const skills = await listSkills(input.db, input.owner);
  const pending = await input.db.list<PendingSkillWrite>(input.owner, SKILL_PENDING_KIND);
  const context: SkillReviewContext = {
    date: input.date,
    tasks,
    memories,
    skills,
    pending,
    readSkill: (name) => readSkillMarkdown(input.db, input.owner, name),
  };
  const reviewer =
    input.reviewer ??
    ((ctx: SkillReviewContext) => proposeSkillChanges(ctx).then((r) => r.proposals));
  // The deterministic default also reports the window counts; an
  // injected reviewer only returns proposals, so counts are derived
  // from the window either way for the run record.
  const window = dayWindow(input.date);
  const completed = tasks.filter(
    (task) =>
      (task.status === "succeeded" || task.status === "failed") &&
      task.updatedAt >= window.start &&
      task.updatedAt < window.end,
  );
  const counts = {
    tasksReviewed: completed.length,
    succeededTasks: completed.filter((task) => task.status === "succeeded").length,
    failedTasks: completed.filter((task) => task.status === "failed").length,
  };

  const issues: string[] = [];
  let proposals: SkillProposal[] = [];
  try {
    proposals = await reviewer(context);
  } catch {
    const run = skillReviewRunSchema.parse({
      ...base,
      ...counts,
      status: "partial",
      issues: ["the background review pass did not complete; no proposals were staged"],
      failureSignature: "skill review pass failure",
    });
    await input.db.put(input.owner, SKILL_REVIEW_RUN_KIND, run);
    return { run, pending: [], preflightIssues: [] };
  }

  const staged: PendingSkillWrite[] = [];
  const pendingFingerprints = new Set(
    pending.filter((entry) => entry.status === "pending").map((entry) => entry.fingerprint),
  );
  let skipped = 0;
  for (const proposal of proposals) {
    const parsed = skillManageOpSchema.safeParse(proposal.op);
    if (!parsed.success) {
      skipped++;
      if (!issues.includes("a review proposal failed validation and was not staged"))
        issues.push("a review proposal failed validation and was not staged");
      continue;
    }
    const op = parsed.data;
    const fingerprint = skillOpFingerprint(op);
    if (pendingFingerprints.has(fingerprint)) {
      skipped++;
      continue;
    }
    // Advisory warnings at proposal time (recomputed at apply).
    let warnings: SkillLintWarning[] = [];
    try {
      if (op.action === "create") {
        const { body } = parseSkillMarkdown(op.content);
        warnings = lintSkill({ body, referencesCount: 0 });
      } else if (op.action === "patch") {
        const current = await readSkillMarkdown(input.db, input.owner, op.name);
        if (current)
          warnings = lintSkill({ body: parseSkillMarkdown(current).body, referencesCount: 0 });
      }
    } catch {
      skipped++;
      if (!issues.includes("a review proposal failed validation and was not staged"))
        issues.push("a review proposal failed validation and was not staged");
      continue;
    }
    const record = pendingSkillWriteSchema.parse({
      id: randomUUID(),
      op,
      action: op.action,
      skillName: op.name,
      provenance: BACKGROUND_REVIEW_PROVENANCE,
      status: "pending",
      rationale: String(proposal.rationale ?? "").slice(0, 1000),
      fingerprint,
      reviewRunId: runId,
      warnings,
      createdAt: now.toISOString(),
      decidedAt: null,
    });
    await input.db.put(input.owner, SKILL_PENDING_KIND, record);
    pendingFingerprints.add(fingerprint);
    staged.push(record);
  }

  const run = skillReviewRunSchema.parse({
    ...base,
    ...counts,
    status: issues.length ? "partial" : "succeeded",
    proposals: staged.length,
    creates: staged.filter((entry) => entry.action === "create").length,
    patches: staged.filter((entry) => entry.action === "patch").length,
    files: staged.filter((entry) => entry.action === "write_file").length,
    skipped,
    issues,
    failureSignature: issues.length ? "skill review proposal failure" : null,
  });
  await input.db.put(input.owner, SKILL_REVIEW_RUN_KIND, run);
  return { run, pending: staged, preflightIssues: [] };
}

// The pending area's read surface: newest first, optionally only
// the undecided entries.
export async function listPendingSkillWrites(
  db: ReviewStore,
  owner: string,
  pendingOnly = false,
): Promise<PendingSkillWrite[]> {
  const entries = await db.list<PendingSkillWrite>(owner, SKILL_PENDING_KIND);
  return pendingOnly ? entries.filter((entry) => entry.status === "pending") : entries;
}

// Approve one pending write: apply it through the direct machinery
// with the review's provenance stamped, then mark the record
// approved. If the apply fails (the skill moved underneath the
// proposal — a stale patch read, a name since taken), the error
// propagates and the record STAYS pending: an approval is a
// decision to apply this exact op, and a failed apply is new
// information for the next decision, not a silent rejection.
export async function approvePendingSkillWrite(
  db: ReviewStore,
  owner: string,
  id: string,
  options: { now?: Date } = {},
): Promise<{ pending: PendingSkillWrite; result: SkillManageResult }> {
  const entry = await db.get<PendingSkillWrite>(owner, SKILL_PENDING_KIND, id);
  if (!entry) throw new AppError("Pending skill write not found", 404);
  if (entry.status !== "pending")
    throw new AppError(`Pending skill write is already ${entry.status}`, 409);
  const op = skillManageOpSchema.parse(entry.op);
  const result = await applySkillManage(db, owner, op, {
    createdBy: BACKGROUND_REVIEW_PROVENANCE,
    now: options.now,
    readSkill: (name) => readSkillMarkdown(db, owner, name),
  });
  const decided: PendingSkillWrite = pendingSkillWriteSchema.parse({
    ...entry,
    status: "approved",
    decidedAt: (options.now ?? new Date()).toISOString(),
  });
  await db.put(owner, SKILL_PENDING_KIND, decided);
  return { pending: decided, result };
}

// Reject one pending write: discard it. The record stays (marked
// rejected) as the trail of what the review proposed and the
// operator declined; nothing is applied and nothing is deleted.
export async function rejectPendingSkillWrite(
  db: ReviewStore,
  owner: string,
  id: string,
  options: { now?: Date } = {},
): Promise<PendingSkillWrite> {
  const entry = await db.get<PendingSkillWrite>(owner, SKILL_PENDING_KIND, id);
  if (!entry) throw new AppError("Pending skill write not found", 404);
  if (entry.status !== "pending")
    throw new AppError(`Pending skill write is already ${entry.status}`, 409);
  const decided: PendingSkillWrite = pendingSkillWriteSchema.parse({
    ...entry,
    status: "rejected",
    decidedAt: (options.now ?? new Date()).toISOString(),
  });
  await db.put(owner, SKILL_PENDING_KIND, decided);
  return decided;
}

export type { DeliveryStatus };
