import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearStoredSession,
  readStoredSession,
  writeStoredSession,
} from "../src/session-store.web.ts";
import { signinCodeFromUrl, stripSigninParam } from "../src/signin-link.ts";

// A minimal in-memory localStorage stand-in: the web session store
// guards on the global, so tests install one per case.
function installFakeStorage() {
  const entries = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  };
  return entries;
}

test("a stored session token is restored on a later load", () => {
  installFakeStorage();
  writeStoredSession({ token: "token-from-sign-in", mode: "live" });
  // The web store keeps no module state — this read goes back to
  // storage, which is exactly what a page reload does.
  assert.deepEqual(readStoredSession(), { token: "token-from-sign-in", mode: "live" });
});

test("clearing the stored session (sign-out / 401) leaves nothing to restore", () => {
  installFakeStorage();
  writeStoredSession({ token: "token-from-sign-in", mode: "live" });
  clearStoredSession();
  assert.equal(readStoredSession(), null);
});

test("a missing or corrupt stored value restores as no session", () => {
  const entries = installFakeStorage();
  assert.equal(readStoredSession(), null);
  entries.set("openmuse.session", "{not json");
  assert.equal(readStoredSession(), null);
  entries.set("openmuse.session", JSON.stringify({ mode: "live" }));
  assert.equal(readStoredSession(), null);
});

test("the sign-in code is read from the link URL", () => {
  assert.equal(signinCodeFromUrl("https://example.com/?signin=abc123"), "abc123");
  assert.equal(signinCodeFromUrl("https://example.com/?other=1&signin=xyz"), "xyz");
  assert.equal(signinCodeFromUrl("https://example.com/"), null);
  assert.equal(signinCodeFromUrl("https://example.com/?signin="), null);
  assert.equal(signinCodeFromUrl("not a url"), null);
});

test("the signin param is stripped after exchange, keeping the rest of the URL", () => {
  assert.equal(stripSigninParam("https://example.com/?signin=abc123"), "https://example.com/");
  assert.equal(
    stripSigninParam("https://example.com/app?other=1&signin=xyz#chat"),
    "https://example.com/app?other=1#chat",
  );
  // No code present: the URL is returned untouched.
  assert.equal(stripSigninParam("https://example.com/?other=1"), "https://example.com/?other=1");
});
