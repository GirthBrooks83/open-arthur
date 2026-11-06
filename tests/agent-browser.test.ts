import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { createWorkerServer } from "../apps/worker/src/server.ts";
import { buildExtractSchema, type StagehandModule } from "../apps/worker/src/stagehand.ts";
import { browserFixture } from "./helpers/browser.ts";

// Agent browser (Stagehand) wiring, in the same style as
// tests/mem0-lane.test.ts: health separates enablement from wiring,
// the API server forwards extraction to the browser worker, and the
// worker enforces auth, the SSRF guard, and the disabled state. The
// Stagehand module itself is faked at the loadModule seam; the live
// extract against a real page + local model is proven separately in
// the lab (see the PR description).

const workerToken = "test-worker-token-at-least-32-characters";

function baseConfig(directory: string, overrides: Partial<Config> = {}): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    ...overrides,
  };
}

test("health reports agent browser enablement separately from wiring", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-agent-browser-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const offDb = await createStore({ dataDir: join(directory, "off-db") });
  t.after(async () => {
    await db.close();
    await offDb.close();
    await rm(directory, { recursive: true, force: true });
  });

  const enabled = await createApp(
    db,
    baseConfig(directory, {
      workerUrl: "http://127.0.0.1:8790",
      workerToken,
      agentBrowserEnabled: true,
    }),
  );
  const enabledHealth = (await (await enabled.app.request("/api/health")).json()) as {
    integrations: Record<string, unknown>;
    browserConfigured: boolean;
  };
  assert.equal(enabledHealth.browserConfigured, true);
  assert.equal(enabledHealth.integrations.agentBrowser, true);
  // The adapter ships in the codebase regardless of operator flags.
  assert.equal(enabledHealth.integrations.agentBrowserWired, true);

  const off = await createApp(offDb, baseConfig(directory, {}));
  const offHealth = (await (await off.app.request("/api/health")).json()) as {
    integrations: Record<string, unknown>;
  };
  assert.equal(offHealth.integrations.agentBrowser, false);
  assert.equal(offHealth.integrations.agentBrowserWired, true);
});

test("browser service forwards extraction to the worker", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const { service } = await browserFixture(t, (path, body) => {
    calls.push({ path, body });
    return {
      data: {
        url: "https://example.com/",
        title: "Example Domain",
        data: { heading: "Example Domain", description: "Stub description" },
      },
    };
  });
  const result = await service.extract(
    "https://example.com/",
    "Extract the heading and description",
    ["heading", "description"],
  );
  assert.deepEqual(result.data, { heading: "Example Domain", description: "Stub description" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, "/extract");
  assert.deepEqual(calls[0]?.body, {
    url: "https://example.com/",
    instruction: "Extract the heading and description",
    fields: ["heading", "description"],
  });
});

test("browser service surfaces a worker with Stagehand disabled in plain language", async (t) => {
  const { service } = await browserFixture(t, () => ({
    status: 501,
    data: {
      error: {
        code: "STAGEHAND_DISABLED",
        message:
          "The agent browser (Stagehand) is not enabled on this worker. Start it with WORKER_STAGEHAND_ENABLED=true.",
      },
    },
  }));
  await assert.rejects(
    service.extract("https://example.com/", "Extract the heading"),
    /not enabled on this worker/,
  );
});

const fakePage = {
  goto: async () => {},
  title: async () => "Example Domain",
  url: () => "https://example.com/",
};
const fakeStagehandModule: StagehandModule = {
  localBrowser: {
    launch: async () => ({ context: { pages: async () => [fakePage] }, close: async () => {} }),
  },
  Stagehand: {
    create: async () => ({
      extract: async () => ({ data: { heading: "Example Domain" } }),
      close: async () => {},
    }),
  },
};

async function startWorker(
  t: TestContext,
  stagehand?: { ollamaUrl: string; model: string; loadModule: () => Promise<StagehandModule> },
) {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-agent-browser-worker-"));
  const worker = await createWorkerServer({
    token: workerToken,
    dataDir,
    allowFakeIpRange: true,
    stagehand,
  });
  worker.server.listen(0, "127.0.0.1");
  await once(worker.server, "listening");
  const address = worker.server.address();
  assert(address && typeof address !== "string");
  t.after(async () => {
    await worker.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

function postExtract(base: string, body: unknown, authenticated = true) {
  return fetch(`${base}/extract`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${workerToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("worker extract route requires auth and reports the disabled lane", async (t) => {
  const base = await startWorker(t);
  assert.equal(
    (await postExtract(base, { url: "https://example.com/", instruction: "x" }, false)).status,
    401,
  );
  const response = await postExtract(base, {
    url: "https://example.com/",
    instruction: "Extract the heading",
  });
  assert.equal(response.status, 501);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "STAGEHAND_DISABLED");
  assert.match(body.error.message, /WORKER_STAGEHAND_ENABLED/);
});

test("worker extract validates input, guards destinations, and runs the extractor", async (t) => {
  const base = await startWorker(t, {
    ollamaUrl: "http://127.0.0.1:11434",
    model: "llama3.2:1b",
    loadModule: async () => fakeStagehandModule,
  });

  const ok = await postExtract(base, {
    url: "https://example.com/",
    instruction: "Extract the heading",
    fields: ["heading"],
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    url: "https://example.com/",
    title: "Example Domain",
    data: { heading: "Example Domain" },
  });

  const blocked = await postExtract(base, {
    url: "http://127.0.0.1:9/secret",
    instruction: "Extract the heading",
  });
  assert.equal(blocked.status, 400);
  assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, "BLOCKED_URL");

  const badFields = await postExtract(base, {
    url: "https://example.com/",
    instruction: "Extract the heading",
    fields: ["not a field!"],
  });
  assert.equal(badFields.status, 400);
  assert.equal(
    ((await badFields.json()) as { error: { code: string } }).error.code,
    "INVALID_FIELDS",
  );

  const noInstruction = await postExtract(base, { url: "https://example.com/", instruction: " " });
  assert.equal(noInstruction.status, 400);
  assert.equal(
    ((await noInstruction.json()) as { error: { code: string } }).error.code,
    "INVALID_INSTRUCTION",
  );
});

test("worker extract retries once when the browser drops its CDP connection", async (t) => {
  let creates = 0;
  const flakyModule: StagehandModule = {
    localBrowser: {
      launch: async () => ({ context: { pages: async () => [fakePage] }, close: async () => {} }),
    },
    Stagehand: {
      create: async () => {
        creates += 1;
        const mine = creates;
        return {
          extract: async () => {
            if (mine === 1) throw new Error("CDPConnectionClosedError: CDP connection closed");
            return { data: { heading: "Example Domain" } };
          },
          close: async () => {},
        };
      },
    },
  };
  const base = await startWorker(t, {
    ollamaUrl: "http://127.0.0.1:11434",
    model: "llama3.2:1b",
    loadModule: async () => flakyModule,
  });
  const response = await postExtract(base, {
    url: "https://example.com/",
    instruction: "Extract the heading",
    fields: ["heading"],
  });
  assert.equal(response.status, 200);
  const retryBody = (await response.json()) as { data: unknown };
  assert.deepEqual(retryBody.data, { heading: "Example Domain" });
  assert.equal(creates, 2);
});

test("extract schema follows the requested fields or falls back to a summary", () => {
  const withFields = buildExtractSchema(["heading", "price"]) as unknown as {
    shape: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(withFields.shape), ["heading", "price"]);
  const summary = buildExtractSchema() as unknown as { shape: Record<string, unknown> };
  assert.deepEqual(Object.keys(summary.shape), ["summary"]);
});
