// News — short news briefings filed off to the side, out of the
// main chat (Joseph's ask, 2026-11-15). A briefing is one filed
// edition: a title naming the window it covers plus a handful of
// one-line items (headline, source, optional link). Briefings live
// in the Store under their own kind, one record per edition, and
// the News page in the client reads them newest first.
//
// This module is storage + shape ONLY: nothing here fetches news
// or schedules filings. A separate lane produces editions and
// files them through the authenticated add route; this lane just
// gives them a durable home and a read surface, mirroring the
// daily brief's record discipline (engine/daily-brief.ts) without
// its computation — a news briefing is authored elsewhere, never
// derived from task records.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NewsBriefing } from "../../../../packages/domain/src/index.ts";
import type { Store } from "../db.ts";

// Store kind for the filed editions. One record per briefing (the
// id is a fresh UUID per edition): editions accumulate, unlike the
// daily brief's one-record-per-date discipline, because several
// editions can land in a day and none replaces another.
export const NEWS_BRIEFING_KIND = "news-briefings";

// An edition is a handful of one-liners (the standing briefing
// format caps at 5–7); the schema allows headroom for a busy
// window but refuses a dump — a briefing with fifty items is a
// feed, not a briefing.
export const NEWS_ITEM_CAP = 50;

export const newsItemSchema = z.object({
  headline: z.string().trim().min(1).max(500),
  source: z.string().trim().min(1).max(200).optional(),
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https?:\/\//, "url must be an http(s) link")
    .optional(),
});
export const newsBriefingInputSchema = z.object({
  // The window the edition covers, in the filer's own words
  // (e.g. "News — Sunday afternoon"): the page shows it verbatim.
  title: z.string().trim().min(1).max(300),
  items: z.array(newsItemSchema).min(1).max(NEWS_ITEM_CAP),
});
export type NewsBriefingInput = z.infer<typeof newsBriefingInputSchema>;

// Build the stored record from a validated input: optional item
// fields normalize to null so every stored item carries the full
// NewsItem shape the client renders.
export function buildNewsBriefing(input: NewsBriefingInput, now = new Date()): NewsBriefing {
  return {
    id: randomUUID(),
    title: input.title,
    items: input.items.map((item) => ({
      headline: item.headline,
      source: item.source ?? null,
      url: item.url ?? null,
    })),
    createdAt: now.toISOString(),
  };
}

// File one edition for the owner and return the stored record.
export async function addNewsBriefing(
  db: Pick<Store, "put">,
  owner: string,
  input: NewsBriefingInput,
  now = new Date(),
): Promise<NewsBriefing> {
  const briefing = buildNewsBriefing(input, now);
  await db.put(owner, NEWS_BRIEFING_KIND, briefing);
  return briefing;
}

// The owner's filed editions, newest first. The Store lists by
// updated_at descending already; the explicit createdAt sort keeps
// the order honest even if a record is ever re-put, and the limit
// is clamped to the same 1..100 window as the other list routes.
export async function listNewsBriefings(
  db: Pick<Store, "list">,
  owner: string,
  limit = 20,
): Promise<NewsBriefing[]> {
  const briefings = await db.list<NewsBriefing>(owner, NEWS_BRIEFING_KIND);
  return briefings
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(100, limit)));
}
