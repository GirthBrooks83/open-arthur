// Builds the on-device brain engine page into the web export.
//
// The engine (apps/mobile/ondevice/engine.ts, WebLLM) is bundled with
// esbuild into apps/mobile/public/local-brain/ and — with --with-dist —
// also copied into the finished Expo web export at dist/web/local-brain/.
// It is intentionally kept out of the Metro bundle: WebLLM is large and
// GPU-focused, the engine is only needed when the user picks the local
// brain, and isolating it means an engine problem can never break the
// main app build.

import { copyFile, cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(mobileDir, "public", "local-brain");

await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [join(mobileDir, "ondevice", "engine.ts")],
  outfile: join(outDir, "engine.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  logLevel: "info",
});
await copyFile(join(mobileDir, "ondevice", "index.html"), join(outDir, "index.html"));
console.log(`on-device brain page written to ${outDir}`);

if (process.argv.includes("--with-dist")) {
  const distDir = join(mobileDir, "dist", "web", "local-brain");
  await cp(outDir, distDir, { recursive: true });
  console.log(`on-device brain page copied into web export at ${distDir}`);
}
