// Collective Consult (PR-iota) — the durable record of a question the
// agent asked the team (ATLAS / Claude) through the Slack bridge.
//
// A consult is async by design: the question is posted, the task moves
// on, and a thread reply closes the consult and spawns a continuation
// task. This module is the pure state machine for that record — no I/O.
// The consult_team tool (model.ts), the thread-reply matcher (slack.ts)
// and the Daily Brief staleness line build on these transitions.

export type ConsultAudience = "atlas" | "claude" | "team";
export type ConsultStatus = "open" | "answered";

export interface ConsultRecord {
  id: string;
  taskId: string;
  question: string;
  audience: ConsultAudience;
  channel: string;
  /** Slack ts of the posted question; thread replies carry it as their parent. */
  postedTs: string;
  status: ConsultStatus;
  createdAt: string;
  answeredAt?: string;
  /** The reply text, stored as DATA (untrusted external input). */
  answerText?: string;
}

/** Consults live on the task state under this key. */
export type ConsultState = ConsultRecord[];

export function findOpenConsult(
  consults: readonly ConsultRecord[],
  taskId: string,
): ConsultRecord | undefined {
  return consults.find((c) => c.taskId === taskId && c.status === "open");
}

/**
 * Open a consult. One open consult per task: a second question while one
 * is outstanding is refused, so a task can never scatter unanswered
 * questions across the channel.
 */
export function openConsult(
  consults: readonly ConsultRecord[],
  input: Omit<ConsultRecord, "status" | "answeredAt" | "answerText">,
): { consults: ConsultState; consult?: ConsultRecord; error?: string } {
  if (findOpenConsult(consults, input.taskId))
    return {
      consults: [...consults],
      error: `Task ${input.taskId} already has an open consult; wait for its answer or finish without one.`,
    };
  const consult: ConsultRecord = { ...input, status: "open" };
  return { consults: [...consults, consult], consult };
}

/**
 * Close the consult whose question a thread reply answers. The reply's
 * parent ts identifies the consult; an unmatched or already-answered ts
 * changes nothing, so unrelated thread traffic is harmless.
 */
export function closeConsultByThread(
  consults: readonly ConsultRecord[],
  postedTs: string,
  answerText: string,
  answeredAt: string,
): { consults: ConsultState; closed?: ConsultRecord } {
  const index = consults.findIndex((c) => c.postedTs === postedTs && c.status === "open");
  if (index === -1) return { consults: [...consults] };
  const closed: ConsultRecord = {
    ...consults[index],
    status: "answered",
    answeredAt,
    answerText,
  };
  const next = [...consults];
  next[index] = closed;
  return { consults: next, closed };
}

/** Open consults older than the threshold — the Daily Brief's stale list. */
export function staleConsults(
  consults: readonly ConsultRecord[],
  now: Date,
  thresholdMs = 24 * 60 * 60 * 1000,
): ConsultRecord[] {
  return consults.filter(
    (c) => c.status === "open" && now.getTime() - Date.parse(c.createdAt) > thresholdMs,
  );
}
