import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  type ApprovalActionRunner,
  ApprovalGate,
} from "../apps/server/src/engine/approval-actions.ts";
import type { ProposalVersion } from "../apps/server/src/engine/approval-center.ts";
import { AppError } from "../apps/server/src/errors.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

// Approval Center production gate (engine/approval-actions.ts): the
// merge + deploy call sites. A restricted action runs ONLY through the
// executor, ONLY on an exact-version approval — a message is not an
// approval, a stale approval is not an approval — and at most once,
// even across a restart (fresh gate instances over the same store).

const mergeV1 = {
  title: "Merge PR #52",
  action: "merge",
  details: "Merge PR #52 (Supabase egress fix) into main.",
  evidence: "PR #52 gate: biome/typecheck/tests pass",
};
const deployV1 = {
  title: "Deploy open-arthur",
  action: "deploy",
  details: "Deploy the open-arthur service from main cc5bfa7.",
};

function spyRunners() {
  const calls: { kind: string; version: ProposalVersion }[] = [];
  const make =
    (kind: string): ApprovalActionRunner =>
    async (_owner, version) => {
      calls.push({ kind, version });
      return `${kind} executed: ${version.details}`;
    };
  return { calls, runners: { merge: make("merge"), deploy: make("deploy") } };
}

const isConflict = (error: unknown) => error instanceof AppError && error.status === 409;

test("a merge with only a message saying 'Approve this' refuses to execute", async () => {
  const db = await createStore();
  try {
    const { calls, runners } = spyRunners();
    const gate = new ApprovalGate(db, runners, async () => "fallback ran");
    const req = await gate.create("owner", mergeV1);
    await gate.postMessage("owner", req.id, { from: "owner", text: "Approve this" });
    await assert.rejects(() => gate.execute("owner", req.id), isConflict);
    assert.equal(calls.length, 0);
    const { executions } = await gate.get("owner", req.id);
    assert.equal(executions.length, 0);
  } finally {
    await db.close();
  }
});

test("a merge approved then revised refuses to execute the stale approval", async () => {
  const db = await createStore();
  try {
    const { calls, runners } = spyRunners();
    const gate = new ApprovalGate(db, runners, async () => "fallback ran");
    const req = await gate.create("owner", mergeV1);
    await gate.control("owner", req.id, "approve_exact_version", { version: 1 });
    await gate.revise("owner", req.id, {
      action: "merge",
      details: "Merge PR #52 AND PR #51 into main.",
      evidence: "scope widened by owner request",
    });
    await assert.rejects(() => gate.execute("owner", req.id), isConflict);
    assert.equal(calls.length, 0);
  } finally {
    await db.close();
  }
});

test("approving a superseded version is refused at the control surface", async () => {
  const db = await createStore();
  try {
    const { runners } = spyRunners();
    const gate = new ApprovalGate(db, runners, async () => "fallback ran");
    const req = await gate.create("owner", deployV1);
    await gate.revise("owner", req.id, { ...deployV1, details: "Deploy from main 4ad2670." });
    await assert.rejects(
      () => gate.control("owner", req.id, "approve_exact_version", { version: 1 }),
      isConflict,
    );
    const { request } = await gate.get("owner", req.id);
    assert.equal(request.status, "pending");
    assert.equal(request.approvedVersion, null);
  } finally {
    await db.close();
  }
});

test("a deploy approved at its exact version executes once, with that exact version", async () => {
  const db = await createStore();
  try {
    const { calls, runners } = spyRunners();
    const gate = new ApprovalGate(db, runners, async () => "fallback ran");
    const req = await gate.create("owner", deployV1);
    const revised = await gate.revise("owner", req.id, {
      ...deployV1,
      details: "Deploy the open-arthur service from main 4ad2670.",
    });
    const v2 = revised.versions[1];
    assert.ok(v2);
    await gate.control("owner", req.id, "approve_exact_version", { version: 2 });

    const record = await gate.execute("owner", req.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.kind, "deploy");
    assert.equal(calls[0]?.version.version, 2);
    assert.equal(calls[0]?.version.details, "Deploy the open-arthur service from main 4ad2670.");
    // The execution record binds to v2's number AND content hash.
    assert.equal(record.version, 2);
    assert.equal(record.contentHash, v2.contentHash);

    // At most once: a second execute refuses and the runner never runs again.
    await assert.rejects(() => gate.execute("owner", req.id), isConflict);
    assert.equal(calls.length, 1);
    const { executions } = await gate.get("owner", req.id);
    assert.equal(executions.length, 1);
  } finally {
    await db.close();
  }
});

