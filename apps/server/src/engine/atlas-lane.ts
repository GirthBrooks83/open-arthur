import type { Config } from "../config.ts";

// ATLAS lane liveness — the GitHub Eyes split-state pattern
// (engine/github-eyes.ts) applied to the lane health used to assert
// "ready" from configuration alone: enabled + GROQ_API_KEY present
// was the whole proof, so a dead or revoked Groq route still
// reported ready. Now "ready" is earned per process:
//
//   - boot: status is "configured" (or "off" / "awaiting-groq-key"),
//     never "ready";
//   - startup: probe() fires from the server entry once it is
//     serving (index.ts, next to the Eyes revalidation) and makes
//     ONE real read-only call through the lane's own route —
//     GET {baseUrl}/models with the lane's Groq key, the cheapest
//     call that proves the endpoint answers and accepts the key;
//   - success earns "ready" in THIS process; failure reports
//     "degraded" with the error recorded, never a silent "ready".
//
// In-memory only, deliberately: the probe re-earns the stamp within
// seconds of every boot, so a persisted record would add no truth —
// the same reasoning the Step 5 audit applied to integrationsLive.

export type AtlasProbeState = "off" | "pending" | "passed" | "failed";
export type AtlasLaneStatusValue =
  | "off"
  | "awaiting-groq-key"
  | "configured"
  | "ready"
  | "degraded";

export interface AtlasLaneConfig {
  enabled: boolean;
  configured: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  billing: string;
}

export interface AtlasLaneStatus extends AtlasLaneConfig {
  status: AtlasLaneStatusValue;
  /** The earned half of the split: this process's own probe proof. */
  probe: {
    state: AtlasProbeState;
    /** When the last probe ran (ISO); null until the first one. */
    at: string | null;
    /** Why the last probe failed; null when it passed or has not run. */
    error: string | null;
  };
  /** When the lane last earned "ready" in this process (ISO). */
  lastReadyAt: string | null;
}

/** The configured lane, with the same defaults app.ts always used. */
export function resolveAtlasLane(config: Config): AtlasLaneConfig {
  return (
    config.atlasLane ?? {
      enabled: true,
      configured: Boolean(process.env.GROQ_API_KEY),
      provider: "GPT-OSS 120B via Groq free tier (OpenAI-compatible) — not a paid OpenAI key",
      model: "openai/gpt-oss-120b",
      baseUrl: "https://api.groq.com/openai/v1",
      billing: "free_then_paid — auto cut-off if the free route stops being free; never charges",
    }
  );
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class AtlasLaneProbe {
  private probeState: AtlasProbeState = "pending";
  private probeAt: string | null = null;
  private probeError: string | null = null;
  private lastReadyAt: string | null = null;

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  status(atlas: AtlasLaneConfig): AtlasLaneStatus {
    const status: AtlasLaneStatusValue = !atlas.enabled
      ? "off"
      : !atlas.configured
        ? "awaiting-groq-key"
        : this.probeState === "passed"
          ? "ready"
          : this.probeState === "failed"
            ? "degraded"
            : "configured";
    return {
      ...atlas,
      status,
      probe: {
        state: atlas.enabled && atlas.configured ? this.probeState : "off",
        at: this.probeAt,
        error: this.probeError,
      },
      lastReadyAt: this.lastReadyAt,
    };
  }

  /**
   * One real read-only call through the lane's route. Never throws:
   * the outcome is recorded either way and the post-probe status is
   * returned for the caller's log line.
   */
  async probe(atlas: AtlasLaneConfig, apiKey: string | undefined): Promise<AtlasLaneStatus> {
    if (!atlas.enabled || !atlas.configured) {
      this.probeState = "off";
      return this.status(atlas);
    }
    this.probeAt = new Date().toISOString();
    try {
      const response = await this.fetchFn(`${atlas.baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey ?? ""}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${atlas.baseUrl}/models`);
      this.probeState = "passed";
      this.probeError = null;
      this.lastReadyAt = this.probeAt;
    } catch (error) {
      this.probeState = "failed";
      this.probeError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
    return this.status(atlas);
  }
}

/** The one probe the server entry fires at startup and health reads. */
export const atlasLaneProbe = new AtlasLaneProbe();
