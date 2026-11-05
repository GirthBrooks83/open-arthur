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
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
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
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
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
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
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
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: process.env.BROWSER_WORKER_URL,
    workerToken: process.env.WORKER_TOKEN,
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
