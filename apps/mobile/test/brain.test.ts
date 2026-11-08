import assert from "node:assert/strict";
import { test } from "node:test";
import {
  brainBadge,
  canChatLocally,
  canDeleteModelCache,
  DEFAULT_LOCAL_MODEL_ID,
  detectLocalBrainSupport,
  downloadWarning,
  formatBytes,
  initialLocalBrainState,
  LARGE_DOWNLOAD_BYTES,
  LOCAL_MODELS,
  type LocalBrainState,
  localBrainReducer,
  resolveSavedModelId,
} from "../src/brain.ts";

test("the picker offers a fast small model and a smarter bigger one, sizes ascending", () => {
  const [fast, smart] = LOCAL_MODELS;
  assert.ok(fast && smart);
  assert.match(fast.id, /1B/);
  assert.match(smart.id, /3B/);
  assert.ok(fast.downloadBytes < smart.downloadBytes);
  assert.ok(fast.downloadBytes > 0);
  // Sizes are part of the consent shown before download: both models
  // must carry a real number, and the big one crosses the warning line.
  assert.ok(smart.downloadBytes >= LARGE_DOWNLOAD_BYTES);
  assert.ok(fast.downloadBytes < LARGE_DOWNLOAD_BYTES);
});

test("the picker offers four models with the exact WebLLM catalog ids", () => {
  // Ids must match WebLLM 0.2.87's prebuiltAppConfig exactly — a typo'd
  // id only fails at download time on the phone, so pin them here.
  assert.deepEqual(
    LOCAL_MODELS.map((model) => model.id),
    [
      "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      "Llama-3.2-3B-Instruct-q4f16_1-MLC",
      "Qwen2.5-3B-Instruct-q4f16_1-MLC",
      "gemma-2-2b-it-q4f16_1-MLC",
    ],
  );
  for (const model of LOCAL_MODELS) {
    assert.ok(model.downloadBytes > 0, model.id);
    assert.ok(model.vramMB > 0, model.id);
    assert.ok(model.label.length > 0, model.id);
  }
  // The smallest download is the 1B; nothing in the list is a toy size.
  const smallest = Math.min(...LOCAL_MODELS.map((model) => model.downloadBytes));
  assert.equal(smallest, LOCAL_MODELS[0]?.downloadBytes);
});

test("the default model is Llama 3.2 3B, and saved picks resolve against the catalog", () => {
  assert.equal(DEFAULT_LOCAL_MODEL_ID, "Llama-3.2-3B-Instruct-q4f16_1-MLC");
  assert.ok(LOCAL_MODELS.some((model) => model.id === DEFAULT_LOCAL_MODEL_ID));
  // No saved pick (or storage unavailable) → the default.
  assert.equal(resolveSavedModelId(null), DEFAULT_LOCAL_MODEL_ID);
  assert.equal(resolveSavedModelId(undefined), DEFAULT_LOCAL_MODEL_ID);
  assert.equal(resolveSavedModelId(""), DEFAULT_LOCAL_MODEL_ID);
  // A saved pick still in the catalog is honored.
  assert.equal(resolveSavedModelId("gemma-2-2b-it-q4f16_1-MLC"), "gemma-2-2b-it-q4f16_1-MLC");
  // A stale saved pick (model dropped from the catalog) falls back.
  assert.equal(resolveSavedModelId("Some-Removed-Model-MLC"), DEFAULT_LOCAL_MODEL_ID);
});

test("cache deletion is offered only for cached models that are not in use", () => {
  const cached = ["Llama-3.2-1B-Instruct-q4f16_1-MLC", "Qwen2.5-3B-Instruct-q4f16_1-MLC"];
  // Idle: any cached model can go; uncached ones cannot.
  assert.equal(
    canDeleteModelCache("Llama-3.2-1B-Instruct-q4f16_1-MLC", initialLocalBrainState, cached),
    true,
  );
  assert.equal(
    canDeleteModelCache("Llama-3.2-3B-Instruct-q4f16_1-MLC", initialLocalBrainState, cached),
    false,
  );
  // The loaded model is protected while ready/generating/downloading…
  const ready: LocalBrainState = {
    stage: "ready",
    progress: 0,
    note: "",
    modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  };
  assert.equal(canDeleteModelCache("Llama-3.2-1B-Instruct-q4f16_1-MLC", ready, cached), false);
  assert.equal(
    canDeleteModelCache(
      "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      { ...ready, stage: "generating" },
      cached,
    ),
    false,
  );
  assert.equal(
    canDeleteModelCache(
      "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      { ...ready, stage: "downloading" },
      cached,
    ),
    false,
  );
  // …but other cached models stay removable, and an errored load frees it.
  assert.equal(canDeleteModelCache("Qwen2.5-3B-Instruct-q4f16_1-MLC", ready, cached), true);
  assert.equal(
    canDeleteModelCache("Llama-3.2-1B-Instruct-q4f16_1-MLC", { ...ready, stage: "error" }, cached),
    true,
  );
});

