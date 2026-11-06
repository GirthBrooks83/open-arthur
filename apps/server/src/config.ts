import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.DO_NOT_TRACK ??= "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";

export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  // Directory holding the Expo web export (apps/mobile `build:web` output).
  // When it contains an index.html the API server also serves the app UI
  // from the same origin, so a single hosted service (e.g. Render's free
  // plan) can serve both the UI and the API. Unset or missing files mean
  // API-only, exactly as before.
  webDir?: string;
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
  // Optional fallback models (MODEL_FALLBACK, then MODEL_FALLBACK_2; same
  // "<provider>/<model-id>" form as MODEL). Together they form the ordered
  // provider chain: when a provider's quota is exhausted for a run (e.g. a
  // daily free-tier cap), the task engine fails over to the next configured
  // model whose provider key is present, records the switch in the task's
  // events, and continues. Each provider's own key must be configured.
  fallbackModel?: string;
  fallbackModel2?: string;
  // Optional cap on the tokens a single model call may generate
  // (MODEL_MAX_OUTPUT_TOKENS, positive integer; unset or invalid = no
  // cap, exactly as before). Free-tier providers budget EXPECTED output
  // per minute (Groq's OTPM grants 1000 tokens/min on this account), and
  // a call whose expected output exceeds the whole budget is rejected
  // outright — no retry or failover can save it, because every provider
  // in the chain would be asked for the same oversized call. Capping the
  // per-call output keeps each call inside the budget; the engine's
  // multi-step loop still lets a task produce as much as it needs across
  // calls.
  maxOutputTokens?: number;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  intelligenceApiKey?: string;
  // ATLAS lane (owner's orders, 2026-11-04: "Turn ATLAS on" + the
  // free-route clarification — "the free part of Atlas"). The lane is
  // powered by the FREE route already live in this stack: GPT-OSS 120B
  // served by the Groq free tier through Groq's OpenAI-compatible
  // endpoint. It is NOT a paid OpenAI API connection and no OpenAI key
  // exists or will be funded for it. Billing classification:
  // free_then_paid with auto cut-off — if the Groq free tier ever stops
  // being free, this lane must be cut off, never charged.
  atlasLane?: {
    enabled: boolean;
    configured: boolean;
    provider: string;
    model: string;
    baseUrl: string;
    billing: string;
  };
  // Slack bridge (the agent's own bot user in the owner's workspace).
  // Both values come from the Slack app Joseph creates from the manifest
  // in docs terms; unset means the bridge answers setup challenges but
  // never acts or posts. See apps/server/src/slack.ts.
  slackBotToken?: string;
  slackSigningSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  // Agent browser (Stagehand) enablement on the API side. The browser
  // worker does the actual Stagehand work (POST /extract, behind
  // WORKER_STAGEHAND_ENABLED on the worker); this flag is the server's
  // opt-in to offer the extract_web tool to the agent. Optional in the
  // type because tests and embedders construct Config literals; unset
  // means off, exactly as before.
  agentBrowserEnabled?: boolean;
  taskWorkerEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  integrations?: IntegrationEndpoints;
  allowedOrigins: string[];
}

// Approved external lanes (see docs/integrations.md). Each is an optional
// self-hosted service the operator runs separately; the URL being set is
// what enables the lane. Unset means the lane is off — nothing in the
// server talks to these endpoints unless they are configured here.
export interface IntegrationEndpoints {
  omnirouteUrl?: string;
  // Three memory lanes (owner's decisions, 2026-11-04): Mem0 is the MAIN
  // memory lane; Graphiti runs ALONGSIDE as the side lane — the temporal
  // graph that retires superseded facts; Hindsight is the THIRD lane,
  // ordered the same evening to run beside the other two. All stay
  // usable; see docs/integrations.md.
  mem0Url?: string;
  graphitiUrl?: string;
  hindsightUrl?: string;
  n8nUrl?: string;
  anythingLlmUrl?: string;
}
let warnedInvalidMaxOutputTokens = false;

// MODEL_MAX_OUTPUT_TOKENS: a positive integer caps the tokens a single
// model call may generate (see Config.maxOutputTokens). Anything else —
// non-numeric, zero, negative, fractional — is treated as unset (no cap)
// and warned about once, so a typo in the environment never silently
// changes model behavior or spams the log on every config read.
export function parseMaxOutputTokens(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  if (!warnedInvalidMaxOutputTokens) {
    warnedInvalidMaxOutputTokens = true;
    console.warn(
      `MODEL_MAX_OUTPUT_TOKENS=${JSON.stringify(raw)} is not a positive integer; ignoring it (no per-call output-token cap).`,
    );
  }
  return undefined;
}

export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui")
    throw new Error("AGENT_BACKEND must be sample, model or agui");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const config: Config = {
    mode,
    port,
    // Hosted platforms (Render, Fly, …) assign PORT and require binding all
    // interfaces; a loopback-only bind is invisible to their port scan and
    // the deploy never goes live. Locally (no PORT set) stay on loopback.
    host: process.env.HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1"),
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    webDir: resolve(process.env.WEB_DIR ?? "apps/mobile/dist/web"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    fallbackModel: process.env.MODEL_FALLBACK,
    fallbackModel2: process.env.MODEL_FALLBACK_2,
    maxOutputTokens: parseMaxOutputTokens(process.env.MODEL_MAX_OUTPUT_TOKENS),
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    intelligenceApiKey: process.env.CPK_INTELLIGENCE_API_KEY,
    atlasLane: {
      enabled: process.env.ATLAS_LANE_ENABLED !== "false",
      // The free route's credential is the Groq key (GROQ_API_KEY);
      // OPENAI_API_KEY deliberately plays no part in this lane.
      configured: Boolean(process.env.GROQ_API_KEY),
      provider: "GPT-OSS 120B via Groq free tier (OpenAI-compatible) — not a paid OpenAI key",
      model: "openai/gpt-oss-120b",
      baseUrl: "https://api.groq.com/openai/v1",
      billing: "free_then_paid — auto cut-off if the free route stops being free; never charges",
    },
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: process.env.BROWSER_WORKER_URL,
    workerToken: process.env.WORKER_TOKEN,
    agentBrowserEnabled: process.env.AGENT_BROWSER_ENABLED === "true",
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    integrations: {
      omnirouteUrl: process.env.OMNIROUTE_URL,
      mem0Url: process.env.MEM0_URL,
      graphitiUrl: process.env.GRAPHITI_URL,
      hindsightUrl: process.env.HINDSIGHT_URL,
      n8nUrl: process.env.N8N_URL,
      anythingLlmUrl: process.env.ANYTHINGLLM_URL,
    },
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
    ).split(","),
  };
  if (
    mode === "live" &&
    (!config.accessKey || config.accessKey.length < 24 || !config.encryptionKey)
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  return config;
}
