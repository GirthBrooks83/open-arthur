// Shared contract for Open Arthur's on-device ("local") brain.
//
// The on-device engine is a small standalone web page (index.html +
// engine.js, built from this folder into the web export under
// /local-brain/) that runs a WebLLM model entirely on the user's device
// via WebGPU. It is deliberately NOT bundled into the React Native /
// Metro app: the app talks to it over postMessage using the message
// types below, so a bundling or engine failure can never break the
// main app, and the engine can be loaded lazily only when asked for.
//
// This file is pure data and types — no React, no DOM, no web-llm
// imports — so the app UI, the engine page, and the unit tests can all
// share one definition of the models and the wire protocol.

export interface LocalModelOption {
  /** WebLLM prebuilt model id. */
  id: string;
  label: string;
  blurb: string;
  /**
   * Approximate one-time download size in bytes (model weights dominate).
   * Shown to the user BEFORE any download starts — the target phone is
   * low on storage, so this number is part of the consent, not a footnote.
   */
  downloadBytes: number;
  /** GPU memory the model needs once loaded, from WebLLM's catalog. */
  vramMB: number;
}

export const LOCAL_MODELS: LocalModelOption[] = [
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Fast — Llama 3.2 (1B)",
    blurb: "Smallest download. Quick, simpler replies.",
    downloadBytes: 700_000_000,
    vramMB: 880,
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Smarter — Llama 3.2 (3B)",
    blurb: "Better answers, but a much bigger download and slower on most phones.",
    downloadBytes: 1_900_000_000,
    vramMB: 2_265,
  },
];

export function localModelById(id: string): LocalModelOption | undefined {
  return LOCAL_MODELS.find((model) => model.id === id);
}

export function formatBytes(bytes: number): string {
  // Show tenths of a GB from 0.1 GB up — "0.7 GB" reads better than
  // "700 MB" in the download warning on a phone.
  if (bytes >= 100_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/** The system prompt the on-device model runs with — small models need it short. */
export const ON_DEVICE_SYSTEM_PROMPT =
  "You are Arthur, a friendly assistant running entirely on this phone. " +
  "You are a small local model: you cannot browse the web, use tools, or see the user's apps or files. " +
  "Keep answers short, clear, and honest. If a question needs the internet or the user's data, say so plainly.";

export interface EngineChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Messages the app sends into the engine page. */
export type EngineRequest =
  | { kind: "local-brain:init"; modelId: string }
  | { kind: "local-brain:generate"; id: string; messages: EngineChatMessage[] }
  | { kind: "local-brain:interrupt"; id: string };

/** Messages the engine page posts back to the app. */
export type EngineEvent =
  /** Posted as soon as the engine script runs, so the app knows the page loaded. */
  | { kind: "local-brain:hello" }
  | { kind: "local-brain:progress"; text: string; progress: number }
  | { kind: "local-brain:ready" }
  /** Cumulative reply text for the in-flight generation. */
  | { kind: "local-brain:delta"; id: string; text: string }
  | { kind: "local-brain:done"; id: string }
  | { kind: "local-brain:error"; id?: string; message: string };

export function isEngineEvent(value: unknown): value is EngineEvent {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.startsWith("local-brain:");
}

export function isEngineRequest(value: unknown): value is EngineRequest {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "local-brain:init" ||
    kind === "local-brain:generate" ||
    kind === "local-brain:interrupt"
  );
}
