// Brain selection and on-device engine state for the chat screen.
//
// Two brains can answer a chat message:
//  - "cloud": the server agent (existing behavior; tools, memory, apps).
//  - "local": a small WebLLM model running entirely on the user's device
//    in the browser — no API key, no server, no cost. Chat only; it has
//    no tools and no access to the user's data, and the UI must always
//    say which brain answered.
//
// This module is the pure logic half (catalog rules, support detection,
// engine state machine). It has no React or DOM imports of its own so
// it can be unit tested directly; callers pass in what they detected.

import {
  DEFAULT_LOCAL_MODEL_ID,
  formatBytes,
  LOCAL_MODELS,
  type LocalModelOption,
  localModelById,
} from "../ondevice/protocol";

export type BrainMode = "cloud" | "local";

export { DEFAULT_LOCAL_MODEL_ID, formatBytes, LOCAL_MODELS, type LocalModelOption };

/**
 * Which model the picker starts on: the user's saved pick when it is
 * still in the catalog, otherwise the default model. A stale saved id
 * (model removed from the catalog in an update) must never strand the
 * picker on a model that no longer exists.
 */
export function resolveSavedModelId(saved: string | null | undefined): string {
  if (saved && localModelById(saved)) return saved;
  return DEFAULT_LOCAL_MODEL_ID;
}

/**
 * A downloaded model's cache may be deleted from the picker only when
 * the model is actually cached and is not the one currently loaded,
 * loading, or mid-reply — deleting weights out from under a live
 * engine would break the running model. Switching to another model
 * (or reloading the page) releases it.
 */
export function canDeleteModelCache(
  modelId: string,
  state: LocalBrainState,
  cachedModelIds: readonly string[],
): boolean {
  if (!cachedModelIds.includes(modelId)) return false;
  const busy =
    state.modelId === modelId &&
    (state.stage === "downloading" || state.stage === "ready" || state.stage === "generating");
  return !busy;
}

/** Downloads at or above this size get the strong storage warning. */
export const LARGE_DOWNLOAD_BYTES = 1_500_000_000;

/**
 * The plain-language storage warning shown before a model download.
 * Always mentions the size; large models get an explicit
 * check-your-free-space warning because the target phone runs low.
 */
export function downloadWarning(model: LocalModelOption): string {
  const size = formatBytes(model.downloadBytes);
  if (model.downloadBytes >= LARGE_DOWNLOAD_BYTES)
    return (
      `Large download: about ${size}, saved on this device. ` +
      "Check you have at least that much free space before starting — " +
      "if storage runs out mid-download the model will not load."
    );
  return (
    `One-time download of about ${size}, saved on this device so it works offline afterwards. ` +
    "Make sure you have at least that much free space."
  );
}

export type LocalBrainSupport = { supported: true } | { supported: false; reason: string };

/**
 * Feature detection for the on-device brain, as pure inputs so it is
 * testable. The on-device engine needs the web build and WebGPU.
 */
export function detectLocalBrainSupport(input: {
  isWeb: boolean;
  hasWebGPU: boolean;
}): LocalBrainSupport {
  if (!input.isWeb)
    return {
      supported: false,
      reason:
        "The on-device brain runs in the web app. Open Open Arthur in your phone's browser to use it.",
    };
  if (!input.hasWebGPU)
    return {
      supported: false,
      reason:
        "This browser doesn't offer WebGPU, so it can't run the local model. " +
        "On Android, Chrome with WebGPU enabled is the reliable route. Cloud chat above still works.",
    };
  return { supported: true };
}

export type LocalBrainStage =
  | "idle" // model not downloaded/loaded yet
  | "downloading" // engine init in flight (download + GPU load)
  | "ready" // loaded; can chat
  | "generating" // a reply is streaming
  | "error"; // something failed; `note` says what, in plain language

export interface LocalBrainState {
  stage: LocalBrainStage;
  /** 0..1 while downloading, otherwise 0. */
  progress: number;
  /** Last status line from the engine (download step or error message). */
  note: string;
  modelId: string | null;
}

export const initialLocalBrainState: LocalBrainState = {
  stage: "idle",
  progress: 0,
  note: "",
  modelId: null,
};

export type LocalBrainEvent =
  | { type: "init-started"; modelId: string }
  | { type: "progress"; progress: number; text: string }
  | { type: "engine-ready" }
  | { type: "generation-started" }
  | { type: "generation-finished" }
  | { type: "failed"; message: string }
  | { type: "reset" };

export function localBrainReducer(state: LocalBrainState, event: LocalBrainEvent): LocalBrainState {
  switch (event.type) {
    case "init-started":
      // Switching models always goes back through a download/load.
      return { stage: "downloading", progress: 0, note: "Starting…", modelId: event.modelId };
    case "progress":
      if (state.stage !== "downloading") return state;
      return {
        ...state,
        progress: Math.min(1, Math.max(0, event.progress)),
        note: event.text || state.note,
      };
    case "engine-ready":
      if (state.stage !== "downloading") return state;
      return { ...state, stage: "ready", progress: 0, note: "" };
    case "generation-started":
      if (state.stage !== "ready") return state;
      return { ...state, stage: "generating" };
    case "generation-finished":
      if (state.stage !== "generating") return state;
      return { ...state, stage: "ready" };
    case "failed":
      return { ...state, stage: "error", progress: 0, note: event.message };
    case "reset":
      return initialLocalBrainState;
  }
}

/** Sending is only possible once the model is loaded and idle. */
export function canChatLocally(state: LocalBrainState): boolean {
  return state.stage === "ready";
}

/**
 * The honest label for who produced (or will produce) the next reply.
 * The UI shows this in both modes so a local answer is never passed
 * off as the full cloud Arthur.
 */
export function brainBadge(mode: BrainMode, local: LocalBrainState): string {
  if (mode === "cloud") return "Brain: Cloud — full Arthur (tools, memory, your apps)";
  switch (local.stage) {
    case "ready":
    case "generating":
      return "Brain: On this phone — small local model, chat only, nothing leaves the device";
    case "downloading":
      return "Brain: On this phone — model loading…";
    case "error":
      return "Brain: On this phone — unavailable right now";
    default:
      return "Brain: On this phone — model not loaded yet";
  }
}

/** Prefix every local assistant bubble carries about its limits. */
export const LOCAL_REPLY_LABEL = "On this phone · local model";
