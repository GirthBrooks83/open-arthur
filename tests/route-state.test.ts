import assert from "node:assert/strict";
import { test } from "node:test";
import { RouteStateTracker } from "../apps/server/src/engine/route-state.ts";

// Simulated provider fixtures, in the style of tests/rate-limit.test.ts:
// the exact wordings the deployed free tiers returned live.
const GEMINI_PER_MINUTE =
  "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.6-flash. Please retry in 23.696171825s.";
const GEMINI_DAILY_CAP =
  "You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash. Please retry in 3h33m47.202315424s.";
const GROQ_OTPM =
  "Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_01m6ma7taaew6txcabt33rga5y` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Used 820, Requested 705. Please try again in 31.5s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing";

const HEAD = "openai/gemini/gemini-3-flash-preview";
const NEXT = "openai/groq/openai/gpt-oss-120b";
const THIRD = "openai/gemini/gemini-3.1-flash-lite";
const T0 = 1_700_000_000_000;

test("an unproven route reports unknown, never active", () => {
  const tracker = new RouteStateTracker();
  const status = tracker.statusFor(HEAD, T0);
  assert.equal(status.state, "unknown");
  assert.equal(status.lastSuccessAt, null);
  assert.equal(status.retryAfter, null);
  assert.equal(tracker.isCooling(HEAD, T0), false);
});

test("a 429 trips the breaker: cooldown honors the provider's retry window", () => {
  const tracker = new RouteStateTracker();
  tracker.recordFailure(HEAD, GEMINI_PER_MINUTE, T0);
  const status = tracker.statusFor(HEAD, T0);
  assert.equal(status.state, "cooldown");
  assert.equal(status.errorClass, "rate-limit");
  assert.equal(status.lastFailureAt, new Date(T0).toISOString());
  assert.ok(status.retryAfter !== null);
  const retryMs = Date.parse(status.retryAfter) - T0;
  assert.ok(Math.abs(retryMs - 23_696) < 5, `expected ~23696ms, got ${retryMs}`);
  assert.equal(status.cooldownUntil, status.retryAfter);
  assert.equal(tracker.isCooling(HEAD, T0 + 23_000), true);
});

test("a daily-cap 429 trips a long cooldown with its full retry_after", () => {
  const tracker = new RouteStateTracker();
  tracker.recordFailure(HEAD, GEMINI_DAILY_CAP, T0);
  const status = tracker.statusFor(HEAD, T0);
  assert.equal(status.state, "cooldown");
  const retryMs = Date.parse(status.retryAfter ?? "") - T0;
  const expected = 3 * 3_600_000 + 33 * 60_000 + 47_000;
  assert.ok(Math.abs(retryMs - expected) < 1000, `expected ~${expected}ms, got ${retryMs}`);
});

test("breaker trip makes chain construction fail over to the next route", () => {
  const tracker = new RouteStateTracker();
  tracker.recordFailure(HEAD, GROQ_OTPM, T0);
  assert.deepEqual(tracker.orderChain([HEAD, NEXT, THIRD], T0 + 1_000), [NEXT, THIRD, HEAD]);
});

test("cooldown expiry makes the route eligible again (degraded until it re-earns active)", () => {
  const tracker = new RouteStateTracker();
  tracker.recordFailure(HEAD, GEMINI_PER_MINUTE, T0);
  const after = T0 + 24_000;
  assert.equal(tracker.isCooling(HEAD, after), false);
  assert.deepEqual(tracker.orderChain([HEAD, NEXT], after), [HEAD, NEXT]);
  // Eligible is not "active": the last earned outcome is still the failure.
  assert.equal(tracker.statusFor(HEAD, after).state, "degraded");
  assert.equal(tracker.statusFor(HEAD, after).retryAfter, null);
});

test("a success clears the cooldown and earns active", () => {
  const tracker = new RouteStateTracker();
  tracker.recordFailure(HEAD, GEMINI_PER_MINUTE, T0);
  tracker.recordSuccess(HEAD, T0 + 5_000);
  const status = tracker.statusFor(HEAD, T0 + 5_000);
  assert.equal(status.state, "active");
  assert.equal(status.lastSuccessAt, new Date(T0 + 5_000).toISOString());
  assert.equal(status.cooldownUntil, null);
  assert.deepEqual(tracker.orderChain([HEAD, NEXT], T0 + 5_000), [HEAD, NEXT]);
});

test("a non-rate-limit failure degrades without tripping the breaker", () => {
  const tracker = new RouteStateTracker();
  tracker.recordFailure(HEAD, "The model service could not take that request just now", T0);
  const status = tracker.statusFor(HEAD, T0);
  assert.equal(status.state, "degraded");
  assert.equal(status.errorClass, "error");
  assert.equal(status.cooldownUntil, null);
  assert.equal(tracker.isCooling(HEAD, T0), false);
  // Degraded routes keep their chain place: only known cooldowns sink.
  assert.deepEqual(tracker.orderChain([HEAD, NEXT], T0), [HEAD, NEXT]);
});

test("ordering is stable: deliberate order survives within each group", () => {
  const tracker = new RouteStateTracker();
  tracker.recordFailure(NEXT, GEMINI_PER_MINUTE, T0);
  assert.deepEqual(tracker.orderChain([HEAD, NEXT, THIRD], T0), [HEAD, THIRD, NEXT]);
  // Every route cooling: the original order stands — nothing better exists.
  tracker.recordFailure(HEAD, GEMINI_PER_MINUTE, T0);
  tracker.recordFailure(THIRD, GEMINI_PER_MINUTE, T0);
  assert.deepEqual(tracker.orderChain([HEAD, NEXT, THIRD], T0), [HEAD, NEXT, THIRD]);
});

test("snapshot reports every chain route in chain order", () => {
  const tracker = new RouteStateTracker();
  tracker.recordSuccess(NEXT, T0);
  tracker.recordFailure(HEAD, GEMINI_PER_MINUTE, T0);
  const snap = tracker.snapshot([HEAD, NEXT, THIRD], T0);
  assert.deepEqual(
    snap.map((s) => [s.model, s.state]),
    [
      [HEAD, "cooldown"],
      [NEXT, "active"],
      [THIRD, "unknown"],
    ],
  );
});
