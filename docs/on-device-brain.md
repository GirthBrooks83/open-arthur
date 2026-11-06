# On-device brain

Open Arthur can chat with a small language model that runs **entirely on
the user's device** — no API key, no server, $0. It is a complement to
the cloud brain, never a silent replacement: the chat screen carries a
**Cloud / On this phone** toggle, and every reply says which brain
produced it.

## How it works

- The engine is a standalone web page, `apps/mobile/ondevice/`, bundled
  with esbuild into the web export at `/local-brain/` (engine.js +
  index.html) by `apps/mobile/scripts/build-local-brain.mjs`, which runs
  as part of `pnpm build:web`. It is deliberately **not** bundled
  through Metro: WebLLM is large and GPU-focused, it is only needed
  when the user picks the local brain, and isolating it means an
  engine problem can never break the main app build.
- The app (`apps/mobile/src/local-brain.web.tsx`) embeds the engine
  page in a hidden iframe and talks to it over `postMessage` using the
  protocol in `apps/mobile/ondevice/protocol.ts` (same-origin and
  source-checked on both sides). The engine runs WebLLM
  (`@mlc-ai/web-llm`) on WebGPU and streams replies back token by
  token.
- The server agent/task system is untouched: local mode is chat-only,
  in the UI, and local chats are not saved to the server.

## Models

The picker shows each model's download size **before** anything is
downloaded (with an explicit free-space warning — the target phone
runs low on storage). Weights are downloaded once from WebLLM's public
model host, cached on-device, and then work offline.

| Model | Download (approx.) | Notes |
| --- | --- | --- |
| Llama 3.2 1B Instruct (q4f16) | ~0.7 GB | Fast; simpler replies |
| Llama 3.2 3B Instruct (q4f16) | ~1.9 GB | Smarter; slower, larger |

## Honest limits

- Local mode needs WebGPU. Without it the UI says so plainly and the
  cloud chat is unaffected. (Chrome on Android is the reliable route;
  the models use f16 shaders, which the device GPU must support.)
- The local model has no tools, no memory of the user's apps or files,
  and noticeably weaker answers than the cloud brain. Its bubbles are
  labeled "On this phone · local model" so it is never passed off as
  the full Arthur.
- Engine states are explicit: not loaded / downloading (with %) /
  ready / generating / unavailable.
- Selection and state logic lives in `apps/mobile/src/brain.ts` and is
  covered by `apps/mobile/test/brain.test.ts`.
