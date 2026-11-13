import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ConsultRecord,
  closeConsultByThread,
  findOpenConsult,
  openConsult,
  staleConsults,
} from "../apps/server/src/engine/consults.ts";
import { deriveStaleConsultItems } from "../apps/server/src/engine/daily-brief.ts";

const INPUT = {
  id: "c1",
  taskId: "task-1",
  question: "ATLAS: is the router the right seam for per-task models?",
  audience: "atlas" as const,
  channel: "C0CEJ24DUNR",
  postedTs: "1794550000.000100",
  createdAt: "2026-11-12T10:00:00.000Z",
};

describe("openConsult", () => {
  it("opens a consult and finds it again", () => {
    const { consults, consult, error } = openConsult([], INPUT);
    assert.equal(error, undefined);
    assert.equal(consult?.status, "open");
    assert.equal(findOpenConsult(consults, "task-1")?.id, "c1");
    assert.equal(findOpenConsult(consults, "other-task"), undefined);
  });

  it("refuses a second open consult for the same task", () => {
    const first = openConsult([], INPUT);
    const second = openConsult(first.consults, {
      ...INPUT,
      id: "c2",
      postedTs: "1794550001.000100",
    });
    assert.equal(second.consult, undefined);
    assert.match(second.error ?? "", /already has an open consult/);
    assert.equal(second.consults.length, 1);
  });

  it("allows a new consult once the previous one is answered", () => {
    const first = openConsult([], INPUT);
    const closed = closeConsultByThread(
      first.consults,
      INPUT.postedTs,
      "Yes — the router.",
      "2026-11-12T12:00:00.000Z",
    );
    const second = openConsult(closed.consults, {
      ...INPUT,
      id: "c2",
      postedTs: "1794550002.000100",
    });
    assert.equal(second.error, undefined);
    assert.equal(second.consults.length, 2);
  });
});

describe("closeConsultByThread", () => {
  it("closes the matching open consult and stores the answer as data", () => {
    const { consults } = openConsult([], INPUT);
    const { consults: next, closed } = closeConsultByThread(
      consults,
      INPUT.postedTs,
      "Ship it.",
      "2026-11-12T12:00:00.000Z",
    );
    assert.equal(closed?.status, "answered");
    assert.equal(closed?.answerText, "Ship it.");
    assert.equal(closed?.answeredAt, "2026-11-12T12:00:00.000Z");
    assert.equal(next[0].status, "answered");
  });

  it("ignores replies that match no open consult", () => {
    const { consults } = openConsult([], INPUT);
    const { consults: next, closed } = closeConsultByThread(
      consults,
      "9999999999.999999",
      "Unrelated thread reply",
      "2026-11-12T12:00:00.000Z",
    );
    assert.equal(closed, undefined);
    assert.equal(next[0].status, "open");
  });

  it("does not re-close an answered consult", () => {
    const { consults } = openConsult([], INPUT);
    const once = closeConsultByThread(
      consults,
      INPUT.postedTs,
      "First",
      "2026-11-12T12:00:00.000Z",
    );
    const twice = closeConsultByThread(
      once.consults,
      INPUT.postedTs,
      "Second",
      "2026-11-12T13:00:00.000Z",
    );
    assert.equal(twice.closed, undefined);
    assert.equal(twice.consults[0].answerText, "First");
  });
});

describe("staleConsults", () => {
  const NOW = new Date("2026-11-14T10:00:01.000Z");

  it("lists open consults older than the threshold only", () => {
    const old: ConsultRecord = { ...INPUT, status: "open" };
    const fresh: ConsultRecord = {
      ...INPUT,
      id: "c2",
      taskId: "task-2",
      postedTs: "1794550003.000100",
      createdAt: "2026-11-14T09:00:00.000Z",
      status: "open",
    };
    const answered: ConsultRecord = {
      ...INPUT,
      id: "c3",
      taskId: "task-3",
      postedTs: "1794550004.000100",
      status: "answered",
    };
    const stale = staleConsults([old, fresh, answered], NOW);
    assert.deepEqual(
      stale.map((c) => c.id),
      ["c1"],
    );
  });
});

describe("deriveStaleConsultItems (Daily Brief surfacing)", () => {
  it("shapes a stale open consult as a needs-decision item and skips the rest", () => {
    const stale: ConsultRecord = { ...INPUT, status: "open" };
    const fresh: ConsultRecord = {
      ...INPUT,
      id: "c2",
      taskId: "task-2",
      postedTs: "1794550003.000100",
      createdAt: "2026-11-14T09:00:00.000Z",
      status: "open",
    };
    const items = deriveStaleConsultItems([stale, fresh], new Date("2026-11-14T10:00:01.000Z"));
    assert.equal(items.length, 1);
    assert.equal(items[0].taskId, "task-1");
    assert.equal(items[0].status, "open_consult");
    assert.match(items[0].title, /unanswered for 2 days — asked ATLAS/);
    assert.match(items[0].detail ?? "", /router the right seam/);
  });
});
