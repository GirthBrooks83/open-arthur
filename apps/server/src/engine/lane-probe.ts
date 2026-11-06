import type { Config } from "../config.ts";

// Live lane probes — the honesty fix for /api/health (ATLAS audit,
// Priority 3). The existing `integrations.*` health values are
// Boolean(url): they report CONFIGURATION, and they stay green with a
// dead tunnel. This module answers a different question — "is the
// lane answering right now?" — with real, lightweight HTTP probes:
//
//   mem0 / graphiti / hindsight  -> GET <url>/health, reachable only
//                                   on a successful (2xx) response;
//                                   each lane exposes that endpoint
//                                   (see engine/mem0.ts etc.).
//   omniroute / anythingllm / n8n -> GET <url>/ (the base URL itself);
//                                   ANY HTTP response — even a 404 or
//                                   an auth challenge — proves the
//                                   service is reachable; only a
//                                   network error / timeout is false.
//   browser worker               -> GET <workerUrl>/health, 2xx only
//                                   (the worker serves {status:"ok"}
//                                   there unauthenticated; see
//                                   apps/worker/src/server.ts).
//
// Slack is deliberately NOT probed: its proof is event-driven (Slack
// signs and POSTs events to us), so there is no lane endpoint whose
// liveness a GET could establish. It stays configuration-only.
//
// Shape: background refresh + cached snapshot. Probing must never
// slow /api/health or break it, so `snapshot()` never awaits a
// network call: it returns the last probed values immediately and,
// when the cache is stale, kicks off a refresh in the background.
// Before the first probe lands, a configured lane reports null
// ("unknown / not yet probed"); an unconfigured lane is always null.
// A probe failure is a VALUE (false), never a thrown error.

export type LaneLiveState = boolean | null;

export interface IntegrationsLive {
  mem0: LaneLiveState;
  graphiti: LaneLiveState;
  hindsight: LaneLiveState;
  omniroute: LaneLiveState;
  anythingllm: LaneLiveState;
  n8n: LaneLiveState;
}

export interface LaneProbeSnapshot {
  integrationsLive: IntegrationsLive;
  browserLive: LaneLiveState;
}

export interface LaneProbeTargets {
  mem0?: string;
  graphiti?: string;
  hindsight?: string;
  omniroute?: string;
  anythingllm?: string;
  n8n?: string;
  browser?: string;
}

type FetchFn = typeof fetch;

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_TTL_MS = 60_000;

type LaneKey = keyof LaneProbeTargets;

const HEALTH_PATH_LANES: readonly LaneKey[] = ["mem0", "graphiti", "hindsight", "browser"];
const BASE_URL_LANES: readonly LaneKey[] = ["omniroute", "anythingllm", "n8n"];

function cleanBase(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

export class LaneProbe {
  private readonly targets: Record<LaneKey, string | undefined>;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private state: Record<LaneKey, LaneLiveState>;
  private lastProbeAt: number | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    targets: LaneProbeTargets,
    fetchFn: FetchFn = fetch,
    options: { timeoutMs?: number; ttlMs?: number; now?: () => number } = {},
  ) {
    this.targets = {
      mem0: cleanBase(targets.mem0),
      graphiti: cleanBase(targets.graphiti),
      hindsight: cleanBase(targets.hindsight),
      omniroute: cleanBase(targets.omniroute),
      anythingllm: cleanBase(targets.anythingllm),
      n8n: cleanBase(targets.n8n),
      browser: cleanBase(targets.browser),
    };
    this.fetchFn = fetchFn;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.state = {
      mem0: null,
      graphiti: null,
      hindsight: null,
      omniroute: null,
      anythingllm: null,
      n8n: null,
      browser: null,
    };
  }

  // The current snapshot, without ever waiting on the network. When
  // the cached values are stale (or never probed) and at least one
  // lane is configured, a background refresh starts; callers keep
  // seeing the last known values until it lands.
  snapshot(): LaneProbeSnapshot {
    this.maybeRefresh();
    return this.peek();
  }

  // The current snapshot with no side effects (no refresh triggered).
  peek(): LaneProbeSnapshot {
    return {
      integrationsLive: {
        mem0: this.state.mem0,
        graphiti: this.state.graphiti,
        hindsight: this.state.hindsight,
        omniroute: this.state.omniroute,
        anythingllm: this.state.anythingllm,
        n8n: this.state.n8n,
      },
      browserLive: this.state.browser,
    };
  }

  private get hasConfiguredLane(): boolean {
    return Object.values(this.targets).some((url) => Boolean(url));
  }

  private maybeRefresh(): void {
    if (!this.hasConfiguredLane || this.inFlight) return;
    if (this.lastProbeAt !== null && this.now() - this.lastProbeAt < this.ttlMs) return;
    // Fire and forget: refresh() never rejects (every probe reports
    // failure by value), so this cannot become an unhandled rejection.
    void this.refresh();
  }

  // Probe every configured lane in parallel and update the cache.
  // Concurrent calls share one in-flight run. Never throws.
  async refresh(): Promise<LaneProbeSnapshot> {
    if (this.inFlight) {
      await this.inFlight;
      return this.peek();
    }
    const run = (async () => {
      const entries = await Promise.all(
        (Object.keys(this.targets) as LaneKey[]).map(async (key) => {
          const url = this.targets[key];
          if (!url) return [key, null] as const;
          return [key, await this.probeOne(key, url)] as const;
        }),
      );
      for (const [key, value] of entries) this.state[key] = value;
      this.lastProbeAt = this.now();
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
    return this.peek();
  }

  private async probeOne(key: LaneKey, baseUrl: string): Promise<boolean> {
    const isHealthLane = HEALTH_PATH_LANES.includes(key);
    const url = isHealthLane ? `${baseUrl}/health` : baseUrl;
    try {
      const response = await this.fetchFn(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Release the connection promptly; the body carries no signal
      // for a liveness probe (base-URL lanes count any response).
      try {
        await response.body?.cancel();
      } catch {
        // Cancelling is best-effort hygiene only.
      }
      return isHealthLane ? response.ok : true;
    } catch {
      return false;
    }
  }
}

export function laneProbeFor(
  config: Config,
  fetchFn: FetchFn = fetch,
  options: { timeoutMs?: number; ttlMs?: number; now?: () => number } = {},
): LaneProbe {
  return new LaneProbe(
    {
      mem0: config.integrations?.mem0Url,
      graphiti: config.integrations?.graphitiUrl,
      hindsight: config.integrations?.hindsightUrl,
      omniroute: config.integrations?.omnirouteUrl,
      anythingllm: config.integrations?.anythingLlmUrl,
      n8n: config.integrations?.n8nUrl,
      browser: config.workerUrl,
    },
    fetchFn,
    options,
  );
}

// Re-exported so tests (and future callers) can name the lane groups
// without duplicating the health-path vs base-URL distinction.
export const LANE_PROBE_HEALTH_PATH_LANES = HEALTH_PATH_LANES;
export const LANE_PROBE_BASE_URL_LANES = BASE_URL_LANES;
