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
  groq: "GROQ_API_KEY",
  venice: "VENICE_API_KEY",
};

export function modelProviderKeyPresent(model?: string): boolean {
  if (!model) return false;
  const provider = model.split("/")[0];
  const keyEnv = provider ? PROVIDER_KEY_ENV[provider] : undefined;
  if (keyEnv) return Boolean(process.env[keyEnv]);
  // Unknown provider prefix: keep the previous any-known-key behaviour.
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.VENICE_API_KEY,
  );
}

// The BuiltInAgent constructor options that apply the configured
// per-call output-token cap (MODEL_MAX_OUTPUT_TOKENS). Empty when no cap
// is configured, so spreading the result into a constructor leaves the
// agent exactly as before. BuiltInAgent forwards `maxOutputTokens`
// verbatim into the AI SDK streamText call (it is one of the runtime's
// streamText-mirroring config properties), which is what makes the cap
// effective at the provider: the provider budgets the call's expected
// output against its per-minute output allowance (e.g. Groq OTPM).
export function modelCallOptions(config: Pick<Config, "maxOutputTokens">): {
  maxOutputTokens?: number;
} {
  return config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {};
}

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : modelProviderKeyPresent(config.model))
  );
}
