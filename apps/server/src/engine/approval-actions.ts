import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { providerFailure } from "../log.ts";
import {
  ApprovalCenter,
  type ApprovalControl,
  ApprovalError,
  type ApprovalRequest,
  type DiscussionMessage,
  type ProposalVersion,
} from "./approval-center.ts";
import { ApprovalExecutor, type ExecutionRecord } from "./approval-executor.ts";

// Approval Center — the production gate (Owner Interaction Layer,
// PRODUCTION-PATCH-SPEC). The engine (approval-center.ts) and executor
// (approval-executor.ts) stay pure and in-memory; this gate owns
// durability and the restricted-action call sites:
//
// - Every operation rehydrates a fresh ApprovalCenter from the Store
//   (kind "approvals"), applies exactly one engine operation, and
//   persists the record back. The Store is the source of truth, so a
//   restart loses nothing and no in-memory copy can diverge.
// - Execution records live under kind "approval-executions" and seed
//   the executor on every execute, so at-most-once survives restarts.
//   An execution is CLAIMED in the store before its runner starts
//   (state "claimed") and the same record is completed when the runner
//   returns — a crash mid-run leaves the claim behind, so the action
//   can never run twice and the interrupted run stays visible to the
//   owner instead of vanishing.
// - MERGE and DEPLOY are the first restricted actions routed through
//   the executor: an execute call for any other action kind refuses —
//   everything else keeps its current path, per the port's scope.
//   A restricted action runs ONLY through ApprovalExecutor, with the
//   runner resolved per action kind (injected by the service; the
//   service's default dispatches an agent task carrying the exact
//   approved version's text — the app's execution channel).

export const APPROVAL_REQUEST_KIND = "approvals";
export const APPROVAL_EXECUTION_KIND = "approval-executions";

/** The restricted actions with executor call sites in this port. */
export const RESTRICTED_APPROVAL_ACTIONS = ["merge", "deploy"] as const;
export type RestrictedApprovalAction = (typeof RESTRICTED_APPROVAL_ACTIONS)[number];

/** The side-effecting implementation of one restricted action. */
export type ApprovalActionRunner = (owner: string, version: ProposalVersion) => Promise<string>;
export type ApprovalActionRunners = Partial<Record<RestrictedApprovalAction, ApprovalActionRunner>>;

export function restrictedActionFor(action: string): RestrictedApprovalAction | null {
  return (RESTRICTED_APPROVAL_ACTIONS as readonly string[]).includes(action)
    ? (action as RestrictedApprovalAction)
    : null;
}

/** Engine refusals become HTTP-shaped errors at the gate boundary. */
export function approvalAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ApprovalError) {
    const status = error.code === "not_found" ? 404 : error.code === "empty_proposal" ? 422 : 409;
    return new AppError(error.message, status);
  }
  // Anything else is an internal failure (store, runner, provider).
  // The full detail is logged server-side and NEVER reaches the
  // client: raw internal or upstream error text is not client-facing
  // wording, so the response carries one generic human message.
  providerFailure("approval operation", error);
  return new AppError("Something went wrong running that approval — it's logged.", 500);
}

type StoredExecution = ExecutionRecord & { id: string };

export class ApprovalGate {
  private readonly db: Store;
  private readonly runners: ApprovalActionRunners;
  private readonly fallbackRunner: ApprovalActionRunner;

  constructor(db: Store, runners: ApprovalActionRunners, fallbackRunner: ApprovalActionRunner) {
    this.db = db;
    this.runners = runners;
    this.fallbackRunner = fallbackRunner;
  }

  private async loadCenter(owner: string): Promise<ApprovalCenter> {
    const center = new ApprovalCenter();
    const records = await this.db.list<ApprovalRequest>(owner, APPROVAL_REQUEST_KIND);
    for (const record of records) center.restoreRequest(record);
    return center;
  }

  private async loadExecutor(owner: string, center: ApprovalCenter): Promise<ApprovalExecutor> {
    const executor = new ApprovalExecutor(center);
    const stored = await this.db.list<StoredExecution>(owner, APPROVAL_EXECUTION_KIND);
    executor.restoreRecords(
      stored.map((record) => ({
        requestId: record.requestId,
        version: record.version,
        contentHash: record.contentHash,
        action: record.action,
        details: record.details,
        at: record.at,
        result: record.result,
        state: record.state,
      })),
    );
    return executor;
  }

