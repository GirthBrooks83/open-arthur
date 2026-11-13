import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Production failure, 2026-11-13: every recall_arthur_record proof
// task failed on the deployed server while the source-tree fixture
// (tests/critic-tool-evidence.test.ts) passed. One layer of that
// failure lives here: the snapshot asset
// (apps/server/src/knowledge/arthur-sync-state.md) was never part of
// the build output — tsc compiles .ts only and nothing copied the
// .md — so in the layout the start command actually guarantees
// (`node dist/apps/server/src/index.js`, dist + package.json +
// node_modules) the compiled loader's module-relative candidates
// miss and the cwd candidates depend on the source tree surviving
// into the runtime and the process starting at the repo root. This
// test reproduces that layout exactly: run the package's real
// build:server, stage ONLY dist + package.json into a clean tree
// (no apps/server/src anywhere), and ask the compiled loader —
// from that tree, as its cwd — for the snapshot. Before the fix it
// returns null and this test fails; the build must ship the asset
// beside the compiled module for it to pass.
test("the built server loads the arthur record snapshot in a dist-only layout", {
  timeout: 300_000,
}, async (t) => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const buildScript = pkg.scripts["build:server"];
  assert.ok(buildScript, "package.json must define build:server");
  await run("sh", ["-c", buildScript], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const staging = await mkdtemp(join(tmpdir(), "openmuse-dist-layout-"));
  t.after(() => rm(staging, { recursive: true, force: true }));
  await cp(join(root, "dist"), join(staging, "dist"), { recursive: true });
  await cp(join(root, "package.json"), join(staging, "package.json"));
  await writeFile(
    join(staging, "probe.mjs"),
    [
      'import { loadArthurRecordSnapshot, recallArthurRecord } from "./dist/apps/server/src/engine/arthur-record.js";',
      "const snapshot = loadArthurRecordSnapshot();",
      "if (!snapshot) { console.log(JSON.stringify({ loaded: false })); process.exit(0); }",
      'const recall = recallArthurRecord(snapshot, "memory lanes");',
      "console.log(JSON.stringify({",
      "  loaded: true,",
      "  generatedAt: snapshot.generatedAt,",
      "  sections: snapshot.sections.length,",
      "  matchCount: recall.matches.length,",
      '  text: recall.matches.map((m) => m.text).join("\\n"),',
      "}));",
      "",
    ].join("\n"),
  );
  const { stdout } = await run("node", ["probe.mjs"], {
    cwd: staging,
    maxBuffer: 64 * 1024 * 1024,
  });
  const probe = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
    loaded: boolean;
    generatedAt?: string;
    sections?: number;
    matchCount?: number;
    text?: string;
  };
  assert.equal(
    probe.loaded,
    true,
    "compiled loader returned no snapshot in a dist-only layout (the production start layout)",
  );
  assert.equal(probe.generatedAt, "2026-11-12T06:40:24-08:00");
  assert.ok((probe.sections ?? 0) > 1, "snapshot sections should parse in the dist layout");
  assert.ok((probe.matchCount ?? 0) > 0, "a memory-lanes recall should match in the dist layout");
  assert.match(probe.text ?? "", /Mem0/);
});
