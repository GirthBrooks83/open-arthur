// Copies the server's runtime assets into the compiled output.
//
// tsc compiles .ts only, so without this step the built server
// silently ships without the arthur-sync snapshot that
// recall_arthur_record reads (apps/server/src/knowledge/
// arthur-sync-state.md). The compiled loader looks beside its own
// module first (dist/apps/server/src/knowledge/), so the asset must
// land there at build time — relying on the source tree surviving
// into the runtime and the process starting at the repo root made
// production recall fail whenever those accidents did not hold
// (2026-11-13). Fails the build loudly when the source asset is
// missing: a server without the snapshot must never deploy quietly.

import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "apps", "server", "src", "knowledge", "arthur-sync-state.md");
const targetDir = join(root, "dist", "apps", "server", "src", "knowledge");

await stat(source);
await mkdir(targetDir, { recursive: true });
await copyFile(source, join(targetDir, "arthur-sync-state.md"));
