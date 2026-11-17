import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalCenter,
  ApprovalError,
  type ProposalVersion,
} from "../apps/server/src/engine/approval-center.ts";
import { ApprovalExecutor } from "../apps/server/src/engine/approval-executor.ts";

// Execution binding: an approval of the exact version executes ONLY that
// version — nothing runs unapproved, nothing superseded runs, and a
// request executes at most once.

function setup() {
  let tick = 0;
  let seq = 0;
  const center = new ApprovalCenter({
    now: () => new Date(Date.UTC(2026, 10, 15, 15, 0, tick++)),
    nextId: () => `req-${++seq}`,
  });
  const executor = new ApprovalExecutor(
    center,
    () => new Date(Date.UTC(2026, 10, 15, 16, 0, tick++)),
  );
  const ran: ProposalVersion[] = [];
  const runner = (v: ProposalVersion): string => {
    ran.push(v);
    return `executed: ${v.action}`;
  };
  return { center, executor, ran, runner };
}

const v1 = {
  title: "Modify GitHub Actions workflow",
  action: "Modify GitHub Actions workflow",
  details: "Fix CI workflow permissions.",
  evidence: "CI run #92 failing on permissions",
};

test("execution is refused before any approval, and nothing runs", () => {
  const { center, executor, ran, runner } = setup();
  const req = center.create(v1);
  assert.throws(
    () => executor.execute(req.id, runner),
    (err: unknown) => err instanceof ApprovalError && err.code === "not_pending",
  );
  assert.equal(ran.length, 0);
  assert.equal(executor.executionLog().length, 0);
});

test("a message saying 'Approve this' does not unlock execution", () => {
  const { center, executor, ran, runner } = setup();
  const req = center.create(v1);
  center.postMessage(req.id, { from: "owner", text: "Approve this" });
  assert.throws(() => executor.execute(req.id, runner));
  assert.equal(ran.length, 0);
});

test("approval followed by a revision cannot execute the revised version", () => {
  const { center, executor, ran, runner } = setup();
  const req = center.create(v1);
  center.approveExactVersion(req.id, 1);
  center.revise(req.id, {
    ...v1,
    details: "Fix CI workflow permissions AND add a concurrency group.",
  });
  assert.throws(
    () => executor.execute(req.id, runner),
    (err: unknown) => err instanceof ApprovalError && err.code === "not_pending",
  );
  assert.equal(ran.length, 0);
});

test("approving the exact current version executes only that version", () => {
  const { center, executor, ran, runner } = setup();
  const req = center.create(v1);
  center.revise(req.id, {
    ...v1,
    details: "Fix CI workflow permissions AND add a concurrency group.",
  });
  center.approveExactVersion(req.id, 2);

  const record = executor.execute(req.id, runner);
  assert.equal(ran.length, 1);
  assert.equal(ran[0]?.version, 2);
  assert.equal(ran[0]?.details, "Fix CI workflow permissions AND add a concurrency group.");
  // The execution record binds to v2's number AND content hash.
  const v2 = center.getRequest(req.id).versions[1];
  assert.equal(record.version, 2);
  assert.equal(record.contentHash, v2?.contentHash);
  assert.equal(record.contentHash, center.getRequest(req.id).approvedHash);
  assert.equal(executor.executionLog().length, 1);
});

test("a request executes at most once", () => {
  const { center, executor, ran, runner } = setup();
  const req = center.create(v1);
  center.approveExactVersion(req.id, 1);
  executor.execute(req.id, runner);
  assert.throws(() => executor.execute(req.id, runner));
  assert.equal(ran.length, 1);
});

test("rejected and stopped requests never execute", () => {
  const { center, executor, ran, runner } = setup();
  const a = center.create(v1);
  center.reject(a.id);
  assert.throws(() => executor.execute(a.id, runner));

  const b = center.create(v1);
  center.approveExactVersion(b.id, 1);
  center.stopOperation(b.id);
  assert.throws(() => executor.execute(b.id, runner));
  assert.equal(ran.length, 0);
});