test("approvals and the at-most-once claim survive a restart (fresh gate, same store)", async () => {
  const db = await createStore();
  try {
    const first = spyRunners();
    const gateA = new ApprovalGate(db, first.runners, async () => "fallback ran");
    const req = await gateA.create("owner", mergeV1);
    await gateA.control("owner", req.id, "approve_exact_version", { version: 1 });

    // Simulated restart: a brand-new gate over the same store still
    // sees the approval and executes the exact approved version.
    const second = spyRunners();
    const gateB = new ApprovalGate(db, second.runners, async () => "fallback ran");
    const record = await gateB.execute("owner", req.id);
    assert.equal(record.version, 1);
    assert.equal(second.calls.length, 1);

    // And a third instance still cannot execute it again.
    const third = spyRunners();
    const gateC = new ApprovalGate(db, third.runners, async () => "fallback ran");
    await assert.rejects(() => gateC.execute("owner", req.id), isConflict);
    assert.equal(third.calls.length, 0);
  } finally {
    await db.close();
  }
});

test("an action without a call site in this port refuses, even when approved", async () => {
  const db = await createStore();
  try {
    const { calls, runners } = spyRunners();
    const gate = new ApprovalGate(db, runners, async () => "fallback ran");
    const req = await gate.create("owner", {
      title: "Buy a domain",
      action: "spend",
      details: "Buy a domain for $12.",
    });
    await gate.control("owner", req.id, "approve_exact_version", { version: 1 });
    await assert.rejects(() => gate.execute("owner", req.id), isConflict);
    assert.equal(calls.length, 0);
  } finally {
    await db.close();
  }
});

// --- HTTP surface: the six routes over a real app (sample mode) ---

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = (path: string, body?: unknown) =>
  server.app.request(`/api/agent${path}`, {
    headers: headers(),
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
async function read<T>(path: string, body: unknown, status: number): Promise<T> {
  const response = await request(path, body);
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<T>;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-approvals-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("routes: message cannot approve, exact-version control can, execute dispatches once", async () => {
  const created = await read<{ id: string; status: string }>("/approvals", mergeV1, 201);
  assert.equal(created.status, "pending");

  await read(`/approvals/${created.id}/messages`, { from: "owner", text: "Approve this" }, 201);
  // A message is not an approval: execution still refuses.
  const refused = await request(`/approvals/${created.id}/execute`, {});
  assert.equal(refused.status, 409);

  const approved = await read<{ status: string; approvedVersion: number }>(
    `/approvals/${created.id}/control`,
    { control: "approve_exact_version", version: 1 },
    200,
  );
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedVersion, 1);

  // The default runner dispatches an agent task with the exact
  // approved version's text — the merge call site, end to end.
  const record = await read<{ version: number; result: string }>(
    `/approvals/${created.id}/execute`,
    {},
    200,
  );
  assert.equal(record.version, 1);
  assert.match(record.result, /^dispatched as task /);
  const tasks = await db.list<AgentTask>("local-user", "tasks");
  const dispatched = tasks.find((task) => record.result.endsWith(task.id));
  assert.ok(dispatched);
  assert.match(dispatched.prompt, /Merge PR #52 \(Supabase egress fix\) into main\./);

  const view = await read<{ executions: unknown[] }>(`/approvals/${created.id}`, undefined, 200);
  assert.equal(view.executions.length, 1);
  const again = await request(`/approvals/${created.id}/execute`, {});
  assert.equal(again.status, 409);
});
