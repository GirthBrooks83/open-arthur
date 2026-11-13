// Daily Brief — the operator-reporting SHAPE from LobeHub's
// Daily Brief + nightly self-review (parts-scavenge MAP, Tier 1
// item #8). PATTERNS ONLY: LobeHub is under the LobeHub Community
// License (not OSI), so no LobeHub code is used or adapted — only
// the reporting pattern, which the MAP records as: a morning brief
// with exactly three buckets (finished / still running / needs
// your decision), a nightly self-review that adds PROPOSAL actions
// to the brief (only an approved set ever executes — this module
// proposes, it never executes), and a self-evolving view that flags
// the lesson the agent keeps breaking.
//
// Where the shape lands in Open Arthur (a REPORT, not a new brain):
// - Finished / running / needs-decision are computed from the
//   owner's task records: finished = tasks that reached a terminal
//   status inside the brief's day window; running = queued/running
//   right now; needs-decision = tasks parked in waiting_approval /
//   waiting_input, plus Critic-blocked tasks paused for the
//   operator's review (the MAP's needs-decision bucket is where
//   pending approvals surface). The background skill review's
//   staged writes (engine/skill-review.ts, PR-epsilon) are the
//   other pending-approval surface: every undecided pending skill
//   write joins needs-decision as a first-class item, and the
//   latest review run is summarised in the self-review proposals.
// - The distillation diary section embeds the dream diary the
//   nightly distillation job (engine/distillation.ts, PR-delta)
//   wrote for the brief's date — "what Arthur consolidated last
//   night" as a standing brief section.
// - Needs-decision also carries the background skill review's
//   PENDING writes (engine/skill-review.ts, PR-epsilon): the MAP
//   puts approval of those proposals in this bucket, so the
//   operator sees each staged skill change here with its
//   rationale, next to the tasks waiting on him.
// - Lessons violated are derived from the verifier spine's
//   verdicts (PR-alpha): tasks whose completion the Verifier
//   rejected, tasks the Critic blocked for missing evidence, and
//   runs that ended without confirming completion. A lesson hit
//   twice or more in a day is the "keeps breaking" flag, and the
//   self-review turns each repeated lesson into a proposal action.
// - Delivery is two-channel: in-app (the brief record itself,
//   served by the authenticated brief routes, plus the standard
//   outcome notification) and a post to the team's Slack channel
//   (#team-arthur, under the operator's standing progress-post OK)
//   through the Slack bridge's bot token. Slack delivery is gated
//   per date: a brief whose date already posted is never posted
//   twice, exactly as distillation's hash gate makes a re-run a
//   no-op.
// - Scheduling rides the gamma-hardened scheduled-run machinery
//   (engine/cron.ts): the job is a worker task that returns
//   `scheduled` with the next morning's nextRunAt, its preflight
//   failure is the terminal `blocked_config` status, and its
//   outcome notice is delivered through the same delivery path
//   (positive evidence only). No second scheduler exists.
//
// The brief is DETERMINISTIC in v1 (no model call): buckets,
// lessons and proposals are computed from records, so the morning
// job costs zero tokens and can never fabricate a summary. A
// model-written narrative can later be layered over the same
// computed brief without changing its contract.
import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { type ConsultRecord, staleConsults } from "./consults.ts";
import { type DeliveryStatus, deliveryStatusSchema } from "./cron.ts";
import {
  DISTILLATION_RUN_KIND,
  type DistillationRun,
  DREAM_DIARY_KIND,
  type DreamDiary,
  dayWindow,
  isValidDay,
  scheduledDistillationDate,
} from "./distillation.ts";
import {
  listPendingSkillWrites,
  type PendingSkillWrite,
  SKILL_REVIEW_RUN_KIND,
  type SkillReviewRun,
} from "./skill-review.ts";

// Store kind for the brief records: ONE record per date (the
// record id IS the date, the dream-diary discipline), the full
// brief included, so the in-app read surface is the record itself
// and re-generating a date updates its brief instead of piling up
// duplicates — the history the briefs route serves is the days.
export const DAILY_BRIEF_KIND = "daily-briefs";

// The structural Slack surface the brief needs — the real
// SlackBriefPoster below satisfies it, and tests inject doubles.
// Posting reports by value, never by throwing, like the memory
// lanes: a Slack problem degrades the brief's delivery record, it
// never fails the brief.
export interface DailyBriefSlack {
  readonly configured: boolean;
  post(text: string): Promise<boolean>;
}

