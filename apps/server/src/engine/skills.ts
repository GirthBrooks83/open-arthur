// Skill machinery — the Hermes Agent skill_manage tool contract,
// the advisory skill linter, and 3-level progressive disclosure
// (MIT, (c) Nous Research — Hermes Agent, audited at HEAD 93dd2435;
// tools/skill_manager_tool.py, tools/skill_linter.py,
// tools/skills_tool.py, tools/skill_provenance.py — parts-scavenge
// MAP, Tier 2 items #6 + #7 and Design Note B steps 2–4). Only the
// SHAPES are ported, not Hermes code: per-action schema-enforced
// slots (a call carrying another action's fields is rejected before
// anything applies), patch-preferred edits, and an advisory linter
// whose warnings ride back to the caller. Where Hermes leaves its
// safety mitigations OFF by default, Open Arthur ships them ON
// (Design Note B step 4): the background review's writes land in a
// PENDING area and apply only on approval — that half lives in
// engine/skill-review.ts; this module is the store and the write
// contract both callers share.
//
// Skills are stored as records, not files: Open Arthur runs on a
// hosted server with no durable per-owner filesystem, so a skill is
// one store record whose content IS the SKILL.md document
// (agentskills.io frontmatter + body), plus one record per
// references/ file. The 3 disclosure levels map onto reads of those
// records:
//   level 1 — frontmatter only (name, description, version,
//             provenance): what a skill listing surfaces;
//   level 2 — the full SKILL.md (frontmatter + body): what loading
//             a skill returns;
//   level 3 — an individual references/ file, read on demand.
// Frontmatter provenance is first-class: `metadata.created_by`
// records WHO wrote the skill (Hermes' skill_provenance tag — the
// Curator and the audit log both depend on it), and the background
// review's writes always carry `background_review`.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

export const SKILLS_KIND = "skills";
export const SKILL_FILES_KIND = "skill-files";

// Where a skill write came from. `agent` is a live task's tool call;
// `background_review` is the nightly review (Design Note B's
// provenance tag — everything the review writes carries it);
// `operator` is a direct authenticated API call.
export const skillProvenanceSchema = z.enum(["background_review", "agent", "operator"]);
export type SkillProvenance = z.infer<typeof skillProvenanceSchema>;

// Hermes' advisory linter bounds (MAP item #6): a body past ~24k
// chars is a skill trying to be a document; more than 60
// references/ files is sprawl. Both are warnings, never failures.
export const SKILL_BODY_WARN_CHARS = 24_000;
export const SKILL_REFERENCES_WARN_COUNT = 60;

// agentskills.io name shape: lowercase letters, digits and hyphens,
// no leading/trailing hyphen (the same rule Arthur's own custom
// skills follow on disk).
export const skillNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "skill name must be lowercase letters, digits and hyphens")
  .max(64);

export const skillFrontmatterSchema = z.object({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(1024),
  version: z.string().trim().min(1).max(32).optional(),
  metadata: z.object({ created_by: skillProvenanceSchema }).passthrough().optional(),
});
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

