// Content-free audit log — a cross-task lifecycle record that
// complements the per-task StageTrace from the verifier spine
// (PR-alpha). Ported from Agent-Me (MIT, (c) Agent-Me contributors) —
// backend/app/audit.py and the AuditEvent model in
// backend/app/owner_models.py (parts-scavenge MAP, Tier 1 item #3).
//
// The schema itself forbids content: an operation is a lowercase
// dotted name, the outcome is one of three values, and the payload
// carries INTEGER COUNTS ONLY (at most 10 keys, non-negative). There
// is no field that could hold a prompt, a path, a token, an id of
// content, or exception text — content-freeness is enforced by
// construction, not by convention, so status surfaces and progress
// reporting can consume this log without a leak review. Like the
// donor's, the log is bounded and rotating (self-trimming at 10,000
// rows, oldest dropped): an operational log, not an immutable or
// dispute-grade audit trail.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../db.ts";

// The donor's bounds (owner_models.py / audit.py).
export const AUDIT_LOG_CAP = 10000;
export const AUDIT_PAYLOAD_MAX_KEYS = 10;
// The donor's read bound: AuditLog.events accepts 1..1000.
export const AUDIT_READ_MAX = 1000;

const AUDIT_KIND = "audit-events";

// Donor operation pattern (owner_models.py): a leading lowercase
// letter, then lowercase letters, digits, dots or underscores.
export const auditOperationSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.]{0,79}$/, "operation must be a lowercase dotted name");
export type AuditOperation = z.infer<typeof auditOperationSchema>;

// Donor outcome enum (owner_models.py): exactly three values.
export const auditOutcomeSchema = z.enum(["succeeded", "denied", "failed"]);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

// Donor count-key pattern (owner_models.py): lowercase snake names.
const countKeySchema = z.string().regex(/^[a-z_]{1,40}$/);

// Payload = counts only. The value schema rejects every non-integer
// (strings, booleans, floats, negative numbers) before the key/count
// refinements run, so no caller can smuggle text into the log by
// choosing a creative payload shape.
export const auditPayloadSchema = z
  .record(z.string(), z.number().int().nonnegative())
  .superRefine((payload, context) => {
    const keys = Object.keys(payload);
    if (keys.length > AUDIT_PAYLOAD_MAX_KEYS)
      context.addIssue({
        code: "custom",
        message: `payload carries at most ${AUDIT_PAYLOAD_MAX_KEYS} counts`,
      });
    for (const key of keys)
      if (!countKeySchema.safeParse(key).success)
        context.addIssue({
          code: "custom",
          message: `payload key ${JSON.stringify(key)} must be a lowercase count name`,
        });
  });
export type AuditPayload = z.infer<typeof auditPayloadSchema>;

export const auditEventSchema = z.object({
  id: z.string().min(1),
  at: z.iso.datetime(),
  operation: auditOperationSchema,
  outcome: auditOutcomeSchema,
  payload: auditPayloadSchema.default({}),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

// The store surface the log needs — the real Store satisfies it, and
// tests can inject a small cap instead of writing 10,000 rows.
type AuditStore = Pick<Store, "get" | "list" | "put" | "remove">;

export class AuditLog {
  constructor(
    private readonly db: AuditStore,
    private readonly cap: number = AUDIT_LOG_CAP,
  ) {
    if (!Number.isInteger(cap) || cap < 1)
      throw new Error("Audit log cap must be a positive integer");
  }

  // Validate, append, and self-trim to the cap (oldest dropped).
  // Validation failures throw: a caller that tries to record content
  // gets an error, never a quietly-coerced event.
  async record(
    owner: string,
    operation: string,
    outcome: AuditOutcome = "succeeded",
    payload: AuditPayload = {},
  ): Promise<AuditEvent> {
    const event = auditEventSchema.parse({
      id: randomUUID(),
      at: new Date().toISOString(),
      operation,
      outcome,
      payload,
    });
    await this.db.put(owner, AUDIT_KIND, event);
    // Store.list is newest-first (updated_at DESC), so everything
    // past the cap is the oldest and is dropped.
    const events = await this.db.list<AuditEvent>(owner, AUDIT_KIND);
    for (const stale of events.slice(this.cap)) await this.db.remove(owner, AUDIT_KIND, stale.id);
    return event;
  }

  // Recent events, newest first. The limit follows the donor's read
  // contract (1..1000); routes cap it further for their page size.
  async events(owner: string, limit = 100): Promise<AuditEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_READ_MAX)
      throw new Error(`Audit limit must be between 1 and ${AUDIT_READ_MAX}`);
    const events = await this.db.list<AuditEvent>(owner, AUDIT_KIND);
    // Re-validate on the way out: a record that does not fit the
    // schema (written by anything else) is never served as an event.
    const valid: AuditEvent[] = [];
    for (const event of events) {
      const parsed = auditEventSchema.safeParse(event);
      if (parsed.success) valid.push(parsed.data);
      if (valid.length >= limit) break;
    }
    return valid;
  }
}