// Slack message text limits, mirroring src/slack.ts (the bridge's
// chunking discipline): keep each post comfortably under the
// practical limit and cap the number of chunks.
const SLACK_CHUNK_LIMIT = 3900;
const SLACK_MAX_CHUNKS = 3;
const SLACK_TIMEOUT_MS = 8000;

export function chunkBriefText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= SLACK_CHUNK_LIMIT) return [trimmed];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > SLACK_CHUNK_LIMIT && chunks.length < SLACK_MAX_CHUNKS - 1) {
    let cut = rest.lastIndexOf("\n", SLACK_CHUNK_LIMIT);
    if (cut < SLACK_CHUNK_LIMIT / 2) cut = rest.lastIndexOf(" ", SLACK_CHUNK_LIMIT);
    if (cut < SLACK_CHUNK_LIMIT / 2) cut = SLACK_CHUNK_LIMIT;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest && chunks.length < SLACK_MAX_CHUNKS)
    chunks.push(
      rest.length > SLACK_CHUNK_LIMIT ? `${rest.slice(0, SLACK_CHUNK_LIMIT - 1)}…` : rest,
    );
  return chunks.filter(Boolean);
}

// The real poster: the Slack bridge's bot token (config
// .slackBotToken, PR #13) posting to the one channel the operator
// designated for team progress posts (config.slackBriefChannel —
// the #team-arthur channel id). Env-gated and honest like every
// other lane: unset token or channel means not configured, and the
// brief records that instead of pretending it posted.
export class SlackBriefPoster implements DailyBriefSlack {
  private readonly token?: string;
  private readonly channel?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    token: string | undefined,
    channel: string | undefined,
    fetchFn: typeof fetch = fetch,
    timeoutMs = SLACK_TIMEOUT_MS,
  ) {
    this.token = token;
    this.channel = channel;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  get configured(): boolean {
    return Boolean(this.token && this.channel);
  }

  async post(text: string): Promise<boolean> {
    if (!this.token || !this.channel) return false;
    try {
      for (const chunk of chunkBriefText(text)) {
        const response = await this.fetchFn("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ channel: this.channel, text: chunk }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok || data.ok !== true) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Post ONE message and return its Slack ts (PR-iota: a consult matches
   * thread replies by the question's ts). No chunking — callers cap the
   * text under Slack's limit. By value like post(): undefined when
   * unconfigured, rejected, or the response carries no ts.
   */
  async postForTs(text: string): Promise<string | undefined> {
    if (!this.token || !this.channel) return undefined;
    try {
      const response = await this.fetchFn("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ channel: this.channel, text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || data.ok !== true || typeof data.ts !== "string") return undefined;
      return data.ts;
    } catch {
      return undefined;
    }
  }
}

export function dailyBriefSlackFor(config: Config): SlackBriefPoster {
  return new SlackBriefPoster(config.slackBotToken, config.slackBriefChannel);
}

export const briefItemSchema = z.object({
  taskId: z.string().min(1),
  title: z.string(),
  // The task's TaskStatus at brief-build time, kept as a plain
  // string: the brief is a report about statuses, not a consumer
  // that should break when the status enum grows.
  status: z.string().min(1),
  // One-line operator context: the result excerpt for a finished
  // task, the error for a failed one, the open question for a
  // waiting one. Null when the task carries none of those.
  detail: z.string().nullable(),
});
export type BriefItem = z.infer<typeof briefItemSchema>;

export const briefLessonSchema = z.object({
  // Stable lesson key (see LESSON_TEXT below).
  lesson: z.string().min(1),
  description: z.string(),
  count: z.number().int().positive(),
  taskIds: z.array(z.string()),
});
export type BriefLesson = z.infer<typeof briefLessonSchema>;

export const briefProposalSchema = z.object({
  title: z.string().min(1),
  detail: z.string(),
  source: z.enum(["lessons", "distillation", "skill_review"]),
});
export type BriefProposal = z.infer<typeof briefProposalSchema>;

// Slack delivery verdicts for a brief run. `already_delivered` is
// the per-date gate's no-op proof; `not_attempted` is recorded when
// the run was blocked before delivery was ever considered.
export const briefSlackDeliverySchema = z.enum([
  "delivered",
  "delivery_failed",
  "not_configured",
  "already_delivered",
  "not_attempted",
]);
export type BriefSlackDelivery = z.infer<typeof briefSlackDeliverySchema>;

export const dailyBriefSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  trigger: z.enum(["manual", "scheduled"]),
  status: z.enum(["succeeded", "blocked_config"]),
  // The three buckets (items capped at BRIEF_BUCKET_CAP; the counts
  // always carry the full totals).
  finished: z.array(briefItemSchema),
  finishedCount: z.number().int().nonnegative(),
  running: z.array(briefItemSchema),
  runningCount: z.number().int().nonnegative(),
  needsDecision: z.array(briefItemSchema),
  needsDecisionCount: z.number().int().nonnegative(),
  // The dream diary the nightly distillation wrote for this date,
  // embedded so the stored brief is self-contained; null when no
  // diary exists for the date.
  diaryDate: z.string().nullable(),
  diaryMarkdown: z.string().nullable(),
  lessonsViolated: z.array(briefLessonSchema),
  selfReviewProposals: z.array(briefProposalSchema),
  // Preflight issues (blocked_config). Operator-facing strings,
  // never exception text.
  issues: z.array(z.string()),
  // Delivery of the in-app outcome notice, decided by positive
  // evidence on the manual path (the scheduled path records its
  // delivery on the task, via engine/cron.ts, instead).
  deliveryStatus: deliveryStatusSchema.nullable(),
  slackDeliveryStatus: briefSlackDeliverySchema,
  // The rendered brief (Markdown) — the in-app surface's content.
  markdown: z.string(),
  createdAt: z.iso.datetime(),
});
export type DailyBrief = z.infer<typeof dailyBriefSchema>;

// Bucket items stored on the record are capped so a huge day can
// not bloat the record; counts always carry the true totals and
// the cap is reported in the rendered brief when it bites.
export const BRIEF_BUCKET_CAP = 25;
// Self-review proposals are likewise capped: a brief that proposes
// twenty actions proposes none.
export const BRIEF_PROPOSAL_CAP = 5;

// The next brief run: 15:00 UTC — morning for the operator (US
// Pacific, 07:00 PST / 08:00 PDT), and deliberately after the
// nightly distillation (02:17 UTC) and the skill review
// (03:17 UTC) so the brief can carry the dream diary and the
// review summary those runs produced. If today's slot is still
// ahead it is used; a run that fires just after 15:00 reschedules
// to tomorrow, never twice in a day.
export function nextDailyBriefRunAt(from: Date): string {
  const today = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 15, 0, 0, 0),
  );
  const next =
    today.getTime() > from.getTime()
      ? today
      : new Date(
          Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1, 15, 0, 0, 0),
        );
  return next.toISOString();
}

