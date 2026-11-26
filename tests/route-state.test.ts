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

const OMNIROUTE_COOLDOWN_MESSAGE =
  "All credentials for model gemini-3-flash-preview are cooling down";
const OMNIROUTE_COOLDOWN_BODY =
  '{"error":{"message":"All credentials for model gemini-3-flash-preview are cooling down","type":"rate_limit_error","code":"model_cooldown","model":"gemini-3-flash-preview","reset_seconds":84903,"retry_after":"2026-11-27T07:59:58.460Z","credentials_cooling":1}}';

test("an OmniRoute cooldown trips the breaker: bare message sinks briefly, body sinks for its full window", () => {
  const bare = new RouteStateTracker();
  bare.recordFailure(HEAD, OMNIROUTE_COOLDOWN_MESSAGE, T0);
  const bareStatus = bare.statusFor(HEAD, T0);
  assert.equal(bareStatus.state, "cooldown");
  assert.equal(bareStatus.errorClass, "rate-limit");
  assert.deepEqual(bare.orderChain([HEAD, NEXT], T0), [NEXT, HEAD]);

  const withBody = new RouteStateTracker();
  withBody.recordFailure(HEAD, OMNIROUTE_COOLDOWN_MESSAGE, T0, OMNIROUTE_COOLDOWN_BODY);
  const bodyStatus = withBody.statusFor(HEAD, T0);
  assert.equal(bodyStatus.state, "cooldown");
  const retryMs = Date.parse(bodyStatus.retryAfter ?? "") - T0;
  assert.ok(Math.abs(retryMs - 84_903_000) < 1000, `expected ~84903000ms, got ${retryMs}`);
  // Display text stays the bare message — the body is classification-only.
  assert.equal(bodyStatus.lastError, OMNIROUTE_COOLDOWN_MESSAGE);
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
