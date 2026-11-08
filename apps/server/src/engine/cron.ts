// Cron semantics for scheduled runs — cherry-picked SEMANTICS from
// Hermes Agent (MIT, (c) Hermes Agent contributors), cron/jobs.py +
// cron/scheduler.py at pinned HEAD 93dd2435 (parts-scavenge MAP,
// Tier 1 item #4). The Hermes engine itself is NOT ported: Open
// Arthur already schedules recurring work as monitor tasks
// (engine/worker.ts leases due tasks, engine/service.ts runs them).
// What is ported is the discipline Hermes applies around a run:
//
// - Preflight: a scheduled job's prerequisites are checked BEFORE
//   dispatch. Failure marks the run `blocked_config`, raises one
//   alert, and no model (or page) call is made.
// - Execution != delivery: a run's execution result and its delivery
//   result are separate facts. A delivery counts as delivered ONLY
//   on positive evidence from the delivery path (the notification
//   record read back from the store), never on attempt. Delivery
//   that was attempted and positively failed is `delivery_failed`;
//   delivery whose outcome cannot be confirmed either way is
//   `delivery_unverified`. Both are distinct terminal run states.
// - Execution ledger `unknown`: a scheduled attempt that stops
//   mid-flight (its lease expires with no terminal record) resolves
//   to `unknown` and is NEVER auto-rerun (engine/worker.ts).
// - Incident dedup: repeated failures with the same normalized
//   error signature alert once; a reminder fires after ~6h of
//   continued failure; a success re-arms the alert.
// - [SILENT]: a run whose output carries the [SILENT] marker
//   suppresses SUCCESS delivery; failures always deliver.
import { z } from "zod";
import {
  type AgentTask,
  type Monitor,
  monitorInputSchema,
} from "../../../../packages/domain/src/agent.ts";
import type { Config } from "../config.ts";

// Hermes' incident reminder cadence: a still-failing job re-alerts
// roughly six hours after the previous alert for the same incident.
export const INCIDENT_REMINDER_MS = 6 * 60 * 60 * 1000;

// The marker a run's output carries when it has nothing worth
// delivering on success (Hermes' [SILENT] convention).
export const SILENT_MARKER = "[SILENT]";

// Terminal delivery outcomes for a run, kept separate from the
// run's execution outcome (see the header note).
export const deliveryStatusSchema = z.enum([
  "delivered",
  "delivery_failed",
  "delivery_unverified",
  "suppressed_silent",
]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

// The per-attempt delivery record stored on a task's state once its
// outcome notice has been through the delivery path. Keyed by the
// run's attempt count and the notice's dedup key, so the delivery
// path is idempotent per run: re-publication (the maintenance scan
// re-offers every settled task) never delivers or re-decides twice.
export const deliveryRecordSchema = z.object({
  attempts: z.number().int().nonnegative(),
  key: z.string(),
  status: deliveryStatusSchema,
  at: z.iso.datetime(),
});
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;

// One open failure incident for a scheduled job: every failure whose
// normalized signature matches folds into the same incident, so a
// job failing the same way for hours alerts once (plus the 6h
// reminder), not once per tick.
export const incidentStateSchema = z.object({
  signature: z.string(),
  hash: z.string(),
  count: z.number().int().positive(),
  firstAt: z.number().int().nonnegative(),
  lastAlertAt: z.number().int().nonnegative(),
  reminders: z.number().int().nonnegative(),
});
export type IncidentState = z.infer<typeof incidentStateSchema>;

export function incidentFromState(value: unknown): IncidentState | null {
  const parsed = incidentStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Normalize an error message into the signature incidents are deduped
// by: case, whitespace, numbers, URLs and UUIDs — the parts that
// change between ticks of the SAME failure — are folded away, so
// "fetch failed for https://x at 12:03" and the same failure an hour
// later share one signature, while a genuinely different error does
// not.
export function normalizeErrorSignature(error: string): string {
  return error
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export type IncidentAction = "alert" | "suppress" | "remind";

// Decide what a new failure does to the job's incident: a failure
// with a new signature opens a fresh incident and alerts; the same
// signature alerts again only once the reminder window has passed;
// anything in between is suppressed (the failure is still recorded
// on the task and the incident count still grows).
export function decideIncident(
  current: IncidentState | null,
  signature: string,
  hash: string,
  now: number,
): { action: IncidentAction; incident: IncidentState } {
  if (!current || current.signature !== signature)
    return {
      action: "alert",
      incident: { signature, hash, count: 1, firstAt: now, lastAlertAt: now, reminders: 0 },
    };
  if (now - current.lastAlertAt >= INCIDENT_REMINDER_MS)
    return {
      action: "remind",
      incident: {
        ...current,
        count: current.count + 1,
        lastAlertAt: now,
        reminders: current.reminders + 1,
      },
    };
  return { action: "suppress", incident: { ...current, count: current.count + 1 } };
}

// [SILENT] detection: the marker anywhere in the run's output text
// suppresses SUCCESS delivery for that run (failures always deliver;
// the suppression decision itself lives in the delivery path, which
// knows which class a notice is).
export function isSilentOutput(text: string | undefined | null): boolean {
  return typeof text === "string" && text.includes(SILENT_MARKER);
}

// Preflight for a scheduled (monitor) run, checked before dispatch:
// the job definition must still validate against the same schema it
// was created with, its prerequisites must be present, and its
// delivery target must resolve. Returns the list of blocking issues
// (empty = cleared to run). A blocked job makes NO page fetch and NO
// model call — the caller marks it blocked_config and alerts once.
export function preflightMonitorJob(
  task: AgentTask,
  monitor: Monitor | null,
  config: Pick<Config, "mode">,
): string[] {
  const issues: string[] = [];
  if (!task.prompt.trim()) issues.push("the job definition has no prompt");
  if (typeof task.input.monitorId !== "string" || !task.input.monitorId)
    issues.push("the job definition does not name its monitor");
  if (!monitor) {
    issues.push("the monitor record for this job is missing");
    return issues;
  }
  // The delivery target is the job's own task channel: outcomes are
  // published as notifications attached to monitor.taskId, so a
  // record pointing at a different task cannot be delivered to.
  if (monitor.taskId !== task.id)
    issues.push("the monitor's delivery target does not resolve to this job");
  const definition = monitorInputSchema.safeParse({
    title: monitor.title,
    url: monitor.url,
    condition: monitor.condition,
    value: monitor.value,
    intervalMinutes: monitor.intervalMinutes,
  });
  if (!definition.success)
    issues.push(
      `the monitor definition is invalid: ${definition.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  else if (definition.data.url.startsWith("sample:")) {
    if (config.mode !== "sample")
      issues.push("the sample source is unavailable outside sample workspaces");
    else if (definition.data.url !== "sample://availability")
      issues.push("the sample source is unknown");
  } else {
    const url = new URL(definition.data.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      issues.push("the monitor source must be a public HTTP(S) page");
  }
  return issues;
}