// The day a brief covers: the UTC day that just ended — the same
// completed day the nightly distillation processed (its diary is
// the brief's diary section). Running and needs-decision are live
// state at build time regardless of the covered day.
export function scheduledBriefDate(now: Date): string {
  return scheduledDistillationDate(now);
}

const excerpt = (text: string | null | undefined, max = 240): string | null => {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

// Terminal statuses that count as "finished" when a task reaches
// them inside the brief's day window: the ordinary terminals plus
// the cron-semantics terminals (engine/cron.ts) — a scheduled run
// that ended blocked_config or delivery_failed DID finish, and the
// brief is where the operator sees it.
const FINISHED_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "blocked_config",
  "delivery_failed",
  "delivery_unverified",
  "unknown",
]);

export interface BriefBuckets {
  finished: BriefItem[];
  running: BriefItem[];
  needsDecision: BriefItem[];
}

// Split the owner's tasks into the brief's three buckets. The
// brief job's own task is excluded: it is the reporter, not the
// reported (and while it executes it would otherwise list itself
// as running). Finished is windowed by updatedAt; running and
// needs-decision are the live state at build time.
export function classifyBriefTasks(
  tasks: AgentTask[],
  window: { start: string; end: string },
): BriefBuckets {
  const finished: BriefItem[] = [];
  const running: BriefItem[] = [];
  const needsDecision: BriefItem[] = [];
  for (const task of tasks) {
    if (task.input?.dailyBrief === true) continue;
    if (
      FINISHED_STATUSES.has(task.status) &&
      task.updatedAt >= window.start &&
      task.updatedAt < window.end
    ) {
      finished.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        detail:
          task.status === "succeeded"
            ? excerpt(task.result)
            : (excerpt(task.error) ?? excerpt(task.result)),
      });
    } else if (task.status === "running" || task.status === "queued") {
      running.push({ taskId: task.id, title: task.title, status: task.status, detail: null });
    } else if (
      task.status === "waiting_approval" ||
      task.status === "waiting_input" ||
      (task.status === "paused" && task.state?.criticBlocked === true)
    ) {
      needsDecision.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        detail: excerpt(task.question) ?? excerpt(task.error) ?? excerpt(task.result),
      });
    }
  }
  return { finished, running, needsDecision };
}

