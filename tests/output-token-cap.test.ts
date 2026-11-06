import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AbstractAgent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { modelCallOptions } from "../apps/server/src/agent-config.ts";
import { parseMaxOutputTokens, readConfig } from "../apps/server/src/config.ts";
import { createDemoModel, demoModel } from "../apps/server/src/demo/model.ts";

// MODEL_MAX_OUTPUT_TOKENS caps the tokens a single model call may
// generate. The cap exists because free-tier providers budget EXPECTED
// output per minute (Groq OTPM: 1000 tokens/min on the deployed
// account): a live run died when one call's expected output (1014
// tokens) exceeded the entire budget — a rejection no retry, wait, or
// provider failover can pass, since every provider would be asked for
// the same oversized call. 512 is the recommended deployed value.

function withEnv(value: string | undefined, run: () => void) {
  const saved = process.env.MODEL_MAX_OUTPUT_TOKENS;
  if (value === undefined) delete process.env.MODEL_MAX_OUTPUT_TOKENS;
  else process.env.MODEL_MAX_OUTPUT_TOKENS = value;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env.MODEL_MAX_OUTPUT_TOKENS;
    else process.env.MODEL_MAX_OUTPUT_TOKENS = saved;
  }
}

test("valid values parse, including the recommended deployed value 512", () => {
  assert.equal(parseMaxOutputTokens(undefined), undefined);
  assert.equal(parseMaxOutputTokens("512"), 512);
  assert.equal(parseMaxOutputTokens(" 512 "), 512);
  assert.equal(parseMaxOutputTokens("1"), 1);
  assert.equal(parseMaxOutputTokens("8192"), 8192);
});

test("readConfig wires MODEL_MAX_OUTPUT_TOKENS into the config", () => {
  withEnv("512", () => assert.equal(readConfig().maxOutputTokens, 512));
  withEnv(undefined, () => assert.equal(readConfig().maxOutputTokens, undefined));
});

// Kept as the only invalid-input test in this file: the parse warning is
// a once-per-process guard, and this test owns it.
test("invalid values are treated as unset and warned about exactly once", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    for (const raw of ["abc", "0", "-5", "512.5", "", "1e3"])
      assert.equal(parseMaxOutputTokens(raw), undefined, `input ${JSON.stringify(raw)}`);
    withEnv("abc", () => assert.equal(readConfig().maxOutputTokens, undefined));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /MODEL_MAX_OUTPUT_TOKENS/);
});

test("modelCallOptions is empty without a cap and carries it when set", () => {
  assert.deepEqual(modelCallOptions({}), {});
  assert.deepEqual(modelCallOptions({ maxOutputTokens: undefined }), {});
  assert.deepEqual(modelCallOptions({ maxOutputTokens: 512 }), { maxOutputTokens: 512 });
});

function constructedConfig(options: Record<string, unknown>): Record<string, unknown> {
  const agent = new BuiltInAgent({
    model: "openai/gpt-4o",
    maxSteps: 1,
    ...options,
  } as ConstructorParameters<typeof BuiltInAgent>[0]);
  return (agent as unknown as { config: Record<string, unknown> }).config;
}

test("the cap lands on the constructed agent; without it the agent is unchanged", () => {
  const capped = constructedConfig(modelCallOptions({ maxOutputTokens: 512 }));
  assert.equal(capped.maxOutputTokens, 512);
  const plain = constructedConfig(modelCallOptions({}));
  assert.equal("maxOutputTokens" in plain, false);
  assert.equal(plain.maxOutputTokens, undefined);
});

test("the cap reaches the provider request as max_tokens; no cap sends none", async () => {
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  const mock = createDemoModel({ latency: 0 });
  await mock.start();
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
  process.env.OPENAI_API_KEY = "local-demo-test";
  const runOnce = async (spread: { maxOutputTokens?: number }) => {
    const options = {
      model: demoModel,
      maxSteps: 3,
      maxRetries: 0,
      ...spread,
      tools: [
        defineTool({
          name: "browse_web",
          description: "Read a page (unit-test tool implementation).",
          parameters: z.object({ url: z.url() }),
          execute: async ({ url }) => ({
            sessionId: randomUUID(),
            url,
            title: "Hacker News",
            text: "Hacker News\n1.\t\n\tTest headline returned only by this tool\n2. Another observed headline\n3.\nA third observed headline",
          }),
        }),
      ],
    };
    class CapAgent extends AbstractAgent {
      run(input: RunAgentInput) {
        return new BuiltInAgent(options).run(input);
      }
    }
    const agent = new CapAgent();
    agent.addMessage({
      id: randomUUID(),
      role: "user",
      content: "Find cool stuff on Hacker News",
    });
    await agent.runAgent();
    return mock
      .getRequests()
      .map((entry) => entry.body as unknown as Record<string, unknown> | null);
  };
  try {
    const cappedBodies = await runOnce(modelCallOptions({ maxOutputTokens: 512 }));
    assert.ok(cappedBodies.length > 0);
    for (const body of cappedBodies) assert.equal(body?.max_tokens, 512);
    mock.clearRequests();
    const plainBodies = await runOnce(modelCallOptions({}));
    assert.ok(plainBodies.length > 0);
    for (const body of plainBodies) assert.equal(body?.max_tokens, undefined);
  } finally {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await mock.stop();
  }
});
