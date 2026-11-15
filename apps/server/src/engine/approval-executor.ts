// Approval executor — the step the recovered engine was missing.
//
// Execution is bound to the exact approved version BY CONSTRUCTION:
// execute() refuses unless ApprovalCenter.isApproved(id) is true at the
// moment of execution, and it runs the CURRENT version's payload — which
// isApproved() guarantees is byte-identical (version number + sha256
// content hash) to the version the owner approved. Any revision between
// approval and execution flips isApproved() to false and execution is
// refused. There is no path that executes an unapproved or superseded
// version, and a request executes at most once.

import type { ApprovalCenter, ProposalVersion } from "./approval-center.ts";
import { ApprovalError } from "./approval-center.ts";

export interface ExecutionRecord {
  requestId: string;
  /** The exact version that ran — number AND content hash. */
  version: number;
  contentHash: string;
  action: string;
  details: string;
  at: string;
  result: string;
}

/** The side-effecting work, injected so tests can observe exactly what ran. */
export type ProposalRunner = (version: ProposalVersion) => string;

export class ApprovalExecutor {
  private readonly executions: ExecutionRecord[] = [];
  private readonly executedIds = new Set<string>();
  private readonly center: ApprovalCenter;
  private readonly now: () => Date;

  constructor(center: ApprovalCenter, now: () => Date = () => new Date()) {
    this.center = center;
    this.now = now;
  }

  /**
   * Run the approved proposal. Refuses (ApprovalError) when:
   *  - the request was already executed (executes at most once), or
   *  - the current version is not exactly the approved version
   *    (never approved, rejected, stopped, or revised after approval).
   * On success the runner receives the exact approved version object and
   * the run is recorded with its version number + content hash.
   */
  execute(id: string, runner: ProposalRunner): ExecutionRecord {
    if (this.executedIds.has(id)) {
      throw new ApprovalError(
        "not_pending",
        `Request ${id} was already executed; an approval executes at most once`,
      );
    }
    if (!this.center.isApproved(id)) {
      throw new ApprovalError(
        "not_pending",
        `Request ${id} has no approval covering its current version; refusing to execute`,
      );
    }
    const req = this.center.getRequest(id);
    const current = req.versions[req.versions.length - 1];
    if (!current) {
      throw new ApprovalError("empty_proposal", "Request has no versions");
    }
    // Defense in depth: isApproved() already proved this equality; assert
    // it again at the point of no return so the binding is local.
    if (req.approvedVersion !== current.version || req.approvedHash !== current.contentHash) {
      throw new ApprovalError(
        "version_mismatch",
        "Approved version does not match the current version; refusing to execute",
      );
    }
    const result = runner(current);
    const record: ExecutionRecord = {
      requestId: id,
      version: current.version,
      contentHash: current.contentHash,
      action: current.action,
      details: current.details,
      at: this.now().toISOString(),
      result,
    };
    this.executions.push(record);
    this.executedIds.add(id);
    return record;
  }

  /** Everything that has actually executed, in order. */
  executionLog(): ExecutionRecord[] {
    return [...this.executions];
  }

  /**
   * Persistence seam (production port): seed this executor with
   * execution records loaded from the durable store, so the
   * at-most-once guarantee survives a restart — a request executed
   * before the restart still refuses to execute again.
   */
  restoreRecords(records: ExecutionRecord[]): void {
    for (const record of records) {
      this.executions.push(record);
      this.executedIds.add(record.requestId);
    }
  }

  /**
   * Async variant for production runners (a merge or deploy does real
   * async work). Same binding as execute(), with claim-then-run
   * semantics — the request is claimed BEFORE the runner starts,
   * mirroring ActionService's claim, so a crash mid-run can never
   * re-execute: the claim is already recorded. The guards are identical
   * and run synchronously up front; a refusal throws before the runner
   * is ever invoked.
   */
  async executeAsync(
    id: string,
    runner: (version: ProposalVersion) => Promise<string>,
  ): Promise<ExecutionRecord> {
    if (this.executedIds.has(id)) {
      throw new ApprovalError(
        "not_pending",
        `Request ${id} was already executed; an approval executes at most once`,
      );
    }
    if (!this.center.isApproved(id)) {
      throw new ApprovalError(
        "not_pending",
        `Request ${id} has no approval covering its current version; refusing to execute`,
      );
    }
    const req = this.center.getRequest(id);
    const current = req.versions[req.versions.length - 1];
    if (!current) {
      throw new ApprovalError("empty_proposal", "Request has no versions");
    }
    // Defense in depth: isApproved() already proved this equality; assert
    // it again at the point of no return so the binding is local.
    if (req.approvedVersion !== current.version || req.approvedHash !== current.contentHash) {
      throw new ApprovalError(
        "version_mismatch",
        "Approved version does not match the current version; refusing to execute",
      );
    }
    // Claim first (at-most-once), then run.
    this.executedIds.add(id);
    const result = await runner(current);
    const record: ExecutionRecord = {
      requestId: id,
      version: current.version,
      contentHash: current.contentHash,
      action: current.action,
      details: current.details,
      at: this.now().toISOString(),
      result,
    };
    this.executions.push(record);
    return record;
  }
}
