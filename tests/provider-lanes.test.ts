import assert from "node:assert/strict";
import { test } from "node:test";
import { agentConfigured, modelProviderKeyPresent } from "../apps/server/src/agent.ts";
import type { Config } from "../apps/server/src/config.ts";

// The Groq and Venice lanes are env-only, same as Gemini: MODEL=<lane>/<id>
// plus the lane's own key. agentConfigured must require the key matching the
// selected lane, so a missing key reports "not configured" instead of
// failing inside the runtime on the first model call. Groq is a live,
// verified free-tier lane; Venice is staged as configured-but-unverified
// (its chat endpoint rejected the lab key on 2026-11-04 — see
// docs/integrations.md). These tests pin the configured check only.

const KEY_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "VENICE_API_KEY",
] as const;

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

test("groq model with GROQ_API_KEY is configured", () => {
  withKeys({ GROQ_API_KEY: "test-key" }, () => {
    assert.equal(modelProviderKeyPresent("groq/openai/gpt-oss-120b"), true);
    assert.equal(agentConfigured(modelConfig("groq/openai/gpt-oss-120b")), true);
  });
});

test("groq model without GROQ_API_KEY is not configured, even with other keys", () => {
  withKeys({ GOOGLE_API_KEY: "test-key", OPENAI_API_KEY: "test-key" }, () => {
    assert.equal(modelProviderKeyPresent("groq/openai/gpt-oss-120b"), false);
    assert.equal(agentConfigured(modelConfig("groq/openai/gpt-oss-120b")), false);
  });
});

test("venice model with VENICE_API_KEY is configured", () => {
  withKeys({ VENICE_API_KEY: "test-key" }, () => {
    assert.equal(modelProviderKeyPresent("venice/llama-3.3-70b"), true);
    assert.equal(agentConfigured(modelConfig("venice/llama-3.3-70b")), true);
  });
});

test("venice model without VENICE_API_KEY is not configured, even with other keys", () => {
  withKeys({ GROQ_API_KEY: "test-key", ANTHROPIC_API_KEY: "test-key" }, () => {
    assert.equal(modelProviderKeyPresent("venice/llama-3.3-70b"), false);
    assert.equal(agentConfigured(modelConfig("venice/llama-3.3-70b")), false);
  });
});
