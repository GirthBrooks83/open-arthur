# Biome gate

OpenMuse uses [Biome](https://biomejs.dev) as its single formatter + linter for
JS/TS/JSX/JSON/CSS/GraphQL. It replaces ESLint + Prettier with one binary.

## Where it lives

- Config: `biome.json` (schema pinned to the installed Biome version;
  formatter: space indent, line width 100, double quotes; linter: recommended
  preset with `useExhaustiveDependencies` and `noSvgWithoutTitle` off;
  organize-imports assist on; `node_modules`, `.expo`, `dist`, `ios`,
  `android`, `.openmuse`, `artifacts` excluded).
- Dependency: `@biomejs/biome` in root `devDependencies`.
- Scripts: `pnpm lint` = `biome check .` (check only, no writes);
  `pnpm format` = `biome check --write .` (apply safe fixes).
- CI: the `quality` job in `.github/workflows/ci.yml` runs `pnpm lint`
  before typecheck and tests, so the required `quality` status check
  enforces the gate on every PR.

Biome does not replace type-checking: `pnpm typecheck` (`tsc`) still runs
separately in the same job.

## Verification — 2026-11-04 (branch `chore/biome-gate`)

- Biome 2.5.13, `biome check .` on `main` @ 851025f: **exit 0 — 111 files
  checked, 0 diagnostics, 0 fixes needed.** The codebase is already
  format- and lint-clean under the committed config; this branch therefore
  adds no config or code changes, only this record.
- Repo test suite (`tsx --test tests/*.test.ts apps/mobile/test/*.test.ts`,
  the `pnpm test` command): 152 tests, 151 pass; `tests/browser.test.ts`
  failed at file level under full-suite parallel load and **passed 16/16 on
  isolated rerun** the same day — a pre-existing timing flake, unrelated to
  this branch (the branch diff vs `main` is this document only).

## For contributors

Run `pnpm lint` before pushing. If it flags formatting, run `pnpm format`,
review the diff, and commit the result with your change — never disable a
rule to make the gate pass without recording why in `biome.json`.
