# Approved integrations — status record

This file is the in-repo record of the integration stack the owner approved
on 2026-11-04, what is actually wired, and what is only staged. It mirrors
the lab's sync state (`arthur-sync/state.md`, generated from the lab
INVENTORY.md); if the two disagree, the lab record is the source and this
file is stale.

Rules that govern everything below:

- **Zero cost.** No paid tier, no card, no auto-converting trial.
- **Secrets stay out of the repo.** Every lane is configured by server-side
  environment variables only (see `.env.example`). Nothing here contains or
  implies a real key.
- **Honest status.** "Configured" means the config slot exists. "Verified"
  means a real request succeeded end-to-end, with the date it happened.

## Model lanes (selected by `MODEL=<lane>/<model-id>` + the lane key)

| Lane | Env key | Status |
| --- | --- | --- |
| Gemini (`google/…`) | `GOOGLE_API_KEY` | **Live, verified** 2026-11-03/04 — the default lane (`google/gemini-3.5-flash`). Free tier: synthetic data only. Free-tier quotas bite in real use (verified live 2026-11-05: 5 requests/minute and a small daily request cap on this project — a multi-step run can exhaust both). The task engine now waits out per-minute rate limits using the provider's suggested retry window and resumes the run (`engine/rate-limit.ts`). `MODEL`, `MODEL_FALLBACK` and `MODEL_FALLBACK_2` form an ordered provider chain (first entry whose provider key is set is active; shown at `/api/health` as `modelRouting` and recorded on each task): when a provider's quota is exhausted — a daily cap, or a window that keeps renewing — the run fails over to the next provider, records the switch in the task's events, and continues; only when every provider is exhausted does the task fail, with a plain-language "all providers exhausted" summary and the earliest suggested reset. |
| Groq (`groq/…`) | `GROQ_API_KEY` | **Live, verified** 2026-11-04 — free-tier grunt-work lane. Provider slot added in this change; previously an unrelated key could satisfy the configured check for a `groq/…` model. |
| Venice (`venice/…`) | `VENICE_API_KEY` | **Configured but UNVERIFIED.** Approved by the owner 2026-11-04. The model list reads fine (139 models), but chat completions returned HTTP 401 from Venice's side on 2026-11-04. Needs a fresh key and a passing chat test before anyone calls this lane working. |
| ATLAS (`openai/gpt-oss-120b` via Groq) | `GROQ_API_KEY` (on Groq's OpenAI-compatible endpoint) | **ON — free route (owner's orders 2026-11-04: "Turn ATLAS on" + "the free part of Atlas").** Powered by GPT-OSS 120B on the Groq free tier (`OPENAI_BASE_URL=https://api.groq.com/openai/v1`, selected as `MODEL=openai/openai/gpt-oss-120b` — see `.env.example` for why the id is doubled); this is **not a paid OpenAI API connection** and no paid `OPENAI_API_KEY` exists or will be funded for it. `/api/health` reports the lane with its provider, model, and billing classification: **free_then_paid with auto cut-off** — if the free route stops being free, the lane cuts off; it never charges. `ATLAS_LANE_ENABLED=false` turns it off. **Smoke record 2026-11-04:** health reports the lane ready; the route itself is proven at the API level (a chat completion through this exact endpoint + key returned a valid tool call with plan content from `openai/gpt-oss-120b`). Known gap: inside the task engine, this model's runs end without the engine's completion confirmation (tasks land in `waiting_input`, no error) — its reasoning-first responses return empty visible content at small token budgets. Engine-side fix (larger output budget / chat-completions mode for this lane) is future work; do not call engine completion verified until a task reaches `succeeded` on this lane. |
| Anthropic (`anthropic/…`) | `ANTHROPIC_API_KEY` | Slot exists (upstream). Parked — not part of the approved live stack. |

## External lanes (self-hosted services; URL set = lane on)

`/api/health` reports each of these as a boolean (configured or not).
Endpoints are read in `apps/server/src/config.ts` (`integrations`).

