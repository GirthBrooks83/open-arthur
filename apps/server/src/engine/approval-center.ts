// Arthur Approval Center — version-exact owner approvals with a live
// conversation channel (Owner Interaction Layer requirement, adopted
// 2026-11-14; Intelligence & Autonomy Upgrade piece 2/3, 2026-11-15).
//
// The non-negotiables this module enforces BY CONSTRUCTION, not by UI
// convention:
//
// 1. Approval is version-exact. An approval records the version number
//    AND a content hash of the proposal it covered. Approving version N
//    can never authorize version N+1: any change to the proposal creates
//    a NEW version and voids every earlier approval.
// 2. Messaging never approves anything. The message channel is a
//    separate method with no path to approval state — a message whose
//    text literally reads "Approve this" is discussion, not approval.
//    Only the explicit approveExactVersion control approves, and only
//    the exact current version.
// 3. A pending approval never blocks communication. postMessage is
//    accepted in every non-terminal state, including while an approval
//    is pending — the owner can question, redirect, or discuss
//    unrelated things without dismissing the request.
// 4. Nothing is forgotten. Every version and every audit entry
//    (creations, revisions, messages, decisions) is retained for the
//    life of the request; revising a proposal appends, never rewrites.
//
// Production port (2026-11-15): the engine itself stays in-memory and
// pure; durability lives in engine/approval-actions.ts, which
// rehydrates a center from the Store on every call (restoreRequest),
// applies one operation, and persists the record back — so the Store
// is always the source of truth and a restart loses nothing.

import { createHash, randomUUID } from "node:crypto";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "changes_requested" | "stopped";

/** The five owner controls from the Approval Center spec. */
export type ApprovalControl =
  | "approve_exact_version"
  | "reject"
  | "request_changes"
  | "keep_pending"
  | "stop_operation";

export interface ProposalVersion {
  version: number;
  action: string;
  details: string;
  evidence?: string;
  /** sha256 of action + details + evidence — what an approval binds to. */
  contentHash: string;
  createdAt: string;
  createdBy: string;
}

export interface DiscussionMessage {
  at: string;
  from: string;
  text: string;
  /** The version under discussion when the message arrived. */
  version: number;
}

export type AuditEntryKind =
  | "created"
  | "version_created"
  | "message"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "kept_pending"
  | "stopped";

