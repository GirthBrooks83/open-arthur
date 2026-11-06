import type { Config } from "../config.ts";

// Hindsight — the THIRD memory lane (owner's decision, 2026-11-04: run
// it after Mem0, the main lane, and Graphiti, the side lane). Until now
// HINDSIGHT_URL was configuration-only: the URL was read into config
// and shown as a health boolean, but no code ever called the service.
// This module is the real adapter, shaped exactly like the Mem0 and
// Graphiti adapters (engine/mem0.ts, engine/graphiti.ts).
//
// Unlike the other two lanes, Hindsight does NOT speak the lab
// /add//search wrapper contract — it is the real Hindsight server with
// its native REST API (the same calls the official hindsight-client
// makes; verified against the lab service on :8931 and its OpenAPI
// models):
//   GET  /health                                       -> { status: "healthy", database: "connected" }
//   POST /v1/default/banks/{bank}/memories             -> retain:
//        body { items: [{ content }], async: false }
//        -> { success: true, bank_id, items_count, async: false }
//   POST /v1/default/banks/{bank}/memories/recall      -> recall:
//        body { query }
//        -> { results: [{ id, text, type, ... }] }
//
// Memories live in a bank — an isolated namespace inside the service.
// The operator's lab service uses bank "arthur-service" (the scored
// head-to-head bank is separate and never touched), so that is the
// default here too.
//
// What this lane adds: Hindsight consolidates retained facts into
// observations server-side, so recall can surface a consolidated,
// correction-aware view (in the lab smoke, the corrected budget's
// consolidated observation ranked first) rather than raw saves alone.
//
// The app's internal store stays canonical: every save lands there
// first and is then mirrored to the lane, and recall merges lane facts
// into the internal list. A lane that is down, slow, or misbehaving
// must never fail a save or a task — every method here swallows its own
// errors and reports failure by value (false / []), never by throwing.
//
// Timeout split, measured against the real lab service (2026-11-05,
// memory-lanes smoke results): recall answers in ~0.6–0.7 s, so it
// keeps the standard 4 s budget; retain runs LLM extraction lane-side
// (the smoke driver retries retains over tens of seconds), so retains
// get the same 90 s budget as Graphiti adds. A timed-out retain
// returns false (the save has already succeeded internally either way).

type FetchFn = typeof fetch;

const DEFAULT_SEARCH_TIMEOUT_MS = 4000;
const DEFAULT_ADD_TIMEOUT_MS = 90000;
const DEFAULT_BANK_ID = "arthur-service";

export class HindsightLane {
  private readonly baseUrl?: string;
  private readonly bankId: string;
  private readonly fetchFn: FetchFn;
  private readonly searchTimeoutMs: number;
  private readonly addTimeoutMs: number;

  constructor(
    baseUrl: string | undefined,
    fetchFn: FetchFn = fetch,
    searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    addTimeoutMs = DEFAULT_ADD_TIMEOUT_MS,
    bankId = DEFAULT_BANK_ID,
  ) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : undefined;
    this.fetchFn = fetchFn;
    this.searchTimeoutMs = searchTimeoutMs;
    this.addTimeoutMs = addTimeoutMs;
    this.bankId = bankId;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  private bankPath(suffix: string): string {
    return `${this.baseUrl}/v1/default/banks/${encodeURIComponent(this.bankId)}${suffix}`;
  }

  // Mirror one saved fact to the lane via a native retain. True only
  // when the lane accepted it (2xx); false when unconfigured,
  // unreachable, or rejected.
  async add(text: string): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const response = await this.fetchFn(this.bankPath("/memories"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ content: text }], async: false }),
        signal: AbortSignal.timeout(this.addTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Recall facts relevant to a query via a native recall. Returns the
  // result texts; [] when unconfigured, unreachable, or the reply is
  // not the expected shape — callers treat [] as "internal store only".
  async search(query: string): Promise<string[]> {
    if (!this.baseUrl || !query.trim()) return [];
    try {
      const response = await this.fetchFn(this.bankPath("/memories/recall"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(this.searchTimeoutMs),
      });
      if (!response.ok) return [];
      const body: unknown = await response.json();
      if (!body || typeof body !== "object") return [];
      const results = (body as { results?: unknown }).results;
      if (!Array.isArray(results)) return [];
      return results
        .map((result) =>
          result && typeof result === "object" ? (result as { text?: unknown }).text : undefined,
        )
        .filter((text): text is string => typeof text === "string" && text.length > 0);
    } catch {
      return [];
    }
  }
}

export function hindsightLaneFor(config: Config): HindsightLane {
  return new HindsightLane(config.integrations?.hindsightUrl);
}