// A stored skill: the SKILL.md document split at its frontmatter so
// level-1 reads never pay for the body. `body` is the Markdown after
// the closing frontmatter fence; `content` is never stored — it is
// reassembled on read (single source of truth, no drift).
export const skillRecordSchema = z.object({
  id: z.string().min(1),
  name: skillNameSchema,
  description: z.string().min(1),
  version: z.string().nullable(),
  createdBy: skillProvenanceSchema.nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SkillRecord = z.infer<typeof skillRecordSchema>;

// A references/ file belonging to a skill (disclosure level 3).
export const skillFileRecordSchema = z.object({
  // `${skillName}:${path}` — one record per file, so a listing is a
  // prefix read and a file read is a point get.
  id: z.string().min(1),
  skillName: skillNameSchema,
  path: z.string().min(1),
  content: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SkillFileRecord = z.infer<typeof skillFileRecordSchema>;

// Level 1 — what a listing or a model's skill index sees.
export interface SkillSummary {
  name: string;
  description: string;
  version: string | null;
  createdBy: SkillProvenance | null;
  references: string[];
  updatedAt: string;
}

// Reassemble the full SKILL.md document (level 2) from a record.
// Key order is fixed so a patch round-trip is byte-stable: a
// patch's old_string matched against this rendering is the same
// rendering the next read returns.
export function renderSkillMarkdown(skill: SkillRecord): string {
  const lines = ["---", `name: ${skill.name}`, `description: ${skill.description}`];
  if (skill.version) lines.push(`version: ${skill.version}`);
  if (skill.createdBy) lines.push("metadata:", `  created_by: ${skill.createdBy}`);
  lines.push("---", "", skill.body.replace(/\n+$/, ""), "");
  return lines.join("\n");
}

// Parse a SKILL.md document into frontmatter + body. The parser is
// deliberately small — it accepts exactly what renderSkillMarkdown
// emits plus hand-written equivalents (name, description, version,
// and a metadata block with created_by); anything richer is a
// schema violation, not a silent drop. Throws AppError(400) on a
// malformed document: frontmatter problems are HARD failures in the
// Hermes contract (the linter is advisory; the schema is not).
export function parseSkillMarkdown(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const fail = (message: string): never => {
    throw new AppError(`Invalid SKILL.md: ${message}`, 400);
  };
  const text = content.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) fail("the document must open with a --- frontmatter fence");
  const close = text.indexOf("\n---\n", 4);
  if (close < 0) fail("the frontmatter fence is never closed");
  const block = text.slice(4, close);
  const body = text.slice(close + 5).replace(/^\n+/, "");
  const fields = new Map<string, string>();
  let inMetadata = false;
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    // Capture groups are optional in the regex type; a failed match
    // leaves the whole result undefined, which is the checkable form.
    const entry = (indented ? line.trim() : line).match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!entry) fail(`malformed frontmatter line: ${line.trim()}`);
    const [, key, value] = entry as unknown as [string, string, string];
    if (indented) {
      if (!inMetadata) fail(`unexpected indented line: ${line.trim()}`);
      fields.set(`metadata.${key}`, value.trim());
      continue;
    }
    inMetadata = false;
    if (key === "metadata") {
      inMetadata = true;
      continue;
    }
    fields.set(key, value.trim());
  }
  const raw: Record<string, unknown> = {};
  if (fields.has("name")) raw.name = fields.get("name");
  if (fields.has("description")) raw.description = fields.get("description");
  if (fields.has("version")) raw.version = fields.get("version");
  const createdBy = fields.get("metadata.created_by");
  if (createdBy !== undefined) raw.metadata = { created_by: createdBy };
  const parsed = skillFrontmatterSchema.safeParse(raw);
  if (!parsed.success)
    fail(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  const frontmatter = parsed.data as SkillFrontmatter;
  // The one metadata key with semantics here is validated strictly;
  // a created_by outside the enum never parses (schema above).
  return { frontmatter, body };
}

// The advisory linter (Hermes' skill_linter shape): warnings are
// returned to the caller and recorded nowhere as failures — a skill
// that trips one still applies. Schema violations are NOT the
// linter's business; they throw before linting runs.
export interface SkillLintWarning {
  rule: "oversized_body" | "references_sprawl" | "incident_log_shape";
  message: string;
}

export function lintSkill(input: { body: string; referencesCount: number }): SkillLintWarning[] {
  const warnings: SkillLintWarning[] = [];
  if (input.body.length > SKILL_BODY_WARN_CHARS)
    warnings.push({
      rule: "oversized_body",
      message: `Skill body is ${input.body.length} characters, past the ~${SKILL_BODY_WARN_CHARS} advisory bound — move detail into references/ files (progressive disclosure level 3).`,
    });
  if (input.referencesCount > SKILL_REFERENCES_WARN_COUNT)
    warnings.push({
      rule: "references_sprawl",
      message: `${input.referencesCount} references/ files, past the ${SKILL_REFERENCES_WARN_COUNT} advisory bound — consolidate the supporting files.`,
    });
  // Incident-log shape: a skill body that reads as a dated incident
  // log (three or more ISO-dated entries) is a LESSONS journal, not
  // a procedure — procedures say what to do; logs say what happened.
  const datedEntries = input.body.match(/^\s*(?:[-*]\s*)?\d{4}-\d{2}-\d{2}\b/gm) ?? [];
  if (datedEntries.length >= 3)
    warnings.push({
      rule: "incident_log_shape",
      message:
        "Skill body reads as an incident log (3+ dated entries) — distill it into procedure steps and Pitfalls instead of dated entries.",
    });
  return warnings;
}

// --- skill_manage: the write contract -----------------------------
// One op per call. Each action's object carries ONLY its own slots
// and is .strict(): a field belonging to another action (content on
// a patch, old_string on a create, file fields on either) fails
// validation BEFORE anything applies — Hermes' pre-effect rejection
// (the misfiled-text-slot fix), enforced by the schema itself.

const slotBase = { name: skillNameSchema };
export const skillManageOpSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      ...slotBase,
      // The full SKILL.md document (frontmatter + body).
      content: z.string().min(1).max(200_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("patch"),
      ...slotBase,
      old_string: z.string().min(1),
      new_string: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal("write_file"),
      ...slotBase,
      // references/ files only: the path is relative and must live
      // under references/ (the SKILL.md itself is create/patch's
      // slot, never write_file's).
      file_path: z
        .string()
        .min(1)
        .max(200)
        .regex(/^references\/[A-Za-z0-9._/-]+$/, "file_path must be a path under references/")
        .refine((path) => !path.split("/").includes(".."), "file_path must not contain .."),
      file_content: z.string().max(200_000),
    })
    .strict(),
]);
export type SkillManageOp = z.infer<typeof skillManageOpSchema>;

