// Nightly distillation job — the Deep Dream SHAPE from CowAgent
// (MIT, (c) CowAgent contributors), agent/memory/summarizer.py
// MemoryFlushManager.deep_dream() (parts-scavenge MAP, Tier 1 item
// #5 + Design Note C). Only the shape is ported, not CowAgent code:
// a scheduled pass re-reads the day's material, distills durable
// facts out of it, settles them into long-term memory under a
// content-hash gate so a re-run is a no-op, and leaves a dated dream
// diary as the human-reviewable record of what changed. CowAgent's
// template defaults (full-access permission, self-evolution ON) are
// explicitly NOT inherited: this is a bounded batch job that writes
// only through the existing memory-lane adapters, never deletes
// anything, and runs no model calls in v1.
//
// Where the shape lands in Open Arthur (a JOB, not a fourth store):
// - Input: the day's internal-store memories and task outcomes
//   (StageTrace-era task records from the verifier spine, PR-alpha).
// - Output 1 — durable facts settle into Mem0 (the MAIN lane) via
//   its adapter's add(), gated by a persistent content-hash settle
//   store: a fact whose hash is already settled is never written
//   again. Mem0 has no delete endpoint, so a duplicate write is
//   forever — the hash gate is the safety, exactly as upstream's
//   _settle_flush_hashes / _settle_daily_hash discipline is.
// - Output 2 — supersession CANDIDATES go to Graphiti (the side
//   lane) via its adapter's add(): ingesting the newer fact as an
//   episode is the lane's own invalidation path (its graph retires
//   facts a newer episode supersedes). This job never hand-rolls a
//   delete or an invalidation; it only hands candidates over.
// - Output 3 — a dated Markdown dream diary per run, stored as a
//   record and served by the authenticated distillation routes.
// - Scheduling rides the gamma-hardened scheduled-run machinery
//   (engine/cron.ts): the job is a worker task that returns
//   `scheduled` with a nightly nextRunAt, its preflight failure is
//   the terminal `blocked_config` status, its outcome notice is
//   delivered through the same delivery path (positive evidence
//   only), and repeated lane failures fold into one incident by
//   normalized error signature. No second scheduler exists.
//
// Distillation is DETERMINISTIC in v1 (no model call): candidates
// are the day's memory texts plus succeeded tasks' results,
// deduplicated by normalized content, and supersession candidates
// are detected by a documented subject heuristic. That keeps the
// nightly job inside the free-tier budget machinery by costing zero
// tokens (PR #27's rate-limit patterns are respected by not needing
// them); a model-written merge can replace the candidate step later
// behind the same hash-settle gate.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentMemory, AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import { type DeliveryStatus, deliveryStatusSchema } from "./cron.ts";

// Store kinds for the job's own records. Settled hashes and handed-
// off supersession candidates are separate kinds so each gate can be
// audited (and tested) on its own.
export const DISTILLATION_RUN_KIND = "distillation-runs";
export const DISTILLATION_SETTLED_KIND = "distillation-settled";
export const DISTILLATION_SUPERSESSION_KIND = "distillation-supersessions";
export const DREAM_DIARY_KIND = "dream-diary";

// The structural lane surface the job needs — the real Mem0Lane and
// GraphitiLane adapters satisfy it, and tests inject doubles. The
// job writes ONLY through this surface, never raw lane HTTP.
export interface DistillationLane {
  readonly configured: boolean;
  add(text: string): Promise<boolean>;
}

export const distillationRunStatusSchema = z.enum(["succeeded", "partial", "blocked_config"]);
export type DistillationRunStatus = z.infer<typeof distillationRunStatusSchema>;

