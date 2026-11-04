import type { Config } from "./config.ts";

// Provider prefix of MODEL ("google/gemini-…") -> the env var holding its key.
// The configured check must require the key that matches the selected
// provider; any unrelated provider key would otherwise report "configured"
// and fail opaquely inside the runtime on the first model call.
//
// This module is deliberately free of CopilotKit imports: app.ts and
// workspace.ts need agentConfigured() on every request, and pulling it from
// agent.ts dragged the whole CopilotKit runtime (~100 MB RSS) into the
// startup path of a server that only needs it for chat requests.
const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};

export function modelProviderKeyPresent(model?: string): boolean {
  if (!model) return false;
  const provider = model.split("/")[0];
  const keyEnv = provider ? PROVIDER_KEY_ENV[provider] : undefined;
  if (keyEnv) return Boolean(process.env[keyEnv]);
  // Unknown provider prefix: keep the previous any-known-key behaviour.
  return Boolean(
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_API_KEY,
  );
}

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : modelProviderKeyPresent(config.model))
  );
}