// What a skill_manage call returns: the applied result plus the
// advisory linter's warnings (the Hermes contract: lint output
// rides back to the caller, it never blocks the write).
export interface SkillManageResult {
  action: SkillManageOp["action"];
  name: string;
  // The skill's summary after the write (level 1).
  skill: SkillSummary;
  // For write_file: the references path written.
  path?: string;
  warnings: SkillLintWarning[];
}

// The store surface the machinery needs — the real Store satisfies
// it and tests inject nothing else (Store is already the seam every
// engine module uses).
type SkillStore = Pick<Store, "get" | "list" | "put">;

export async function listSkillFiles(
  db: SkillStore,
  owner: string,
  skillName: string,
): Promise<SkillFileRecord[]> {
  const files = await db.list<SkillFileRecord>(owner, SKILL_FILES_KIND);
  return files
    .filter((file) => file.skillName === skillName)
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function summarize(db: SkillStore, owner: string, skill: SkillRecord): Promise<SkillSummary> {
  const files = await listSkillFiles(db, owner, skill.name);
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    createdBy: skill.createdBy,
    references: files.map((file) => file.path),
    updatedAt: skill.updatedAt,
  };
}

// Level 1: every skill's frontmatter summary, name order.
export async function listSkills(db: SkillStore, owner: string): Promise<SkillSummary[]> {
  const skills = await db.list<SkillRecord>(owner, SKILLS_KIND);
  const summaries: SkillSummary[] = [];
  for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name)))
    summaries.push(await summarize(db, owner, skill));
  return summaries;
}

// Level 2: the full SKILL.md document; null when the skill is
// absent. This is also the read the patch path enforces before any
// write (read-before-write, below).
export async function readSkillMarkdown(
  db: SkillStore,
  owner: string,
  name: string,
): Promise<string | null> {
  const skill = await db.get<SkillRecord>(owner, SKILLS_KIND, name);
  return skill ? renderSkillMarkdown(skill) : null;
}

// Level 3: one references/ file's content; null when absent.
export async function readSkillFile(
  db: SkillStore,
  owner: string,
  name: string,
  path: string,
): Promise<string | null> {
  const file = await db.get<SkillFileRecord>(owner, SKILL_FILES_KIND, `${name}:${path}`);
  return file ? file.content : null;
}

