import type {
  ApprovalControl,
  ApprovalExecution,
  ApprovalRequest,
  ProposalVersion,
} from "../../../packages/domain/src/agent";

// Approval Center client state + transport.
//
// Route discipline (Owner Interaction Layer): this module is the ONLY
// place the client builds /api/agent/approvals paths, and the two
// write surfaces are separate functions over separate paths —
// postApprovalMessage can only ever reach the messages route, and
// approval state can only change through sendApprovalControl (the
// control route) or executeApproval (the execute route). A message is
// never an approval, whatever its text says; the server enforces the
// same split, and the client mirrors it structurally instead of
// relying on wording.

export interface ApprovalTransport {
  request<T>(path: string, body?: unknown, method?: string): Promise<T>;
}

export const approvalsListPath = "/api/agent/approvals";
export function approvalPath(id: string): string {
  return `/api/agent/approvals/${id}`;
}
export function approvalMessagesPath(id: string): string {
  return `${approvalPath(id)}/messages`;
}
export function approvalControlPath(id: string): string {
  return `${approvalPath(id)}/control`;
}
export function approvalExecutePath(id: string): string {
  return `${approvalPath(id)}/execute`;
}

export async function fetchApprovals(transport: ApprovalTransport): Promise<ApprovalRequest[]> {
  return transport.request<ApprovalRequest[]>(approvalsListPath);
}

export async function fetchApproval(
  transport: ApprovalTransport,
  id: string,
): Promise<{ request: ApprovalRequest; executions: ApprovalExecution[] }> {
  return transport.request<{ request: ApprovalRequest; executions: ApprovalExecution[] }>(
    approvalPath(id),
  );
}

/** Talk to Arthur: discussion only. This function has no path to approval state. */
export async function postApprovalMessage(
  transport: ApprovalTransport,
  id: string,
  text: string,
): Promise<{ message: unknown; request: ApprovalRequest }> {
  return transport.request(approvalMessagesPath(id), { from: "owner", text });
}

/** The five owner controls — the ONLY client path that can change approval state. */
export async function sendApprovalControl(
  transport: ApprovalTransport,
  id: string,
  control: ApprovalControl,
  opts?: { version?: number; note?: string },
): Promise<ApprovalRequest> {
  return transport.request<ApprovalRequest>(approvalControlPath(id), { control, ...opts });
}

/** Run an approved restricted action through the executor (at most once, server-side). */
export async function executeApproval(
  transport: ApprovalTransport,
  id: string,
): Promise<ApprovalExecution> {
  return transport.request<ApprovalExecution>(approvalExecutePath(id), {});
}

// --- Pure state helpers (what the screen renders) ---

export function currentVersion(request: ApprovalRequest): ProposalVersion {
  const version = request.versions[request.versions.length - 1];
  if (!version) throw new Error("Approval request has no versions");
  return version;
}

export function isTerminal(request: ApprovalRequest): boolean {
  return request.status === "rejected" || request.status === "stopped";
}

/** Discussion stays open in every non-terminal state; terminal requests are read-only. */
export function canDiscuss(request: ApprovalRequest): boolean {
  return !isTerminal(request);
}

/** True only while the approval on record covers the CURRENT version (number + hash). */
export function approvalCoversCurrent(request: ApprovalRequest): boolean {
  if (request.approvedVersion === null || request.approvedHash === null) return false;
  const version = currentVersion(request);
  return (
    request.approvedVersion === version.version && request.approvedHash === version.contentHash
  );
}

/**
 * A stale approval: an approval exists on record but no longer covers
 * the current version (Arthur revised after approval). The engine
 * voids approvals on revise, so this state should not arrive from the
 * server — but a client holding an older copy must never render it as
 * approved, so the screen checks instead of trusting its copy.
 */
export function staleApproval(request: ApprovalRequest): boolean {
  return request.approvedVersion !== null && !approvalCoversCurrent(request);
}

/** The controls the owner may use in the request's current state. */
export function visibleControls(request: ApprovalRequest): ApprovalControl[] {
  switch (request.status) {
    case "pending":
      return [
        "approve_exact_version",
        "request_changes",
        "keep_pending",
        "reject",
        "stop_operation",
      ];
    case "changes_requested":
      return ["approve_exact_version", "keep_pending", "reject", "stop_operation"];
    case "approved":
      // Approved and not yet run: the remaining decision is to stop it.
      // Running it is the separate Execute action (see canExecute).
      return ["stop_operation"];
    default:
      return [];
  }
}

/** Execute is offered only for an approved request whose approval covers the current version. */
export function canExecute(request: ApprovalRequest, executions: ApprovalExecution[]): boolean {
  if (request.status !== "approved" || !approvalCoversCurrent(request)) return false;
  const version = currentVersion(request);
  return !executions.some((record) => record.version === version.version);
}

/** The execution record for the current version, if it already ran. */
export function currentExecution(
  request: ApprovalRequest,
  executions: ApprovalExecution[],
): ApprovalExecution | undefined {
  const version = currentVersion(request);
  return executions.find((record) => record.version === version.version);
}

/** Short form of a version's content hash, for the card. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
