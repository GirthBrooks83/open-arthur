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
| Gemini (`google/…`) | `GOOGLE_API_KEY` | **Live, verified** 2026-11-03/04 — the default lane (`google/gemini-3.5-flash`). Free tier: synthetic data only. |
| Groq (`groq/…`) | `GROQ_API_KEY` | **Live, verified** 2026-11-04 — free-tier grunt-work lane. Provider slot added in this change; previously an unrelated key could satisfy the configured check for a `groq/…` model. |
| Venice (`venice/…`) | `VENICE_API_KEY` | **Configured but UNVERIFIED.** Approved by the owner 2026-11-04. The model list reads fine (139 models), but chat completions returned HTTP 401 from Venice's side on 2026-11-04. Needs a fresh key and a passing chat test before anyone calls this lane working. |
| ATLAS / OpenAI (`openai/…`) | `OPENAI_API_KEY` | **Config placeholder only — stays OFF.** The owner will not fund a paid OpenAI key. The slot exists so the lane can be enabled by configuration if that ever changes; no key is set. |
| Anthropic (`anthropic/…`) | `ANTHROPIC_API_KEY` | Slot exists (upstream). Parked — not part of the approved live stack. |

## External lanes (self-hosted services; URL set = lane on)

`/api/health` reports each of these as a boolean (configured or not).
Endpoints are read in `apps/server/src/config.ts` (`integrations`).

| Lane | Env var | Lab status (2026-11-04) |
| --- | --- | --- |
| OmniRoute | `OMNIROUTE_URL` | **Wired in the lab** — free model router; Groq lane answered in 0.48 s, Gemini lane in 2.6 s, both with real routed requests. Binds without an API key by default — set one before any long-running use. |
| Graphiti | `GRAPHITI_URL` | **Wired in the lab harness** — temporal knowledge-graph memory, the approved memory lane. Fresh-process recall re-verified 2026-11-04 against a persisted embedded FalkorDB store (10/15 on the lab recall set). The memory head-to-head is still running (a challenger, Mem0, scored 15/15 in round 3); switching the approved memory lane is the owner's decision, not an automatic swap. |
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

- **Memory challengers** (head-to-head still open): Mem0 (round 3: 15/15 —
  see the Graphiti note above; the switch decision is the owner's),
  Cognee, Hindsight, AgentDB, claude-mem (write path proven, semantic
  recall not yet).
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
- **Other:** Langfuse (deferred by rule: no observability server before
  the memory winner is named), Strands TS SDK (held on harness),
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
