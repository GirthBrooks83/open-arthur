// On-device brain engine page.
//
// This file is bundled by esbuild (see scripts/build-local-brain.mjs)
// into the web export as /local-brain/engine.js and loaded by
// /local-brain/index.html inside a hidden iframe in the app. It never
// ships through Metro. It runs a WebLLM model on the device GPU and
// talks to the app only through the postMessage protocol in
// ./protocol.ts. Nothing here touches the network except the one-time
// model download from WebLLM's public model host; after that the
// weights are cached on-device and chat works offline.

import {
  CreateMLCEngine,
  deleteModelAllInfoInCache,
  hasModelInCache,
  type MLCEngine,
} from "@mlc-ai/web-llm";
import {
  type EngineChatMessage,
  type EngineEvent,
  type EngineRequest,
  isEngineRequest,
  LOCAL_MODELS,
  localModelById,
  ON_DEVICE_SYSTEM_PROMPT,
} from "./protocol";

let engine: MLCEngine | undefined;
let loadedModelId: string | undefined;
let loading: Promise<void> | undefined;
let activeGeneration: string | undefined;

function post(event: EngineEvent): void {
  window.parent.postMessage(event, window.location.origin);
}

function fail(message: string, id?: string): void {
  post({ kind: "local-brain:error", id, message });
}

function hasWebGPU(): boolean {
  if (typeof navigator === "undefined") return false;
  // WebGPU isn't in this project's TS DOM types yet; probe structurally.
  const gpu = (navigator as unknown as { gpu?: unknown }).gpu;
  return typeof gpu === "object" && gpu !== null;
}

async function init(modelId: string): Promise<void> {
  if (!hasWebGPU()) {
    fail(
      "This browser doesn't offer WebGPU, so the on-device model can't run here. " +
        "Cloud chat in the app still works.",
    );
    return;
  }
  if (engine && loadedModelId === modelId) {
    post({ kind: "local-brain:ready" });
    return;
  }
  if (loading) {
    // A load is already in flight; its progress/ready events serve both.
    await loading;
    if (loadedModelId === modelId) post({ kind: "local-brain:ready" });
    return;
  }
  const onProgress = (report: { progress: number; text: string }) =>
    post({ kind: "local-brain:progress", text: report.text, progress: report.progress });
  loading = (async () => {
    try {
      if (engine) {
        engine.setInitProgressCallback(onProgress);
        await engine.reload(modelId);
      } else {
        engine = await CreateMLCEngine(modelId, { initProgressCallback: onProgress });
      }
      loadedModelId = modelId;
      post({ kind: "local-brain:ready" });
      // A fresh download just landed in the cache; keep the picker honest.
      void postCacheStatus();
    } catch (error) {
      fail(
        `The on-device model couldn't load: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      loading = undefined;
    }
  })();
  await loading;
}

async function generate(id: string, history: EngineChatMessage[]): Promise<void> {
  if (!engine || !loadedModelId) {
    fail("The on-device model isn't loaded yet.", id);
    return;
  }
  activeGeneration = id;
  try {
    const messages: EngineChatMessage[] = [
      { role: "system", content: ON_DEVICE_SYSTEM_PROMPT },
      ...history.filter((message) => message.role !== "system"),
    ];
    const chunks = await engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 600,
    });
    let text = "";
    for await (const chunk of chunks) {
      if (activeGeneration !== id) return; // interrupted or superseded
      text += chunk.choices[0]?.delta.content ?? "";
      post({ kind: "local-brain:delta", id, text });
    }
    if (activeGeneration === id) {
      activeGeneration = undefined;
      post({ kind: "local-brain:done", id });
    }
  } catch (error) {
    if (activeGeneration === id) {
      activeGeneration = undefined;
      fail(
        `The on-device model stopped while replying: ${error instanceof Error ? error.message : String(error)}`,
        id,
      );
    }
  }
}

async function interrupt(id: string): Promise<void> {
  if (activeGeneration !== id) return;
  activeGeneration = undefined;
  try {
    await engine?.interruptGenerate();
  } catch {
    // Interrupting is best-effort; the generation guard above already
    // stops further deltas from being posted.
  }
  post({ kind: "local-brain:done", id });
}

async function postCacheStatus(): Promise<void> {
  const cached: string[] = [];
  for (const model of LOCAL_MODELS) {
    try {
      if (await hasModelInCache(model.id)) cached.push(model.id);
    } catch {
      // A cache probe failing for one model must not hide the others.
    }
  }
  post({ kind: "local-brain:cache", cached });
}

async function deleteCache(modelId: string): Promise<void> {
  if (!localModelById(modelId)) {
    fail(`Unknown on-device model: ${modelId}`);
    return;
  }
  if (loadedModelId === modelId) {
    fail(
      "That model is loaded right now — switch to another model first, then remove its download.",
    );
    return;
  }
  try {
    await deleteModelAllInfoInCache(modelId);
    post({ kind: "local-brain:cache-deleted", modelId });
  } catch (error) {
    fail(
      `The downloaded model couldn't be removed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await postCacheStatus();
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  // Only the hosting app page (same origin, our parent frame) may drive us.
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  if (!isEngineRequest(event.data)) return;
  const request: EngineRequest = event.data;
  if (request.kind === "local-brain:init") void init(request.modelId);
  else if (request.kind === "local-brain:generate") void generate(request.id, request.messages);
  else if (request.kind === "local-brain:interrupt") void interrupt(request.id);
  else if (request.kind === "local-brain:cache-status") void postCacheStatus();
  else if (request.kind === "local-brain:delete-cache") void deleteCache(request.modelId);
});

// Announce ourselves so the app can tell "engine page loaded" apart
// from "engine files missing" (e.g. a dev server without the bundle).
post({ kind: "local-brain:hello" });
