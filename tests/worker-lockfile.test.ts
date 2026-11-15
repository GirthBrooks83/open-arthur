import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The worker's Docker image installs with `npm ci` from its own lockfile,
// outside the pnpm workspace flow, and npm ci refuses to run when the lock
// and package.json disagree. Commit f073883 added Stagehand to
// apps/worker/package.json without regenerating that lockfile, and the
// browser-container job failed at the install step from then on. This test
// is the tripwire: the lock's root entry must mirror package.json, and every
// declared dependency must have a resolved entry in the lock.
test("apps/worker package-lock.json covers every package.json dependency", async () => {
  const pkg = JSON.parse(await readFile(join(root, "apps/worker/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const lock = JSON.parse(await readFile(join(root, "apps/worker/package-lock.json"), "utf8")) as {
    packages?: Record<
      string,
      { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    >;
  };
  const packages = lock.packages ?? {};
  const regenerate =
    "regenerate it with `npm install` in apps/worker and commit the updated package-lock.json";
  assert.deepEqual(
    packages[""]?.dependencies ?? {},
    pkg.dependencies ?? {},
    `package-lock.json root dependencies differ from apps/worker/package.json — ${regenerate}`,
  );
  assert.deepEqual(
    packages[""]?.devDependencies ?? {},
    pkg.devDependencies ?? {},
    `package-lock.json root devDependencies differ from apps/worker/package.json — ${regenerate}`,
  );
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.ok(
      packages[`node_modules/${name}`],
      `package-lock.json has no resolved entry for ${name} — ${regenerate}`,
    );
  }
});
