import type { Config } from "../config.ts";

// Mem0 — the MAIN memory lane (owner's decision, 2026-11-04). Until now
// MEM0_URL was configuration-only: the URL was read into config and shown
// as a health boolean, but no code ever called the service. This module
// is the real adapter.
//
// The lane speaks the memory-lane service contract (the self-hosted Mem0
// wrapper the operator runs, e.g. the lab service on :8971):
//   GET  /health          -> { lane: "mem0", ok: true }
//   POST /add { text }    -> stores the fact (extraction happens lane-side)
//   GET  /search?q=...    -> { facts: string[], scores: number[] }
//
// The app's internal store stays canonical: every save lands there first
// and is then mirrored to the lane, and recall merges lane facts into the
// internal list. A lane that is down, slow, or misbehaving must never
// fail a save or a task — every method here swallows its own errors and
// reports failure by value (false / []), never by throwing.

type FetchFn = typeof fetch;

const DEFAULT_TIMEOUT_MS = 4000;

export class Mem0Lane {
  private readonly baseUrl?: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string | undefined,
    fetchFn: FetchFn = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : undefined;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  // Mirror one saved fact to the lane. True only when the lane accepted
  // it (2xx); false when unconfigured, unreachable, or rejected.
  async add(text: string): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const response = await this.fetchFn(`${this.baseUrl}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.timeoutMs),
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
        signal: AbortSignal.timeout(this.timeoutMs),
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

export function mem0LaneFor(config: Config): Mem0Lane {
  return new Mem0Lane(config.integrations?.mem0Url);
}