// The background skill review's undecided proposals, shaped as
// needs-decision items: approving or rejecting them happens on
// the skills surface (engine/skill-review.ts) — the brief only
// surfaces them, with the review's own rationale as the detail.
export function deriveSkillDecisionItems(pending: PendingSkillWrite[]): BriefItem[] {
  return pending
    .filter((entry) => entry.status === "pending")
    .map((entry) => ({
      taskId: entry.id,
      title: `Skill proposal: ${entry.action} "${entry.skillName}"`,
      status: "pending_skill_write",
      detail: excerpt(entry.rationale),
    }));
}

// Team consults (PR-iota) still open past the staleness threshold,
// shaped as needs-decision items: the team has not answered, and only
// the operator can chase the answer or write the question off. The
// brief only surfaces them; answering happens in Slack.
export function deriveStaleConsultItems(consults: ConsultRecord[], now: Date): BriefItem[] {
  return staleConsults(consults, now).map((consult) => {
    const days = Math.floor((now.getTime() - Date.parse(consult.createdAt)) / 86_400_000);
    const audience =
      consult.audience === "atlas"
        ? "ATLAS"
        : consult.audience === "claude"
          ? "Claude"
          : "the team";
    return {
      taskId: consult.taskId,
      title: `Team consult unanswered for ${days} day${days === 1 ? "" : "s"} — asked ${audience}`,
      status: "open_consult",
      detail: excerpt(consult.question),
    };
  });
}

// The lessons the verifier spine (PR-alpha) can prove were broken,
// keyed stably so a lesson's count is comparable day over day. The
// descriptions are the behavioural rules themselves (the LESSONS.md
// pattern, automated — MAP part #8's self-evolving view).
export const LESSON_TEXT: Record<string, string> = {
  verification_failed:
    "A completion was claimed that the Verifier could not verify — a completion counts only when its evidence checks out.",
  critic_blocked:
    "A completion was blocked by the Critic for missing evidence — gather matching evidence before claiming a task is done.",
  unconfirmed_run:
    "A run ended without confirming completion — every run must end by finishing the task or asking the user.",
};

// Derive the day's violated lessons from the alpha verdicts on the
// tasks updated inside the window: the Verifier's rejection flag,
// the Critic's block flag, and the Critic stage-trace entry that
// records an unconfirmed run. Counts are per lesson; a count of 2+
// is the "keeps breaking" flag the self-review acts on.
export function deriveLessonsViolated(
  tasks: AgentTask[],
  window: { start: string; end: string },
): BriefLesson[] {
  const hits = new Map<string, string[]>();
  const hit = (lesson: string, taskId: string) => {
    const list = hits.get(lesson) ?? [];
    list.push(taskId);
    hits.set(lesson, list);
  };
  for (const task of tasks) {
    if (task.input?.dailyBrief === true) continue;
    if (task.updatedAt < window.start || task.updatedAt >= window.end) continue;
    if (task.state?.verificationFailed === true) hit("verification_failed", task.id);
    if (task.state?.criticBlocked === true) hit("critic_blocked", task.id);
    if (
      task.stageTrace?.some(
        (entry) => entry.agent === "critic" && entry.metrics?.unconfirmed === true,
      )
    )
      hit("unconfirmed_run", task.id);
  }
  return [...hits.entries()]
    .map(([lesson, taskIds]) => ({
      lesson,
      description: LESSON_TEXT[lesson] ?? lesson,
      count: taskIds.length,
      taskIds,
    }))
    .sort((a, b) => b.count - a.count || a.lesson.localeCompare(b.lesson));
}

