// Memory parity v1 (PR-mu) — a read-only window onto Arthur's curated
// sync record: the arthur-sync package (Arthur-here's learned state —
// lanes, decisions, operating rules) bundled with the server as a
// SNAPSHOT, not a live sync. The snapshot file
// (apps/server/src/knowledge/arthur-sync-state.md) is a verbatim copy of
// the curated package, refreshed by hand in a PR when the record moves;
// every recall result carries the snapshot's generated date so staleness
// is visible instead of silent.
//
// Parse and search are pure functions over the snapshot text (the
// consults.ts pattern). Only loadArthurRecordSnapshot touches the disk,
// once, and caches. The recall_arthur_record tool (model.ts) is the only
// consumer, and it is read-only: it is deliberately NOT in
// MUTATING_TOOLS (engine/service.ts).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTHUR_RECORD_TOOL_NAME = "recall_arthur_record";

/** Default ceiling on returned match text, so a recall can't flood a run. */
export const MAX_RECALL_CHARS = 6000;
/** Per-block ceiling; one long entry is excerpted, never dumped whole. */
const MAX_BLOCK_CHARS = 2000;

export interface ArthurRecordSection {
  heading: string;
  body: string;
}

export interface ArthurRecordSnapshot {
  /** ISO timestamp from the snapshot's "Generated:" line, when present. */
  generatedAt: string | null;
  sections: ArthurRecordSection[];
}

export interface ArthurRecordMatch {
  heading: string;
  text: string;
}

export interface ArthurRecordRecall {
  snapshotDate: string | null;
  matches: ArthurRecordMatch[];
  note: string;
}

/** Split the snapshot markdown into its `## ` sections (preamble first). */
export function parseArthurRecord(text: string): ArthurRecordSnapshot {
  const generated = /^Generated:\s*(\S+)/m.exec(text);
  const sections: ArthurRecordSection[] = [];
  let heading = "Overview";
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) sections.push({ heading, body });
    lines = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
    } else if (line.startsWith("# ") && heading === "Overview" && lines.length === 0) {
      heading = line.slice(2).trim();
    } else {
      lines.push(line);
    }
  }
  flush();
  return { generatedAt: generated?.[1] ?? null, sections };
}

/**
 * Split a section body into entry blocks: a new block starts at a
 * bullet (`- `) or numbered (`1. `) line; continuation lines stay with
 * the block they follow. Any lead-in text is its own block.
 */
function splitBlocks(body: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) blocks.push(text);
    current = [];
  };
  for (const line of body.split("\n")) {
    if (/^(- |\d+\. )/.test(line) && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length >= 2),
    ),
  ];
}

function truncateBlock(text: string): string {
  if (text.length <= MAX_BLOCK_CHARS) return text;
  return `${text.slice(0, MAX_BLOCK_CHARS)} […]`;
}

/**
 * Search the snapshot for a query. Matching is case-insensitive keyword
 * matching over section headings and entry blocks — honest v1 search,
 * not semantic recall. A section whose heading matches contributes its
 * first block even when no block matches, so the agent can see what the
 * section holds. Results are capped at `maxChars` of match text.
 */
export function recallArthurRecord(
  snapshot: ArthurRecordSnapshot,
  query: string,
  maxChars: number = MAX_RECALL_CHARS,
): ArthurRecordRecall {
  const date = snapshot.generatedAt;
  const dateText = date ?? "an unknown date";
  const terms = queryTerms(query);
  if (terms.length === 0)
    return {
      snapshotDate: date,
      matches: [],
      note: `That query has no searchable terms. Arthur's synced record is a curated snapshot generated ${dateText}; ask about a lane, decision or rule by name.`,
    };
  interface ScoredBlock {
    text: string;
    score: number;
    order: number;
  }
  interface ScoredSection {
    heading: string;
    headingHit: boolean;
    blocks: ScoredBlock[];
    order: number;
  }
  const scored: ScoredSection[] = [];
  snapshot.sections.forEach((section, order) => {
    const headingLower = section.heading.toLowerCase();
    const headingHit = terms.some((term) => headingLower.includes(term));
    const allBlocks = splitBlocks(section.body);
    const blocks: ScoredBlock[] = [];
    allBlocks.forEach((text, blockOrder) => {
      const lower = text.toLowerCase();
      const score = terms.filter((term) => lower.includes(term)).length;
      if (score > 0) blocks.push({ text, score, order: blockOrder });
    });
    if (headingHit && blocks.length === 0 && allBlocks[0])
      blocks.push({ text: allBlocks[0], score: 0, order: 0 });
    if (blocks.length === 0) return;
    blocks.sort((a, b) => b.score - a.score || a.order - b.order);
    scored.push({ heading: section.heading, headingHit, blocks, order });
  });
  scored.sort((a, b) => {
    if (a.headingHit !== b.headingHit) return a.headingHit ? -1 : 1;
    const best = (s: ScoredSection) => Math.max(...s.blocks.map((b) => b.score));
    return best(b) - best(a) || a.order - b.order;
  });
  const matches: ArthurRecordMatch[] = [];
  let used = 0;
  for (const section of scored) {
    for (const block of section.blocks) {
      const text = truncateBlock(block.text);
      if (matches.length > 0 && used + text.length > maxChars)
        return {
          snapshotDate: date,
          matches,
          note: `Matches from Arthur's synced record (snapshot generated ${dateText}), capped at ${maxChars} characters — narrow the query for more. The record is a curated snapshot, not a live sync; facts may have moved since.`,
        };
      matches.push({ heading: section.heading, text });
      used += text.length;
    }
  }
  if (matches.length === 0)
    return {
      snapshotDate: date,
      matches: [],
      note: `No part of Arthur's synced record matches "${query}". The record is a curated snapshot generated ${dateText} covering lanes, decisions and operating rules — absence here means the topic is not in the record, not that it is untrue.`,
    };
  return {
    snapshotDate: date,
    matches,
    note: `Matches from Arthur's synced record (snapshot generated ${dateText}). The record is a curated snapshot, not a live sync; facts may have moved since.`,
  };
}

let cachedSnapshot: ArthurRecordSnapshot | null | undefined;

/**
 * Load and parse the bundled snapshot, once. Candidate paths cover the
 * tsx dev layout (module lives in apps/server/src/engine, asset in
 * apps/server/src/knowledge) and the compiled dist layout (module in
 * dist/apps/server/src/engine, asset copied beside it into
 * dist/apps/server/src/knowledge by build:server — see
 * scripts/copy-server-assets.mjs; the source tree is NOT guaranteed
 * to ship with a deploy, so the cwd candidates below are only a
 * fallback). Returns null when no candidate exists — the tool then
 * says so honestly instead of inventing recall.
 */
export function loadArthurRecordSnapshot(): ArthurRecordSnapshot | null {
  if (cachedSnapshot !== undefined) return cachedSnapshot;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const asset = "arthur-sync-state.md";
  const candidates = [
    path.join(moduleDir, "..", "knowledge", asset),
    path.join(process.cwd(), "apps", "server", "src", "knowledge", asset),
    path.join(moduleDir, "..", "..", "..", "..", "apps", "server", "src", "knowledge", asset),
    path.join(moduleDir, "..", "..", "..", "..", "..", "apps", "server", "src", "knowledge", asset),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    cachedSnapshot = parseArthurRecord(readFileSync(candidate, "utf8"));
    return cachedSnapshot;
  }
  cachedSnapshot = null;
  return cachedSnapshot;
}
