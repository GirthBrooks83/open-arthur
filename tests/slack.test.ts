import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";
import {
  chunkSlackText,
  type SlackEventPayload,
  slackConfigured,
  slackRoutes,
  verifySlackSignature,
} from "../apps/server/src/slack.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

// Slack bridge tests: the endpoint must answer Slack's setup challenge
// before any secret exists, enforce the v0 signature once a secret is
// configured, never react to bots (including itself), dedupe retries,
// and route real mentions through the same AgentService the app uses.

const SECRET = "test-signing-secret";
const BOT_ID = "UARTHURBOT";

function config(overrides: Partial<Config> = {}): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: ".openmuse-test",
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    slackBotToken: "xoxb-test",
    slackSigningSecret: SECRET,
    ...overrides,
  } as Config;
}

function sign(secret: string, timestamp: string, raw: string) {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex");
}

interface StubTask {
  status: string;
  result?: string;
  question?: string;
  error?: string;
}

function stubAgent(script: StubTask) {
  const created: { owner: string; prompt: string; key?: string }[] = [];
  const agent = {
    async createTask(owner: string, raw: { prompt: string }, key?: string) {
      created.push({ owner, prompt: raw.prompt, key });
      return { id: "task-1" } as AgentTask;
    },
    async getTask() {
      return { id: "task-1", ...script } as AgentTask;
    },
  } as unknown as AgentService;
  return { agent, created };
}

function bridge(cfg: Config, agent: AgentService, posts: unknown[], logs: string[]) {
  const app = slackRoutes(cfg, agent, {
    postMessage: async (input) => {
      posts.push(input);
    },
    authTest: async () => BOT_ID,
    pollMs: 1,
    timeoutMs: 5000,
    log: (message) => logs.push(message),
  });
  return app;
}

async function postEvent(
  app: ReturnType<typeof slackRoutes>,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return app.request("/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function signedPost(app: ReturnType<typeof slackRoutes>, payload: unknown) {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return postEvent(app, raw, {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": sign(SECRET, ts, raw),
  });
}

const mention = (overrides: Record<string, unknown> = {}): SlackEventPayload => ({
  type: "event_callback",
  event_id: "Ev123",
  team_id: "T1",
  event: {
    type: "app_mention",
    user: "UJOSEPH",
    channel: "C0CEJ24DUNR",
    channel_type: "channel",
    text: `<@${BOT_ID}> what is 17 + 25?`,
    ts: "1793933246.510629",
    ...overrides,
  },
});

test("url_verification is answered with no secrets configured at all", async () => {
  const { agent } = stubAgent({ status: "succeeded" });
  const app = bridge(
    config({ slackBotToken: undefined, slackSigningSecret: undefined }),
    agent,
    [],
    [],
  );
  const res = await postEvent(app, { type: "url_verification", challenge: "abc123" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { challenge: "abc123" });
});

test("url_verification with a configured secret requires a valid signature", async () => {
  const { agent } = stubAgent({ status: "succeeded" });
  const app = bridge(config(), agent, [], []);
  const bad = await postEvent(app, { type: "url_verification", challenge: "abc123" });
  assert.equal(bad.status, 401);
  const good = await signedPost(app, { type: "url_verification", challenge: "abc123" });
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { challenge: "abc123" });
});

test("verifySlackSignature rejects stale timestamps and tampered bodies", () => {
  const raw = JSON.stringify({ type: "event_callback" });
  const now = Date.now();
  const fresh = String(Math.floor(now / 1000));
  assert.equal(verifySlackSignature(SECRET, fresh, raw, sign(SECRET, fresh, raw), now), true);
  const stale = String(Math.floor(now / 1000) - 600);
  assert.equal(verifySlackSignature(SECRET, stale, raw, sign(SECRET, stale, raw), now), false);
  assert.equal(
    verifySlackSignature(SECRET, fresh, `${raw} `, sign(SECRET, fresh, raw), now),
    false,
  );
  assert.equal(verifySlackSignature(SECRET, fresh, raw, undefined, now), false);
});

test("events are not acted on until the signing secret is configured", async () => {
  const { agent, created } = stubAgent({ status: "succeeded", result: "hi" });
  const logs: string[] = [];
  const app = bridge(config({ slackSigningSecret: undefined }), agent, [], logs);
  const res = await postEvent(app, mention());
  assert.equal(res.status, 200);
  assert.equal(created.length, 0);
  assert.ok(logs.some((line) => line.includes("SLACK_SIGNING_SECRET")));
});

test("the bot ignores its own messages and other bots", async () => {
  const { agent, created } = stubAgent({ status: "succeeded", result: "hi" });
  const app = bridge(config(), agent, [], []);
  const process = (app as unknown as { __process: (p: SlackEventPayload) => Promise<void> })
    .__process;
  await process(mention({ user: BOT_ID }));
  await process(mention({ user: "UOTHER", bot_id: "B999" }));
  await process(mention({ user: "UOTHER", subtype: "bot_message" }));
  assert.equal(created.length, 0);
});

test("a mention runs a task for the Slack identity and replies threaded with the result", async () => {
  const { agent, created } = stubAgent({ status: "succeeded", result: "42 BANANA" });
  const posts: { channel: string; threadTs?: string; text: string }[] = [];
  const app = bridge(config(), agent, posts, []);
  const process = (app as unknown as { __process: (p: SlackEventPayload) => Promise<void> })
    .__process;
  await process(mention());
  assert.equal(created.length, 1);
  assert.equal(created[0]?.owner, "slack-T1-UJOSEPH");
  assert.ok(created[0]?.prompt.includes("what is 17 + 25?"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.channel, "C0CEJ24DUNR");
  assert.equal(posts[0]?.threadTs, "1793933246.510629");
  assert.equal(posts[0]?.text, "42 BANANA");
});

test("a duplicate delivery (Slack retry) runs the task only once", async () => {
  const { agent, created } = stubAgent({ status: "succeeded", result: "once" });
  const posts: unknown[] = [];
  const app = bridge(config(), agent, posts, []);
  await signedPost(app, mention());
  await signedPost(app, mention());
  // Processing is async after the 200; give it room to settle.
  for (let i = 0; i < 50 && posts.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(created.length, 1);
  assert.equal(posts.length, 1);
});

test("without a bot token the run still happens but the reply is skipped with a logged reason", async () => {
  const { agent, created } = stubAgent({ status: "succeeded", result: "unpostable" });
  const logs: string[] = [];
  // No postMessage injection: the real one must gate on the token.
  const app = slackRoutes(config({ slackBotToken: undefined }), agent, {
    authTest: async () => BOT_ID,
    pollMs: 1,
    timeoutMs: 5000,
    log: (message) => logs.push(message),
  });
  const process = (app as unknown as { __process: (p: SlackEventPayload) => Promise<void> })
    .__process;
  await process(mention());
  assert.equal(created.length, 1);
  assert.ok(logs.some((line) => line.includes("SLACK_BOT_TOKEN")));
});

test("chunkSlackText bounds chunk size and count", () => {
  const chunks = chunkSlackText("word ".repeat(5000));
  assert.ok(chunks.length >= 2 && chunks.length <= 3);
  for (const chunk of chunks) assert.ok(chunk.length <= 3900);
  assert.deepEqual(chunkSlackText("short"), ["short"]);
});

test("slackConfigured requires both values", () => {
  assert.equal(slackConfigured(config()), true);
  assert.equal(slackConfigured(config({ slackBotToken: undefined })), false);
  assert.equal(slackConfigured(config({ slackSigningSecret: undefined })), false);
});
