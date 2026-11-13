import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import type { AgentService } from "./engine/service.ts";

// Slack bridge: gives the deployed agent its own bot user in the owner's
// Slack workspace. Slack POSTs Events API payloads to /api/slack/events;
// mentions and DMs run through the SAME AgentService the app uses (no
// second brain), and the result is posted back threaded under the
// original message.
//
// Env-gated and honest, like every other lane in this server:
// - No SLACK_SIGNING_SECRET: url_verification challenges are still
//   answered (Slack checks the URL during app setup, before any secret
//   exists in our env), and events are accepted but only logged — the
//   bot cannot prove they are genuine, so it does not act on them.
// - Secret set: every request must carry a valid v0 signature.
// - No SLACK_BOT_TOKEN: the agent still runs, but replies are skipped
//   with a clear logged reason (there is no way to post without it).

export interface SlackInnerEvent {
  type: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

export interface SlackEventPayload {
  type: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: SlackInnerEvent;
}

export interface SlackBridgeDeps {
  /** Post one message to Slack. Default: real chat.postMessage call. */
  postMessage?: (input: { channel: string; threadTs?: string; text: string }) => Promise<void>;
  /** Resolve the bot's own user id (auth.test). Default: real call. */
  authTest?: () => Promise<string | undefined>;
  /** Task polling cadence / ceiling (tests shrink these). */
  pollMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

// The app's session owner (auth.ts mints sessions with this owner id).
// App tasks — and the Collective Consults recorded on them (PR-iota) —
// live under it, so consult answers resolve against it no matter which
// Slack identity posted the reply.
const APP_OWNER = "local-user";

const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
const DEDUPE_TTL_MS = 10 * 60 * 1000;
// Slack message text can run long; keep each post comfortably under the
// practical limit and cap the number of chunks.
const CHUNK_LIMIT = 3900;
const MAX_CHUNKS = 3;

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | undefined,
  rawBody: string,
  signature: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs - ts * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const expected =
    "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function chunkSlackText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= CHUNK_LIMIT) return [trimmed];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > CHUNK_LIMIT && chunks.length < MAX_CHUNKS - 1) {
    let cut = rest.lastIndexOf("\n", CHUNK_LIMIT);
    if (cut < CHUNK_LIMIT / 2) cut = rest.lastIndexOf(" ", CHUNK_LIMIT);
    if (cut < CHUNK_LIMIT / 2) cut = CHUNK_LIMIT;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest && chunks.length < MAX_CHUNKS)
    chunks.push(rest.length > CHUNK_LIMIT ? `${rest.slice(0, CHUNK_LIMIT - 1)}…` : rest);
  return chunks.filter(Boolean);
}

export function slackConfigured(config: Config): boolean {
  return Boolean(config.slackBotToken && config.slackSigningSecret);
}

async function slackApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!data.ok) throw new Error(`Slack ${method} failed: ${String(data.error ?? response.status)}`);
  return data;
}