  private async persist(owner: string, request: ApprovalRequest): Promise<ApprovalRequest> {
    await this.db.put(owner, APPROVAL_REQUEST_KIND, request);
    return request;
  }

  async create(
    owner: string,
    input: { title: string; action: string; details: string; evidence?: string },
  ): Promise<ApprovalRequest> {
    try {
      const center = await this.loadCenter(owner);
      return await this.persist(owner, center.create(input));
    } catch (error) {
      throw approvalAppError(error);
    }
  }

  /** The card: full request record plus everything that actually ran. */
  async get(
    owner: string,
    id: string,
  ): Promise<{ request: ApprovalRequest; executions: ExecutionRecord[] }> {
    try {
      const center = await this.loadCenter(owner);
      const request = center.getRequest(id);
      const executor = await this.loadExecutor(owner, center);
      return {
        request,
        executions: executor.executionLog().filter((record) => record.requestId === id),
      };
    } catch (error) {
      throw approvalAppError(error);
    }
  }

  /** Every request for this owner, newest activity first (the client's list). */
  async list(owner: string): Promise<ApprovalRequest[]> {
    const records = await this.db.list<ApprovalRequest>(owner, APPROVAL_REQUEST_KIND);
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Talk to Arthur: discussion only — never approval state. */
  async postMessage(
    owner: string,
    id: string,
    input: { from: string; text: string },
  ): Promise<{ message: DiscussionMessage; request: ApprovalRequest }> {
    try {
      const center = await this.loadCenter(owner);
      const message = center.postMessage(id, input);
      const request = await this.persist(owner, center.getRequest(id));
      return { message, request };
    } catch (error) {
      throw approvalAppError(error);
    }
  }

  /** A revision always appends a version and voids any prior approval. */
  async revise(
    owner: string,
    id: string,
    input: { action: string; details: string; evidence?: string },
  ): Promise<ApprovalRequest> {
    try {
      const center = await this.loadCenter(owner);
      return await this.persist(owner, center.revise(id, input));
    } catch (error) {
      throw approvalAppError(error);
    }
  }

  /** The five controls; approve_exact_version is the only approval path. */
  async control(
    owner: string,
    id: string,
    control: ApprovalControl,
    opts?: { version?: number; note?: string },
  ): Promise<ApprovalRequest> {
    try {
      const center = await this.loadCenter(owner);
      return await this.persist(owner, center.applyControl(id, control, opts));
    } catch (error) {
      throw approvalAppError(error);
    }
  }

  /**
   * Execute a restricted action (merge / deploy) through the executor.
   * Refuses — before any runner is invoked — when the current version's
   * action has no call site here, or when no exact-version approval
   * covers the current version (never approved, message-only
   * "approval", or revised after approval).
   */
  async execute(owner: string, id: string): Promise<ExecutionRecord> {
    const center = await this.loadCenter(owner);
    let request: ApprovalRequest;
    try {
      request = center.getRequest(id);
    } catch (error) {
      throw approvalAppError(error);
    }
    const current = request.versions[request.versions.length - 1];
    if (!current) throw new AppError("Request has no versions", 422);
    const kind = restrictedActionFor(current.action);
    if (!kind) {
      throw new AppError(
        `"${current.action}" has no restricted-action call site in this port ` +
          `(only ${RESTRICTED_APPROVAL_ACTIONS.join(" and ")} route through the approval executor)`,
        409,
      );
    }
    const runner = this.runners[kind] ?? this.fallbackRunner;
    const executor = await this.loadExecutor(owner, center);
    let record: ExecutionRecord;
    try {
      record = await executor.executeAsync(id, (version) => runner(owner, version), {
        // Claim-before-run: the claimed execution record is durable
        // BEFORE the runner starts. If the process dies mid-run, the
        // claim is what a restart restores — it blocks any second
        // execution and shows up as the interrupted run, instead of
        // the execution vanishing and the action running twice. If
        // the claim cannot be persisted, the runner never runs.
        onClaim: async (claim) => {
          await this.db.put(owner, APPROVAL_EXECUTION_KIND, { ...claim, id: claim.requestId });
        },
      });
    } catch (error) {
      throw approvalAppError(error);
    }
    await this.db.put(owner, APPROVAL_EXECUTION_KIND, { ...record, id: record.requestId });
    return record;
  }
}