// Apply one skill_manage op directly to the live skill store. This
// is the DIRECT path — the one a caller with standing write access
// uses. The background review never calls this: it stages through
// engine/skill-review.ts's pending area (write-approval ON), and
// only an approval reaches this function with the review's
// provenance attached.
//
// Provenance: `createdBy` is stamped from the CALLER, never trusted
// from the document — a create whose content claims a different
// created_by is rewritten to the caller's tag, so provenance cannot
// be forged by the text being written. On patch the existing tag is
// preserved (authorship of the skill doesn't change hands on an
// edit); a skill with no tag keeps none unless the patch's result
// declares one, which is then the caller's only if it matches.
export async function applySkillManage(
  db: SkillStore & Pick<Store, "put">,
  owner: string,
  op: SkillManageOp,
  options: {
    createdBy: SkillProvenance;
    now?: Date;
    readSkill?: (name: string) => Promise<string | null>;
  },
): Promise<SkillManageResult> {
  const now = (options.now ?? new Date()).toISOString();
  if (op.action === "create") {
    const existing = await db.get<SkillRecord>(owner, SKILLS_KIND, op.name);
    if (existing)
      throw new AppError(
        `Skill ${op.name} already exists — patch it instead of recreating it`,
        409,
      );
    const { frontmatter, body } = parseSkillMarkdown(op.content);
    if (frontmatter.name !== op.name)
      throw new AppError(
        `Invalid SKILL.md: frontmatter name ${JSON.stringify(frontmatter.name)} does not match the op name ${JSON.stringify(op.name)}`,
        400,
      );
    const skill: SkillRecord = skillRecordSchema.parse({
      id: op.name,
      name: op.name,
      description: frontmatter.description,
      version: frontmatter.version ?? null,
      createdBy: options.createdBy,
      body,
      createdAt: now,
      updatedAt: now,
    });
    await db.put(owner, SKILLS_KIND, skill);
    return {
      action: "create",
      name: op.name,
      skill: await summarize(db, owner, skill),
      warnings: lintSkill({ body, referencesCount: 0 }),
    };
  }
  if (op.action === "patch") {
    // Read-before-write, enforced in the machinery (Hermes'
    // read-before-write on patches): the caller must have READ the
    // skill's current SKILL.md in this session — evidenced by the
    // injected readSkill seam having been consulted for this name —
    // before a patch may apply. A patch attempted blind is rejected
    // before anything is read from the store or written.
    if (!options.readSkill)
      throw new AppError(
        "patch requires read-before-write: read the skill first, then patch it",
        400,
      );
    const readBack = await options.readSkill(op.name);
    if (readBack === null) throw new AppError(`Skill ${op.name} not found — nothing to patch`, 404);
    const skill = await db.get<SkillRecord>(owner, SKILLS_KIND, op.name);
    if (!skill) throw new AppError(`Skill ${op.name} not found — nothing to patch`, 404);
    const current = renderSkillMarkdown(skill);
    if (readBack !== current)
      throw new AppError(
        "patch rejected: the read copy is stale — re-read the skill and patch against the current text",
        409,
      );
    const occurrences = current.split(op.old_string).length - 1;
    if (occurrences === 0)
      throw new AppError(
        "patch rejected: old_string not found in the skill's current SKILL.md",
        400,
      );
    if (occurrences > 1)
      throw new AppError(
        "patch rejected: old_string matches more than once — widen it until it matches exactly once",
        400,
      );
    const next = current.replace(op.old_string, op.new_string);
    const { frontmatter, body } = parseSkillMarkdown(next);
    if (frontmatter.name !== op.name)
      throw new AppError("patch rejected: a patch may not rename a skill", 400);
    const updated: SkillRecord = skillRecordSchema.parse({
      ...skill,
      description: frontmatter.description,
      version: frontmatter.version ?? null,
      // Authorship is preserved; a tag is only adopted when the
      // document declares exactly the caller's own provenance.
      createdBy:
        skill.createdBy ??
        (frontmatter.metadata?.created_by === options.createdBy ? options.createdBy : null),
      body,
      updatedAt: now,
    });
    await db.put(owner, SKILLS_KIND, updated);
    const files = await listSkillFiles(db, owner, op.name);
    return {
      action: "patch",
      name: op.name,
      skill: await summarize(db, owner, updated),
      warnings: lintSkill({ body, referencesCount: files.length }),
    };
  }
  // write_file — references/ only (the schema enforces the path).
  const skill = await db.get<SkillRecord>(owner, SKILLS_KIND, op.name);
  if (!skill) throw new AppError(`Skill ${op.name} not found — create it before adding files`, 404);
  const existingFile = await db.get<SkillFileRecord>(
    owner,
    SKILL_FILES_KIND,
    `${op.name}:${op.file_path}`,
  );
  const record: SkillFileRecord = skillFileRecordSchema.parse({
    id: `${op.name}:${op.file_path}`,
    skillName: op.name,
    path: op.file_path,
    content: op.file_content,
    createdAt: existingFile?.createdAt ?? now,
    updatedAt: now,
  });
  await db.put(owner, SKILL_FILES_KIND, record);
  const files = await listSkillFiles(db, owner, op.name);
  return {
    action: "write_file",
    name: op.name,
    path: op.file_path,
    skill: await summarize(db, owner, skill),
    warnings: lintSkill({ body: skill.body, referencesCount: files.length }),
  };
}

// A stable content fingerprint for a proposed op — used by the
// pending area to show (and by tests to prove) exactly what an
// approval would apply. Hash of the canonical op JSON.
export function skillOpFingerprint(op: SkillManageOp): string {
  return createHash("sha256").update(JSON.stringify(op)).digest("hex").slice(0, 16);
}

export function newSkillId(): string {
  return randomUUID();
}
