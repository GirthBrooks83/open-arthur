import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARTHUR_RECORD_TOOL_NAME,
  loadArthurRecordSnapshot,
  MAX_RECALL_CHARS,
  parseArthurRecord,
  recallArthurRecord,
} from "../apps/server/src/engine/arthur-record.ts";
import { MUTATING_TOOLS } from "../apps/server/src/engine/service.ts";

const FIXTURE = `# Open Arthur → Arthur sync state
Generated: 2026-11-12T06:40:24-08:00 (America/Los_Angeles)
Repos tracked: 40 · Counts: {'on': 14, 'approved': 22, 'locked_off': 9, 'off': 1}

## ON — wired / live for Arthur
- **Mem0** — Memory layer for agents — THE chosen memory lane · _Chosen by Joseph 2026-11-04 — WIRED as the memory lane in Open Arthur_
- **n8n** — Self-hosted workflow automation · _WIRED in local lab stack_

## LOCKED OFF — dead / blocked / study-only
- **call-me** — Lets an agent phone Joseph · _BLOCKED at $0 (needs paid telephony)_

## Rules
- Curated, non-secret knowledge only — credentials, keys, and raw private memory never sync.
`;

describe("parseArthurRecord", () => {
  it("extracts the generated date and the sections", () => {
    const snapshot = parseArthurRecord(FIXTURE);
    assert.equal(snapshot.generatedAt, "2026-11-12T06:40:24-08:00");
    assert.deepEqual(
      snapshot.sections.map((s) => s.heading),
      [
        "Open Arthur → Arthur sync state",
        "ON — wired / live for Arthur",
        "LOCKED OFF — dead / blocked / study-only",
        "Rules",
      ],
    );
  });
});

describe("recallArthurRecord", () => {
  it("returns the matching section content with the snapshot date", () => {
    const snapshot = parseArthurRecord(FIXTURE);
    const result = recallArthurRecord(snapshot, "Mem0 memory lane");
    assert.equal(result.snapshotDate, "2026-11-12T06:40:24-08:00");
    // Best-scoring block leads (the Rules section also mentions "memory"
    // once, so it trails as a second, weaker match — keyword search).
    assert.equal(result.matches[0]?.heading, "ON — wired / live for Arthur");
    assert.match(result.matches[0]?.text ?? "", /Mem0/);
    assert.match(result.matches[0]?.text ?? "", /chosen memory lane/);
    assert.match(result.note, /snapshot generated 2026-11-12/);
  });

  it("surfaces a section whose heading matches even when no entry does", () => {
    const snapshot = parseArthurRecord(FIXTURE);
    const result = recallArthurRecord(snapshot, "locked off");
    // Heading hits sort first: the LOCKED OFF section leads, contributing
    // its first entry even though no entry text contains the terms (the
    // preamble also matches — it literally lists 'locked_off' counts).
    assert.equal(result.matches[0]?.heading, "LOCKED OFF — dead / blocked / study-only");
    assert.match(result.matches[0]?.text ?? "", /call-me/);
  });

  it("returns the honest empty result, with the snapshot date, when nothing matches", () => {
    const snapshot = parseArthurRecord(FIXTURE);
    const result = recallArthurRecord(snapshot, "underwater basket weaving");
    assert.deepEqual(result.matches, []);
    assert.equal(result.snapshotDate, "2026-11-12T06:40:24-08:00");
    assert.match(result.note, /No part of Arthur's synced record matches/);
    assert.match(result.note, /not in the record, not that it is untrue/);
  });

  it("caps the returned text and says so", () => {
    const entries = Array.from(
      { length: 150 },
      (_, i) => `- **Lane${i}** — lane filler text to give this entry some body length.`,
    ).join("\n");
    const snapshot = parseArthurRecord(
      `# Record\nGenerated: 2026-11-12T06:40:24-08:00\n\n## Lanes\n${entries}\n`,
    );
    const result = recallArthurRecord(snapshot, "lane");
    const total = result.matches.reduce((sum, m) => sum + m.text.length, 0);
    assert.ok(result.matches.length < 150);
    assert.ok(total <= MAX_RECALL_CHARS, `expected <= ${MAX_RECALL_CHARS}, got ${total}`);
    assert.match(result.note, /capped/);
  });

  it("is read-only: repeated recalls are identical and the snapshot is untouched", () => {
    const snapshot = parseArthurRecord(FIXTURE);
    const before = JSON.stringify(snapshot);
    const first = recallArthurRecord(snapshot, "Mem0");
    const second = recallArthurRecord(snapshot, "Mem0");
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(snapshot), before);
  });
});

describe("recall_arthur_record registration", () => {
  it("is named recall_arthur_record and is NOT a mutating tool", () => {
    assert.equal(ARTHUR_RECORD_TOOL_NAME, "recall_arthur_record");
    assert.equal(MUTATING_TOOLS.has(ARTHUR_RECORD_TOOL_NAME), false);
  });

  it("loads the bundled snapshot asset and recalls from it", () => {
    const snapshot = loadArthurRecordSnapshot();
    assert.ok(snapshot, "bundled arthur-sync-state.md should load");
    assert.match(snapshot.generatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    const result = recallArthurRecord(snapshot, "Mem0");
    assert.ok(result.matches.length >= 1);
    assert.match(result.matches[0]?.text ?? "", /Mem0/);
    assert.equal(result.snapshotDate, snapshot.generatedAt);
  });
});
