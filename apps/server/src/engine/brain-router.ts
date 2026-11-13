// Brain Router (PR-theta, Phase 1) — deliberate per-task model selection.
//
// Today the model chain (MODEL, MODEL_FALLBACK, MODEL_FALLBACK_2 in
// config.ts) is only a failure-fallback order: every task starts at the
// primary and falls back on error. This module adds the deliberate step:
// classify the task, then order the SAME configured chain so the best
// family for the class goes first. Pure and deterministic — no I/O, no
// extra model calls (the classifier must cost ~0 against daily quotas).
//
// Wiring into executeModelTask + audit-log recording of RoutingDecision
// is the next commit; nothing imports this module yet.
//
// Production families: the Groq endpoint serves the fast models (Qwen /
// Llama ids) and the fallback is a Gemini id. modelFamily() recognises
// exactly those two families; anything else is "other" and keeps chain
// order.

export type TaskClass =
  | "routine"
  | "research"
  | "strategy"
  | "architecture"
  | "coding"
  | "multimodal";

/** Classes that prefer the deep-reasoning (Gemini) family first. */
const DEEP_CLASSES: ReadonlySet<TaskClass> = new Set([
  "research",
  "strategy",
  "architecture",
  "multimodal",
]);

// Deterministic keyword scoring. Highest total wins; ties break by the
// order classes appear in this table (coding first, routine is the
// zero-score default). Substrings are matched against the lowercased
// task text (title + plan), so keep them lowercase and specific.
const CLASS_KEYWORDS: ReadonlyArray<readonly [TaskClass, readonly string[]]> = [
  [
    "coding",
    [
      "code",
      "bug",
      "debug",
      "compile",
      "typescript",
      "javascript",
      "function",
      "refactor",
      "implement",
      "test failure",
      "stack trace",
    ],
  ],
  [
    "architecture",
    ["architect", "security", "threat", "schema", "migration", "auth design", "data model"],
  ],
  [
    "research",
    [
      "research",
      "search",
      "find",
      "compare",
      "investigate",
      "look up",
      "survey",
      "what is",
      "which is better",
    ],
  ],
  ["strategy", ["strategy", "roadmap", "priorit", "trade-off", "tradeoff", "decide whether"]],
  ["multimodal", ["image", "screenshot", "photo", "video", "audio", "diagram"]],
];

export function classifyTaskText(text: string): TaskClass {
  const haystack = ` ${text.toLowerCase()} `;
  let best: TaskClass = "routine";
  let bestScore = 0;
  for (const [taskClass, keywords] of CLASS_KEYWORDS) {
    let score = 0;
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) score += 1;
    }
    if (score > bestScore) {
      best = taskClass;
      bestScore = score;
    }
  }
  return best;
}

export type ModelFamily = "google" | "groq" | "other";

export function modelFamily(modelId: string | undefined): ModelFamily {
  if (!modelId) return "other";
  if (/gemini/i.test(modelId)) return "google";
  return "groq";
}

export interface BrainBudget {
  /** Google-family calls already made today (UTC day). */
  googleUsedToday: number;
  /** Cap for Google-family calls per day; production free tier is ~20. */
  googleDailyBudget: number;
}

/**
 * Per-day counter for google-family usage, so routeModels can degrade
 * deep classes to the fast family before the free tier's daily cap
 * (~20 requests) hard-stops a run mid-flight. In-memory: a server
 * restart resets the count, which only ever makes the router MORE
 * willing to spend google calls that day — the provider's own quota
 * errors remain the backstop, exactly as before routing existed.
 */
export class DailyGoogleBudget {
  private day = "";
  private used = 0;
  private cap: number;

  constructor(cap = 15) {
    this.cap = cap;
  }

  setCap(cap: number): void {
    if (Number.isSafeInteger(cap) && cap > 0) this.cap = cap;
  }

  private rollover(now: Date): void {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
  }

  snapshot(now = new Date()): BrainBudget {
    this.rollover(now);
    return { googleUsedToday: this.used, googleDailyBudget: this.cap };
  }

  recordUse(now = new Date()): void {
    this.rollover(now);
    this.used += 1;
  }
}

/** Shared process-wide budget; model.ts records each run that starts on (or fails over to) a google-family model. */
export const googleDailyBudget = new DailyGoogleBudget();

export interface RoutingDecision {
  taskClass: TaskClass;
  /** The configured chain, reordered for this class. Never empty when the input chain is non-empty. */
  orderedModels: string[];
  /** Human-readable reason, recorded to the audit log by the wiring commit. */
  reason: string;
}

export function routeModels(
  taskClass: TaskClass,
  chain: readonly (string | undefined)[],
  budget: BrainBudget,
): RoutingDecision {
  const models = chain.filter((m): m is string => typeof m === "string" && m.length > 0);
  if (models.length === 0) {
    return { taskClass, orderedModels: [], reason: "no models configured; chain empty" };
  }
  if (!DEEP_CLASSES.has(taskClass)) {
    return {
      taskClass,
      orderedModels: [...models],
      reason: `${taskClass} task: fast family first (configured chain order)`,
    };
  }
  const googleFirst = models.filter((m) => modelFamily(m) === "google");
  if (googleFirst.length === 0) {
    return {
      taskClass,
      orderedModels: [...models],
      reason: `${taskClass} task: no google-family model configured; chain order kept`,
    };
  }
  if (budget.googleUsedToday >= budget.googleDailyBudget) {
    return {
      taskClass,
      orderedModels: [...models],
      reason: `${taskClass} task: google daily budget exhausted (${budget.googleUsedToday}/${budget.googleDailyBudget}); fast family first`,
    };
  }
  const rest = models.filter((m) => modelFamily(m) !== "google");
  return {
    taskClass,
    orderedModels: [...googleFirst, ...rest],
    reason: `${taskClass} task: deep family first (google budget ${budget.googleUsedToday}/${budget.googleDailyBudget})`,
  };
}
