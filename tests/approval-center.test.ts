import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalCenter, ApprovalError } from "../apps/server/src/engine/approval-center.ts";

// Owner Interaction Layer / Approval Center lab slice. The two proofs
// the spec demands: (1) a changed proposal invalidates a prior
// approval — approval is version-exact; (2) a pending approval never
// blocks an incoming message, and a message never approves anything.

function center() {
  let tick = 0;
  let seq = 0;
  return new ApprovalCenter({
    now: () => new Date(Date.UTC(2026, 10, 15, 14, 0, tick++)),
    nextId: () => `req-${++seq}`,
  });
}

const v1 = {
  title: "Modify GitHub Actions workflow",
  action: "Modify GitHub Actions workflow",
  details: "Fix CI workflow permissions.",
  evidence: "CI run #92 failing on permissions",
};

test("a changed proposal invalidates a prior approval", () => {
  const c = center();
  const req = c.create(v1);
  c.approveExactVersion(req.id, 1);
  assert.equal(c.isApproved(req.id), true);

  const revised = c.revise(req.id, {
    action: "Modify GitHub Actions workflow",
    details: "Fix CI workflow permissions AND add a concurrency group.",
    evidence: "CI run #92 failing on permissions",
  });
  assert.equal(revised.versions.length, 2);
  assert.equal(revised.status, "pending");
  assert.equal(revised.approvedVersion, null);
  // The v1 approval does not carry to v2.
  assert.equal(c.isApproved(req.id), false);
});

test("approving a superseded version is refused, not silently applied", () => {
  const c = center();
  const req = c.create(v1);
  c.revise(req.id, { ...v1, details: "Different details entirely." });
  assert.throws(
    () => c.approveExactVersion(req.id, 1),
    (err: unknown) => err instanceof ApprovalError && err.code === "version_mismatch",
  );
  assert.equal(c.isApproved(req.id), false);
  // Approving the exact current version works.
  c.approveExactVersion(req.id, 2);
  assert.equal(c.isApproved(req.id), true);
  assert.equal(c.getRequest(req.id).approvedVersion, 2);
});

test("a pending approval never blocks an incoming message", () => {
  const c = center();
  const req = c.create(v1);
  assert.equal(req.status, "pending");

  const msg = c.postMessage(req.id, {
    from: "owner",
    text: "Why is this change necessary?",
  });
  assert.equal(msg.version, 1);
  const after = c.getRequest(req.id);
  assert.equal(after.discussion.length, 1);
  assert.equal(after.status, "pending");
});

test("a message is never an approval, even one that says 'Approve this'", () => {
  const c = center();
  const req = c.create(v1);
  c.postMessage(req.id, { from: "owner", text: "Approve this" });
  c.postMessage(req.id, { from: "owner", text: "Looks good, go ahead" });
  assert.equal(c.isApproved(req.id), false);
  assert.equal(c.getRequest(req.id).status, "pending");
  assert.equal(c.getRequest(req.id).approvedVersion, null);
});

test("discussion stays live across a revision and history is preserved", () => {
  const c = center();
  const req = c.create(v1);
  c.postMessage(req.id, { from: "owner", text: "Can you revise it first?" });
  c.revise(req.id, { ...v1, details: "Revised details." });
  // Still free to talk while v2 is pending.
  c.postMessage(req.id, { from: "arthur", text: "New version ready for review." });

  const history = c.auditHistory(req.id);
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[0]?.details, v1.details);
  assert.equal(history.discussion.length, 2);
  assert.deepEqual(
    history.audit.map((e) => e.kind),
    ["created", "message", "version_created", "message"],
  );
});

test("the five controls all work through applyControl", () => {
  const c = center();

  const a = c.create(v1);
  c.applyControl(a.id, "keep_pending");
  assert.equal(c.getRequest(a.id).status, "pending");
  c.applyControl(a.id, "request_changes", { note: "Show more evidence" });
  assert.equal(c.getRequest(a.id).status, "changes_requested");
  c.applyControl(a.id, "approve_exact_version", { version: 1 });
  assert.equal(c.isApproved(a.id), true);

  const b = c.create(v1);
  c.applyControl(b.id, "reject");
  assert.equal(c.getRequest(b.id).status, "rejected");
  assert.equal(c.isApproved(b.id), false);

  const d = c.create(v1);
  c.applyControl(d.id, "stop_operation");
  assert.equal(c.getRequest(d.id).status, "stopped");
  // A stopped request's discussion is closed.
  assert.throws(() => c.postMessage(d.id, { from: "owner", text: "hello" }));
});

test("approve control without a version number is refused", () => {
  const c = center();
  const req = c.create(v1);
  assert.throws(
    () => c.applyControl(req.id, "approve_exact_version"),
    (err: unknown) => err instanceof ApprovalError && err.code === "version_mismatch",
  );
  assert.equal(c.isApproved(req.id), false);
});