// The nightly self-review's proposal actions (deterministic v1):
// one proposal per REPEATED lesson (the twice-rule — a single hit
// is reported in the lessons section but does not spawn an action),
// one when the day's distillation run did not succeed, and the
// background skill review's summary (PR-epsilon): what its latest
// run staged is a decision the operator owes, and a run that did
// not succeed is a configuration smell. These are proposals for
// the operator's decision only: nothing in this lane executes them
// (MAP part #8 — only the approved set ever executes, and approval
// lives outside the brief).
export function deriveSelfReviewProposals(input: {
  date: string;
  lessons: BriefLesson[];
  distillationStatus: DistillationRun["status"] | null;
  skillReviewRun: SkillReviewRun | null;
}): BriefProposal[] {
  const proposals: BriefProposal[] = [];
  for (const lesson of input.lessons) {
    if (lesson.count < 2) continue;
    proposals.push({
      source: "lessons",
      title: `Review the repeated lesson: ${lesson.lesson.replace(/_/g, " ")}`,
      detail:
        `${lesson.count} tasks broke this lesson on ${input.date}. ${lesson.description} ` +
        "Proposal: inspect those tasks and tighten the completion discipline before the next scheduled run.",
    });
  }
  if (input.distillationStatus !== null && input.distillationStatus !== "succeeded") {
    proposals.push({
      source: "distillation",
      title: "Check the memory-lane configuration",
      detail:
        `Nightly distillation for ${input.date} finished with status ${input.distillationStatus}. ` +
        "Its unsettled material stays retryable, but the lane configuration needs a look.",
    });
  }
  if (input.skillReviewRun) {
    const review = input.skillReviewRun;
    if (review.proposals > 0)
      proposals.push({
        source: "skill_review",
        title: `Decide the skill review's ${review.proposals} staged proposal(s)`,
        detail:
          `The background skill review for ${review.date} staged ${review.creates} new skill(s), ` +
          `${review.patches} patch(es) and ${review.files} reference file(s) in the pending area. ` +
          "They are listed under Needs your decision; nothing applies until approved.",
      });
    if (review.status !== "succeeded")
      proposals.push({
        source: "skill_review",
        title: "Check the background skill review",
        detail:
          `The skill review for ${review.date} finished with status ${review.status}` +
          `${review.issues.length ? `: ${review.issues.join("; ")}` : ""}. ` +
          "Any proposals it staged are unaffected.",
      });
  }
  return proposals.slice(0, BRIEF_PROPOSAL_CAP);
}

const bucketSection = (title: string, items: BriefItem[], count: number): string[] => {
  const lines = [`## ${title} (${count})`, ""];
  if (!items.length) {
    lines.push("- None.", "");
    return lines;
  }
  for (const item of items) {
    lines.push(`- ${item.title} — ${item.status}`);
    if (item.detail) lines.push(`  ${item.detail}`);
  }
  if (count > items.length) lines.push(`- …and ${count - items.length} more.`);
  lines.push("");
  return lines;
};

// The rendered brief: the in-app surface's content, stored on the
// record. Task titles and result excerpts appear here because the
// brief is the owner's own report, served only through the
// authenticated routes; cross-owner/status surfaces keep the audit
// log's counts-only discipline (PR-beta).
export function buildBriefMarkdown(input: {
  date: string;
  finished: BriefItem[];
  finishedCount: number;
  running: BriefItem[];
  runningCount: number;
  needsDecision: BriefItem[];
  needsDecisionCount: number;
  diaryMarkdown: string | null;
  lessonsViolated: BriefLesson[];
  selfReviewProposals: BriefProposal[];
}): string {
  const lines = [
    `# Daily Brief: ${input.date}`,
    "",
    ...bucketSection("Finished", input.finished, input.finishedCount),
    ...bucketSection("Still running", input.running, input.runningCount),
    ...bucketSection("Needs your decision", input.needsDecision, input.needsDecisionCount),
    "## From the dream diary",
    "",
    ...(input.diaryMarkdown
      ? [input.diaryMarkdown.trim(), ""]
      : ["- No dream diary entry for this date.", ""]),
    "## Lessons violated",
    "",
    ...(input.lessonsViolated.length
      ? input.lessonsViolated.map(
          (lesson) =>
            `- ${lesson.description} (×${lesson.count}${lesson.count >= 2 ? " — keeps breaking" : ""})`,
        )
      : ["- None."]),
    "",
    "## Self-review proposals",
    "",
    ...(input.selfReviewProposals.length
      ? input.selfReviewProposals.map((proposal) => `- **${proposal.title}** — ${proposal.detail}`)
      : ["- None."]),
    "",
  ];
  return lines.join("\n");
}

