import type { Config } from "../config.ts";

// Graphiti — the SIDE memory lane (owner's decision, 2026-11-04: run it
// alongside Mem0). Until now GRAPHITI_URL was configuration-only: the
// URL was read into config and shown as a health boolean, but no code
// ever called the service. This module is the real adapter, shaped
// exactly like the Mem0 adapter (engine/mem0.ts).
//
// The lane speaks the same memory-lane service contract (the self-hosted
// Graphiti wrapper the operator runs, e.g. the lab service on :8972):
//   GET  /health          -> { lane: "graphiti", ok: true }
//   POST /add { text }    -> ingests an episode; the lane extracts a
//                            temporal graph from it and retires facts a
//                            newer episode supersedes
//   GET  /search?q=...    -> { facts: string[] } (top edge facts)
//
// Why this lane exists next to Mem0: supersession. Mem0's corrections
// are additive — a superseded fact can still rank first in its recall.
// Graphiti's graph is bi-temporal: when a newer episode contradicts an
// older fact, the old edge is invalidated and stops surfacing in
// search. Mirroring the same saves here is what retires stale facts.
//
// The app's internal store stays canonical: every save lands there
// first and is then mirrored to the lane, and recall merges lane facts
// into the internal list. A lane that is down, slow, or misbehaving
// must never fail a save or a task — every method here swallows its own
// errors and reports failure by value (false / []), never by throwing.
//
// Timeout split, measured against the real lab service (2026-11-05,
// memory-lanes smoke results): /search answers in ~0.4 s, so it keeps
// the standard 4 s budget; /add runs full LLM extraction lane-side and
// took 7–56 s per write, so adds get a 90 s budget. A timed-out add
// returns false (the save has already succeeded internally either way).

type FetchFn = typeof fetch;

const DEFAULT_SEARCH_TIMEOUT_MS = 4000;
const DEFAULT_ADD_TIMEOUT_MS = 90000;

export class GraphitiLane {
  private readonly baseUrl?: string;
  private readonly fetchFn: FetchFn;
  private readonly searchTimeoutMs: number;
  private readonly addTimeoutMs: number;

  constructor(
    baseUrl: string | undefined,
    fetchFn: FetchFn = fetch,
    searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    addTimeoutMs = DEFAULT_ADD_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : undefined;
    this.fetchFn = fetchFn;
    this.searchTimeoutMs = searchTimeoutMs;
    this.addTimeoutMs = addTimeoutMs;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  // Mirror one saved fact to the lane as a new episode. True only when
  // the lane accepted it (2xx); false when unconfigured, unreachable,
  // or rejected.
  async add(text: string): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const response = await this.fetchFn(`${this.baseUrl}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.addTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Recall facts relevant to a query. Returns the lane's fact strings;
  // [] when unconfigured, unreachable, or the reply is not the expected
  // shape — callers treat [] as "internal store only".
  async search(query: string): Promise<string[]> {
    if (!this.baseUrl || !query.trim()) return [];
    try {
      const response = await this.fetchFn(`${this.baseUrl}/search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(this.searchTimeoutMs),
      });
      if (!response.ok) return [];
      const body: unknown = await response.json();
      if (!body || typeof body !== "object") return [];
      const facts = (body as { facts?: unknown }).facts;
      if (!Array.isArray(facts)) return [];
      return facts.filter((fact): fact is string => typeof fact === "string" && fact.length > 0);
    } catch {
      return [];
    }
  }
}

export function graphitiLaneFor(config: Config): GraphitiLane {
  return new GraphitiLane(config.integrations?.graphitiUrl);
}
