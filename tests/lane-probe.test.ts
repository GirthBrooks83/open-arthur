import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { LaneProbe } from "../apps/server/src/engine/lane-probe.ts";

// Live lane probes (ATLAS audit Priority 3): /api/health's
// `integrations.*` booleans are Boolean(url) — configuration, not
// truth. The probe module adds `integrationsLive` + `browserLive`:
// real GET probes, cached for a TTL behind a background refresh, so
// health stays fast and a dead lane reports false instead of staying
// green. These tests prove that against stub servers, a counting
// fake fetch, and the real /api/health payload.

let healthyStub: Server,
  healthyUrl: string,
  healthyHits = 0;
let failingStub: Server, failingUrl: string;
let baseStub: Server, baseUrl: string;

before(async () => {
  // Memory-lane style stub: /health answers 200.
  healthyStub = createServer((request, response) => {
    healthyHits += 1;
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    } else {
      response.writeHead(404);
      response.end("nope");
    }
  });
  healthyStub.listen(0, "127.0.0.1");
  await once(healthyStub, "listening");
  const healthyAddress = healthyStub.address();
  assert(healthyAddress && typeof healthyAddress !== "string");
  healthyUrl = `http://127.0.0.1:${healthyAddress.port}`;

  // /health answers, but with a failure status: a health-path lane
  // counts only a successful response as live.
  failingStub = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  failingStub.listen(0, "127.0.0.1");
  await once(failingStub, "listening");
  const failingAddress = failingStub.address();
  assert(failingAddress && typeof failingAddress !== "string");
  failingUrl = `http://127.0.0.1:${failingAddress.port}`;

  // Base-URL lane stub: the root answers 404 (no health endpoint) —
  // for omniroute/anythingllm/n8n any HTTP response proves reachability.
  baseStub = createServer((_request, response) => {
    response.writeHead(404);
    response.end("root");
  });
  baseStub.listen(0, "127.0.0.1");
  await once(baseStub, "listening");
  const baseAddress = baseStub.address();
  assert(baseAddress && typeof baseAddress !== "string");
  baseUrl = `http://127.0.0.1:${baseAddress.port}`;
});

after(async () => {
  for (const stub of [healthyStub, failingStub, baseStub]) {
    stub?.closeAllConnections();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("probe reports stub lanes by their real answers", async () => {
  const probe = new LaneProbe(
    {
      mem0: healthyUrl,
      graphiti: failingUrl,
      hindsight: "http://127.0.0.1:1", // nothing listens: dead lane
      omniroute: baseUrl,
      anythingllm: healthyUrl,
      browser: healthyUrl,
      // n8n left unconfigured
    },
    fetch,
    { timeoutMs: 1000 },
  );
  // Before any probe lands, configured lanes are null (unknown),
  // exactly like unconfigured ones — never a guessed boolean.
  assert.deepEqual(probe.peek(), {
    integrationsLive: {
      mem0: null,
      graphiti: null,
      hindsight: null,
      omniroute: null,
      anythingllm: null,
      n8n: null,
    },
    browserLive: null,
  });

  const snapshot = await probe.refresh();
  assert.equal(snapshot.integrationsLive.mem0, true, "200 on /health is live");
  assert.equal(snapshot.integrationsLive.graphiti, false, "503 on /health is not live");
  assert.equal(snapshot.integrationsLive.hindsight, false, "connection refused is not live");
  assert.equal(
    snapshot.integrationsLive.omniroute,
    true,
    "any response on the base URL is reachable",
  );
  assert.equal(snapshot.integrationsLive.anythingllm, true);
  assert.equal(snapshot.integrationsLive.n8n, null, "unconfigured stays null");
  assert.equal(snapshot.browserLive, true, "worker /health 200 is live");
});

test("a hanging lane times out as false and never throws", async () => {
  const hanging = createServer(() => {
    // Never respond: the probe's own timeout is the only way out.
  });
  hanging.listen(0, "127.0.0.1");
  await once(hanging, "listening");
  const address = hanging.address();
  assert(address && typeof address !== "string");
  try {
    const probe = new LaneProbe({ mem0: `http://127.0.0.1:${address.port}` }, fetch, {
      timeoutMs: 100,
    });
    const started = Date.now();
    const snapshot = await probe.refresh();
    assert.equal(snapshot.integrationsLive.mem0, false);
    assert.ok(Date.now() - started < 5000, "timeout probe resolves promptly");
  } finally {
    hanging.closeAllConnections();
    await new Promise<void>((resolve) => hanging.close(() => resolve()));
  }
});

test("a fetch that rejects (or hangs until abort) reports false by value", async () => {
  const throwing = new LaneProbe({ mem0: "http://lane.invalid" }, async () => {
    throw new Error("network down");
  });
  assert.equal((await throwing.refresh()).integrationsLive.mem0, false);

  const hangingFetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted", "AbortError")),
      );
    })) as typeof fetch;
  const timedOut = new LaneProbe({ graphiti: "http://lane.invalid" }, hangingFetch, {
    timeoutMs: 50,
  });
  assert.equal((await timedOut.refresh()).integrationsLive.graphiti, false);
});