// The Slack rendering: the same brief, compact — counts up front,
// a few titles per bucket, the lessons, and a pointer to the app
// for the full text. Chunked by the poster when it runs long.
export function buildBriefSlackText(input: {
  date: string;
  finished: BriefItem[];
  finishedCount: number;
  running: BriefItem[];
  runningCount: number;
  needsDecision: BriefItem[];
  needsDecisionCount: number;
  diaryMarkdown: string | null;
  lessonsViolated: BriefLesson[];
  selfReviewProposals: BriefProposal[];
}): string {
  const titles = (items: BriefItem[], count: number): string[] => {
    const lines = items.slice(0, 5).map((item) => `• ${item.title} (${item.status})`);
    if (count > lines.length) lines.push(`• …and ${count - lines.length} more`);
    return lines.length ? lines : ["• None"];
  };
  const lines = [
    `*Daily Brief — ${input.date}*`,
    `Finished: ${input.finishedCount} · Still running: ${input.runningCount} · Needs your decision: ${input.needsDecisionCount}`,
    "",
    "*Finished*",
    ...titles(input.finished, input.finishedCount),
    "",
    "*Still running*",
    ...titles(input.running, input.runningCount),
    "",
    "*Needs your decision*",
    ...titles(input.needsDecision, input.needsDecisionCount),
    "",
    input.diaryMarkdown
      ? "Dream diary: included in the in-app brief."
      : "Dream diary: no entry for this date.",
    ...(input.lessonsViolated.length
      ? [
          "",
          "*Lessons violated*",
          ...input.lessonsViolated.map(
            (lesson) => `• ${lesson.lesson.replace(/_/g, " ")} ×${lesson.count}`,
          ),
        ]
      : []),
    ...(input.selfReviewProposals.length
      ? [
          "",
          "*Self-review proposals*",
          ...input.selfReviewProposals.map((proposal) => `• ${proposal.title}`),
        ]
      : []),
    "",
    "Full brief is in the app.",
  ];
  return lines.join("\n");
}

export interface DailyBriefOutcome {
  brief: DailyBrief;
  preflightIssues: string[];
}

