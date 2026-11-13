import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

// The hosted single-service deploy (Render free plan) serves the Expo web
// export and the API from one origin. These tests pin that contract: the
// UI is served when a web build is present, API behavior is untouched, and
// without a web build the root keeps its old JSON pointer.
let directory: string, webDir: string;
let db: Store, dbBare: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let bareApp: Awaited<ReturnType<typeof createApp>>["app"];

function config(webDir?: string): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    webDir,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-web-ui-"));
  webDir = join(directory, "web");
  await mkdir(join(webDir, "_expo"), { recursive: true });
  await writeFile(
    join(webDir, "index.html"),
    '<!doctype html><title>OpenMuse</title><div id="root"></div>',
  );
  await writeFile(join(webDir, "_expo", "app.js"), "console.log('openmuse');");
  await writeFile(
    join(webDir, "manifest.json"),
    JSON.stringify({
      name: "Open Arthur",
      short_name: "Open Arthur",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#FCFCFC",
      theme_color: "#FCFCFC",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      ],
    }),
  );
  db = await createStore();
  ({ app } = await createApp(db, config(webDir)));
  dbBare = await createStore();
  ({ app: bareApp } = await createApp(dbBare, config(join(directory, "missing"))));
});
after(async () => {
  await db.close();
  await dbBare.close();
  await rm(directory, { recursive: true, force: true });
});

test("root serves the web UI when a web build is present", async () => {
  const response = await app.request("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /<title>OpenMuse<\/title>/);
});

test("web assets are served with their content type", async () => {
  const response = await app.request("/_expo/app.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  assert.match(await response.text(), /openmuse/);
});

test("the web app manifest is served as JSON, not the SPA page", async () => {
  const response = await app.request("/manifest.json");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const manifest = await response.json();
  // The fields Chrome requires before it offers a true "Install app".
  assert.equal(manifest.name, "Open Arthur");
  assert.equal(manifest.short_name, "Open Arthur");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
});

test("unknown non-API paths fall back to the app entry (SPA routing)", async () => {
  const response = await app.request("/some/deep/route");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>OpenMuse<\/title>/);
});

test("path traversal cannot escape the web root", async () => {
  const response = await app.request("/%2e%2e/%2e%2e/package.json");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>OpenMuse<\/title>/);
});

test("API health stays JSON alongside the UI", async () => {
  const response = await app.request("/api/health");
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
});

test("unknown API paths still 404 as JSON, not the SPA page", async () => {
  const response = await app.request("/api/does-not-exist", {
    headers: { Authorization: "Bearer test" },
  });
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(await response.text(), /<title>OpenMuse<\/title>/);
});

test("without a web build the root keeps the JSON pointer", async () => {
  const response = await bareApp.request("/");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.name, "OpenMuse");
  assert.equal(body.health, "/api/health");
});