test("cache: a second snapshot within the TTL does not re-probe; after the TTL it does", async () => {
  healthyHits = 0;
  let now = 1_000_000;
  const probe = new LaneProbe({ mem0: healthyUrl }, fetch, {
    timeoutMs: 1000,
    ttlMs: 60_000,
    now: () => now,
  });

  // First snapshot returns the unknown state immediately and starts
  // a background probe; awaiting refresh() joins that same run.
  assert.equal(probe.snapshot().integrationsLive.mem0, null);
  await probe.refresh();
  assert.equal(probe.peek().integrationsLive.mem0, true);
  const hitsAfterFirstProbe = healthyHits;
  assert.ok(hitsAfterFirstProbe >= 1);

  // Within the TTL, snapshots serve the cache — no new probe.
  now += 30_000;
  assert.equal(probe.snapshot().integrationsLive.mem0, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(healthyHits, hitsAfterFirstProbe);

  // Past the TTL, the next snapshot starts a fresh probe.
  now += 31_000;
  probe.snapshot();
  await probe.refresh();
  assert.ok(healthyHits > hitsAfterFirstProbe);
});

const baseConfig = (dataDir: string, overrides: Partial<Config> = {}): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  ...overrides,
});

type HealthBody = {
  ok: boolean;
  browserConfigured: boolean;
  integrations: Record<string, boolean>;
  integrationsLive: Record<string, boolean | null>;
  browserLive: boolean | null;
};

async function healthOf(server: Awaited<ReturnType<typeof createApp>>): Promise<HealthBody> {
  const response = await server.app.request("/api/health");
  assert.equal(response.status, 200);
  return (await response.json()) as HealthBody;
}

test("health payload carries the live block additively; config flags unchanged", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-lane-probe-"));
  const db: Store = await createStore({ dataDir: join(directory, "db") });
  const laneProbe = new LaneProbe(
    { mem0: healthyUrl, omniroute: baseUrl, browser: healthyUrl },
    fetch,
    { timeoutMs: 1000, ttlMs: 60_000 },
  );
  const server = await createApp(
    db,
    baseConfig(directory, {
      workerUrl: healthyUrl,
      workerToken: "test-worker-token-at-least-32-characters",
      integrations: { mem0Url: healthyUrl, omnirouteUrl: baseUrl },
    }),
    { laneProbe },
  );
  t.after(async () => {
    await server.agent?.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  // First call: configuration is already true (the old semantics,
  // unchanged) while live truth is still unknown (null) — the probe
  // runs in the background and health does not wait for it.
  const first = await healthOf(server);
  assert.equal(first.ok, true);
  assert.equal(first.integrations.mem0, true);
  assert.equal(first.integrations.mem0Wired, true);
  assert.equal(first.browserConfigured, true);
  assert.deepEqual(first.integrationsLive, {
    mem0: null,
    graphiti: null,
    hindsight: null,
    omniroute: null,
    anythingllm: null,
    n8n: null,
  });
  assert.equal(first.browserLive, null);

  // Once the background probe lands, the SAME config flags stay true
  // and the live block reports the lanes' real answers.
  await laneProbe.refresh();
  const second = await healthOf(server);
  assert.equal(second.integrations.mem0, true);
  assert.equal(second.integrationsLive.mem0, true);
  assert.equal(second.integrationsLive.omniroute, true);
  assert.equal(second.integrationsLive.graphiti, null, "unconfigured lane stays null");
  assert.equal(second.browserLive, true);
});

test("a dead lane never breaks /api/health: config stays true, live reports false", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-lane-probe-dead-"));
  const db: Store = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(
    db,
    baseConfig(directory, {
      integrations: { mem0Url: "http://127.0.0.1:1", hindsightUrl: "http://127.0.0.1:1" },
    }),
  );
  t.after(async () => {
    await server.agent?.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  // Wait for the background probe (default 2.5s timeout budget per
  // lane, connection-refused is immediate) and re-read health.
  await server.laneProbe.refresh();
  const health = await healthOf(server);
  assert.equal(health.ok, true);
  // The honesty gap, demonstrated: configuration still says true…
  assert.equal(health.integrations.mem0, true);
  assert.equal(health.integrations.hindsight, true);
  // …while live truth says the lanes are not answering.
  assert.equal(health.integrationsLive.mem0, false);
  assert.equal(health.integrationsLive.hindsight, false);
  assert.equal(health.browserLive, null, "no worker configured");
});

test("an app with nothing configured reports every live value null and probes nothing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-lane-probe-empty-"));
  const db: Store = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, baseConfig(directory));
  t.after(async () => {
    await server.agent?.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const health = await healthOf(server);
  assert.deepEqual(health.integrationsLive, {
    mem0: null,
    graphiti: null,
    hindsight: null,
    omniroute: null,
    anythingllm: null,
    n8n: null,
  });
  assert.equal(health.browserLive, null);
});
