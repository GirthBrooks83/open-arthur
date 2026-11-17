import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import type { ApprovalRequest, ProposalVersion } from "../../../packages/domain/src/agent";
import {
  type ApprovalTransport,
  approvalCoversCurrent,
  canDiscuss,
  canExecute,
  currentVersion,
  executeApproval,
  fetchApprovals,
  postApprovalMessage,
  sendApprovalControl,
  staleApproval,
  visibleControls,
} from "../src/approval-state.ts";

// Approvals client: the card's state logic, and the structural proof
// that the Talk to Arthur composer can never change approval state —
// the message function reaches only the messages route, and the
// screen source never names a state-changing path at all.

function version(n: number, hash: string): ProposalVersion {
  return {
    version: n,
    action: "merge",
    details: `Details for v${n}`,
    contentHash: hash,
    createdAt: "2026-11-15T00:00:00.000Z",
    createdBy: "arthur",
  };
}
function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    title: "Merge PR #52",
    status: "pending",
    versions: [version(1, "hash-v1")],
    discussion: [],
    audit: [],
    approvedVersion: null,
    approvedHash: null,
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
    ...overrides,
  };
}

test("current version is the last version; a fresh request has no approval", () => {
  const req = request({ versions: [version(1, "hash-v1"), version(2, "hash-v2")] });
  assert.equal(currentVersion(req).version, 2);
  assert.equal(approvalCoversCurrent(req), false);
  assert.equal(staleApproval(req), false);
  assert.equal(canExecute(req, []), false);
});

test("an approval covers only the exact version it named (number + hash)", () => {
  const approved = request({ status: "approved", approvedVersion: 1, approvedHash: "hash-v1" });
  assert.equal(approvalCoversCurrent(approved), true);
  assert.equal(staleApproval(approved), false);
  assert.equal(canExecute(approved, []), true);
  // Same version number, different content: not covered.
  const tampered = request({ status: "approved", approvedVersion: 1, approvedHash: "hash-other" });
  assert.equal(approvalCoversCurrent(tampered), false);
  assert.equal(canExecute(tampered, []), false);
});

test("a revision after approval makes the held approval stale, never executable", () => {
  const revised = request({
    status: "approved",
    approvedVersion: 1,
    approvedHash: "hash-v1",
    versions: [version(1, "hash-v1"), version(2, "hash-v2")],
  });
  assert.equal(staleApproval(revised), true);
  assert.equal(approvalCoversCurrent(revised), false);
  assert.equal(canExecute(revised, []), false);
});

test("an executed version cannot be executed again from the client", () => {
  const approved = request({ status: "approved", approvedVersion: 1, approvedHash: "hash-v1" });
  const executions = [
    {
      requestId: "req-1",
      version: 1,
      contentHash: "hash-v1",
      action: "merge",
      details: "Details for v1",
      at: "2026-11-15T01:00:00.000Z",
      result: "done",
    },
  ];
  assert.equal(canExecute(approved, executions), false);
});

test("controls follow the request state; discussion closes only at terminal states", () => {
  assert.deepEqual(visibleControls(request({ status: "pending" })), [
    "approve_exact_version",
    "request_changes",
    "keep_pending",
    "reject",
    "stop_operation",
  ]);
  assert.deepEqual(visibleControls(request({ status: "changes_requested" })), [
    "approve_exact_version",
    "keep_pending",
    "reject",
    "stop_operation",
  ]);
  assert.deepEqual(visibleControls(request({ status: "approved" })), ["stop_operation"]);
  assert.deepEqual(visibleControls(request({ status: "rejected" })), []);
  assert.deepEqual(visibleControls(request({ status: "stopped" })), []);
  assert.equal(canDiscuss(request({ status: "pending" })), true);
  assert.equal(canDiscuss(request({ status: "approved" })), true);
  assert.equal(canDiscuss(request({ status: "rejected" })), false);
  assert.equal(canDiscuss(request({ status: "stopped" })), false);
});

class Recorder implements ApprovalTransport {
  readonly calls: { path: string; body?: unknown }[] = [];
  async request<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ path, body });
    return {} as T;
  }
}

test("posting a message — even 'Approve this' — reaches only the messages route", async () => {
  const recorder = new Recorder();
  await postApprovalMessage(recorder, "req-1", "Approve this");
  await postApprovalMessage(recorder, "req-1", "Yes, do it, I approve, ship it");
  assert.deepEqual(
    recorder.calls.map((call) => call.path),
    ["/api/agent/approvals/req-1/messages", "/api/agent/approvals/req-1/messages"],
  );
  assert.ok(
    recorder.calls.every(
      (call) => !call.path.endsWith("/control") && !call.path.endsWith("/execute"),
    ),
  );
  assert.deepEqual(recorder.calls[0]?.body, { from: "owner", text: "Approve this" });
});

test("state changes go only through the control and execute routes", async () => {
  const recorder = new Recorder();
  await sendApprovalControl(recorder, "req-1", "approve_exact_version", { version: 2 });
  await executeApproval(recorder, "req-1");
  await fetchApprovals(recorder);
  assert.deepEqual(
    recorder.calls.map((call) => call.path),
    [
      "/api/agent/approvals/req-1/control",
      "/api/agent/approvals/req-1/execute",
      "/api/agent/approvals",
    ],
  );
  assert.deepEqual(recorder.calls[0]?.body, { control: "approve_exact_version", version: 2 });
});

test("the screen source never names a state-changing path itself", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../src/approvals.tsx", import.meta.url)),
    "utf8",
  );
  // All approval paths are built in approval-state.ts; the screen
  // imports the intent-named functions and cannot spell /control,
  // /execute or /messages on its own.
  assert.ok(source.includes("postApprovalMessage"));
  assert.ok(source.includes("sendApprovalControl"));
  for (const fragment of ["/control", "/execute", "/messages", "/api/agent/approvals"]) {
    assert.ok(!source.includes(fragment), `approvals.tsx must not contain ${fragment}`);
  }
});