export function slackRoutes(config: Config, agent: AgentService, deps: SlackBridgeDeps = {}) {
  const log = deps.log ?? ((message: string) => console.log(`[OpenMuse] slack: ${message}`));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 3000;
  const timeoutMs = deps.timeoutMs ?? 150000;
  const postMessage =
    deps.postMessage ??
    (async ({ channel, threadTs, text }) => {
      if (!config.slackBotToken) {
        log("reply skipped — SLACK_BOT_TOKEN is not configured, so the bot cannot post");
        return;
      }
      await slackApi(config.slackBotToken, "chat.postMessage", {
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    });
  let botUserIdPromise: Promise<string | undefined> | undefined;
  const botUserId = () => {
    if (deps.authTest) return deps.authTest();
    if (!config.slackBotToken) return Promise.resolve(undefined);
    botUserIdPromise ??= slackApi(config.slackBotToken, "auth.test", {})
      .then((data) => (typeof data.user_id === "string" ? data.user_id : undefined))
      .catch(() => undefined);
    return botUserIdPromise;
  };

  // Slack retries deliveries; the same event must never run twice. Keyed
  // by event_id, and for message-like events also by channel+ts because
  // one message can arrive as both an app_mention and a message event.
  const seen = new Map<string, number>();
  const alreadySeen = (keys: string[]): boolean => {
    const at = now();
    for (const [key, stamp] of seen) if (at - stamp > DEDUPE_TTL_MS) seen.delete(key);
    if (keys.some((key) => seen.has(key))) return true;
    for (const key of keys) seen.set(key, at);
    return false;
  };

  const reply = async (event: SlackInnerEvent, text: string) => {
    const threadTs = event.thread_ts ?? event.ts;
    for (const chunk of chunkSlackText(text)) {
      await postMessage({ channel: event.channel ?? "", threadTs, text: chunk });
    }
  };

  // Collective Consult (PR-iota): a reply in the thread of a consult
  // question the agent posted closes that consult and spawns the
  // continuation task. This runs BEFORE the actionable gate on purpose:
  // an answer needs no bot mention, and the answerers (ATLAS, Claude)
  // may post through app integrations the bot filter would otherwise
  // drop. Two guards keep it narrow: the bot's own posts never count as
  // answers, and a reply has an effect only when it matches an OPEN
  // consult by thread ts — everything else falls through untouched.
  const consultAnswer = async (payload: SlackEventPayload): Promise<boolean> => {
    const event = payload.event;
    if (!event?.thread_ts || !event.channel || !event.ts) return false;
    if (event.thread_ts === event.ts) return false; // the question itself, not a reply
    if (config.slackBriefChannel && event.channel !== config.slackBriefChannel) return false;
    const text = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return false;
    const self = await botUserId();
    if (self && event.user === self) return false;
    const answered = await agent.answerConsult(APP_OWNER, event.thread_ts, text);
    if (!answered) return false;
    await postMessage({
      channel: event.channel,
      threadTs: event.thread_ts,
      text: "Got it — picked up as a follow-up task.",
    });
    return true;
  };

  const runEvent = async (payload: SlackEventPayload, event: SlackInnerEvent) => {
    const team = payload.team_id ?? "unknown";
    const owner = `slack-${team}-${event.user}`;
    const rawText = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!rawText) {
      await reply(event, "Here. What do you need?");
      return;
    }
    const task = await agent.createTask(
      owner,
      {
        title: `Slack: ${rawText.slice(0, 60)}`,
        prompt:
          `A message arrived for you in Slack (channel ${event.channel ?? "DM"}). ` +
          `Respond to it as the assistant in that Slack conversation. The message:\n\n${rawText}`,
      },
      `slack:${payload.event_id ?? `${event.channel}:${event.ts}`}`,
    );
    const deadline = now() + timeoutMs;
    for (;;) {
      const current = await agent.getTask(owner, task.id);
      if (current.status === "succeeded") {
        await reply(event, current.result ?? "Done.");
        return;
      }
      if (current.status === "waiting_input") {
        await reply(event, current.question ?? "I need one more detail to finish that.");
        return;
      }
      if (current.status === "failed" || current.status === "cancelled") {
        await reply(
          event,
          `That one hit a problem${current.error ? `: ${current.error.slice(0, 300)}` : "."}`,
        );
        return;
      }
      if (now() > deadline) {
        await reply(event, "Still working on that one — it'll land here when it finishes.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  // Exported for tests: decide whether an inner event is actionable.
  const actionable = async (payload: SlackEventPayload): Promise<SlackInnerEvent | undefined> => {
    const event = payload.event;
    if (!event || !event.user || !event.channel) return undefined;
    // Never react to bots (including ourselves) or to edits/joins/etc.
    if (event.bot_id || event.subtype) return undefined;
    const self = await botUserId();
    if (self && event.user === self) return undefined;
    if (event.type === "app_mention") return event;
    if (event.type === "message") {
      // DMs to the bot are always for the bot. Plain channel messages are
      // handled by the app_mention event for the same message; only act
      // here when the bot is explicitly mentioned in the text.
      if (event.channel_type === "im") return event;
      if (self && (event.text ?? "").includes(`<@${self}>`)) return event;
    }
    return undefined;
  };

  const app = new Hono();
  app.post("/events", async (c) => {
    const raw = await c.req.text();
    const secret = config.slackSigningSecret;
    if (secret) {
      const ok = verifySlackSignature(
        secret,
        c.req.header("x-slack-request-timestamp"),
        raw,
        c.req.header("x-slack-signature"),
        now(),
      );
      if (!ok) return c.json({ error: "Invalid Slack signature" }, 401);
    }
    let payload: SlackEventPayload;
    try {
      payload = JSON.parse(raw) as SlackEventPayload;
    } catch {
      return c.json({ error: "Invalid request data" }, 400);
    }
    // URL verification happens during app setup, before any secret or
    // token exists in our env — answer it whenever the payload is well
    // formed (and, once a secret IS configured, only after the signature
    // check above has passed).
    if (payload.type === "url_verification" && payload.challenge) {
      return c.json({ challenge: payload.challenge });
    }
    if (payload.type !== "event_callback" || !payload.event) return c.json({ ok: true });
    if (!secret) {
      log("event received but SLACK_SIGNING_SECRET is not configured — not acting on it");
      return c.json({ ok: true });
    }
    const keys = [payload.event_id ?? "", `${payload.event.channel}:${payload.event.ts}`].filter(
      Boolean,
    );
    if (alreadySeen(keys)) return c.json({ ok: true });
    // Acknowledge fast; Slack retries anything slower than ~3 seconds.
    void (async () => {
      try {
        if (await consultAnswer(payload)) return;
        const event = await actionable(payload);
        if (event) await runEvent(payload, event);
      } catch (error) {
        log(`event handling failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
    })();
    return c.json({ ok: true });
  });
  // Test seam: lets the suite drive processing deterministically.
  (app as unknown as { __process: unknown }).__process = async (payload: SlackEventPayload) => {
    if (await consultAnswer(payload)) return;
    const event = await actionable(payload);
    if (event) await runEvent(payload, event);
  };
  return app;
}
