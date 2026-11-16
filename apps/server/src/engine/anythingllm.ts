import type { Config } from "../config.ts";

// AnythingLLM — the workspace / RAG surface (self-hosted, e.g. the lab
// service on :3001). Until now ANYTHINGLLM_URL was configuration-only:
// the URL was read into config and shown as a health boolean, and the
// live probe counted ANY HTTP response from the base URL as "live" —
// a dead-end web server squatting on the port looked identical to a
// healthy AnythingLLM. This module is the real adapter, shaped like
// the memory-lane adapters (engine/mem0.ts etc.).
//
// The service contract (self-hosted AnythingLLM developer API):
//   GET  /api/ping                              -> { online: true }
//        (unauthenticated; the one endpoint that proves the service
//        itself — not just something — is answering)
//   GET  /api/v1/workspaces                     -> { workspaces: [...] }
//        (Authorization: Bearer <ANYTHINGLLM_API_KEY>)
//   POST /api/v1/workspace/:slug/chat           -> { textResponse, ... }
//        { message, mode: "chat" } — "chat" mode answers from the
//        model without requiring embedded documents; "query" mode
//        would refuse when the workspace has no relevant context.
//
// Liveness means a real request succeeded: ping() is true only on a
// 2xx whose body is the expected { online: true } shape. The lane
// probe (engine/lane-probe.ts) uses exactly this check for the
// anythingllm lane, so /api/health's integrationsLive.anythingllm is
// backed by the adapter, not by reachability.
//
// Failure discipline, like the other lanes: a down, slow, or
// misbehaving service must never fail a task — every method swallows
// its own errors and reports failure by value, never by throwing.
// Chat failures additionally degrade to a short human message: the
// service's raw error body (which can carry provider internals) is
// never surfaced to callers or users.

type FetchFn = typeof fetch;

const DEFAULT_TIMEOUT_MS = 4000;
// Chat runs a full LLM completion lane-side; the lab round trip on a
// small local model took ~20-70 s under load, so chat gets a budget
// an order of magnitude above the probe budget.
const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

export type AnythingLlmChatResult = { ok: true; text: string } | { ok: false; error: string };

const NOT_CONFIGURED_MESSAGE = "AnythingLLM isn't set up on this server yet.";
const UNREACHABLE_MESSAGE = "AnythingLLM didn't answer — it may be offline. Try again in a bit.";
const REJECTED_MESSAGE =
  "AnythingLLM couldn't complete that chat. Check the workspace and try again.";
const EMPTY_REPLY_MESSAGE = "AnythingLLM answered without any text. Try again.";

export class AnythingLlmLane {
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly chatTimeoutMs: number;

  constructor(
    baseUrl: string | undefined,
    apiKey?: string,
    fetchFn: FetchFn = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    chatTimeoutMs = DEFAULT_CHAT_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : undefined;
    this.apiKey = apiKey?.trim() ? apiKey.trim() : undefined;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.chatTimeoutMs = chatTimeoutMs;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  // True only when the service itself answers its ping endpoint with
  // the expected shape — a real request succeeding, not any HTTP
  // response from the port. False when unconfigured, unreachable, or
  // the reply is anything else.
  async ping(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/ping`, {
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

  // Slugs of the workspaces the configured API key can see; [] when
  // unconfigured, keyless, unreachable, or the reply is not the
  // expected shape.
  async workspaces(): Promise<string[]> {
    if (!this.baseUrl || !this.apiKey) return [];
    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return [];
      const body: unknown = await response.json();
      if (!body || typeof body !== "object") return [];
      const list = (body as { workspaces?: unknown }).workspaces;
      if (!Array.isArray(list)) return [];
      return list
        .map((entry) =>
          entry && typeof entry === "object" ? (entry as { slug?: unknown }).slug : undefined,
        )
        .filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
    } catch {
      return [];
    }
  }

  // One chat round trip against a workspace. Success carries the
  // reply text; every failure mode degrades to a human message (see
  // the constants above) — the service's raw error body is dropped
  // here and never reaches the caller.
  async chat(workspaceSlug: string, message: string): Promise<AnythingLlmChatResult> {
    if (!this.baseUrl || !this.apiKey) return { ok: false, error: NOT_CONFIGURED_MESSAGE };
    if (!workspaceSlug.trim() || !message.trim()) return { ok: false, error: REJECTED_MESSAGE };
    let response: Response;
    try {
      response = await this.fetchFn(
        `${this.baseUrl}/api/v1/workspace/${encodeURIComponent(workspaceSlug)}/chat`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message, mode: "chat" }),
          signal: AbortSignal.timeout(this.chatTimeoutMs),
        },
      );
    } catch {
      return { ok: false, error: UNREACHABLE_MESSAGE };
    }
    if (!response.ok) return { ok: false, error: REJECTED_MESSAGE };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: REJECTED_MESSAGE };
    }
    if (!body || typeof body !== "object") return { ok: false, error: REJECTED_MESSAGE };
    const reply = body as { textResponse?: unknown; error?: unknown };
    // The developer API reports a failed completion as HTTP 200 with
    // an `error` string and a null textResponse — that string is the
    // raw provider error, so it degrades like any other failure.
    if (typeof reply.error === "string" && reply.error.length > 0)
      return { ok: false, error: REJECTED_MESSAGE };
    if (typeof reply.textResponse !== "string" || reply.textResponse.length === 0)
      return { ok: false, error: EMPTY_REPLY_MESSAGE };
    return { ok: true, text: reply.textResponse };
  }
}

export function anythingLlmLaneFor(config: Config): AnythingLlmLane {
  return new AnythingLlmLane(
    config.integrations?.anythingLlmUrl,
    config.integrations?.anythingLlmApiKey,
  );
}
