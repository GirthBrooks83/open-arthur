import assert from "node:assert/strict";
import { test } from "node:test";
import { agentConfigured, modelProviderKeyPresent } from "../apps/server/src/agent.ts";
import type { Config } from "../apps/server/src/config.ts";

// The Gemini wiring is env-only: MODEL=google/<model-id> plus GOOGLE_API_KEY.
// agentConfigured must require the key matching the selected provider, so a
// missing GOOGLE_API_KEY reports "not configured" (clean 503 at the chat
// route) instead of failing inside the runtime on the first model call.

const KEY_VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"] as const;

function withKeys(keys: Partial<Record<(typeof KEY_VARS)[number], string>>, run: () => void) {
  const saved = KEY_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of KEY_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(keys)) process.env[name] = value;
  try {
    run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function modelConfig(model?: string): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: ".openmuse",
    model,
    agentBackend: "model",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
}

test("google model with GOOGLE_API_KEY is configured", () => {
  withKeys({ GOOGLE_API_KEY: "test-key" }, () => {
    assert.equal(modelProviderKeyPresent("google/gemini-2.5-flash"), true);
    assert.equal(agentConfigured(modelConfig("google/gemini-2.5-flash")), true);
  });
});

test("google model without GOOGLE_API_KEY is not configured, even with other keys", () => {
  withKeys({ OPENAI_API_KEY: "test-key", ANTHROPIC_API_KEY: "test-key" }, () => {
    assert.equal(modelProviderKeyPresent("google/gemini-2.5-flash"), false);
    assert.equal(agentConfigured(modelConfig("google/gemini-2.5-flash")), false);
  });
  withKeys({}, () => {
    assert.equal(agentConfigured(modelConfig("google/gemini-2.5-flash")), false);
  });
});

test("existing providers keep working with their own keys", () => {
  withKeys({ OPENAI_API_KEY: "test-key" }, () => {
    assert.equal(agentConfigured(modelConfig("openai/gpt-5")), true);
    assert.equal(agentConfigured(modelConfig("anthropic/claude-sonnet-5")), false);
  });
  withKeys({ ANTHROPIC_API_KEY: "test-key" }, () => {
    assert.equal(agentConfigured(modelConfig("anthropic/claude-sonnet-5")), true);
  });
});

test("no model selected is never configured in model backend", () => {
  withKeys({ GOOGLE_API_KEY: "test-key" }, () => {
    assert.equal(modelProviderKeyPresent(undefined), false);
    assert.equal(agentConfigured(modelConfig(undefined)), false);
  });
});
