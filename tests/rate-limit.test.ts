import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allProvidersExhaustedMessage,
  buildProviderChain,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  isQuotaExhausted,
  rateLimitDelayMs,
} from "../apps/server/src/engine/rate-limit.ts";

// The exact daily-cap error the deployed Gemini free tier returned on
// 2026-11-05 — the failover fixture.
const GEMINI_DAILY_CAP =
  "You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash. Please retry in 3h33m47.202315424s.";
const GEMINI_PER_MINUTE =
  "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.6-flash. Please retry in 23.696171825s.";
// The exact Groq error the flipped Qwen brain returned live on 2026-11-05:
// a short output-token window ("try again in", not "retry in").
const GROQ_OTPM =
  "Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_01m6ma7taaew6txcabt33rga5y` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Used 820, Requested 705. Please try again in 31.5s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing";

test("parses the Gemini per-minute quota retry delay", () => {
  const delay = rateLimitDelayMs(GEMINI_PER_MINUTE);
  assert.ok(delay !== null);
  assert.ok(Math.abs(delay - 23_696) < 5, `expected ~23696ms, got ${delay}`);
});

test("parses the Gemini daily quota delay as hours (caller must not sleep it out)", () => {
  const delay = rateLimitDelayMs(GEMINI_DAILY_CAP);
  assert.ok(delay !== null);
  const expected = 3 * 3_600_000 + 33 * 60_000 + 47_000;
  assert.ok(Math.abs(delay - expected) < 1000, `expected ~${expected}ms, got ${delay}`);
});

test("rate limit without a delay falls back to the default wait", () => {
  assert.equal(
    rateLimitDelayMs("429 Too Many Requests: rate limit reached"),
    DEFAULT_RATE_LIMIT_WAIT_MS,
  );
});

test("non-rate-limit errors are not retried", () => {
  assert.equal(rateLimitDelayMs("The page could not be loaded."), null);
  assert.equal(rateLimitDelayMs("Model run timed out after five minutes"), null);
  assert.equal(rateLimitDelayMs("Error 4290: unrelated failure"), null);
});

test("quota exhaustion: long windows and renewed short windows end the provider", () => {
  assert.equal(isQuotaExhausted(3 * 3_600_000, 0), true); // daily cap, first failure
  assert.equal(isQuotaExhausted(23_696, 0), false); // per-minute window, worth waiting out
  assert.equal(isQuotaExhausted(23_696, 2), true); // window kept renewing past the retry budget
  assert.equal(isQuotaExhausted(null, 5), false); // not a rate limit at all
});

test("failover decision: the real Gemini daily-cap error fails over immediately", () => {
  const delay = rateLimitDelayMs(GEMINI_DAILY_CAP);
  assert.equal(isQuotaExhausted(delay, 0), true);
  // ...while the per-minute shape is waited out on the same provider first.
  assert.equal(isQuotaExhausted(rateLimitDelayMs(GEMINI_PER_MINUTE), 0), false);
});

test("parses the Groq 'try again in' window as a short wait, not exhaustion", () => {
  const delay = rateLimitDelayMs(GROQ_OTPM);
  assert.ok(delay !== null);
  assert.ok(Math.abs(delay - 31_500) < 5, `expected ~31500ms, got ${delay}`);
  assert.equal(isQuotaExhausted(delay, 0), false);
});

test("no failover on non-quota errors (e.g. an unknown provider prefix)", () => {
  const message =
    'Unknown provider "groq" in "groq/llama-3.3-70b-versatile". Supported: openai, anthropic, google (gemini).';
  assert.equal(rateLimitDelayMs(message), null);
  assert.equal(isQuotaExhausted(rateLimitDelayMs(message), 0), false);
});

test("provider chain: configured order wins, unkeyed and duplicate entries drop out", () => {
  const keyed = new Set(["openai/qwen/qwen3.8-27b", "google/gemini-3.5-flash"]);
  const keyPresent = (m: string) => keyed.has(m);
  // Ordering: primary first, then fallbacks in order.
  assert.deepEqual(
    buildProviderChain(
      ["openai/qwen/qwen3.8-27b", "google/gemini-3.5-flash", undefined],
      keyPresent,
    ),
    ["openai/qwen/qwen3.8-27b", "google/gemini-3.5-flash"],
  );
  // Active provider = first configured+keyed entry: an unkeyed primary is
  // skipped, so the fallback becomes the active provider.
  assert.deepEqual(
    buildProviderChain(
      ["anthropic/claude-sonnet-4-5", "google/gemini-3.5-flash", "openai/qwen/qwen3.8-27b"],
      keyPresent,
    ),
    ["google/gemini-3.5-flash", "openai/qwen/qwen3.8-27b"],
  );
  // Duplicates collapse; nothing keyed means an empty chain.
  assert.deepEqual(
    buildProviderChain(["google/gemini-3.5-flash", "google/gemini-3.5-flash"], keyPresent),
    ["google/gemini-3.5-flash"],
  );
  assert.deepEqual(buildProviderChain([undefined, "venice/unknown"], keyPresent), []);
});

test("all-providers-exhausted: plain summary with the earliest suggested reset", () => {
  const now = Date.parse("2026-11-06T05:00:00.000Z");
  const message = allProvidersExhaustedMessage(
    [
      { model: "openai/qwen/qwen3.8-27b", message: "429 rate limit", delayMs: 60_000 },
      { model: "google/gemini-3.5-flash", message: GEMINI_DAILY_CAP, delayMs: 3 * 3_600_000 },
    ],
    now,
  );
  assert.match(message, /All configured model providers are exhausted/);
  assert.match(message, /openai\/qwen\/qwen3\.8-27b/);
  assert.match(message, /google\/gemini-3\.5-flash/);
  assert.match(message, /Earliest provider reset ≈ 2026-11-06T05:01:00\.000Z/);
});