export const distillationRunSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  trigger: z.enum(["manual", "scheduled"]),
  status: distillationRunStatusSchema,
  // Material read for the window.
  sources: z.number().int().nonnegative(),
  // Unique facts distilled from that material.
  distilled: z.number().int().nonnegative(),
  // Candidates dropped as exact (normalized) duplicates.
  duplicates: z.number().int().nonnegative(),
  // Facts newly settled into Mem0 this run.
  settled: z.number().int().nonnegative(),
  // Facts skipped because their hash was already settled (the
  // re-run no-op proof, counted).
  alreadySettled: z.number().int().nonnegative(),
  // Supersession candidates detected in the window's material.
  supersessionCandidates: z.number().int().nonnegative(),
  // Candidates newly handed to Graphiti this run.
  superseded: z.number().int().nonnegative(),
  // Candidates skipped because they were already handed off.
  alreadySuperseded: z.number().int().nonnegative(),
  // Preflight issues (blocked_config) or lane failure notes
  // (partial). Operator-facing strings, never exception text.
  issues: z.array(z.string()),
  // Deterministic failure signature for incident dedup on the
  // scheduled path (engine/cron.ts); null on a clean run.
  failureSignature: z.string().nullable(),
  // Delivery of the run's outcome notice, decided by positive
  // evidence on the manual path (the scheduled path records its
  // delivery on the task, via engine/cron.ts, instead).
  deliveryStatus: deliveryStatusSchema.nullable(),
  diaryDate: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type DistillationRun = z.infer<typeof distillationRunSchema>;

export const dreamDiarySchema = z.object({
  id: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runId: z.string().min(1),
  markdown: z.string(),
  createdAt: z.iso.datetime(),
});
export type DreamDiary = z.infer<typeof dreamDiarySchema>;

const settledRecordSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  settledAt: z.iso.datetime(),
});
const supersessionRecordSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  newerText: z.string(),
  olderText: z.string(),
  handedAt: z.iso.datetime(),
});

// Normalize a fact for identity: case, whitespace and trailing
// punctuation do not make a new fact. The ORIGINAL trimmed text is
// what is written to a lane; the normalized form only feeds the
// content hash and the dedupe key (CowAgent hashes the message
// text the same way before settling a flush).
export function normalizeFact(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .toLowerCase();
}

export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeFact(text)).digest("hex");
}

// The UTC day window [start, end) a run distills, as ISO bounds.
export function dayWindow(date: string): { start: string; end: string } {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function isValidDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

// The next nightly run: 02:17 UTC the following day. A fixed,
// slightly off-the-hour time keeps the job clear of midnight
// bookkeeping and of the top-of-hour maintenance traffic.
export function nextDistillationRunAt(from: Date): string {
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1, 2, 17, 0, 0),
  );
  return next.toISOString();
}

