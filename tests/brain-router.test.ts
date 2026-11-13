import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyTaskText,
  DailyGoogleBudget,
  modelFamily,
  routeModels,
  type BrainBudget,
} from "../apps/server/src/engine/brain-router.ts";

const CHAIN = ["openai/qwen/qwen3.8-27b", "google/gemini-3.5-flash"] as const;
const BUDGET_OK: BrainBudget = { googleUsedToday: 3, googleDailyBudget: 15 };
const BUDGET_SPENT: BrainBudget = { googleUsedToday: 15, googleDailyBudget: 15 };

describe("classifyTaskText", () => {
  it("classifies coding work", () => {
    assert.equal(classifyTaskText("Fix the bug in the login function"), "coding");
    assert.equal(classifyTaskText("Debug this stack trace and refactor"), "coding");
  });

  it("classifies research work", () => {
    assert.equal(classifyTaskText("Research and compare the best options"), "research");
  });

  it("classifies architecture and security work", () => {
    assert.equal(classifyTaskText("Review the security threat model for the schema migration"), "architecture");
  });

  it("classifies strategy work", () => {
    assert.equal(classifyTaskText("Draft the roadmap and decide whether to prioritise shipping"), "strategy");
  });

  it("classifies multimodal work", () => {
    assert.equal(classifyTaskText("Describe what is in this screenshot image"), "multimodal");
  });

  it("defaults to routine when nothing matches", () => {
    assert.equal(classifyTaskText("Say hello and summarise the day"), "routine");
    assert.equal(classifyTaskText(""), "routine");
  });
});

describe("modelFamily", () => {
  it("recognises the two production families", () => {
    assert.equal(modelFamily("google/gemini-3.5-flash"), "google");
    assert.equal(modelFamily("openai/qwen/qwen3.8-27b"), "groq");
    assert.equal(modelFamily(undefined), "other");
    assert.equal(modelFamily(""), "other");
  });
});

describe("routeModels", () => {
  it("keeps chain order for routine and coding tasks", () => {
    for (const taskClass of ["routine", "coding"] as const) {
      const decision = routeModels(taskClass, CHAIN, BUDGET_OK);
      assert.deepEqual(decision.orderedModels, [...CHAIN]);
      assert.match(decision.reason, /fast family first/);
    }
  });

  it("puts the deep family first for research within budget", () => {
    const decision = routeModels("research", CHAIN, BUDGET_OK);
    assert.deepEqual(decision.orderedModels, [CHAIN[1], CHAIN[0]]);
    assert.match(decision.reason, /deep family first/);
  });

  it("degrades to chain order when the google budget is spent", () => {
    const decision = routeModels("research", CHAIN, BUDGET_SPENT);
    assert.deepEqual(decision.orderedModels, [...CHAIN]);
    assert.match(decision.reason, /budget exhausted/);
  });

  it("keeps chain order when no google model is configured", () => {
    const decision = routeModels("strategy", ["openai/qwen/qwen3.8-27b"], BUDGET_OK);
    assert.deepEqual(decision.orderedModels, ["openai/qwen/qwen3.8-27b"]);
    assert.match(decision.reason, /no google-family model/);
  });

  it("handles an empty chain without inventing models", () => {
    const decision = routeModels("routine", [undefined, ""], BUDGET_OK);
    assert.deepEqual(decision.orderedModels, []);
  });

  it("skips empty chain entries", () => {
    const decision = routeModels("routine", [undefined, CHAIN[0], ""], BUDGET_OK);
    assert.deepEqual(decision.orderedModels, [CHAIN[0]]);
  });
});

describe("DailyGoogleBudget", () => {
  const DAY1 = new Date("2026-11-12T12:00:00Z");
  const DAY2 = new Date("2026-11-13T00:00:01Z");

  it("counts uses and reports the snapshot routeModels consumes", () => {
    const budget = new DailyGoogleBudget(2);
    assert.deepEqual(budget.snapshot(DAY1), { googleUsedToday: 0, googleDailyBudget: 2 });
    budget.recordUse(DAY1);
    budget.recordUse(DAY1);
    // At the cap, a deep class degrades to chain order.
    const decision = routeModels("research", CHAIN, budget.snapshot(DAY1));
    assert.deepEqual(decision.orderedModels, [...CHAIN]);
    assert.match(decision.reason, /budget exhausted/);
  });

  it("rolls over at the UTC day boundary", () => {
    const budget = new DailyGoogleBudget(2);
    budget.recordUse(DAY1);
    budget.recordUse(DAY1);
    assert.equal(budget.snapshot(DAY2).googleUsedToday, 0);
  });

  it("ignores invalid caps and keeps the previous one", () => {
    const budget = new DailyGoogleBudget(5);
    budget.setCap(0);
    budget.setCap(-3);
    budget.setCap(2.5);
    assert.equal(budget.snapshot(DAY1).googleDailyBudget, 5);
    budget.setCap(9);
    assert.equal(budget.snapshot(DAY1).googleDailyBudget, 9);
  });
});
