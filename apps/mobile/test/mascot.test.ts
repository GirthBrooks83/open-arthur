import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const uiPath = fileURLToPath(new URL("../src/ui.tsx", import.meta.url));
const uiSource = readFileSync(uiPath, "utf8");
const mascotBlock = uiSource.slice(uiSource.indexOf("export function Mascot"));

test("the default mascot is Arthur, not the capybara", () => {
  assert.match(mascotBlock, /source = require\("\.\.\/assets\/arthur\.png"\)/);
  assert.doesNotMatch(mascotBlock, /capybara\.png/);
  assert.match(mascotBlock, /accessibilityLabel="Arthur"/);
});

test("the mascot stays swappable through the source override", () => {
  assert.match(mascotBlock, /source\?: ImageSourcePropType/);
});

test("the Arthur asset is a 1254x1254 PNG matching the previous default's dimensions", () => {
  const assetPath = fileURLToPath(new URL("../assets/arthur.png", import.meta.url));
  assert.equal(existsSync(assetPath), true);
  const header = readFileSync(assetPath).subarray(0, 24);
  assert.equal(header.toString("ascii", 1, 4), "PNG");
  assert.equal(header.readUInt32BE(16), 1254);
  assert.equal(header.readUInt32BE(20), 1254);
});

test("the original capybara asset is kept for customization", () => {
  const capybaraPath = fileURLToPath(new URL("../assets/capybara.png", import.meta.url));
  assert.equal(existsSync(capybaraPath), true);
});