test("formatBytes renders phone-friendly sizes", () => {
  assert.equal(formatBytes(700_000_000), "0.7 GB");
  assert.equal(formatBytes(1_900_000_000), "1.9 GB");
  assert.equal(formatBytes(12_000_000), "12 MB");
});

test("every model gets a storage warning naming its size; big models get the strong one", () => {
  for (const model of LOCAL_MODELS) {
    const warning = downloadWarning(model);
    assert.match(warning, /free space/i);
    assert.ok(warning.includes(formatBytes(model.downloadBytes)), warning);
  }
  const big = LOCAL_MODELS[1];
  assert.ok(big);
  assert.match(downloadWarning(big), /Large download/);
  const small = LOCAL_MODELS[0];
  assert.ok(small);
  assert.doesNotMatch(downloadWarning(small), /Large download/);
});

test("support detection: web + WebGPU only, with plain-language reasons", () => {
  assert.deepEqual(detectLocalBrainSupport({ isWeb: true, hasWebGPU: true }), {
    supported: true,
  });
  const noGpu = detectLocalBrainSupport({ isWeb: true, hasWebGPU: false });
  assert.equal(noGpu.supported, false);
  if (!noGpu.supported) assert.match(noGpu.reason, /WebGPU/);
  const notWeb = detectLocalBrainSupport({ isWeb: false, hasWebGPU: true });
  assert.equal(notWeb.supported, false);
  if (!notWeb.supported) assert.match(notWeb.reason, /web app/);
});

test("engine state machine: idle → downloading → ready → generating → ready", () => {
  let state: LocalBrainState = initialLocalBrainState;
  assert.equal(canChatLocally(state), false);

  state = localBrainReducer(state, { type: "init-started", modelId: "m1" });
  assert.equal(state.stage, "downloading");
  assert.equal(state.modelId, "m1");

  state = localBrainReducer(state, { type: "progress", progress: 0.5, text: "Fetching weights" });
  assert.equal(state.progress, 0.5);
  assert.equal(state.note, "Fetching weights");
  assert.equal(canChatLocally(state), false);

  // Out-of-range progress is clamped.
  state = localBrainReducer(state, { type: "progress", progress: 7, text: "" });
  assert.equal(state.progress, 1);

  state = localBrainReducer(state, { type: "engine-ready" });
  assert.equal(state.stage, "ready");
  assert.equal(canChatLocally(state), true);

  state = localBrainReducer(state, { type: "generation-started" });
  assert.equal(state.stage, "generating");
  assert.equal(canChatLocally(state), false);

  state = localBrainReducer(state, { type: "generation-finished" });
  assert.equal(state.stage, "ready");
  assert.equal(canChatLocally(state), true);
});

test("stray events cannot corrupt the state machine", () => {
  // Progress before init is ignored.
  assert.equal(
    localBrainReducer(initialLocalBrainState, { type: "progress", progress: 0.3, text: "x" }),
    initialLocalBrainState,
  );
  // Ready before a download starts is ignored.
  assert.equal(localBrainReducer(initialLocalBrainState, { type: "engine-ready" }).stage, "idle");
  // Generation can only start from ready.
  assert.equal(
    localBrainReducer(initialLocalBrainState, { type: "generation-started" }).stage,
    "idle",
  );
});

test("failure surfaces from any stage and reset returns to idle", () => {
  let state = localBrainReducer(initialLocalBrainState, { type: "init-started", modelId: "m1" });
  state = localBrainReducer(state, { type: "failed", message: "Out of GPU memory" });
  assert.equal(state.stage, "error");
  assert.equal(state.note, "Out of GPU memory");
  assert.equal(canChatLocally(state), false);
  state = localBrainReducer(state, { type: "reset" });
  assert.deepEqual(state, initialLocalBrainState);
});

test("switching models re-enters the download stage for the new model", () => {
  let state = localBrainReducer(initialLocalBrainState, { type: "init-started", modelId: "m1" });
  state = localBrainReducer(state, { type: "engine-ready" });
  state = localBrainReducer(state, { type: "init-started", modelId: "m2" });
  assert.equal(state.stage, "downloading");
  assert.equal(state.modelId, "m2");
});

test("badges never let a local answer pass as the cloud Arthur", () => {
  assert.match(brainBadge("cloud", initialLocalBrainState), /Cloud/);
  const ready: LocalBrainState = { stage: "ready", progress: 0, note: "", modelId: "m1" };
  const badge = brainBadge("local", ready);
  assert.match(badge, /On this phone/);
  assert.match(badge, /nothing leaves the device/);
  assert.match(brainBadge("local", initialLocalBrainState), /not loaded yet/);
  const failed: LocalBrainState = { ...ready, stage: "error", note: "boom" };
  assert.match(brainBadge("local", failed), /unavailable/);
});