| Lane | Env var | Lab status (2026-11-04) |
| --- | --- | --- |
| OmniRoute | `OMNIROUTE_URL` | **Wired in the lab** — free model router; Groq lane answered in 0.48 s, Gemini lane in 2.6 s, both with real routed requests. Binds without an API key by default — set one before any long-running use. |
| Mem0 | `MEM0_URL` | **WIRED in the app (adapter: `apps/server/src/engine/mem0.ts`)** — memory saves mirror to the lane (`POST /add`) and task recall merges its facts (`GET /search`); the internal store stays canonical, so a down lane changes nothing. **The MAIN memory lane — chosen by the owner 2026-11-04** ("Mem0 it is"). Won the memory head-to-head: 15/15 in round 3, re-verified live 2026-11-04 (fresh container, persisted store). Its write path preserves budgets, dates, and preferences verbatim — exactly the fact classes the graph lane dropped. Known weakness, on record: corrections are additive, so a superseded fact can still rank first in recall — which is why the Graphiti side lane runs alongside it. |
| Graphiti | `GRAPHITI_URL` | **WIRED in the app (adapter: `apps/server/src/engine/graphiti.ts`)** — memory saves mirror to it as episodes (`POST /add`) and task recall merges its facts (`GET /search`) after Mem0's; the internal store stays canonical, so a down lane changes nothing. **The SIDE memory lane — runs alongside Mem0** (owner's expanded decision, 2026-11-04, minutes after picking Mem0: run both). Temporal knowledge-graph memory; fresh-process recall re-verified 2026-11-04 against a persisted embedded FalkorDB store (10/15 on the lab recall set; 8/15 in round 2 with the other extractor). Its job in the pair: the long-term/temporal graph and clean supersession — when a fact changes, the old value stops surfacing, covering Mem0's stale-first weakness. Both lanes stay usable. Note the write cost: `/add` runs full extraction lane-side (7–56 s per write measured against the lab service), so the adapter gives adds a 90 s budget while search keeps 4 s. Like Mem0, the lane service exposes no delete endpoint, so in-app "forget" removes the canonical internal copy only. |
| Hindsight | `HINDSIGHT_URL` | **The THIRD memory lane — runs beside Mem0 + Graphiti** (owner's order, 2026-11-04: "Add hindsight to run beside the other two"). Tied at the top of the memory head-to-head: 15/15 twice in round 5. Its write path keeps facts verbatim like Mem0, and on corrections the corrected value ranked first 2 of 3 times (Mem0: 0 of 3) — the ranking strength the main lane lacks. Heavy footprint, on record: over 1 GB RSS in the lab (~12× Mem0) and 1.3–2.3 s recall; it is a client/server lane (embedded Postgres store), not a library. |
| n8n | `N8N_URL` | **Wired in the local lab stack** — v2.46.6, hardened localhost-only boot, smoke workflow executed successfully. Fair-code (Sustainable Use License): internal use only, never offer it as a hosted service. Owner account creation is a first-UI-launch step that has deliberately not been done. |
| AnythingLLM | `ANYTHINGLLM_URL` | **Wired in the lab (server)** — installed, database migrated, production boot verified (HTTP 200; API answers 403 without auth, as expected). Collector and frontend installs remain. Lab scope only. |

## Tooling

| Item | Status |
| --- | --- |
| Biome | **Wired in this repo** — `biome.json`, `@biomejs/biome` devDependency, `pnpm lint` in the CI `quality` job. Gate record: `docs/biome-gate.md`. Codebase checks clean (111 files, 0 diagnostics, 2026-11-04). |

## Approved, represented here rather than wired into the server

These were approved by name on 2026-11-04. They are external tools or
app-side surfaces; forcing them into the server code would be decoration,
so this record is their in-repo representation until a real consumer
exists.

| Item | Why it lives here | Lab status (2026-11-04) |
| --- | --- | --- |
| Stagehand | Browser-automation SDK for the browser worker, not the API server. | Ready — live extract proven against a local model; observe/act need a larger local model than 1B. |
| Goose | Standalone agent binary (operator-side). | Ready — goose 1.22.1 runs; capability ceiling is the weak local 1B model. |
| Super Productivity | The operator's task board (GUI app). | Ready — AppImage v19.3.1 in daily use as the queue board; no headless surface exists to wire. |
| Phonon (xn-ptts) | On-device TTS for the voice lane (Phase 3). | Works — real speech synthesized in the lab; live voice-note wiring awaits the owner's go and a venv repair. |

## Staged for approval — NOT wired

Everything below is evaluated or catalogued in the lab and is **not** part
of this change. Each needs the owner's explicit approval before any wiring.

- **Memory challengers** (not chosen): Cognee (also scored 15/15 in the
  head-to-head, but heavy — ~925 MB and multi-second answers on the free
  tier), AgentDB, claude-mem (write path proven, semantic recall not
  yet). The winner, Mem0, is wired as the main memory lane above per
  the owner's 2026-11-04 decision, with Graphiti kept on as the side
  lane by his expanded decision the same evening — and Hindsight joined
  as the third lane by his order later that night, so it no longer sits
  in this staged list.
- **Orchestration:** LangGraph-JS (spike harness runs end-to-end),
  VoltAgent (held on install) — a pick-one spike decides; only the winner
  would be wired.
- **Coding bench:** Cline (held: needs Node 22+), OpenCode (ready),
  Aider (ready), Junie CLI (held on the owner's token), ast-grep (ready),
  PocketBase (held on binary; upstream repo archived — prototypes only).
- **Browser automation, second candidates:** Browser Use (held on
  install), Skyvern (AGPL-3.0, trial only, held on install).
- **Gateways:** LiteLLM (held on install; would duplicate OmniRoute —
  evaluate before ever wiring both).
- **Other:** Langfuse (was deferred by rule until the memory winner was
  named; the winner is now Mem0, but Langfuse itself still needs the
  owner's approval before any wiring), Strands TS SDK (held on harness),
  Letta Code (held on install), Agent Zero (held on security review —
  past-year CVE flags), Awesome LLM Apps (reference shelf; templates, not
  a component), changedetection.io, promptfoo, txtai (catalogued, not yet
  run).

## Locked off — do not wire

Bifrost (environment-blocked), OpenHands (benchmark-gated), Worktrunk
(lab-passed but locked by the owner), AgentSwarms (blocked for self-host:
license + RAM), call-me (blocked at $0: needs paid telephony), Windmill
(parked: host-class), Letta (upstream V1 retired; source gone), OpenClaw
(study only: malicious-package reports in its skill ecosystem).

## Free-window watch

- **Claude via Antigravity** is free at the strong level until
  **2026-11-18** (owner's report, 2026-11-04); no restart date announced.
  It is not wired into this stack — it is tracked on the owner's setup
  board so the lane is switched off before it can cost anything.
