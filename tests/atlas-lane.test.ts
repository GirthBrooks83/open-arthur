import assert from "node:assert/strict";
import { test } from "node:test";
import { type AtlasLaneConfig, AtlasLaneProbe } from "../apps/server/src/engine/atlas-lane.ts";

const CONFIGURED: AtlasLaneConfig = {
  enabled: true,
  configured: true,
  provider: "GPT-OSS 120B via Groq free tier (OpenAI-compatible) — not a paid OpenAI key",
  model: "openai/gpt-oss-120b",
  baseUrl: "https://api.groq.com/openai/v1",
  billing: "free_then_paid — auto cut-off if the free route stops being free; never charges",
};

const okFetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
const unauthorizedFetch = async () => new Response("unauthorized", { status: 401 });
const downFetch = async () => {
  throw new Error("connect ECONNREFUSED api.groq.com:443");
};

test("before any probe the lane reports configured, never ready", () => {
  const probe = new AtlasLaneProbe(okFetch);
  const status = probe.status(CONFIGURED);
  assert.equal(status.status, "configured");
  assert.equal(status.probe.state, "pending");
  assert.equal(status.probe.at, null);
  assert.equal(status.lastReadyAt, null);
});

test("a successful probe earns ready in this process, through the lane's own route", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const probe = new AtlasLaneProbe(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  const status = await probe.probe(CONFIGURED, "groq-key-for-test");
  assert.equal(status.status, "ready");
  assert.equal(status.probe.state, "passed");
  assert.ok(status.probe.at !== null);
  assert.equal(status.lastReadyAt, status.probe.at);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.groq.com/openai/v1/models");
  const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, "Bearer groq-key-for-test");
  // And health keeps reporting the earned state afterwards.
  assert.equal(probe.status(CONFIGURED).status, "ready");
});

test("a failed probe reports degraded with the error recorded, never ready", async () => {
  const probe = new AtlasLaneProbe(unauthorizedFetch);
  const status = await probe.probe(CONFIGURED, "revoked-key");
  assert.equal(status.status, "degraded");
  assert.equal(status.probe.state, "failed");
  assert.match(status.probe.error ?? "", /HTTP 401/);
  assert.equal(status.lastReadyAt, null);
});

test("an unreachable route also fails the probe instead of claiming ready", async () => {
  const probe = new AtlasLaneProbe(downFetch);
  const status = await probe.probe(CONFIGURED, "groq-key-for-test");
  assert.equal(status.status, "degraded");
  assert.match(status.probe.error ?? "", /ECONNREFUSED/);
});

test("an unconfigured lane is never probed and never ready", async () => {
  let called = false;
  const probe = new AtlasLaneProbe(async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  const unconfigured = { ...CONFIGURED, configured: false };
  const status = await probe.probe(unconfigured, undefined);
  assert.equal(called, false);
  assert.equal(status.status, "awaiting-groq-key");
  assert.equal(status.probe.state, "off");
});

test("a disabled lane reports off and is never probed", async () => {
  let called = false;
  const probe = new AtlasLaneProbe(async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  const status = await probe.probe({ ...CONFIGURED, enabled: false }, "key");
  assert.equal(called, false);
  assert.equal(status.status, "off");
});
