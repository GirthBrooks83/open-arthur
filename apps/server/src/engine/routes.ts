import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type {
  AgentIdentity,
  AgentMemory,
  AgentNotification,
} from "../../../../packages/domain/src/agent.ts";
import { AppError } from "../errors.ts";
import type { AgentService } from "./service.ts";
import { skillManageOpSchema } from "./skills.ts";

const text = z.string().trim().min(1).max(4000);
const memorySchema = z.object({ text, source: z.string().trim().min(1).max(200).optional() });
const goalPatchSchema = z.object({
  status: z.enum(["active", "paused", "completed"]).optional(),
  milestones: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        done: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
});

export function agentRoutes(service: AgentService): Hono<{ Variables: { owner: string } }> {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await service.snapshot(c.get("owner"))));
  app.post("/tasks", async (c) =>
    c.json(await service.createTask(c.get("owner"), await c.req.json()), 201),
  );
  app.get("/tasks/:id", async (c) =>
    c.json(await service.detail(c.get("owner"), c.req.param("id"))),
  );
  app.post("/tasks/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel", "retry"]) })
      .parse(await c.req.json());
    return c.json(await service.control(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/tasks/:id/input", async (c) => {
    const body = z
      .object({
        answer: z.string().trim().min(1).max(12000),
        fields: z
          .record(z.string().min(1).max(300), z.union([z.string().max(12000), z.boolean()]))
          .optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.answer(c.get("owner"), c.req.param("id"), body.answer, body.fields),
    );
  });
  app.post("/goals", async (c) =>
    c.json(await service.createGoal(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/goals/:id", async (c) => {
    const body = goalPatchSchema.parse(await c.req.json());
    return c.json(await service.updateGoal(c.get("owner"), c.req.param("id"), body));
  });
  app.post("/monitors", async (c) =>
    c.json(await service.createMonitor(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/monitors/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "stop", "check"]) })
      .parse(await c.req.json());
    return c.json(await service.controlMonitor(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/ideas/refresh", async (c) => c.json(await service.refreshIdeas(c.get("owner"))));
  app.post("/ideas/:id", async (c) => {
    const body = z
      .object({
        action: z.enum(["accept", "dismiss"]),
        prompt: z.string().trim().min(1).max(12000).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.decideIdea(c.get("owner"), c.req.param("id"), body.action, body.prompt),
    );
  });
  app.post("/memories", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory: AgentMemory = {
      id: randomUUID(),
      text: body.text,
      source: body.source ?? "You",
      createdAt: new Date().toISOString(),
    };
    return c.json(await service.remember(c.get("owner"), memory), 201);
  });
  app.post("/memories/:id", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory = await service.db.compareAndSwap<AgentMemory>(
      c.get("owner"),
      "memories",
      c.req.param("id"),
      {},
      body,
    );
    if (!memory) throw new AppError("Memory not found", 404);
    return c.json(memory);
  });
  app.post("/memories/:id/forget", async (c) => {
    if (!(await service.db.take(c.get("owner"), "memories", c.req.param("id"))))
      throw new AppError("Memory not found", 404);
    return c.json({ ok: true });
  });
  app.post("/identity", async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        tone: z.enum(["warm", "concise", "thoughtful"]),
        avatar: z.enum(["sky", "sand", "lilac"]).optional(),
        showChatUpdates: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const owner = c.get("owner");
    await service.ensure(owner);
    const identity = await service.db.compareAndSwap<AgentIdentity>(
      owner,
      "agent-settings",
      "identity",
      {},
      body,
    );
    if (!identity) throw new AppError("Agent identity changed; refresh and try again", 409);
    return c.json(identity);
  });
  app.get("/notifications", async (c) =>
    c.json((await service.snapshot(c.get("owner"))).notifications),
  );
  // Nightly distillation (engine/distillation.ts): the manual
  // trigger runs the real pipeline (distill -> hash-settle ->
  // supersession handoff -> dream diary) on demand; the schedule
  // action ensures the nightly worker task exists; the diary and
  // runs are the operator's read surfaces for what distillation did.
  const distillationDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
  app.post("/distillation/run", async (c) => {
    const raw = await c.req.text();
    const body = z
      .object({ date: distillationDateSchema.optional() })
      .parse(raw ? JSON.parse(raw) : {});
    return c.json(await service.runDistillation(c.get("owner"), body.date));
  });
  app.post("/distillation/schedule", async (c) =>
    c.json(await service.ensureDistillationJob(c.get("owner")), 201),
  );
  app.get("/distillation/diary", async (c) => {
    const date = c.req.query("date");
    if (date !== undefined) distillationDateSchema.parse(date);
    const diary = await service.dreamDiary(c.get("owner"), date);
    if (!diary) throw new AppError("No dream diary entry found", 404);
    return c.json(diary);
  });
  app.get("/distillation/diaries", async (c) => c.json(await service.dreamDiaries(c.get("owner"))));
  app.get("/distillation/runs", async (c) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse({ limit: c.req.query("limit") });
    return c.json(await service.distillationRuns(c.get("owner"), limit));
  });
  // Skill machinery + background review (engine/skills.ts,
  // engine/skill-review.ts): the read surfaces expose the 3
  // disclosure levels (summaries, full SKILL.md, one references/
  // file); skill_manage applies a direct write for a caller with
  // standing access; the review's writes NEVER apply directly —
  // they stage in the pending area and move only through the
  // approve/reject decisions below.
  app.get("/skills", async (c) => c.json(await service.listSkillSummaries(c.get("owner"))));
  // The pending/review routes are registered BEFORE /skills/:name:
  // Hono matches in registration order, and ":name" would otherwise
  // swallow the literal "pending" and "review" segments.
  const skillReviewDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
  app.get("/skills/pending", async (c) => {
    const pendingOnly = c.req.query("status") !== "all";
    return c.json(await service.pendingSkillWrites(c.get("owner"), pendingOnly));
  });
  app.post("/skills/pending/:id/approve", async (c) =>
    c.json(await service.approveSkillWrite(c.get("owner"), c.req.param("id"))),
  );
  app.post("/skills/pending/:id/reject", async (c) =>
    c.json(await service.rejectSkillWrite(c.get("owner"), c.req.param("id"))),
  );
  app.post("/skills/review/run", async (c) => {
    const raw = await c.req.text();
    const body = z
      .object({ date: skillReviewDateSchema.optional() })
      .parse(raw ? JSON.parse(raw) : {});
    return c.json(await service.runSkillReview(c.get("owner"), body.date));
  });
  app.post("/skills/review/schedule", async (c) =>
    c.json(await service.ensureSkillReviewJob(c.get("owner")), 201),
  );
  app.get("/skills/review/runs", async (c) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse({ limit: c.req.query("limit") });
    return c.json(await service.skillReviewRuns(c.get("owner"), limit));
  });
  app.get("/skills/:name", async (c) => {
    const markdown = await service.readSkill(c.get("owner"), c.req.param("name"));
    if (markdown === null) throw new AppError("Skill not found", 404);
    return c.json({ name: c.req.param("name"), markdown });
  });
  app.get("/skills/:name/files/:path{.+}", async (c) => {
    const content = await service.readSkillReference(
      c.get("owner"),
      c.req.param("name"),
      c.req.param("path"),
    );
    if (content === null) throw new AppError("Skill file not found", 404);
    return c.json({ name: c.req.param("name"), path: c.req.param("path"), content });
  });
  app.post("/skills/manage", async (c) => {
    const body = await c.req.json();
    return c.json(await service.skillManage(c.get("owner"), skillManageOpSchema.parse(body)), 201);
  });
  // Content-free audit log (engine/audit.ts): recent lifecycle
  // events for this owner, newest first. Events carry counts only
  // by construction, so this surface needs no content review. The
  // page size is capped at 100 (the AuditLog itself allows 1000).
  app.get("/audit", async (c) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse({ limit: c.req.query("limit") });
    return c.json(await service.auditEvents(c.get("owner"), limit));
  });
  app.post("/notifications/:id/read", async (c) => {
    const notification = await service.db.compareAndSwap<AgentNotification>(
      c.get("owner"),
      "notifications",
      c.req.param("id"),
      {},
      { read: true },
    );
    if (!notification) throw new AppError("Notification not found", 404);
    return c.json(notification);
  });
  app.post("/sample-page", async (c) => {
    if (service.config.mode !== "sample") throw new AppError("Not found", 404);
    const body = z.object({ text: z.string().max(100000) }).parse(await c.req.json());
    await service.db.put(c.get("owner"), "sample-pages", { id: "availability", text: body.text });
    return c.json({ ok: true });
  });
  return app;
}
