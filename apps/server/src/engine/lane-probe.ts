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
//   anythingllm            -> GET <url>/api/ping, live only on a 2xx
//                                   whose body is { online: true } —
//                                   the adapter's real-request check
//                                   (see engine/anythingllm.ts): any
//                                   HTTP response is NOT enough, a
//                                   squatter on the port is not the
//                                   service.
//   omniroute              -> GET <url>/v1/models (the route the
//                                   adapter itself calls); ANY HTTP
//                                   response — even a 404 or an auth
//                                   challenge — proves the service
//                                   is reachable; only a network
//                                   error / timeout is false.
//   n8n                    -> GET <url>/healthz (n8n's own health
//                                   route); ANY HTTP response proves
//                                   reachability, as for omniroute.
//   browser worker               -> GET <workerUrl>/health, 2xx only
//                                   (the worker serves {status:"ok"}
//                                   there unauthenticated; see
//                                   apps/worker/src/server.ts).
//
// Probe targets are not always the service URLs. A lane's service
// URL is where adapters send real work; on a single-host deploy it
// can be a public tunnel address that rotates hourly and adds
// seconds of latency, so probing it measures the tunnel, not the
// lane — a healthy lane reads false whenever the tunnel is slow,
// and forever once its hostname has rotted. Operators can set a
// per-lane probe override (LANE_PROBE_URL_<LANE>, see config.ts)
// pointing at the lane's localhost address; laneProbeFor prefers
// the override and falls back to the service URL when none is set.
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
const BASE_URL_LANES: readonly LaneKey[] = ["omniroute", "n8n"];
const API_PING_LANES: readonly LaneKey[] = ["anythingllm"];

// The path each lane is probed on, appended to its probe target.
// Health-path lanes serve /health; AnythingLLM's /api/ping is probed
// by probeApiPing below; the base-URL lanes are probed on the real
// route that proves the service itself is answering (OmniRoute's
// model list, n8n's health route) rather than the bare root, which
// a tunnel or squatter could answer just as well.
const PROBE_PATHS: Record<LaneKey, string> = {
  mem0: "/health",
  graphiti: "/health",
  hindsight: "/health",
  browser: "/health",
  anythingllm: "/api/ping",
  omniroute: "/v1/models",
  n8n: "/healthz",
};

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
    if (API_PING_LANES.includes(key)) return this.probeApiPing(baseUrl);
    const isHealthLane = HEALTH_PATH_LANES.includes(key);
    const url = `${baseUrl}${PROBE_PATHS[key]}`;
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

  // The AnythingLLM check, shared with the adapter (engine/
  // anythingllm.ts): GET /api/ping must answer 2xx with the service's
  // own { online: true } body. Anything else — a 404 from a squatter,
  // an { online: false }, a non-JSON reply — is not live.
  private async probeApiPing(baseUrl: string): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${baseUrl}/api/ping`, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      if (!body || typeof body !== "object") return false;
      return (body as { online?: unknown }).online === true;
    } catch {
      return false;
    }
  }
}

// A lane's probe target: its probe override when one is set (the
// first non-blank URL wins), else its service URL. A lane with no
// service URL is never probed — an override alone does not enable
// a lane, so unconfigured lanes keep reporting null.
function probeTarget(
  override: string | undefined,
  serviceUrl: string | undefined,
): string | undefined {
  if (!serviceUrl?.trim()) return undefined;
  return [override, serviceUrl].find((url) => url?.trim());
}

export function laneProbeFor(
  config: Config,
  fetchFn: FetchFn = fetch,
  options: { timeoutMs?: number; ttlMs?: number; now?: () => number } = {},
): LaneProbe {
  const integrations = config.integrations;
  const probeUrls = integrations?.probeUrls;
  return new LaneProbe(
    {
      mem0: probeTarget(probeUrls?.mem0, integrations?.mem0Url),
      graphiti: probeTarget(probeUrls?.graphiti, integrations?.graphitiUrl),
      hindsight: probeTarget(probeUrls?.hindsight, integrations?.hindsightUrl),
      omniroute: probeTarget(probeUrls?.omniroute, integrations?.omnirouteUrl),
      anythingllm: probeTarget(probeUrls?.anythingllm, integrations?.anythingLlmUrl),
      n8n: probeTarget(probeUrls?.n8n, integrations?.n8nUrl),
      browser: probeTarget(config.workerProbeUrl, config.workerUrl),
    },
    fetchFn,
    options,
  );
}

// Re-exported so tests (and future callers) can name the lane groups
// without duplicating the health-path vs base-URL distinction.
export const LANE_PROBE_HEALTH_PATH_LANES = HEALTH_PATH_LANES;
export const LANE_PROBE_BASE_URL_LANES = BASE_URL_LANES;
export const LANE_PROBE_API_PING_LANES = API_PING_LANES;
