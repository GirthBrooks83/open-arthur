// Rate-limit classification for provider errors.
//
// Free-tier model quotas are enforced per minute and per day. A multi-step
// agent run can hit the per-minute wall mid-flight even though the same
// request would succeed seconds later; the provider's error message names
// the retry window ("Please retry in 23.69s"). The task engine uses this
// helper to decide whether waiting and resuming the run is worthwhile.
// Long-window exhaustion (a daily cap, "retry in 3h33m") is not retried:
// the run fails with the provider's own message instead of sleeping for
// hours inside a task lease.

const RATE_LIMIT_PATTERN =
  /quota|rate.?limit|too many requests|resource.?exhausted|exceeded your current/i;

/** Longest provider-suggested wait the engine will sleep through. */
export const MAX_RATE_LIMIT_WAIT_MS = 75_000;

/** Fallback wait when a rate-limit error carries no parseable delay. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 20_000;

/**
 * Whether a rate-limit failure ends the current provider's usefulness for
 * this run: its window is long (e.g. a daily cap the engine will not sleep
 * through) or short windows kept renewing past the retry budget. When a
 * fallback model is configured, the engine switches to it instead of
 * failing the run.
 */
export function isQuotaExhausted(delayMs: number | null, attemptsUsed: number): boolean {
  if (delayMs === null) return false;
  return delayMs > MAX_RATE_LIMIT_WAIT_MS || attemptsUsed >= 2;
}

/**
 * Run-wide budget of short-window rate-limit waits, shared across every
 * provider in the chain. The per-provider budget above decides when ONE
 * provider is done; this cap stops a run from restarting that budget at
 * every failover — with a three-provider chain the run could otherwise
 * burn nine attempts and six long sleeps inside a single task, most of
 * them against a failover provider that is just as quota-dead as the one
 * before it. Once the run's waits are spent, any further rate-limit
 * failure ends that provider for the run and fails over (or ends the
 * run when no provider is left).
 */
export const MAX_RUN_RATE_LIMIT_WAITS = 2;

export function isProviderDoneForRun(
  delayMs: number | null,
  attemptsUsed: number,
  runWaitsUsed: number,
): boolean {
  if (isQuotaExhausted(delayMs, attemptsUsed)) return true;
  return delayMs !== null && runWaitsUsed >= MAX_RUN_RATE_LIMIT_WAITS;
}

/**
 * The ordered provider chain for a run: the configured models in order
 * (primary, fallback, second fallback), minus blanks, duplicates, and any
 * model whose provider key is not present. The first entry is the active
 * provider; quota exhaustion fails over to the next entry.
 */
export function buildProviderChain(
  models: readonly (string | undefined)[],
  keyPresent: (model: string) => boolean,
): string[] {
  const chain: string[] = [];
  for (const model of models) {
    if (model && !chain.includes(model) && keyPresent(model)) chain.push(model);
  }
  return chain;
}

export interface ProviderFailure {
  model: string;
  message: string;
  delayMs: number | null;
}

/**
 * Terminal state when every provider in the chain is quota-exhausted: a
 * plain-language summary naming each provider's failure and the earliest
 * reset the providers suggested, instead of one raw provider error.
 */
export function allProvidersExhaustedMessage(
  failures: readonly ProviderFailure[],
  now = Date.now(),
): string {
  const parts = failures.map((f) => `${f.model}: ${f.message.slice(0, 200)}`);
  const delays = failures.map((f) => f.delayMs).filter((d): d is number => d !== null);
  const reset = delays.length
    ? ` Earliest provider reset ≈ ${new Date(now + Math.min(...delays)).toISOString()}.`
    : "";
  return `All configured model providers are exhausted (${parts.join("; ")}).${reset} Work resumes once a provider's quota resets or another provider is configured.`;
}

function parseDurationMs(text: string): number | null {
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g)) {
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value) || !unit) continue;
    total += value * (units[unit] ?? 0);
    matched = true;
  }
  return matched ? Math.round(total) : null;
}

/**
 * If `message` is a provider rate-limit/quota error, return how long the
 * provider suggests waiting before the next attempt (ms). Returns the
 * default wait when the error is a rate limit without a parseable delay,
 * and null when the error is not a rate limit at all.
 */
export function rateLimitDelayMs(message: string): number | null {
  if (!RATE_LIMIT_PATTERN.test(message)) {
    // A bare 429 only counts with an explicit retry hint, so unrelated
    // errors that happen to mention the number are not retried.
    if (!/\b429\b/.test(message) || !/retry/i.test(message)) return null;
  }
  const retryIn = /(?:retry(?:\s+after|\s+in)?|try again in)[:\s]+([0-9][0-9hms. ]*)/i.exec(
    message,
  );
  if (retryIn?.[1]) {
    const parsed = parseDurationMs(retryIn[1]);
    if (parsed !== null) return parsed;
    const bareSeconds = Number(retryIn[1].trim());
    if (Number.isFinite(bareSeconds)) return Math.round(bareSeconds * 1000);
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}
