import { rateLimitDelayMs } from "./rate-limit.ts";

// Per-route outcome state for the model provider chain — the
// circuit breaker behind health's modelRouting block.
//
// Until now, health named the chain head "active" from configuration
// alone: during the 2026-11-21/22 Gemini free-key cooldown latch the
// head route was 429-rejecting every call while health still called
// it active, and every new run ate that 429 before the engine's
// ordinary failover could engage. This tracker is the earned-truth
// layer, in the GitHub Eyes pattern (engine/github-eyes.ts): a route
// is only "active" because calls through it have actually succeeded
// in THIS process, and a rate-limit failure trips a cooldown that
// chain construction honors, so a new run starts on a route that can
// answer instead of re-discovering the wall.
//
// In-memory by design (the Step 5 audit's call for modelRouting):
// real traffic re-derives the truth within one request of a restart,
// and a persisted "active" would be a stale claim after a reboot.
// Cooldowns honor the provider's own retry window verbatim
// (rateLimitDelayMs parses "retry in 23.69s" / "retry in 3h33m" out
// of the error); a rate-limit error with no parseable window trips
// the helper's bounded default wait.

export type RouteErrorClass = "rate-limit" | "error";
export type RouteLiveState = "active" | "cooldown" | "degraded" | "unknown";

export interface RouteStatus {
  model: string;
  state: RouteLiveState;
  /** Last call through this route that succeeded (ISO), if any. */
  lastSuccessAt: string | null;
  /** Last call through this route that failed (ISO), if any. */
  lastFailureAt: string | null;
  /** Truncated wording of the last failure, for the health readout. */
  lastError: string | null;
  errorClass: RouteErrorClass | null;
  /** When the current cooldown ends (ISO); null when not cooling. */
  cooldownUntil: string | null;
  /** Same instant as cooldownUntil, named for health consumers. */
  retryAfter: string | null;
}

interface RouteRecord {
  lastSuccessMs: number | null;
  lastFailureMs: number | null;
  lastError: string | null;
  errorClass: RouteErrorClass | null;
  cooldownUntilMs: number | null;
  lastOutcome: "success" | "failure" | null;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export class RouteStateTracker {
  private readonly records = new Map<string, RouteRecord>();

  private record(model: string): RouteRecord {
    let found = this.records.get(model);
    if (!found) {
      found = {
        lastSuccessMs: null,
        lastFailureMs: null,
        lastError: null,
        errorClass: null,
        cooldownUntilMs: null,
        lastOutcome: null,
      };
      this.records.set(model, found);
    }
    return found;
  }

  /** A call through this route succeeded: it is active, cooldown over. */
  recordSuccess(model: string, now = Date.now()): void {
    const record = this.record(model);
    record.lastSuccessMs = now;
    record.lastOutcome = "success";
    record.cooldownUntilMs = null;
  }

  /**
   * A call through this route failed. A rate-limit failure (per
   * rateLimitDelayMs) trips the cooldown until now + the provider's
   * own retry window; any other failure is recorded as the route's
   * last outcome (state "degraded") without tripping the breaker.
   */
  recordFailure(model: string, message: string, now = Date.now()): void {
    const record = this.record(model);
    record.lastFailureMs = now;
    record.lastOutcome = "failure";
    record.lastError = message.slice(0, 200);
    const delay = rateLimitDelayMs(message);
    if (delay !== null) {
      record.errorClass = "rate-limit";
      record.cooldownUntilMs = now + delay;
    } else {
      record.errorClass = "error";
      record.cooldownUntilMs = null;
    }
  }

  isCooling(model: string, now = Date.now()): boolean {
    const record = this.records.get(model);
    return (
      record?.cooldownUntilMs !== null &&
      record?.cooldownUntilMs !== undefined &&
      record.cooldownUntilMs > now
    );
  }

  cooldownUntil(model: string): string | null {
    const record = this.records.get(model);
    return record ? iso(record.cooldownUntilMs) : null;
  }

  statusFor(model: string, now = Date.now()): RouteStatus {
    const record = this.records.get(model);
    if (!record || record.lastOutcome === null)
      return {
        model,
        state: "unknown",
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
        errorClass: null,
        cooldownUntil: null,
        retryAfter: null,
      };
    const cooling = this.isCooling(model, now);
    const cooldownIso = cooling ? iso(record.cooldownUntilMs) : null;
    return {
      model,
      state: cooling ? "cooldown" : record.lastOutcome === "failure" ? "degraded" : "active",
      lastSuccessAt: iso(record.lastSuccessMs),
      lastFailureAt: iso(record.lastFailureMs),
      lastError: record.lastError,
      errorClass: record.errorClass,
      cooldownUntil: cooldownIso,
      retryAfter: cooldownIso,
    };
  }

  /**
   * The chain a new run should start from: every non-cooling route in
   * its original (configured / brain-routed) order first, then the
   * cooling routes in their original order. Deliberate ordering is
   * preserved within each group; when every route is cooling the
   * original order stands (nothing better exists — the run's ordinary
   * wait/failover semantics take it from there).
   */
  orderChain(chain: readonly string[], now = Date.now()): string[] {
    const ready: string[] = [];
    const cooling: string[] = [];
    for (const model of chain) (this.isCooling(model, now) ? cooling : ready).push(model);
    return [...ready, ...cooling];
  }

  /** Per-route statuses for a chain, in chain order (health block). */
  snapshot(chain: readonly string[], now = Date.now()): RouteStatus[] {
    return chain.map((model) => this.statusFor(model, now));
  }
}

/** The one tracker the engines record into and health reads. */
export const routeState = new RouteStateTracker();