export interface AuditEntry {
  at: string;
  kind: AuditEntryKind;
  actor: string;
  version: number;
  note?: string;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  status: ApprovalStatus;
  versions: ProposalVersion[];
  discussion: DiscussionMessage[];
  audit: AuditEntry[];
  /** Version an approval currently covers, or null. Never implicit. */
  approvedVersion: number | null;
  approvedHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ApprovalError extends Error {
  readonly code: "not_found" | "version_mismatch" | "not_pending" | "empty_proposal";
  constructor(code: ApprovalError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function contentHash(action: string, details: string, evidence?: string): string {
  return createHash("sha256")
    .update(`${action}\n${details}\n${evidence ?? ""}`)
    .digest("hex");
}

const TERMINAL: ReadonlySet<ApprovalStatus> = new Set(["rejected", "stopped"]);

export class ApprovalCenter {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly now: () => Date;
  private readonly nextId: () => string;

  constructor(opts?: { now?: () => Date; nextId?: () => string }) {
    this.now = opts?.now ?? (() => new Date());
    this.nextId = opts?.nextId ?? (() => randomUUID());
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private get(id: string): ApprovalRequest {
    const req = this.requests.get(id);
    if (!req) throw new ApprovalError("not_found", `No approval request ${id}`);
    return req;
  }

  private current(req: ApprovalRequest): ProposalVersion {
    const v = req.versions[req.versions.length - 1];
    if (!v) throw new ApprovalError("empty_proposal", "Request has no versions");
    return v;
  }

  private record(req: ApprovalRequest, entry: Omit<AuditEntry, "at">): void {
    req.audit.push({ ...entry, at: this.stamp() });
    req.updatedAt = this.stamp();
  }

  /** Create a request at version 1, status pending. */
  create(input: {
    title: string;
    action: string;
    details: string;
    evidence?: string;
    createdBy?: string;
  }): ApprovalRequest {
    if (!input.action.trim() || !input.details.trim()) {
      throw new ApprovalError("empty_proposal", "A proposal needs an action and details");
    }
    const at = this.stamp();
    const version: ProposalVersion = {
      version: 1,
      action: input.action,
      details: input.details,
      evidence: input.evidence,
      contentHash: contentHash(input.action, input.details, input.evidence),
      createdAt: at,
      createdBy: input.createdBy ?? "arthur",
    };
    const req: ApprovalRequest = {
      id: this.nextId(),
      title: input.title,
      status: "pending",
      versions: [version],
      discussion: [],
      audit: [],
      approvedVersion: null,
      approvedHash: null,
      createdAt: at,
      updatedAt: at,
    };
    this.requests.set(req.id, req);
    this.record(req, {
      kind: "created",
      actor: version.createdBy,
      version: 1,
    });
    return req;
  }

  /**
   * Revise a proposal. ALWAYS creates a new version and voids any prior
   * approval — even an approval of the immediately preceding version.
   * The old versions and the full discussion stay in the record.
   */
  revise(
    id: string,
    input: { action: string; details: string; evidence?: string },
    actor = "arthur",
  ): ApprovalRequest {
    const req = this.get(id);
    if (TERMINAL.has(req.status)) {
      throw new ApprovalError("not_pending", `Request is ${req.status}; it cannot be revised`);
    }
    if (!input.action.trim() || !input.details.trim()) {
      throw new ApprovalError("empty_proposal", "A proposal needs an action and details");
    }
    const next: ProposalVersion = {
      version: this.current(req).version + 1,
      action: input.action,
      details: input.details,
      evidence: input.evidence,
      contentHash: contentHash(input.action, input.details, input.evidence),
      createdAt: this.stamp(),
      createdBy: actor,
    };
    req.versions.push(next);
    // The whole point of versioning: a changed proposal is a NEW
    // proposal. Any earlier approval covered different content.
    req.approvedVersion = null;
    req.approvedHash = null;
    req.status = "pending";
    this.record(req, { kind: "version_created", actor, version: next.version });
    return req;
  }

  /**
   * The Approve control. Approves ONLY the exact version named, and
   * only if it is still the current version. Approving a superseded
   * version is a version_mismatch error, never a silent success.
   */
  approveExactVersion(id: string, version: number, actor = "owner"): ApprovalRequest {
    const req = this.get(id);
    const current = this.current(req);
    if (version !== current.version) {
      throw new ApprovalError(
        "version_mismatch",
        `Approval named version ${version}, but the current version is ${current.version}. ` +
          "An approval applies only to the exact version reviewed.",
      );
    }
    if (req.status !== "pending" && req.status !== "changes_requested") {
      throw new ApprovalError("not_pending", `Request is ${req.status}; nothing to approve`);
    }
    req.status = "approved";
    req.approvedVersion = current.version;
    req.approvedHash = current.contentHash;
    this.record(req, { kind: "approved", actor, version: current.version });
    return req;
  }

  /**
   * True only while the CURRENT version is exactly the version (number
   * and content hash) an approval covered. Any revision flips this to
   * false until the new version is itself approved.
   */
  isApproved(id: string): boolean {
    const req = this.get(id);
    if (req.status !== "approved" || req.approvedVersion === null) return false;
    const current = this.current(req);
    return req.approvedVersion === current.version && req.approvedHash === current.contentHash;
  }

  reject(id: string, actor = "owner", note?: string): ApprovalRequest {
    const req = this.get(id);
    req.status = "rejected";
    req.approvedVersion = null;
    req.approvedHash = null;
    this.record(req, {
      kind: "rejected",
      actor,
      version: this.current(req).version,
      note,
    });
    return req;
  }

  requestChanges(id: string, actor = "owner", note?: string): ApprovalRequest {
    const req = this.get(id);
    if (TERMINAL.has(req.status)) {
      throw new ApprovalError("not_pending", `Request is ${req.status}`);
    }
    req.status = "changes_requested";
    req.approvedVersion = null;
    req.approvedHash = null;
    this.record(req, {
      kind: "changes_requested",
      actor,
      version: this.current(req).version,
      note,
    });
    return req;
  }

  /** Keep pending: explicitly leave the request awaiting a decision. */
  keepPending(id: string, actor = "owner"): ApprovalRequest {
    const req = this.get(id);
    if (TERMINAL.has(req.status)) {
      throw new ApprovalError("not_pending", `Request is ${req.status}`);
    }
    if (req.status !== "approved") req.status = "pending";
    this.record(req, {
      kind: "kept_pending",
      actor,
      version: this.current(req).version,
    });
    return req;
  }

  stopOperation(id: string, actor = "owner"): ApprovalRequest {
    const req = this.get(id);
    req.status = "stopped";
    req.approvedVersion = null;
    req.approvedHash = null;
    this.record(req, {
      kind: "stopped",
      actor,
      version: this.current(req).version,
    });
    return req;
  }

  /** Dispatch one of the five named controls. */
  applyControl(
    id: string,
    control: ApprovalControl,
    opts?: { version?: number; actor?: string; note?: string },
  ): ApprovalRequest {
    switch (control) {
      case "approve_exact_version":
        if (opts?.version === undefined) {
          throw new ApprovalError(
            "version_mismatch",
            "Approve must name the exact version being approved",
          );
        }
        return this.approveExactVersion(id, opts.version, opts.actor);
      case "reject":
        return this.reject(id, opts?.actor, opts?.note);
      case "request_changes":
        return this.requestChanges(id, opts?.actor, opts?.note);
      case "keep_pending":
        return this.keepPending(id, opts?.actor);
      case "stop_operation":
        return this.stopOperation(id, opts?.actor);
    }
  }

  /**
   * The live conversation channel. Accepted immediately in every
   * non-terminal state — crucially, while an approval is pending — and
   * it NEVER changes approval state, whatever the text says. Messages
   * are instructions or discussion, not approval (spec §4).
   */
  postMessage(id: string, input: { from: string; text: string }): DiscussionMessage {
    const req = this.get(id);
    if (TERMINAL.has(req.status)) {
      throw new ApprovalError("not_pending", `Request is ${req.status}; its discussion is closed`);
    }
    const msg: DiscussionMessage = {
      at: this.stamp(),
      from: input.from,
      text: input.text,
      version: this.current(req).version,
    };
    req.discussion.push(msg);
    this.record(req, {
      kind: "message",
      actor: input.from,
      version: msg.version,
    });
    return msg;
  }

  /** Full history: every version, every message, every decision. */
  auditHistory(id: string): {
    versions: ProposalVersion[];
    discussion: DiscussionMessage[];
    audit: AuditEntry[];
  } {
    const req = this.get(id);
    return {
      versions: [...req.versions],
      discussion: [...req.discussion],
      audit: [...req.audit],
    };
  }

  getRequest(id: string): ApprovalRequest {
    return this.get(id);
  }

  /**
   * Persistence seam (production port): insert a record loaded from
   * the durable store, exactly as stored. Used only by the
   * approval-actions gate when rehydrating a center; the record is
   * trusted because this same engine wrote it. No audit entry is
   * added — the stored history already carries it.
   */
  restoreRequest(record: ApprovalRequest): void {
    this.requests.set(record.id, record);
  }
}