// Build one brief for a day. Never throws for a Slack problem: the
// post reports by value and its verdict is recorded on the brief.
// The only preflight failure is an invalid day — recorded as a
// blocked_config brief, with no Slack post attempted. The record
// is always persisted, so a blocked brief is a recorded fact, not
// a crash.
export async function runDailyBriefPass(input: {
  db: Pick<Store, "get" | "list" | "put">;
  owner: string;
  slack: DailyBriefSlack;
  date: string;
  trigger: "manual" | "scheduled";
  now?: Date;
}): Promise<DailyBriefOutcome> {
  const now = input.now ?? new Date();
  const base = {
    // One record per date: the id is the date, so re-generating a
    // date updates the same record (the store keys by id).
    id: input.date,
    date: input.date,
    trigger: input.trigger,
    finished: [],
    finishedCount: 0,
    running: [],
    runningCount: 0,
    needsDecision: [],
    needsDecisionCount: 0,
    diaryDate: null,
    diaryMarkdown: null,
    lessonsViolated: [],
    selfReviewProposals: [],
    deliveryStatus: null,
    createdAt: now.toISOString(),
  } satisfies Partial<DailyBrief>;
  if (!isValidDay(input.date)) {
    const issues = ["the brief window is not a valid day"];
    const brief = dailyBriefSchema.parse({
      ...base,
      status: "blocked_config",
      issues,
      slackDeliveryStatus: "not_attempted",
      markdown: `# Daily Brief: ${input.date}\n\nThis brief was blocked: ${issues.join("; ")}.\n`,
    });
    await input.db.put(input.owner, DAILY_BRIEF_KIND, brief);
    return { brief, preflightIssues: issues };
  }

  const window = dayWindow(input.date);
  const tasks = await input.db.list<AgentTask>(input.owner, "tasks");
  const buckets = classifyBriefTasks(tasks, window);
  // The needs-decision bucket also carries the background skill
  // review's pending writes (PR-epsilon): they are decisions the
  // operator owes, exactly like a waiting task.
  const pendingWrites = await listPendingSkillWrites(input.db, input.owner, true);
  buckets.needsDecision = [...buckets.needsDecision, ...deriveSkillDecisionItems(pendingWrites)];
  // ... and team consults (PR-iota) the team has left unanswered past
  // the staleness threshold, read off the same task list (consults live
  // on task state): also decisions the operator owes.
  const consults = tasks.flatMap((task) => {
    const raw = task.state?.consults;
    return Array.isArray(raw) ? (raw as ConsultRecord[]) : [];
  });
  buckets.needsDecision = [...buckets.needsDecision, ...deriveStaleConsultItems(consults, now)];
  const lessonsViolated = deriveLessonsViolated(tasks, window);
  const diary = await input.db.get<DreamDiary>(input.owner, DREAM_DIARY_KIND, input.date);
  const distillationRuns = await input.db.list<DistillationRun>(input.owner, DISTILLATION_RUN_KIND);
  const dayRun = distillationRuns.find((run) => run.date === input.date) ?? null;
  // The skill-review summary the proposals report: the brief
  // date's own run when one exists (the morning brief covers the
  // same day the 03:17 review processed), else the latest run on
  // record — an older run's staged proposals are still decisions
  // owed until they are decided.
  const reviewRuns = await input.db.list<SkillReviewRun>(input.owner, SKILL_REVIEW_RUN_KIND);
  const reviewRun = reviewRuns.find((run) => run.date === input.date) ?? reviewRuns[0] ?? null;
  const selfReviewProposals = deriveSelfReviewProposals({
    date: input.date,
    lessons: lessonsViolated,
    distillationStatus: dayRun?.status ?? null,
    skillReviewRun: reviewRun,
  });
  const content = {
    date: input.date,
    finished: buckets.finished.slice(0, BRIEF_BUCKET_CAP),
    finishedCount: buckets.finished.length,
    running: buckets.running.slice(0, BRIEF_BUCKET_CAP),
    runningCount: buckets.running.length,
    needsDecision: buckets.needsDecision.slice(0, BRIEF_BUCKET_CAP),
    needsDecisionCount: buckets.needsDecision.length,
    diaryMarkdown: diary?.markdown ?? null,
    lessonsViolated,
    selfReviewProposals,
  };
  const markdown = buildBriefMarkdown(content);

  // Slack delivery, gated per date (the settle-gate discipline
  // from distillation): a date whose brief already posted is never
  // posted twice; an unconfigured bridge is recorded, not hidden;
  // a failed post is recorded and the brief still succeeds — the
  // in-app brief is the deliverable, Slack is one channel for it.
  let slackDeliveryStatus: BriefSlackDelivery;
  if (!input.slack.configured) {
    slackDeliveryStatus = "not_configured";
  } else {
    const prior = await input.db.list<DailyBrief>(input.owner, DAILY_BRIEF_KIND);
    if (
      prior.some((brief) => brief.date === input.date && brief.slackDeliveryStatus === "delivered")
    )
      slackDeliveryStatus = "already_delivered";
    else
      slackDeliveryStatus = (await input.slack
        .post(buildBriefSlackText(content))
        .catch(() => false))
        ? "delivered"
        : "delivery_failed";
  }

  const brief = dailyBriefSchema.parse({
    ...base,
    status: "succeeded",
    issues: [],
    finished: content.finished,
    finishedCount: content.finishedCount,
    running: content.running,
    runningCount: content.runningCount,
    needsDecision: content.needsDecision,
    needsDecisionCount: content.needsDecisionCount,
    diaryDate: diary ? input.date : null,
    diaryMarkdown: diary?.markdown ?? null,
    lessonsViolated,
    selfReviewProposals,
    slackDeliveryStatus,
    markdown,
  });
  await input.db.put(input.owner, DAILY_BRIEF_KIND, brief);
  return { brief, preflightIssues: [] };
}

export type { DeliveryStatus };
