import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AgentArtifact,
  type AgentIdentity,
  type AgentMemory,
  type AgentNotification,
  type AgentTask,
  type AgentWorkspace,
  createTaskSchema,
  type Evidence,
  type Goal,
  goalInputSchema,
  type Idea,
  type Monitor,
  monitorInputSchema,
  type RunEvent,
} from "../../../../packages/domain/src/agent.ts";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  Mail,
  ProposalInput,
} from "../../../../packages/domain/src/index.ts";
import type { ActionService } from "../actions.ts";
import type { BrowserService } from "../browser.ts";
import { ComputerService } from "../computer.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Files } from "../files.ts";
import { backgroundFailure } from "../log.ts";
import type { WorkspaceService } from "../workspace.ts";
import { type AuditEvent, AuditLog, type AuditOutcome } from "./audit.ts";
import {
  type DeliveryRecord,
  decideIncident,
  deliveryRecordSchema,
  incidentFromState,
  isSilentOutput,
  normalizeErrorSignature,
  preflightMonitorJob,
} from "./cron.ts";
import {
  DISTILLATION_RUN_KIND,
  type DistillationOutcome,
  type DistillationRun,
  DREAM_DIARY_KIND,
  type DreamDiary,
  nextDistillationRunAt,
  recordSettledFact,
  runDistillationPass,
  scheduledDistillationDate,
} from "./distillation.ts";
import { analyzeSpending } from "./finance.ts";
import { type GraphitiLane, graphitiLaneFor } from "./graphiti.ts";
import { type HindsightLane, hindsightLaneFor } from "./hindsight.ts";
import { type Mem0Lane, mem0LaneFor } from "./mem0.ts";
import { executeModelTask, UNCONFIRMED_RUN_QUESTION } from "./model.ts";
import {
  approvePendingSkillWrite,
  listPendingSkillWrites,
  nextSkillReviewRunAt,
  type PendingSkillWrite,
  rejectPendingSkillWrite,
  runSkillReviewPass,
  SKILL_REVIEW_RUN_KIND,
  type SkillReviewer,
  type SkillReviewOutcome,
  type SkillReviewRun,
  scheduledSkillReviewDate,
} from "./skill-review.ts";
import {
  applySkillManage,
  listSkills,
  readSkillFile,
  readSkillMarkdown,
  type SkillManageOp,
  type SkillManageResult,
  type SkillSummary,
} from "./skills.ts";
import {
  citedIds,
  createPlan,
  critiqueAnswer,
  type EvidenceBundle,
  INSUFFICIENT_EVIDENCE,
  type StageTrace,
  survivingMatches,
  VERIFICATION_FAILED,
  verifyCompletionCitations,
} from "./verifier.ts";
import { LostLeaseError, type TaskContext, TaskWorker } from "./worker.ts";

// Tools whose success makes a completion a WRITE task for the
// Verifier stage: the run saved or changed something durable, so its
// completion is checked before it ships (see applyVerifierSpine).
const MUTATING_TOOLS = new Set(["save_memory", "save_artifact", "fill_pdf", "skill_manage"]);

// Bounded auto-continue (ATLAS audit 2026-11-06, Priority 1): the
// follow-up instruction the service itself issues — through the same
// state.answer channel a user's reply uses, so the continuation is an
// ordinary run whose prompt carries it — the FIRST time a model run
// ends without confirming completion. See autoContinueIfUnconfirmed.
export const AUTO_CONTINUE_INSTRUCTION =
  "Automatic follow-up from the system: your previous run ended without confirming completion. Continue this task now and finish it — complete the remaining work, then call finish_task with the result. Call ask_user only if you genuinely need a fact or decision from the user. Do not end this run without calling finish_task or ask_user.";

// The honest terminal error when the auto-continue run ALSO ends
// unconfirmed: the task is failed with this reason on the record
// (and the standard failure notification) instead of being parked
// in waiting_input forever. See autoContinueIfUnconfirmed.
export const UNCONFIRMED_RUN_FAILURE =
  "The agent's run ended without confirming completion, and the automatic follow-up run ended the same way — so this task was stopped instead of being left waiting. Start a new task to try again.";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const date = () => new Date().toISOString();
const terminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  // Cron-semantics terminal states for scheduled runs (engine/cron.ts).
  "blocked_config",
  "delivery_failed",
  "delivery_unverified",
  "unknown",
]);
export class AgentService {
  readonly worker: TaskWorker;
  // Mem0, the main memory lane. Configured only when MEM0_URL is set;
  // every lane call is failure-swallowing (see engine/mem0.ts), so the
  // internal store below remains the canonical memory either way.
  readonly mem0: Mem0Lane;
  // Graphiti, the side memory lane (supersession: it retires facts that
  // newer facts replace). Configured only when GRAPHITI_URL is set;
  // failure-swallowing like Mem0 (see engine/graphiti.ts).
  readonly graphiti: GraphitiLane;
  // Hindsight, the third memory lane (consolidated, correction-aware
  // recall). Configured only when HINDSIGHT_URL is set;
  // failure-swallowing like the other lanes (see engine/hindsight.ts).
  readonly hindsight: HindsightLane;
  // Content-free audit log (engine/audit.ts): the cross-task
  // lifecycle record. Emissions are counts only — see recordAudit.
  readonly auditLog: AuditLog;
  private maintenance?: ReturnType<typeof setInterval>;
  private refreshing = false;
  constructor(
    readonly db: Store,
    readonly config: Config,
    readonly workspace: WorkspaceService,
    readonly files: Files,
    readonly actions: ActionService,
    readonly browser: BrowserService,
    readonly computer: ComputerService = new ComputerService(db, config),
  ) {
    this.mem0 = mem0LaneFor(config);
    this.graphiti = graphitiLaneFor(config);
    this.hindsight = hindsightLaneFor(config);
    this.auditLog = new AuditLog(db);
    this.worker = new TaskWorker(db, (owner, task, context) => this.execute(owner, task, context), {
      settled: async (owner, task) => {
        await this.recordTaskOutcome(owner, task);
        await this.publishOutcome(owner, task);
      },
    });
  }
  // Content-free audit emissions (engine/audit.ts). Best-effort by
  // design: an audit write must never fail the task or save it
  // describes, so a store failure is swallowed here. The AuditLog
  // itself throws on schema violations — these call sites pass only
  // fixed operation names and integer counts, so a throw here can
  // only be a store failure, never recorded content.
  private async recordAudit(
    owner: string,
    operation: string,
    outcome: AuditOutcome,
    payload: Record<string, number> = {},
  ): Promise<void> {
    try {
      await this.auditLog.record(owner, operation, outcome, payload);
    } catch {
      // Best-effort: the lifecycle action itself already succeeded.
    }
  }
  // Terminal lifecycle outcomes, emitted once per settled run (the
  // worker's settled callback — maintain()'s recovery scan calls
  // publishOutcome directly and never reaches this, so recovery
  // cannot duplicate an outcome). Non-terminal settlements
  // (queued/scheduled/waiting_*) record nothing.
  private async recordTaskOutcome(owner: string, task: AgentTask): Promise<void> {
    const counts = { tasks: 1, attempts: task.attempts };
    if (task.status === "succeeded")
      await this.recordAudit(owner, "task.completed", "succeeded", counts);
    else if (task.status === "failed") {
      if (task.state.verificationFailed)
        await this.recordAudit(owner, "task.verification_failed", "failed", counts);
      else await this.recordAudit(owner, "task.failed", "failed", counts);
    } else if (task.status === "paused" && task.state.criticBlocked)
      await this.recordAudit(owner, "task.critic_blocked", "denied", counts);
    else if (task.status === "blocked_config")
      await this.recordAudit(owner, "cron.blocked_config", "denied", counts);
    else if (task.status === "unknown")
      await this.recordAudit(owner, "cron.unknown", "failed", counts);
  }
  // Recent content-free audit events for this owner, newest first
  // (the read surface the /api/agent/audit route serves).
  async auditEvents(owner: string, limit = 50): Promise<AuditEvent[]> {
    return this.auditLog.events(owner, limit);
  }
  // --- Nightly distillation (engine/distillation.ts, PR-delta) ---
  // The core pass is shared by the manual trigger and the scheduled
  // worker task; only their delivery differs (see below).
  private async runDistillationCore(
    owner: string,
    date: string,
    trigger: "manual" | "scheduled",
  ): Promise<DistillationOutcome> {
    return runDistillationPass({
      db: this.db,
      owner,
      mem0: this.mem0,
      graphiti: this.graphiti,
      date,
      trigger,
    });
  }
  private async recordDistillationAudit(owner: string, run: DistillationRun): Promise<void> {
    const counts = {
      runs: 1,
      sources: run.sources,
      distilled: run.distilled,
      duplicates: run.duplicates,
      settled: run.settled,
      candidates: run.supersessionCandidates,
      superseded: run.superseded,
    };
    if (run.status === "succeeded")
      await this.recordAudit(owner, "distillation.completed", "succeeded", counts);
    else if (run.status === "partial")
      await this.recordAudit(owner, "distillation.partial", "failed", counts);
    else await this.recordAudit(owner, "distillation.blocked_config", "denied", counts);
  }
  // Manual trigger (the /memory dream analogue): runs the REAL
  // pipeline — distill -> hash-settle -> supersession handoff ->
  // diary — and delivers the outcome notice with gamma delivery
  // semantics: the notice counts as delivered only on positive
  // evidence (the notification record read back from the store via
  // notify()), a store rejection is delivery_failed, and a write
  // that neither stored nor found the record is
  // delivery_unverified. The delivery verdict is recorded on the
  // run; delivery problems never fail the run itself.
  async runDistillation(
    owner: string,
    date?: string,
  ): Promise<{ run: DistillationRun; diary: DreamDiary | null }> {
    const day = date ?? new Date().toISOString().slice(0, 10);
    const outcome = await this.runDistillationCore(owner, day, "manual");
    await this.recordDistillationAudit(owner, outcome.run);
    const { run } = outcome;
    let title: string;
    let body: string;
    let key: string;
    if (run.status === "blocked_config") {
      title = "Distillation blocked — configuration needs attention";
      body = `The nightly distillation for ${run.date} is blocked by its configuration: ${run.issues.join("; ")}.`;
      // Stable per issue set, like the monitor blocked_config alert:
      // re-running while blocked never re-alerts.
      key = `distillation-blocked:${hash(run.issues.join(";"))}`;
    } else if (run.status === "partial") {
      title = "Distillation needs attention";
      body = `Distillation for ${run.date} finished partially: ${run.issues.join("; ")}. Unsettled material stays retryable.`;
      key = `distillation-partial:${run.date}:${run.id}`;
    } else {
      title = "Dream diary ready";
      body = `Distillation for ${run.date} settled ${run.settled} new fact(s) into Mem0 and flagged ${run.supersessionCandidates} supersession candidate(s). The dream diary for ${run.date} is ready.`;
      // One delivery per day: a no-op re-run re-offers the same key
      // and the store's insertIfAbsent keeps it a single notice.
      key = `dream-diary:${run.date}`;
    }
    let deliveryStatus: DistillationRun["deliveryStatus"];
    try {
      const stored = await this.notify(owner, title, body, undefined, key);
      deliveryStatus = stored ? "delivered" : "delivery_unverified";
    } catch {
      deliveryStatus = "delivery_failed";
    }
    const recorded: DistillationRun = { ...run, deliveryStatus };
    await this.db.put(owner, DISTILLATION_RUN_KIND, recorded);
    return { run: recorded, diary: outcome.diary };
  }
  // Recent distillation runs for this owner, newest first.
  async distillationRuns(owner: string, limit = 20): Promise<DistillationRun[]> {
    const runs = await this.db.list<DistillationRun>(owner, DISTILLATION_RUN_KIND);
    return runs.slice(0, Math.max(1, Math.min(100, limit)));
  }
  // The dream diary entry for one day (or the latest when no day is
  // given); null when no run has written one.
  async dreamDiary(owner: string, date?: string): Promise<DreamDiary | null> {
    if (date) return this.db.get<DreamDiary>(owner, DREAM_DIARY_KIND, date);
    const entries = await this.db.list<DreamDiary>(owner, DREAM_DIARY_KIND);
    return entries[0] ?? null;
  }
  async dreamDiaries(owner: string): Promise<DreamDiary[]> {
    return this.db.list<DreamDiary>(owner, DREAM_DIARY_KIND);
  }
  // Ensure the nightly scheduled distillation job exists: a worker
  // task (kind "agent", input.distillation) created idempotently
  // and parked in `scheduled` with the next nightly nextRunAt, so
  // the existing TaskWorker leases and runs it — the gamma
  // scheduled-run machinery, not a second scheduler. Each run
  // returns `scheduled` again with the following night's time.
  async ensureDistillationJob(owner: string): Promise<AgentTask> {
    const task = await this.createTask(
      owner,
      {
        kind: "agent",
        title: "Nightly distillation",
        prompt:
          "Distill the day's memories and task outcomes into durable facts: settle new facts into Mem0 under the content-hash gate, hand supersession candidates to Graphiti, and write the dream diary.",
        input: { distillation: true },
      },
      "distillation-nightly",
      true,
    );
    if (task.status === "paused" && task.attempts === 0) {
      const scheduled = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        task.id,
        { status: "paused", attempts: 0 },
        { status: "scheduled", nextRunAt: nextDistillationRunAt(new Date()) },
      );
      if (scheduled) return scheduled;
      return (await this.db.get<AgentTask>(owner, "tasks", task.id)) ?? task;
    }
    return task;
  }
  // The scheduled run's execution (called from execute()): the same
  // core pass the manual trigger runs, over the day that just ended.
  // Outcomes map onto the gamma scheduled-run states: preflight
  // failure is terminal blocked_config with a stable-keyed alert;
  // success and partial both reschedule for the next night, with
  // the outcome notice carried in state.notice for the standard
  // delivery path (publishOutcome -> deliverOutcomeNotice), and a
  // partial folds into the task's incident by normalized signature
  // (alert once, remind after ~6h, success re-arms).
  private async executeDistillation(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const day = scheduledDistillationDate(new Date());
    const outcome = await this.runDistillationCore(owner, day, "scheduled");
    await this.recordDistillationAudit(owner, outcome.run);
    const { run } = outcome;
    if (run.status === "blocked_config") {
      const detail = `This distillation job is blocked by its configuration: ${run.issues.join("; ")}. Configure a memory lane to run it again.`;
      await context.event("error", "Distillation blocked by configuration", detail);
      return {
        status: "blocked_config",
        error: detail,
        state: {
          ...task.state,
          blockedConfig: true,
          notice: {
            title: "Distillation blocked — configuration needs attention",
            body: detail,
            key: `blocked-config:${task.id}:${hash(run.issues.join(";"))}`,
          },
        },
      };
    }
    const nextRunAt = nextDistillationRunAt(new Date());
    if (run.status === "partial") {
      await context.event("error", "Distillation finished partially", run.issues.join("; "));
      const signature = run.failureSignature ?? "distillation lane failure";
      const { action, incident } = decideIncident(
        incidentFromState(task.state.incident),
        signature,
        hash(signature).slice(0, 16),
        Date.now(),
      );
      const failures = Number(task.state.failures ?? 0) + 1;
      return {
        status: "scheduled",
        nextRunAt,
        error: run.issues.join("; "),
        result: `Distillation for ${run.date} finished partially; unsettled material stays retryable.`,
        state: {
          ...task.state,
          failures,
          incident,
          notice:
            action === "suppress"
              ? null
              : {
                  title: "Distillation needs attention",
                  body: `Distillation for ${run.date} finished partially: ${run.issues.join("; ")}. Unsettled material stays retryable.`,
                  key: `distillation-partial:${task.id}:${incident.hash}:${
                    action === "remind" ? `remind:${incident.reminders}` : "first"
                  }:${incident.firstAt}`,
                },
        },
      };
    }
    await context.event(
      "result",
      "Distillation complete",
      `Settled ${run.settled} fact(s); ${run.supersessionCandidates} supersession candidate(s) flagged.`,
    );
    return {
      status: "scheduled",
      nextRunAt,
      error: null,
      result: `Distillation for ${run.date} complete. Dream diary written.`,
      state: {
        ...task.state,
        failures: 0,
        incident: null,
        notice: {
          title: "Dream diary ready",
          body: `Distillation for ${run.date} settled ${run.settled} new fact(s) into Mem0 and flagged ${run.supersessionCandidates} supersession candidate(s).`,
          key: `dream-diary:${run.date}`,
        },
      },
    };
  }
  // --- Skill machinery + background review (engine/skills.ts,
  // engine/skill-review.ts, PR-epsilon) ---
  // The direct skill_manage path: a caller with standing write
  // access (a live task's tool, an operator action) applies ops
  // straight to the skill store. The service keeps a per-owner
  // read log so patch's read-before-write rule has a session to
  // check: a read through this service marks the skill read, and a
  // direct patch consumes a function that only answers after such a
  // read — and only with the exact text that was read, so a stale
  // read fails in the machinery, not silently.
  private readonly skillReads = new Map<string, Map<string, string>>();
  private markSkillRead(owner: string, name: string, markdown: string): void {
    const reads = this.skillReads.get(owner) ?? new Map<string, string>();
    reads.set(name, markdown);
    this.skillReads.set(owner, reads);
  }
  async listSkillSummaries(owner: string): Promise<SkillSummary[]> {
    return listSkills(this.db, owner);
  }
  async readSkill(owner: string, name: string): Promise<string | null> {
    const markdown = await readSkillMarkdown(this.db, owner, name);
    if (markdown !== null) this.markSkillRead(owner, name, markdown);
    return markdown;
  }
  async readSkillReference(owner: string, name: string, path: string): Promise<string | null> {
    return readSkillFile(this.db, owner, name, path);
  }
  async skillManage(
    owner: string,
    op: SkillManageOp,
    createdBy: "agent" | "operator" = "operator",
  ): Promise<SkillManageResult> {
    const reads = this.skillReads.get(owner);
    const result = await applySkillManage(this.db, owner, op, {
      createdBy,
      readSkill: async (name) => reads?.get(name) ?? null,
    });
    // A successful write changes the text any earlier read saw;
    // refresh the read log to the new current text so a follow-up
    // patch in the same session patches against what it just wrote.
    const current = await readSkillMarkdown(this.db, owner, op.name);
    if (current !== null) this.markSkillRead(owner, op.name, current);
    const counts = { skills: 1, warnings: result.warnings.length };
    if (op.action === "create") await this.recordAudit(owner, "skill.created", "succeeded", counts);
    else if (op.action === "patch")
      await this.recordAudit(owner, "skill.patched", "succeeded", counts);
    else await this.recordAudit(owner, "skill.file_written", "succeeded", counts);
    return result;
  }
  // The background review: core pass + audit + (manual path) the
  // outcome notice with gamma delivery semantics, mirroring
  // runDistillation. The reviewer seam is injectable for tests; the
  // production default is deterministic and makes no model call.
  private async recordSkillReviewAudit(owner: string, run: SkillReviewRun): Promise<void> {
    const counts = {
      runs: 1,
      reviewed: run.tasksReviewed,
      proposals: run.proposals,
      creates: run.creates,
      patches: run.patches,
      files: run.files,
      skipped: run.skipped,
    };
    if (run.status === "succeeded")
      await this.recordAudit(owner, "skill_review.completed", "succeeded", counts);
    else if (run.status === "partial")
      await this.recordAudit(owner, "skill_review.partial", "failed", counts);
    else await this.recordAudit(owner, "skill_review.blocked_config", "denied", counts);
  }
  async runSkillReview(
    owner: string,
    date?: string,
    reviewer?: SkillReviewer,
  ): Promise<{ run: SkillReviewRun; pending: PendingSkillWrite[] }> {
    const day = date ?? new Date().toISOString().slice(0, 10);
    const outcome: SkillReviewOutcome = await runSkillReviewPass({
      db: this.db,
      owner,
      date: day,
      trigger: "manual",
      reviewer,
    });
    await this.recordSkillReviewAudit(owner, outcome.run);
    const { run } = outcome;
    let title: string;
    let body: string;
    let key: string;
    if (run.status === "blocked_config") {
      title = "Skill review blocked — configuration needs attention";
      body = `The nightly skill review for ${run.date} is blocked by its configuration: ${run.issues.join("; ")}.`;
      key = `skill-review-blocked:${hash(run.issues.join(";"))}`;
    } else if (run.status === "partial") {
      title = "Skill review needs attention";
      body = `The skill review for ${run.date} finished partially: ${run.issues.join("; ")}.`;
      key = `skill-review-partial:${run.date}:${run.id}`;
    } else if (run.proposals > 0) {
      title = "Skill proposals waiting for review";
      body = `The background review for ${run.date} staged ${run.proposals} skill proposal(s) (${run.creates} new, ${run.patches} patch, ${run.files} file). Nothing applies until approved.`;
      key = `skill-review:${run.date}:${run.id}`;
    } else {
      title = "Skill review complete";
      body = `The background review for ${run.date} reviewed ${run.tasksReviewed} task(s) and proposed nothing — a quiet day is a correct no-op.`;
      key = `skill-review:${run.date}:${run.id}`;
    }
    let deliveryStatus: SkillReviewRun["deliveryStatus"];
    try {
      const stored = await this.notify(owner, title, body, undefined, key);
      deliveryStatus = stored ? "delivered" : "delivery_unverified";
    } catch {
      deliveryStatus = "delivery_failed";
    }
    const recorded: SkillReviewRun = { ...run, deliveryStatus };
    await this.db.put(owner, SKILL_REVIEW_RUN_KIND, recorded);
    return { run: recorded, pending: outcome.pending };
  }
  async skillReviewRuns(owner: string, limit = 20): Promise<SkillReviewRun[]> {
    const runs = await this.db.list<SkillReviewRun>(owner, SKILL_REVIEW_RUN_KIND);
    return runs.slice(0, Math.max(1, Math.min(100, limit)));
  }
  // The pending area (write-approval ON): the operator's decision
  // surface. Approving applies the exact staged op with the
  // review's provenance; rejecting discards it. Both decisions are
  // audited with counts/ids only — never skill content.
  async pendingSkillWrites(owner: string, pendingOnly = false): Promise<PendingSkillWrite[]> {
    return listPendingSkillWrites(this.db, owner, pendingOnly);
  }
  async approveSkillWrite(owner: string, id: string): Promise<PendingSkillWrite> {
    const { pending, result } = await approvePendingSkillWrite(this.db, owner, id);
    await this.recordAudit(owner, "skill.pending_approved", "succeeded", {
      writes: 1,
      warnings: result.warnings.length,
    });
    return pending;
  }
  async rejectSkillWrite(owner: string, id: string): Promise<PendingSkillWrite> {
    const pending = await rejectPendingSkillWrite(this.db, owner, id);
    await this.recordAudit(owner, "skill.pending_rejected", "succeeded", { writes: 1 });
    return pending;
  }
  // Ensure the nightly scheduled review job exists — the same
  // idempotent worker-task pattern as ensureDistillationJob, flagged
  // by input.skillReview, parked `scheduled` at the next 03:17 UTC.
  async ensureSkillReviewJob(owner: string): Promise<AgentTask> {
    const task = await this.createTask(
      owner,
      {
        kind: "agent",
        title: "Nightly skill review",
        prompt:
          "Review the day's completed task transcripts and propose skill changes only: a new skill when a workflow has succeeded twice, a patch when a failure matches an existing skill's Pitfalls. Proposals land in the pending area and apply only on approval.",
        input: { skillReview: true },
      },
      "skill-review-nightly",
      true,
    );
    if (task.status === "paused" && task.attempts === 0) {
      const scheduled = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        task.id,
        { status: "paused", attempts: 0 },
        { status: "scheduled", nextRunAt: nextSkillReviewRunAt(new Date()) },
      );
      if (scheduled) return scheduled;
      return (await this.db.get<AgentTask>(owner, "tasks", task.id)) ?? task;
    }
    return task;
  }
  // The scheduled run's execution (called from execute()): the same
  // core pass the manual trigger runs, over the day that just ended.
  // Outcomes map onto the gamma scheduled-run states exactly as
  // distillation's do: preflight failure is terminal blocked_config
  // with a stable-keyed alert; success and partial both reschedule
  // for the next night, with the outcome notice carried in
  // state.notice for the standard delivery path, and a partial folds
  // into the task's incident by normalized signature.
  private async executeSkillReview(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const day = scheduledSkillReviewDate(new Date());
    const outcome = await runSkillReviewPass({
      db: this.db,
      owner,
      date: day,
      trigger: "scheduled",
    });
    await this.recordSkillReviewAudit(owner, outcome.run);
    const { run } = outcome;
    if (run.status === "blocked_config") {
      const detail = `This skill review job is blocked by its configuration: ${run.issues.join("; ")}. Fix the review window to run it again.`;
      await context.event("error", "Skill review blocked by configuration", detail);
      return {
        status: "blocked_config",
        error: detail,
        state: {
          ...task.state,
          blockedConfig: true,
          notice: {
            title: "Skill review blocked — configuration needs attention",
            body: detail,
            key: `blocked-config:${task.id}:${hash(run.issues.join(";"))}`,
          },
        },
      };
    }
    const nextRunAt = nextSkillReviewRunAt(new Date());
    if (run.status === "partial") {
      await context.event("error", "Skill review finished partially", run.issues.join("; "));
      const signature = run.failureSignature ?? "skill review failure";
      const { action, incident } = decideIncident(
        incidentFromState(task.state.incident),
        signature,
        hash(signature).slice(0, 16),
        Date.now(),
      );
      const failures = Number(task.state.failures ?? 0) + 1;
      return {
        status: "scheduled",
        nextRunAt,
        error: run.issues.join("; "),
        result: `Skill review for ${run.date} finished partially; staged proposals are unaffected.`,
        state: {
          ...task.state,
          failures,
          incident,
          notice:
            action === "suppress"
              ? null
              : {
                  title: "Skill review needs attention",
                  body: `The skill review for ${run.date} finished partially: ${run.issues.join("; ")}.`,
                  key: `skill-review-partial:${task.id}:${incident.hash}:${
                    action === "remind" ? `remind:${incident.reminders}` : "first"
                  }:${incident.firstAt}`,
                },
        },
      };
    }
    await context.event(
      "result",
      "Skill review complete",
      `Reviewed ${run.tasksReviewed} task(s); ${run.proposals} proposal(s) staged for approval.`,
    );
    return {
      status: "scheduled",
      nextRunAt,
      error: null,
      result: `Skill review for ${run.date} complete. ${run.proposals} proposal(s) staged.`,
      state: {
        ...task.state,
        failures: 0,
        incident: null,
        notice: {
          title: run.proposals > 0 ? "Skill proposals waiting for review" : "Skill review complete",
          body:
            run.proposals > 0
              ? `The background review for ${run.date} staged ${run.proposals} skill proposal(s). Nothing applies until approved.`
              : `The background review for ${run.date} reviewed ${run.tasksReviewed} task(s) and proposed nothing.`,
          key: `skill-review:${run.date}:${run.id}`,
        },
      },
    };
  }
  // Save a memory to the internal store (canonical — this is the write
  // that must succeed), then mirror it to the memory lanes (Mem0, the
  // main lane, Graphiti, the side lane, and Hindsight, the third lane).
  // The mirrors are awaited so
  // callers and tests can rely on them having been attempted, but a
  // lane failure never fails the save: lane adds report by value, and
  // the catches here are belt-and-braces.
  async remember(owner: string, memory: AgentMemory, ifAbsent = false): Promise<AgentMemory> {
    const saved = ifAbsent
      ? await this.db.insertIfAbsent(owner, "memories", memory)
      : await this.db.put(owner, "memories", memory);
    // Mirror only when this call actually stored the memory (an
    // insertIfAbsent that found an existing record returns null; that
    // record was already mirrored when it was first saved).
    if (saved !== null || !ifAbsent) {
      if (this.mem0.configured) {
        const mirrored = await this.mem0.add(memory.text).catch(() => false);
        // A successful mirror means the lane already holds this
        // fact: settle its content hash so the nightly distillation
        // job (engine/distillation.ts) never writes it a second
        // time (Mem0 has no delete endpoint — duplicates are
        // forever). Best-effort, like the audit emissions.
        if (mirrored) await recordSettledFact(this.db, owner, memory.text).catch(() => undefined);
      }
      if (this.graphiti.configured) await this.graphiti.add(memory.text).catch(() => false);
      if (this.hindsight.configured) await this.hindsight.add(memory.text).catch(() => false);
      // A memory was actually written (a duplicate insertIfAbsent
      // returns null above and is not a new write): count it.
      await this.recordAudit(owner, "memory.saved", "succeeded", { memories: 1 });
    }
    return saved ?? memory;
  }
  // Recall for agent context: the internal list, merged with facts the
  // memory lanes surface for the query — Mem0 (main lane) first, then
  // Graphiti (side lane), then Hindsight (third lane). Lane facts the
  // internal store already holds,
  // or that another lane already contributed (same text, case/
  // whitespace-insensitive), are not duplicated. With no query, no
  // lane configured, or the lanes down, this is exactly the internal
  // list — the pre-adapter behavior.
  async recallMemories(owner: string, query?: string): Promise<AgentMemory[]> {
    const internal = await this.db.list<AgentMemory>(owner, "memories");
    if (!query) return internal;
    const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
    const known = new Set(internal.map((memory) => normalize(memory.text)));
    const extra: AgentMemory[] = [];
    const merge = (facts: string[], prefix: string, source: string) => {
      for (const fact of facts) {
        if (known.has(normalize(fact))) continue;
        known.add(normalize(fact));
        extra.push({
          id: `${prefix}-${hash(fact)}`,
          text: fact,
          source,
          // The lanes' search replies carry no timestamps; epoch marks
          // "date unknown" instead of inventing one.
          createdAt: new Date(0).toISOString(),
        });
      }
    };
    if (this.mem0.configured)
      merge(
        await this.mem0.search(query).catch(() => [] as string[]),
        "mem0",
        "Mem0 (main memory lane)",
      );
    if (this.graphiti.configured)
      merge(
        await this.graphiti.search(query).catch(() => [] as string[]),
        "graphiti",
        "Graphiti (side memory lane)",
      );
    if (this.hindsight.configured)
      merge(
        await this.hindsight.search(query).catch(() => [] as string[]),
        "hindsight",
        "Hindsight (third memory lane)",
      );
    return extra.length ? [...internal, ...extra] : internal;
  }
  start() {
    this.worker.start();
    // Maintenance is independent of the HTTP response and reconciles durable records.
    void this.maintain().catch((error) => backgroundFailure("initial maintenance", error));
    this.maintenance = setInterval(() => {
      void this.maintain().catch((error) => backgroundFailure("maintenance", error));
    }, 60000);
  }
  async stop() {
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = undefined;
    await this.worker.stop();
    while (this.refreshing) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  private async maintain() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // Recover publications if the process exited after committing an outcome.
      for (const { owner, value } of await this.db.scan<AgentTask>("tasks"))
        await this.publishOutcome(owner, value);
      for (const { owner, value } of await this.db.scan<Monitor>("monitors"))
        await this.activateMonitor(owner, value);
      for (const { owner, value } of await this.db.scan<Idea>("ideas"))
        if (
          value.status === "accepted" &&
          value.taskId &&
          !(await this.db.get(owner, "tasks", value.taskId))
        )
          await this.decideIdea(owner, value.id, "accept").catch(async (error) => {
            backgroundFailure("recover accepted idea", error);
            await this.notify(
              owner,
              "Accepted idea needs attention",
              "Open the idea again after making room for another task.",
              undefined,
              `idea-recovery:${value.id}`,
            );
          });
      for (const { owner, value } of await this.db.scan<{ id: string; lastIdeasAt?: string }>(
        "agent-settings",
      )) {
        if (value.id !== "identity") continue;
        if (!value.lastIdeasAt || Date.now() - Date.parse(value.lastIdeasAt) > 15 * 60000)
          await this.refreshIdeas(owner).catch(async () => {
            await this.notify(
              owner,
              "Source refresh needs attention",
              "Reconnect the source or refresh Ideas to see the error.",
              undefined,
              `source-error:${Math.floor(Date.now() / 3600000)}`,
            );
          });
      }
    } finally {
      this.refreshing = false;
    }
  }
  async ensure(owner: string) {
    await this.db.insertIfAbsent(owner, "agent-settings", {
      id: "identity",
      name: "OpenMuse",
      tone: "warm",
    });
  }
  async snapshot(owner: string): Promise<AgentWorkspace> {
    await this.ensure(owner);
    const [tasks, goals, monitors, ideas, memories, artifacts, notifications, identity] =
      await Promise.all([
        this.db.list<AgentTask>(owner, "tasks"),
        this.db.list<Goal>(owner, "goals"),
        this.db.list<Monitor>(owner, "monitors"),
        this.db.list<Idea>(owner, "ideas"),
        this.db.list<AgentMemory>(owner, "memories"),
        this.db.list<AgentArtifact>(owner, "agent-artifacts"),
        this.db.list<AgentNotification>(owner, "notifications"),
        this.db.get<AgentIdentity>(owner, "agent-settings", "identity"),
      ]);
    const heartbeat = await this.db.get<{ lastTickAt: string }>("system", "worker-status", "tasks");
    return {
      tasks,
      goals,
      monitors,
      ideas,
      memories,
      artifacts,
      notifications,
      identity: identity ?? { name: "OpenMuse", tone: "warm" },
      worker: {
        running:
          this.worker.running ||
          Boolean(heartbeat && Date.now() - Date.parse(heartbeat.lastTickAt) < 15000),
        lastTickAt: heartbeat?.lastTickAt ?? this.worker.lastTickAt,
      },
    };
  }
  async getTask(owner: string, id: string) {
    const task = await this.db.get<AgentTask>(owner, "tasks", id);
    if (!task) throw new AppError("Task not found", 404);
    return task;
  }
  async detail(owner: string, id: string) {
    const task = await this.getTask(owner, id);
    const files = (await this.db.list<Artifact>(owner, "files")).filter((file) =>
      task.artifactIds.includes(file.id),
    );
    const browsers = (await this.db.list<BrowserSession>(owner, "browsers")).filter((browser) =>
      [task.state.browserId, task.state.sessionId].includes(browser.id),
    );
    return {
      task,
      files: files.map((file) => this.files.signed(owner, file)),
      browsers: browsers.map((browser) => this.browser.decorate(owner, browser)),
      events: (await this.db.list<RunEvent>(owner, "run-events"))
        .filter((e) => e.taskId === id)
        .sort((a, b) => a.date.localeCompare(b.date)),
      artifacts: (await this.db.list<AgentArtifact>(owner, "agent-artifacts")).filter(
        (a) => a.taskId === id,
      ),
    };
  }
  async createTask(owner: string, raw: unknown, idempotencyKey?: string, held = false) {
    const input = createTaskSchema.parse(raw);
    if (input.goalId && !(await this.db.get(owner, "goals", input.goalId)))
      throw new AppError("Goal not found", 404);
    const id = idempotencyKey ? hash(`task:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<AgentTask>(owner, "tasks", id);
    if (existing) return existing;
    if (
      (await this.db.list<AgentTask>(owner, "tasks")).filter((t) => !terminal.has(t.status))
        .length >= 100
    )
      throw new AppError("Finish or cancel some tasks before adding more", 409);
    const titles =
      input.kind === "document"
        ? [
            "Find the source document",
            "Fill a new copy",
            "Prepare a reply",
            "Wait for your decision",
            "Record the outcome",
          ]
        : input.kind === "monitor"
          ? ["Check the source", "Compare with the last observation", "Report a meaningful change"]
          : input.kind === "finance"
            ? ["Validate transactions", "Calculate the summary", "Save your tracker"]
            : ["Understand the outcome", "Plan the work", "Use connected tools", "Return a result"];
    const task: AgentTask = {
      id,
      title: input.title ?? input.prompt.slice(0, 90),
      prompt: input.prompt,
      kind: input.kind,
      goalId: input.goalId,
      status: held ? "paused" : "queued",
      plan: titles.map((title, i) => ({ id: String(i), title, status: "pending" })),
      evidence: [],
      input: input.input,
      state: {
        connectionId: (await this.workspace.connection(owner))?.id ?? null,
        ...(held && input.kind === "monitor" ? { initializingMonitor: true } : {}),
      },
      createdAt: date(),
      updatedAt: date(),
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
    };
    await this.ensure(owner);
    const inserted = await this.db.insertIfAbsent(owner, "tasks", task);
    if (inserted) await this.recordAudit(owner, "task.created", "succeeded", { tasks: 1 });
    return (await this.db.get<AgentTask>(owner, "tasks", id)) ?? task;
  }
  async control(owner: string, id: string, action: "pause" | "resume" | "cancel" | "retry") {
    const task = await this.getTask(owner, id);
    if (action === "cancel" && task.status === "succeeded")
      throw new AppError("This task is already complete", 409);
    if (action === "retry" && task.status !== "failed")
      throw new AppError("Only failed tasks can be retried", 409);
    if (action === "resume" && task.status !== "paused")
      throw new AppError("Only paused tasks can be resumed", 409);
    if (action === "pause" && (terminal.has(task.status) || task.status === "paused")) return task;
    const status =
      action === "cancel"
        ? "cancelled"
        : action === "pause"
          ? "paused"
          : task.actionId
            ? "waiting_approval"
            : "queued";
    if (action === "retry" && task.actionId) {
      const a = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (a && a.status !== "succeeded")
        throw new AppError(
          "Check the reviewed action before retrying; its outcome may be uncertain. Start a new task when reconciled.",
          409,
        );
    }
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: task.status, leaseId: task.leaseId ?? null },
      {
        status,
        leaseId: null,
        leaseUntil: null,
        error: null,
        updatedAt: date(),
        result:
          action === "cancel"
            ? "Stopped by you."
            : action === "pause"
              ? "Paused. Resume when you're ready."
              : "",
        ...(task.kind === "monitor" && action === "resume"
          ? { state: { ...task.state, failures: 0, notice: null } }
          : {}),
      },
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    this.worker.abort(id);
    if (task.kind === "monitor")
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        {},
        {
          status: action === "cancel" ? "stopped" : action === "pause" ? "paused" : "active",
          nextCheckAt: date(),
        },
      );
    if (action === "cancel" && task.actionId) {
      const proposal = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (proposal?.status === "awaiting_review")
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
    }
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: id,
      kind: "status",
      date: date(),
      title: `Task ${status}`,
      detail: "Changed by you",
    });
    return updated;
  }
  async answer(
    owner: string,
    id: string,
    answer: string,
    fields?: Record<string, string | boolean>,
  ) {
    const task = await this.getTask(owner, id);
    if (task.status !== "waiting_input")
      throw new AppError("This task is not waiting for input", 409);
    const next = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: "waiting_input" },
      {
        status: "queued",
        question: null,
        input: { ...task.input, ...(fields ? { fields } : {}) },
        state: { ...task.state, answer },
        updatedAt: date(),
      },
    );
    if (!next) throw new AppError("Task changed; refresh and try again", 409);
    return next;
  }
  async createGoal(owner: string, raw: unknown, id?: string) {
    const input = goalInputSchema.parse(raw);
    const goal: Goal = {
      id: id ?? randomUUID(),
      title: input.title,
      description: input.description,
      category: input.category,
      status: "active",
      milestones: input.milestones.map((title) => ({ id: randomUUID(), title, done: false })),
      createdAt: date(),
    };
    await this.db.insertIfAbsent(owner, "goals", goal);
    return (await this.db.get<Goal>(owner, "goals", goal.id)) ?? goal;
  }
  async updateGoal(
    owner: string,
    id: string,
    patch: { status?: Goal["status"]; milestones?: Goal["milestones"] },
  ) {
    const goal = await this.db.get<Goal>(owner, "goals", id);
    if (!goal) throw new AppError("Goal not found", 404);
    const saved = await this.db.put(owner, "goals", { ...goal, ...patch });
    if (patch.status === "paused")
      for (const task of await this.db.list<AgentTask>(owner, "tasks"))
        if (task.goalId === id && !terminal.has(task.status) && task.status !== "paused")
          await this.control(owner, task.id, "pause");
    return saved;
  }
  async createMonitor(owner: string, raw: unknown, idempotencyKey?: string) {
    const input = monitorInputSchema.parse(raw);
    const url = new URL(input.url);
    if (url.protocol === "sample:" && this.config.mode !== "sample")
      throw new AppError("Sample sources are unavailable in live workspaces", 422);
    if (!["https:", "http:", "sample:"].includes(url.protocol) || url.username || url.password)
      throw new AppError("Use a public HTTP(S) page", 422);
    if (url.protocol === "sample:" && input.url !== "sample://availability")
      throw new AppError("Unknown sample source", 422);
    const id = idempotencyKey ? hash(`monitor:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<Monitor>(owner, "monitors", id);
    if (existing) {
      await this.activateMonitor(owner, existing);
      return existing;
    }
    const task = await this.createTask(
      owner,
      {
        kind: "monitor",
        title: input.title,
        prompt: `Watch ${input.url} for ${input.condition}${input.value ? `: ${input.value}` : ""}`,
        input: { monitorId: id },
      },
      `monitor:${id}`,
      true,
    );
    const monitor: Monitor = {
      id,
      taskId: task.id,
      ...input,
      status: "active",
      nextCheckAt: date(),
      checks: 0,
    };
    await this.db.insertIfAbsent(owner, "monitors", monitor);
    await this.activateMonitor(owner, monitor);
    return monitor;
  }
  private async activateMonitor(owner: string, monitor: Monitor) {
    if (monitor.status !== "active") return;
    const task = await this.getTask(owner, monitor.taskId);
    if (task.status !== "paused" || !task.state.initializingMonitor) return;
    await this.db.compareAndSwap(
      owner,
      "tasks",
      task.id,
      { status: "paused", attempts: 0, state: { initializingMonitor: true } },
      {
        status: "queued",
        state: { ...task.state, initializingMonitor: false },
      },
    );
  }
  async controlMonitor(owner: string, id: string, action: "pause" | "resume" | "stop" | "check") {
    const monitor = await this.db.get<Monitor>(owner, "monitors", id);
    if (!monitor) throw new AppError("Monitor not found", 404);
    if (monitor.status === "stopped" && action !== "stop")
      throw new AppError("Create a new watch to restart this stopped monitor", 409);
    const status = action === "pause" ? "paused" : action === "stop" ? "stopped" : "active";
    const saved = await this.db.put(owner, "monitors", { ...monitor, status, nextCheckAt: date() });
    const task = await this.getTask(owner, monitor.taskId);
    if (action === "pause" || action === "stop")
      await this.control(owner, task.id, action === "pause" ? "pause" : "cancel");
    else {
      this.worker.abort(task.id);
      await this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        { status: task.status, leaseId: task.leaseId ?? null },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, failures: 0, notice: null },
        },
      );
    }
    return saved;
  }
  async refreshIdeas(owner: string) {
    const w = await this.workspace.snapshot(owner);
    const sentIds = new Set(
      w.mail.filter((mail) => /^Sent\b/i.test(mail.label)).map((mail) => mail.id),
    );
    const completedSources = new Set(
      (await this.db.list<AgentTask>(owner, "tasks"))
        .filter((task) => task.status === "succeeded" && typeof task.input.messageId === "string")
        .map((task) => `${task.kind}:${task.input.messageId}`),
    );
    const obsolete = (kind: AgentTask["kind"], messageId: unknown) =>
      typeof messageId === "string" &&
      (sentIds.has(messageId) || completedSources.has(`${kind}:${messageId}`));
    // Retire earlier suggestions as well as preventing new duplicates. A concurrent
    // acceptance wins its own compare-and-swap and is never overwritten here.
    for (const idea of await this.db.list<Idea>(owner, "ideas"))
      if (idea.status === "new" && obsolete(idea.kind, idea.input.messageId))
        await this.db.compareAndSwap(
          owner,
          "ideas",
          idea.id,
          { status: "new" },
          { status: "dismissed" },
        );
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("document", m.id) &&
          m.attachments.length &&
          /form|permission|complete|fill|sign/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      const id = hash(`document:${mail.id}:${mail.body}`);
      const idea: Idea = {
        id,
        title: `I can help with ${mail.subject}`,
        reason: `${mail.sender} sent a document that may need your attention. I can prepare it and a reply for your review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Help complete the PDF from “${mail.subject}” and prepare a reply for review.`,
        kind: "document",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      };
      await this.db.insertIfAbsent(owner, "ideas", idea);
    }
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("agent", m.id) &&
          /coffee|meet|available|schedule/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      await this.db.insertIfAbsent(owner, "ideas", {
        id: hash(`coordination:${mail.id}`),
        title: `I can help coordinate ${mail.subject}`,
        reason: `${mail.sender} mentioned getting together. I can check your calendar and prepare a response for review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Review the email “${mail.subject}”, check my calendar, and propose a next step. Ask me about missing preferences before preparing a reply.`,
        kind: "agent",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      } satisfies Idea);
    }
    for (const goal of await this.db.list<Goal>(owner, "goals"))
      if (goal.status === "active" && !goal.milestones.length) {
        const id = hash(`goal:${goal.id}:${goal.description}`);
        await this.db.insertIfAbsent(owner, "ideas", {
          id,
          title: `Let's make a plan for ${goal.title}`,
          reason: "This goal has no milestones yet. A concrete plan will give it a next step.",
          evidence: [{ id: goal.id, kind: "user", title: goal.title, excerpt: goal.description }],
          prompt: `Create an actionable plan for ${goal.title}. ${goal.description}`,
          kind: "plan",
          input: { goalId: goal.id },
          status: "new",
          createdAt: date(),
        } satisfies Idea);
      }
    await this.ensure(owner);
    await this.db.compareAndSwap(owner, "agent-settings", "identity", {}, { lastIdeasAt: date() });
    return this.db.list<Idea>(owner, "ideas");
  }
  async decideIdea(owner: string, id: string, action: "accept" | "dismiss", prompt?: string) {
    let idea = await this.db.get<Idea>(owner, "ideas", id);
    if (!idea) throw new AppError("Idea not found", 404);
    if (idea.status === "dismissed" || (idea.status === "accepted" && action === "dismiss"))
      return idea;
    if (action === "dismiss")
      return this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        { status: "dismissed" },
      );
    if (idea.status === "new") {
      const claimed = await this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        {
          status: "accepted",
          taskId: hash(`task:idea:${id}`),
          prompt: prompt ?? idea.prompt,
        },
      );
      idea = claimed ?? (await this.db.get<Idea>(owner, "ideas", id));
      if (idea?.status !== "accepted") return idea;
    }
    const goal = await this.createGoal(
      owner,
      { title: idea.title, description: idea.reason },
      hash(`idea-goal:${id}`),
    );
    const task = await this.createTask(
      owner,
      {
        title: idea.title,
        prompt: idea.prompt,
        kind: idea.kind,
        input: idea.input,
        goalId: goal.id,
      },
      `idea:${id}`,
    );
    await this.db.compareAndSwap(
      owner,
      "ideas",
      id,
      { status: "new" },
      { status: "accepted", taskId: task.id },
    );
    return this.db.get<Idea>(owner, "ideas", id);
  }
  async notify(owner: string, title: string, body: string, taskId?: string, key?: string) {
    const value: AgentNotification = {
      id: key ? hash(key) : randomUUID(),
      taskId,
      title,
      body,
      createdAt: date(),
      read: false,
    };
    await this.db.insertIfAbsent(owner, "notifications", value);
    // Positive evidence only: the record is read back from the store
    // before delivery is claimed, whether this call stored it or a
    // previous publication of the same keyed notice did. A null here
    // means the write neither stored nor found the record —
    // delivery unconfirmed, which callers on the scheduled path
    // record as delivery_unverified (engine/cron.ts).
    return this.db.get<AgentNotification>(owner, "notifications", value.id);
  }
  mailEvidence(mail: Mail): Evidence {
    return { id: mail.id, kind: "mail", title: mail.subject, excerpt: mail.body.slice(0, 400) };
  }
  async artifact(
    owner: string,
    task: AgentTask,
    kind: AgentArtifact["kind"],
    title: string,
    summary: string,
    data: Record<string, unknown>,
    key: string = kind,
  ) {
    const value: AgentArtifact = {
      id: hash(`${task.id}:${key}`),
      taskId: task.id,
      kind,
      title,
      summary,
      data,
      createdAt: date(),
    };
    await this.db.put(owner, "agent-artifacts", value);
    return value;
  }
  async prepare(
    owner: string,
    task: AgentTask,
    input: ProposalInput,
    key: string,
    context: TaskContext,
  ) {
    await context.guard();
    const connection = await this.workspace.connection(owner);
    if (connection?.id !== task.state.connectionId)
      throw new AppError(
        "Google connection changed during this task. Start a new task using the current account.",
        409,
      );
    const proposal = await this.actions.propose(owner, input, `${task.id}:${key}`, task.id);
    try {
      await context.checkpoint({ actionId: proposal.id });
    } catch (error) {
      if (proposal.status === "awaiting_review")
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
      throw error;
    }
    await context.event(
      "approval",
      proposal.title,
      `Review prepared for ${proposal.account ?? "the connected account"}`,
    );
    return proposal;
  }
  private async execute(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    await this.recordAudit(owner, "task.started", "succeeded", {
      tasks: 1,
      attempts: task.attempts,
    });
    await context.event(
      "status",
      task.attempts === 1 ? "Started working" : "Resumed work",
      task.prompt,
    );
    if (task.actionId) {
      const action = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (!action) throw new Error("The linked review could not be found");
      if (action.status === "succeeded") {
        await context.event("result", "Approved action completed", action.result);
        if (task.kind === "document")
          return this.finish(task, context, action.result ?? "Reply completed");
        task = await context.checkpoint({
          state: { ...task.state, approvalResult: action.result },
          actionId: null,
        });
      } else if (action.status !== "awaiting_review" && action.status !== "executing")
        throw new Error(
          `Reviewed action ${action.status}: ${action.error ?? "No further action was taken"}`,
        );
      else return { status: "waiting_approval" };
    }
    if (task.kind === "document") return this.document(owner, task, context);
    // Nightly distillation (engine/distillation.ts): the scheduled
    // job is an ordinary worker task flagged by its input, so it
    // rides the same leasing/settled/delivery machinery as monitors
    // and never reaches the model path (deterministic v1).
    if (task.input.distillation === true) return this.executeDistillation(owner, task, context);
    // Nightly skill review (engine/skill-review.ts): the scheduled
    // job is an ordinary worker task flagged by its input, riding
    // the same machinery; it never reaches the model path (the
    // default reviewer is deterministic).
    if (task.input.skillReview === true) return this.executeSkillReview(owner, task, context);
    if (task.kind === "monitor") {
      // Cron preflight (engine/cron.ts): a scheduled job whose
      // definition no longer validates, whose prerequisites are
      // missing, or whose delivery target does not resolve is
      // blocked BEFORE any page fetch or model call. The block is
      // terminal for the run, the watch pauses, and the alert is
      // raised once — its notice key is stable per issue set, so
      // re-publication can never re-alert.
      const monitor = await this.db.get<Monitor>(owner, "monitors", String(task.input.monitorId));
      const issues = preflightMonitorJob(task, monitor, this.config);
      if (issues.length) {
        const detail = `This watch is blocked by its configuration: ${issues.join("; ")}. Fix the watch to run it again.`;
        if (monitor)
          await this.db.compareAndSwap(
            owner,
            "monitors",
            monitor.id,
            { status: "active" },
            { status: "paused", error: detail },
          );
        await context.event("error", "Watch blocked by configuration", detail);
        return {
          status: "blocked_config",
          error: detail,
          state: {
            ...task.state,
            blockedConfig: true,
            notice: {
              title: "Watch blocked — configuration needs attention",
              body: detail,
              key: `blocked-config:${task.id}:${hash(issues.join(";"))}`,
            },
          },
        };
      }
      try {
        return await this.observe(owner, task, context);
      } catch (error) {
        if (error instanceof LostLeaseError || context.signal.aborted) throw error;
        await context.guard();
        const failures = Number(task.state.failures ?? 0) + 1;
        const detail = error instanceof Error ? error.message : "Page check failed";
        const nextCheckAt = new Date(
          Date.now() + Math.min(60, 2 ** failures) * 60000,
        ).toISOString();
        await this.db.compareAndSwap(
          owner,
          "monitors",
          String(task.input.monitorId),
          { status: "active" },
          {
            error: detail,
            nextCheckAt,
            ...(failures >= 5 ? { status: "paused" } : {}),
          },
        );
        await context.event(
          "error",
          failures >= 5 ? "Watch paused after repeated failures" : "Check failed; retry scheduled",
          detail,
        );
        // Incident dedup (engine/cron.ts): failures folding into the
        // same normalized error signature alert once, remind after
        // ~6h, and re-arm on success (observe clears the incident).
        // The pause transition itself always alerts — it is a state
        // change, not another tick of the same failure.
        const signature = normalizeErrorSignature(detail);
        const { action, incident } = decideIncident(
          incidentFromState(task.state.incident),
          signature,
          hash(signature).slice(0, 16),
          Date.now(),
        );
        const paused = failures >= 5;
        const notice =
          !paused && action === "suppress"
            ? null
            : {
                title: "Watch needs attention",
                body: detail,
                // The key is per incident (its firstAt), not just per
                // signature: a success re-arms alerting, and the new
                // incident's first alert must not be swallowed by the
                // previous incident's already-delivered notice.
                key: `watch-error:${task.id}:${incident.hash}:${
                  paused ? "paused" : action === "remind" ? `remind:${incident.reminders}` : "first"
                }:${incident.firstAt}`,
              };
        return {
          status: paused ? "paused" : "scheduled",
          error: detail,
          nextRunAt: nextCheckAt,
          state: {
            ...task.state,
            failures,
            incident,
            notice,
          },
        };
      }
    }
    if (task.kind === "finance") {
      await context.event("step", "Analyzing the imported transactions");
      const csv = z.string().parse(task.input.csv);
      const data = analyzeSpending(csv);
      const artifact = await this.artifact(
        owner,
        task,
        "finance",
        "Spending tracker",
        `${data.count} transactions · ${data.spending.toFixed(2)} spent`,
        data,
      );
      task = await context.checkpoint({
        artifactIds: [artifact.id],
        evidence: [
          {
            id: task.id,
            kind: "user",
            title: "Your transaction CSV",
            excerpt: `${data.count} rows; ${data.period.from} through ${data.period.to}`,
          },
        ],
      });
      return this.finish(task, context, artifact.summary);
    }
    const result = await executeModelTask(this, owner, task, context);
    const continued = await this.autoContinueIfUnconfirmed(task, result, context);
    return this.applyVerifierSpine(owner, task, result, continued, context);
  }
  // Verifier spine (Design Note A): every model run leaves a
  // StageTrace on the task record, and a SUCCEEDED run passes two
  // gates before its completion is finalized.
  // - Critic: grounded = >=1 surviving evidence match from the recall
  //   path (internal store -> Mem0 -> Graphiti -> Hindsight, the
  //   recallMemories merge order, filtered by the 0.75 coverage
  //   threshold) or from the task's own evidence, OR >=1 successful
  //   tool result in the run. Not grounded: the completion is NOT
  //   shipped — the task parks paused ("blocked") with the fixed
  //   insufficient-evidence refusal as its result, resumable by the
  //   user like any paused task.
  // - Verifier (write tasks only — a mutating tool succeeded): the
  //   completion must be non-empty, every citation it makes must name
  //   a source from the EvidenceBundle, and every save_memory write
  //   is read back exactly once and compared with what the tool
  //   reported (the PR #22 proof pattern as a standing check). On
  //   failure the completion is replaced with the verification-failed
  //   status and the task fails — never silently shipped.
  // An unconfirmed run (no finish_task / ask_user) is a failed
  // Critique: the bounded auto-continue above owns its outcome
  // (requeue once, then honest failure) and this method only records
  // the blocked critic stage on its trace — it does not re-decide it.
  private async applyVerifierSpine(
    owner: string,
    task: AgentTask,
    runResult: Partial<AgentTask>,
    continued: Partial<AgentTask>,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const unconfirmed =
      runResult.status === "waiting_input" && runResult.question === UNCONFIRMED_RUN_QUESTION;
    if (!unconfirmed && continued.status !== "succeeded") return continued;
    const fresh = (await this.db.get<AgentTask>(owner, "tasks", task.id)) ?? task;
    const plan = createPlan(task.prompt);
    const memories = await this.recallMemories(owner, task.prompt);
    const recallMatches = survivingMatches(
      task.prompt,
      memories.map((memory) => ({ id: memory.id, source: memory.source, text: memory.text })),
    );
    const seen = new Set<string>();
    const matches: EvidenceBundle["matches"] = [];
    for (const match of [
      ...recallMatches,
      ...fresh.evidence.map((evidence) => ({
        id: evidence.id,
        source: evidence.title,
        excerpt: evidence.excerpt,
        score: 1,
      })),
    ]) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      matches.push(match);
    }
    const bundle: EvidenceBundle = { matches };
    const stateOf = (value: Partial<AgentTask>) =>
      value.state && typeof value.state === "object" ? value.state : {};
    const toolResults = [
      ...new Set([
        ...((stateOf(runResult).toolResults as string[] | undefined) ?? []),
        ...((fresh.state.toolResults as string[] | undefined) ?? []),
      ]),
    ];
    // A run resumed from an approved action carries that action's
    // result in state — a successful result in the run, for grounding.
    const successfulToolResults = toolResults.length + (fresh.state.approvalResult ? 1 : 0);
    const critique = critiqueAnswer(task.prompt, bundle, successfulToolResults);
    const documentCount = new Set(bundle.matches.map((match) => match.source)).size;
    const trace: StageTrace[] = [
      {
        sequence: 1,
        agent: "planner",
        outcome: "completed",
        summary: "Created an evidence-first execution plan.",
        metrics: { task_count: plan.tasks.length, query_term_count: plan.queryTermCount },
      },
      {
        sequence: 2,
        agent: "researcher",
        outcome: "completed",
        summary: "Collected evidence from the recall path and the task record.",
        metrics: { evidence_count: bundle.matches.length, document_count: documentCount },
      },
      {
        sequence: 3,
        agent: "critic",
        outcome: !unconfirmed && critique.grounded ? "completed" : "blocked",
        summary: unconfirmed
          ? "Blocked the run because it ended without confirming completion."
          : critique.grounded
            ? "Approved the evidence for grounded completion."
            : "Blocked unsupported completion because no matching evidence was found.",
        metrics: {
          approved: !unconfirmed && critique.grounded,
          query_coverage: critique.queryCoverage,
          tool_result_count: successfulToolResults,
          ...(unconfirmed ? { unconfirmed: true } : {}),
        },
      },
    ];
    if (unconfirmed) {
      trace.push({
        sequence: 4,
        agent: "writer",
        outcome: "blocked",
        summary: "No confirmed answer was produced.",
        metrics: { answer_chars: 0, citation_count: 0 },
      });
      return { ...continued, stageTrace: trace };
    }
    const answer = typeof continued.result === "string" ? continued.result : "";
    trace.push({
      sequence: 4,
      agent: "writer",
      outcome: "completed",
      summary: critique.grounded
        ? "Produced the completion from approved evidence."
        : "Returned the insufficient-evidence response.",
      metrics: { answer_chars: answer.length, citation_count: citedIds(answer).length },
    });
    const mergedState = { ...fresh.state, ...stateOf(continued) };
    if (!critique.grounded) {
      await context.event("error", "Insufficient evidence", INSUFFICIENT_EVIDENCE);
      return {
        ...continued,
        status: "paused",
        result: INSUFFICIENT_EVIDENCE,
        error: INSUFFICIENT_EVIDENCE,
        question: null,
        plan: fresh.plan,
        stageTrace: trace,
        state: {
          ...mergedState,
          criticBlocked: true,
          notice: {
            title: "Task blocked — insufficient evidence",
            body: INSUFFICIENT_EVIDENCE,
            key: `critic-blocked:${task.id}:${task.attempts}`,
          },
        },
      } as unknown as Partial<AgentTask>;
    }
    const isWrite = toolResults.some((name) => MUTATING_TOOLS.has(name));
    if (isWrite) {
      // The Verifier's bundle also names the run's tool-result ids, so
      // a citation to a saved memory or artifact is a known source.
      const operations =
        fresh.state.operations && typeof fresh.state.operations === "object"
          ? (fresh.state.operations as Record<string, unknown>)
          : {};
      const savedMemories = Object.values(operations).filter(
        (value): value is { saved: true; id: string; text: string } =>
          value !== null &&
          typeof value === "object" &&
          (value as { saved?: unknown }).saved === true &&
          typeof (value as { id?: unknown }).id === "string" &&
          typeof (value as { text?: unknown }).text === "string",
      );
      const verifierBundle: EvidenceBundle = {
        matches: [
          ...bundle.matches,
          ...savedMemories.map((memory) => ({
            id: memory.id,
            source: "save_memory tool result",
            excerpt: memory.text,
            score: 1,
          })),
          ...fresh.artifactIds.map((id) => ({
            id,
            source: "task artifact",
            excerpt: "",
            score: 1,
          })),
        ].filter((match, index, all) => all.findIndex((other) => other.id === match.id) === index),
      };
      const verification = verifyCompletionCitations(verifierBundle, {
        content: answer,
        citationCount: citedIds(answer).length,
      });
      // save_memory read-back, exactly once: one read of the memory
      // store, every reported save compared against the stored text.
      let readBackVerified = true;
      if (toolResults.includes("save_memory")) {
        const stored = await this.db.list<AgentMemory>(owner, "memories");
        readBackVerified = savedMemories.every((memory) =>
          stored.some((entry) => entry.id === memory.id && entry.text === memory.text),
        );
      }
      const approved = verification.approved && readBackVerified;
      // The Verifier stage's own outcome joins the audit log (the
      // task-level mirror — task.verification_failed or
      // task.completed — is emitted when the run settles).
      await this.recordAudit(
        owner,
        approved ? "verifier.approved" : "verifier.rejected",
        approved ? "succeeded" : "failed",
        { verifications: 1, citations: verification.reportedCitationCount },
      );
      trace.push({
        sequence: 5,
        agent: "verifier",
        outcome: approved ? "completed" : "blocked",
        summary: approved
          ? "Verified the write task's completion invariants."
          : "Blocked the completion because verification invariants failed.",
        metrics: {
          approved,
          citation_paths_valid: verification.citationPathsValid,
          expected_citation_count: verification.expectedCitationCount,
          reported_citation_count: verification.reportedCitationCount,
          ...(toolResults.includes("save_memory") ? { read_back_verified: readBackVerified } : {}),
        },
      });
      if (!approved) {
        await context.event("error", "Verification failed", VERIFICATION_FAILED);
        return {
          ...continued,
          status: "failed",
          result: VERIFICATION_FAILED,
          error: VERIFICATION_FAILED,
          question: null,
          plan: fresh.plan,
          stageTrace: trace,
          state: { ...mergedState, verificationFailed: true },
        } as unknown as Partial<AgentTask>;
      }
    }
    return { ...continued, stageTrace: trace };
  }
  // A model run that ends unconfirmed used to park the task in
  // waiting_input indefinitely — no answer, no failure, a silent stall
  // from the user's seat. The FIRST time that happens for a task,
  // issue the follow-up the canned message asks for automatically:
  // requeue the task with AUTO_CONTINUE_INSTRUCTION in state.answer
  // (the channel a user's reply uses) and record the continuation as a
  // run event, so it is visible in the task's event log. The spend is
  // tracked in task state (state.autoContinued): if the continuation
  // run ALSO ends unconfirmed, the task is failed honestly with
  // UNCONFIRMED_RUN_FAILURE on the record — never parked forever.
  // Hard bound: one auto-continue per task, no loop.
  // Only the unconfirmed-end outcome is eligible: it is identified by
  // the exact canned question (UNCONFIRMED_RUN_QUESTION). Genuine
  // agent questions (ask_user, the document field prompt) and the
  // missing-model message carry different question text and are never
  // auto-continued.
  private async autoContinueIfUnconfirmed(
    task: AgentTask,
    result: Partial<AgentTask>,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    if (result.status !== "waiting_input" || result.question !== UNCONFIRMED_RUN_QUESTION)
      return result;
    const state = { ...task.state, ...(result.state ?? {}) };
    if (state.autoContinued) {
      await context.event("error", "Task needs attention", UNCONFIRMED_RUN_FAILURE);
      return {
        ...result,
        status: "failed",
        // Clear the canned question, like the requeue above does;
        // the patch is JSON-merged, so null is the stored value.
        question: null,
        error: UNCONFIRMED_RUN_FAILURE,
        state,
      } as unknown as Partial<AgentTask>;
    }
    await context.event(
      "status",
      "Auto-continue",
      "The run ended without confirming completion, so the task was continued automatically — once — with a system instruction to finish and confirm the result. No input was needed from you.",
    );
    return {
      ...result,
      status: "queued",
      // Clear the canned question, like answer() does when requeueing;
      // the patch is JSON-merged, so null is the stored value.
      question: null,
      state: { ...state, autoContinued: true, answer: AUTO_CONTINUE_INSTRUCTION },
    } as unknown as Partial<AgentTask>;
  }
  async finish(task: AgentTask, context: TaskContext, result: string) {
    await context.guard();
    await context.event("result", "Work completed", result);
    return {
      status: "succeeded" as const,
      result,
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" as const })),
    };
  }
  private async publishOutcome(owner: string, saved: AgentTask) {
    const task = await this.getTask(owner, saved.id);
    if (task.status === "succeeded") {
      await this.notify(
        owner,
        task.title,
        task.result ?? "Work completed",
        task.id,
        `task-done:${task.id}`,
      );
      if (task.goalId) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const goal = await this.db.get<Goal>(owner, "goals", task.goalId);
          if (!goal || goal.milestones.some((m) => m.id === task.id)) break;
          if (
            await this.db.compareAndSwap(
              owner,
              "goals",
              goal.id,
              { milestones: goal.milestones },
              {
                milestones: [...goal.milestones, { id: task.id, title: task.title, done: true }],
              },
            )
          )
            break;
        }
      }
    } else if (task.status === "failed") {
      await this.notify(
        owner,
        "Task needs attention",
        task.error ?? task.title,
        task.id,
        `task-error:${task.id}:${task.attempts}`,
      );
    } else if (task.status === "waiting_input") {
      await this.notify(
        owner,
        "Your details are needed",
        task.question ?? task.title,
        task.id,
        `input:${task.id}:${hash(task.question ?? "")}`,
      );
    } else if (task.status === "waiting_approval") {
      await this.notify(
        owner,
        "Ready for your review",
        task.title,
        task.id,
        `review:${task.actionId}`,
      );
    }
    if (task.status === "unknown") {
      // A crashed scheduled attempt always delivers its outcome —
      // the user must learn the run's result is unknown (and the
      // dedup key keeps re-publication from repeating the alert).
      await this.notify(
        owner,
        "Scheduled run outcome unknown",
        task.error ?? task.title,
        task.id,
        `task-unknown:${task.id}:${task.attempts}`,
      );
    }
    const notice = z
      .object({ title: z.string(), body: z.string(), key: z.string() })
      .safeParse(task.state.notice);
    if (
      (task.status === "scheduled" ||
        task.status === "blocked_config" ||
        (task.status === "paused" && task.error)) &&
      notice.success
    )
      await this.deliverOutcomeNotice(owner, task, notice.data);
  }
  // Delivery of a settled scheduled run's outcome notice
  // (engine/cron.ts): execution and delivery are separate facts, and
  // a delivery counts as delivered ONLY on positive evidence — the
  // notification record read back from the store (notify returns it),
  // never on attempt. A store rejection is delivery_failed; a write
  // that neither stored nor found the record is
  // delivery_unverified. Both are terminal for a monitor run: the
  // watch pauses in that state instead of ticking on with its alerts
  // going nowhere. A [SILENT] run output suppresses SUCCESS delivery
  // only — failure-class notices (the task carries an error) always
  // deliver. The per-attempt delivery record on the task's state
  // makes this idempotent: the maintenance scan re-offers every
  // settled task, and a run's delivery is decided exactly once.
  private async deliverOutcomeNotice(
    owner: string,
    task: AgentTask,
    notice: { title: string; body: string; key: string },
  ): Promise<void> {
    const prior = deliveryRecordSchema.safeParse(task.state.delivery);
    if (prior.success && prior.data.attempts === task.attempts && prior.data.key === notice.key)
      return;
    let status: DeliveryRecord["status"];
    if (
      !task.error &&
      (isSilentOutput(notice.body) || isSilentOutput(notice.title) || isSilentOutput(task.result))
    ) {
      status = "suppressed_silent";
    } else {
      let stored: AgentNotification | null = null;
      let rejected = false;
      try {
        stored = await this.notify(owner, notice.title, notice.body, task.id, notice.key);
      } catch {
        rejected = true;
      }
      status = rejected ? "delivery_failed" : stored ? "delivered" : "delivery_unverified";
    }
    const delivery: DeliveryRecord = {
      attempts: task.attempts,
      key: notice.key,
      status,
      at: date(),
    };
    const flip =
      (status === "delivery_failed" || status === "delivery_unverified") &&
      task.kind === "monitor" &&
      (task.status === "scheduled" || task.status === "paused");
    if (!flip) {
      await this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        { status: task.status, leaseId: task.leaseId ?? null },
        { state: { ...task.state, delivery } },
      );
      return;
    }
    const detail =
      status === "delivery_failed"
        ? "The watch ran, but its outcome could not be delivered: the notification store rejected the alert. The watch is paused in a delivery-failed state; resume it once delivery works again."
        : "The watch ran, but delivery of its outcome could not be confirmed: the notification was neither stored nor found afterwards. The watch is paused in a delivery-unverified state; resume it once delivery can be confirmed.";
    const updated = await this.db.compareAndSwap(
      owner,
      "tasks",
      task.id,
      { status: task.status, leaseId: task.leaseId ?? null },
      { status, error: detail, state: { ...task.state, delivery } },
    );
    if (!updated) return;
    await this.db.compareAndSwap(
      owner,
      "monitors",
      String(task.input.monitorId),
      { status: "active" },
      { status: "paused", error: detail },
    );
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: task.id,
      kind: "error",
      date: date(),
      title:
        status === "delivery_failed" ? "Outcome delivery failed" : "Outcome delivery unverified",
      detail,
    });
    await this.recordAudit(
      owner,
      status === "delivery_failed" ? "cron.delivery_failed" : "cron.delivery_unverified",
      "failed",
      { tasks: 1, attempts: task.attempts },
    );
  }
  private async document(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    let source = task.state.source as { mail: Mail; fileId: string } | undefined;
    if (!source) {
      const w = await this.workspace.snapshot(owner);
      const mail = w.mail.find((m) => m.id === task.input.messageId);
      if (!mail) throw new Error("Choose a current email with a PDF attachment to start this task");
      const ref = mail.attachments[0];
      if (!ref) throw new Error("This email has no PDF attachment");
      await ctx.guard();
      let file: Artifact;
      try {
        file = await this.files.get(owner, ref);
      } catch (error) {
        if (!(error instanceof AppError && error.status === 404)) throw error;
        file = await this.workspace.importAttachment(owner, ref);
      }
      source = { mail, fileId: file.id };
      task = await ctx.checkpoint({
        state: { ...task.state, source },
        evidence: [this.mailEvidence(mail)],
        plan: task.plan.map((s, i) => ({ ...s, status: i === 0 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Found the document", file.name);
    }
    const fields = z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional()
      .parse(task.input.fields);
    if (!fields || !Object.keys(fields).length) {
      const file = await this.files.get(owner, source.fileId);
      const names = file.fields
        ?.filter((f) => f.type !== "unsupported")
        .map((f) => f.name)
        .join(", ");
      if (!names)
        throw new Error(
          "This PDF has no supported fillable fields. Open it in Files to review it.",
        );
      return {
        status: "waiting_input",
        question: `Enter the form values you want to use. Supported fields: ${names}. The original PDF will stay intact.`,
        state: {
          ...task.state,
          source,
          missingFields: file.fields?.filter((f) => f.type !== "unsupported"),
        },
      };
    }
    let filledId = typeof task.state.filledId === "string" ? task.state.filledId : undefined;
    if (!filledId) {
      await ctx.guard();
      const filled = await this.files.fill(owner, source.fileId, fields);
      filledId = filled.id;
      task = await ctx.checkpoint({
        state: { ...task.state, source, filledId },
        artifactIds: [filledId],
        plan: task.plan.map((s, i) => ({ ...s, status: i <= 1 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Saved a filled copy", filled.name);
    }
    const input: ProposalInput = {
      kind: "email.send",
      data: {
        to: [source.mail.from],
        cc: [],
        bcc: [],
        subject: /^re:/i.test(source.mail.subject)
          ? source.mail.subject
          : `Re: ${source.mail.subject}`,
        body:
          typeof task.input.reply === "string"
            ? task.input.reply
            : "Hello,\n\nPlease find the completed form attached.\n\nThank you.",
        attachmentIds: [filledId],
        threadId: source.mail.threadId,
        replyToMessageId: source.mail.id,
      },
    };
    const proposal = await this.prepare(owner, task, input, "document-reply", ctx);
    return {
      status: "waiting_approval",
      actionId: proposal.id,
      plan: task.plan.map((s, i) => ({
        ...s,
        status: i < 3 ? "succeeded" : i === 3 ? "waiting" : "pending",
      })),
    };
  }
  private async observe(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const monitor = await this.db.get<Monitor>(owner, "monitors", String(task.input.monitorId));
    if (!monitor) throw new Error("Monitor not found");
    if (monitor.status !== "active")
      return { status: monitor.status === "paused" ? "paused" : "cancelled" };
    let observation: { url: string; title: string; text: string; sessionId?: string };
    if (monitor.url === "sample://availability") {
      if (this.config.mode !== "sample") throw new Error("Sample source unavailable");
      const page = await this.db.get<{ text: string }>(owner, "sample-pages", "availability");
      observation = {
        url: monitor.url,
        title: "Sample dinner availability",
        text: page?.text ?? "No tables available. Check again later.",
      };
    } else {
      await ctx.guard();
      observation = await this.browser.observe(
        owner,
        monitor.url,
        typeof task.state.sessionId === "string" ? task.state.sessionId : undefined,
      );
    }
    const text = observation.text.replace(/\s+/g, " ").trim();
    const currentHash = hash(text);
    const previousHash = monitor.lastHash;
    const matched =
      monitor.condition === "change"
        ? Boolean(previousHash && previousHash !== currentHash)
        : monitor.condition === "contains"
          ? text.toLowerCase().includes(monitor.value.toLowerCase())
          : this.matchesPrice(text, Number(monitor.value));
    const previouslyMatched = Boolean(task.state.matched);
    const shouldNotify = matched && (monitor.condition === "change" || !previouslyMatched);
    const nextCheckAt = new Date(Date.now() + monitor.intervalMinutes * 60000).toISOString();
    await ctx.guard();
    // Worker lease is checked before each publication; monitor control also invalidates that lease.
    const savedMonitor = await this.db.compareAndSwap(
      owner,
      "monitors",
      monitor.id,
      { status: "active" },
      {
        checks: monitor.checks + 1,
        lastCheckedAt: date(),
        lastHash: currentHash,
        lastValue: text.slice(0, 1000),
        nextCheckAt,
        error: null,
      },
    );
    if (!savedMonitor) throw new LostLeaseError();
    await ctx.event(
      "observation",
      previousHash ? "Checked for changes" : "Saved the first observation",
      text.slice(0, 1000),
    );
    if (shouldNotify) {
      await ctx.guard();
      await ctx.event("result", "A meaningful change was found", text.slice(0, 500));
    }
    return {
      status: "scheduled",
      nextRunAt: nextCheckAt,
      result: shouldNotify
        ? "Change found. A notification is ready."
        : "Watching. I'll check again on schedule.",
      state: {
        ...task.state,
        sessionId: observation.sessionId,
        matched,
        failures: 0,
        // A successful check re-arms incident alerting (engine/cron.ts).
        incident: null,
        notice: shouldNotify
          ? {
              title: monitor.title,
              body: `Condition met at ${observation.url}: ${text.slice(0, 240)}`,
              key: `monitor:${monitor.id}:${currentHash}`,
            }
          : null,
      },
      error: null,
      evidence: [
        {
          id: monitor.id,
          kind: "web",
          title: observation.title,
          url: observation.url,
          excerpt: text.slice(0, 600),
        },
      ],
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" })),
    };
  }
  private matchesPrice(text: string, threshold: number) {
    const matches = [...text.matchAll(/(?:\$|USD\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)];
    return matches.some((m) => Number(m[1].replace(/,/g, "")) < threshold);
  }
}