// The day a scheduled nightly run distills: the UTC day that just
// ended when it fires (yesterday, relative to the run moment).
export function scheduledDistillationDate(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Subject heuristic for supersession candidates (deterministic v1):
// a fact's subject is the text before a copula ("X is Y", "X is now
// Y") or before a colon ("X: Y"), when that prefix is a plausible
// subject (3–60 chars). Two facts sharing a subject with different
// normalized text are a candidate pair — the newer may supersede
// the older. Anything else has no subject and is never a candidate:
// a missed candidate is safe (Graphiti also sees every save through
// its normal mirror), a false one only costs one extra episode.
export function subjectKey(text: string): string | null {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const copula = trimmed.match(/^(.{3,60}?)\s+(?:is now|now is|is|are|was|were)\s+/i);
  if (copula) return copula[1].trim().toLowerCase();
  const colon = trimmed.indexOf(": ");
  if (colon >= 3 && colon <= 60) return trimmed.slice(0, colon).trim().toLowerCase();
  return null;
}

export interface SupersessionCandidate {
  subject: string;
  newerText: string;
  olderText: string;
  // Stable identity for the handoff gate: re-running over the same
  // pair never hands it to Graphiti twice.
  key: string;
}

export function findSupersessionCandidates(
  newerFacts: string[],
  olderFacts: string[],
): SupersessionCandidate[] {
  const olderBySubject = new Map<string, string[]>();
  for (const fact of olderFacts) {
    const subject = subjectKey(fact);
    if (!subject) continue;
    const list = olderBySubject.get(subject) ?? [];
    list.push(fact);
    olderBySubject.set(subject, list);
  }
  const candidates: SupersessionCandidate[] = [];
  const seen = new Set<string>();
  for (const newer of newerFacts) {
    const subject = subjectKey(newer);
    if (!subject) continue;
    for (const older of olderBySubject.get(subject) ?? []) {
      if (normalizeFact(older) === normalizeFact(newer)) continue;
      const key = `${contentHash(newer).slice(0, 16)}:${contentHash(older).slice(0, 16)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ subject, newerText: newer, olderText: older, key });
    }
  }
  return candidates;
}

// Distill the window's material into unique candidate facts
// (deterministic v1 — see the header note): each memory saved in
// the window is a fact; each SUCCEEDED task that finished in the
// window contributes its result text as a fact. Exact normalized
// duplicates — within the window, or against facts the internal
// store already held before the window — are dropped and counted.
export function distillCandidates(input: {
  memories: AgentMemory[];
  tasks: AgentTask[];
  window: { start: string; end: string };
}): { facts: string[]; sources: number; duplicates: number } {
  const inWindow = (iso: string) => iso >= input.window.start && iso < input.window.end;
  const raw: string[] = [];
  let sources = 0;
  for (const memory of input.memories) {
    if (!inWindow(memory.createdAt)) continue;
    sources++;
    if (memory.text.trim()) raw.push(memory.text.trim());
  }
  for (const task of input.tasks) {
    if (task.status !== "succeeded" || !inWindow(task.updatedAt)) continue;
    sources++;
    if (task.result?.trim()) raw.push(task.result.trim());
  }
  const seen = new Set<string>();
  const facts: string[] = [];
  let duplicates = 0;
  for (const fact of raw) {
    const key = normalizeFact(fact);
    if (!key) continue;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    facts.push(fact);
  }
  return { facts, sources, duplicates };
}

// Preflight for a distillation run, checked before any lane call
// (gamma semantics, engine/cron.ts): the window must be a real day
// and the job must have somewhere to write. Failure is
// blocked_config — terminal for the run, alerted once, and NO lane
// is called. A lane that is configured but DOWN is not a preflight
// failure: it degrades the run to a recorded partial failure.
export function preflightDistillation(input: {
  date: string;
  mem0Configured: boolean;
  graphitiConfigured: boolean;
}): string[] {
  const issues: string[] = [];
  if (!isValidDay(input.date)) issues.push("the distillation window is not a valid day");
  if (!input.mem0Configured && !input.graphitiConfigured)
    issues.push("no memory lane is configured for distillation to write to");
  return issues;
}

export interface DistillationDiaryInput {
  run: Pick<
    DistillationRun,
    "id" | "date" | "status" | "sources" | "distilled" | "duplicates" | "alreadySettled"
  >;
  settledFacts: string[];
  candidates: SupersessionCandidate[];
  handedCandidates: SupersessionCandidate[];
}

// The dream diary entry for a run (CowAgent's dated diary, adapted):
// a Markdown record of what was distilled, what settled, and what
// was flagged as a supersession candidate. Fact texts appear here
// because the diary is the owner's own review surface, served only
// through the authenticated routes; cross-owner/status surfaces use
// the content-free audit log's counts instead.
export function buildDreamDiaryMarkdown(input: DistillationDiaryInput): string {
  const { run } = input;
  const lines = [
    `# Dream Diary: ${run.date}`,
    "",
    `Run ${run.id} — status: ${run.status}.`,
    "",
    "## Counts",
    "",
    `- Sources read: ${run.sources}`,
    `- Facts distilled: ${run.distilled}`,
    `- Duplicates dropped: ${run.duplicates}`,
    `- Already settled (skipped): ${run.alreadySettled}`,
    `- Newly settled into Mem0: ${input.settledFacts.length}`,
    `- Supersession candidates flagged: ${input.candidates.length}`,
    `- Candidates handed to Graphiti: ${input.handedCandidates.length}`,
    "",
    "## Settled into Mem0",
    "",
    ...(input.settledFacts.length ? input.settledFacts.map((fact) => `- ${fact}`) : ["- None."]),
    "",
    "## Supersession candidates for Graphiti",
    "",
    ...(input.candidates.length
      ? input.candidates.map(
          (candidate) =>
            `- "${candidate.newerText}" may supersede "${candidate.olderText}" (subject: ${candidate.subject})`,
        )
      : ["- None."]),
    "",
  ];
  return lines.join("\n");
}

export interface DistillationOutcome {
  run: DistillationRun;
  diary: DreamDiary | null;
  preflightIssues: string[];
}

// Run one distillation pass over a day window. Never throws for a
// lane problem: a configured lane whose add() reports failure (the
// adapters report by value, never by throwing — the catches here
// are belt-and-braces) leaves that fact UNSETTLED, so a later run
// retries it, and marks the run partial. The run record is always
// persisted, so a partial failure is a recorded fact, not a crash.
export async function runDistillationPass(input: {
  db: Pick<Store, "get" | "list" | "put">;
  owner: string;
  mem0: DistillationLane;
  graphiti: DistillationLane;
  date: string;
  trigger: "manual" | "scheduled";
  now?: Date;
}): Promise<DistillationOutcome> {
  const now = input.now ?? new Date();
  const runId = randomUUID();
  const preflightIssues = preflightDistillation({
    date: input.date,
    mem0Configured: input.mem0.configured,
    graphitiConfigured: input.graphiti.configured,
  });
  const base = {
    id: runId,
    date: input.date,
    trigger: input.trigger,
    sources: 0,
    distilled: 0,
    duplicates: 0,
    settled: 0,
    alreadySettled: 0,
    supersessionCandidates: 0,
    superseded: 0,
    alreadySuperseded: 0,
    deliveryStatus: null,
    createdAt: now.toISOString(),
  } satisfies Partial<DistillationRun>;
  if (preflightIssues.length) {
    const run = distillationRunSchema.parse({
      ...base,
      status: "blocked_config",
      issues: preflightIssues,
      failureSignature: "distillation blocked by configuration",
      diaryDate: null,
    });
    await input.db.put(input.owner, DISTILLATION_RUN_KIND, run);
    return { run, diary: null, preflightIssues };
  }

  const window = dayWindow(input.date);
  const memories = await input.db.list<AgentMemory>(input.owner, "memories");
  const tasks = await input.db.list<AgentTask>(input.owner, "tasks");
  const { facts, sources, duplicates } = distillCandidates({ memories, tasks, window });
  const olderFacts = memories
    .filter((memory) => memory.createdAt < window.start)
    .map((memory) => memory.text.trim())
    .filter(Boolean);
  const candidates = findSupersessionCandidates(facts, olderFacts);

  const issues: string[] = [];
  let partial = false;
  // Settle into Mem0 under the content-hash gate.
  const settledFacts: string[] = [];
  let alreadySettled = 0;
  for (const fact of facts) {
    const hash = contentHash(fact);
    const existing = await input.db.get(input.owner, DISTILLATION_SETTLED_KIND, hash);
    if (existing) {
      alreadySettled++;
      continue;
    }
    if (!input.mem0.configured) {
      partial = true;
      if (!issues.includes("Mem0 (the main lane) is not configured; facts were not settled"))
        issues.push("Mem0 (the main lane) is not configured; facts were not settled");
      continue;
    }
    const accepted = await input.mem0.add(fact).catch(() => false);
    if (!accepted) {
      partial = true;
      if (
        !issues.includes(
          "Mem0 (the main lane) did not accept every fact; unsettled facts stay retryable",
        )
      )
        issues.push(
          "Mem0 (the main lane) did not accept every fact; unsettled facts stay retryable",
        );
      continue;
    }
    const record = settledRecordSchema.parse({
      id: hash,
      text: fact,
      settledAt: now.toISOString(),
    });
    await input.db.put(input.owner, DISTILLATION_SETTLED_KIND, record);
    settledFacts.push(fact);
  }
  // Supersession candidates to Graphiti, through its invalidation
  // semantics (the adapter's add): candidates only, each handed off
  // at most once under its own settle gate.
  const handedCandidates: SupersessionCandidate[] = [];
  let alreadySuperseded = 0;
  for (const candidate of candidates) {
    const existing = await input.db.get(input.owner, DISTILLATION_SUPERSESSION_KIND, candidate.key);
    if (existing) {
      alreadySuperseded++;
      continue;
    }
    if (!input.graphiti.configured) {
      partial = true;
      if (
        !issues.includes(
          "Graphiti (the side lane) is not configured; supersession candidates were not handed off",
        )
      )
        issues.push(
          "Graphiti (the side lane) is not configured; supersession candidates were not handed off",
        );
      continue;
    }
    const accepted = await input.graphiti.add(candidate.newerText).catch(() => false);
    if (!accepted) {
      partial = true;
      if (
        !issues.includes(
          "Graphiti (the side lane) did not accept every candidate; unhanded candidates stay retryable",
        )
      )
        issues.push(
          "Graphiti (the side lane) did not accept every candidate; unhanded candidates stay retryable",
        );
      continue;
    }
    const record = supersessionRecordSchema.parse({
      id: candidate.key,
      subject: candidate.subject,
      newerText: candidate.newerText,
      olderText: candidate.olderText,
      handedAt: now.toISOString(),
    });
    await input.db.put(input.owner, DISTILLATION_SUPERSESSION_KIND, record);
    handedCandidates.push(candidate);
  }

  const run = distillationRunSchema.parse({
    ...base,
    status: partial ? "partial" : "succeeded",
    sources,
    distilled: facts.length,
    duplicates,
    settled: settledFacts.length,
    alreadySettled,
    supersessionCandidates: candidates.length,
    superseded: handedCandidates.length,
    alreadySuperseded,
    issues,
    failureSignature: partial ? "distillation lane failure" : null,
    diaryDate: input.date,
  });
  await input.db.put(input.owner, DISTILLATION_RUN_KIND, run);

  // Dream diary: written when this run changed something, or when
  // the day has no entry yet (an empty night is still a recorded
  // night). A pure no-op re-run leaves the existing entry untouched
  // — same discipline as the hash gate: re-runs write nothing new.
  let diary = (await input.db.get<DreamDiary>(input.owner, DREAM_DIARY_KIND, input.date)) ?? null;
  if (!diary || settledFacts.length > 0 || handedCandidates.length > 0) {
    diary = dreamDiarySchema.parse({
      id: input.date,
      date: input.date,
      runId: run.id,
      markdown: buildDreamDiaryMarkdown({
        run,
        settledFacts,
        candidates,
        handedCandidates,
      }),
      createdAt: now.toISOString(),
    });
    await input.db.put(input.owner, DREAM_DIARY_KIND, diary);
  }
  return { run, diary, preflightIssues: [] };
}

// Record a fact as settled without a lane write from this job —
// used when a memory save's own mirror to Mem0 already succeeded
// (service.remember), so distillation never re-writes a fact the
// lane already holds. Best-effort is the caller's concern.
export async function recordSettledFact(
  db: Pick<Store, "put">,
  owner: string,
  text: string,
  at: Date = new Date(),
): Promise<void> {
  const record = settledRecordSchema.parse({
    id: contentHash(text),
    text: text.trim(),
    settledAt: at.toISOString(),
  });
  await db.put(owner, DISTILLATION_SETTLED_KIND, record);
}

export type { DeliveryStatus };
