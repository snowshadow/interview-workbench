import assert from "node:assert/strict";
import test from "node:test";
import { constrainSplit, normalizeSplit, splitBounds, splitForKey } from "../src/lib/split-layout.js";
import { UI_PREF_KEY, readUiPreferences, saveUiPreferences } from "../src/lib/ui-preferences.js";

test("saved layouts reject corrupt and unusable sizes", () => {
  for (const value of [null, undefined, "61", NaN, Infinity, -10, 0, 100, {}]) {
    assert.equal(normalizeSplit(value, 61), 61);
  }
  assert.equal(normalizeSplit(72.5, 61), 72.5);
});

test("split boundaries keep both panels usable and compress proportionally in small windows", () => {
  const bounds = splitBounds(1000, 320, 300);
  assert.deepEqual(bounds, { min: 32, max: 70 });
  assert.equal(constrainSplit(-15, bounds), 32);
  assert.equal(constrainSplit(95, bounds), 70);
  const narrow = splitBounds(300, 320, 300);
  assert.ok(Math.abs(narrow.min - 320 / 620 * 100) < 1e-10);
  assert.ok(Math.abs(narrow.max - narrow.min) < 1e-10);
  assert.ok(Math.round(narrow.min) <= Math.round(narrow.max));
  assert.deepEqual(splitBounds(0, 320, 300), { min: 0, max: 100 });
});

test("keyboard resizing follows the current axis, respects bounds, and supports reset", () => {
  const bounds = { min: 25, max: 75 };
  assert.equal(splitForKey("ArrowRight", "horizontal", 50, bounds, 61), 52);
  assert.equal(splitForKey("ArrowLeft", "horizontal", 26, bounds, 61), 25);
  assert.equal(splitForKey("ArrowDown", "vertical", 50, bounds, 54, 10), 60);
  assert.equal(splitForKey("ArrowUp", "vertical", 50, bounds, 54), 48);
  assert.equal(splitForKey("ArrowDown", "horizontal", 50, bounds, 61), null);
  assert.equal(splitForKey("ArrowLeft", "vertical", 50, bounds, 54), null);
  assert.equal(splitForKey("Home", "horizontal", 50, bounds, 61), 25);
  assert.equal(splitForKey("End", "horizontal", 50, bounds, 61), 75);
  assert.equal(splitForKey("Enter", "horizontal", 50, bounds, 61), 61);
  assert.equal(splitForKey("Enter", "vertical", 50, bounds, 90), 75);
});

test("layout persistence preserves unrelated audio preferences and tolerates unavailable storage", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  });
  const data = new Map([[UI_PREF_KEY, JSON.stringify({ audioSourceMode: "meeting" })]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) },
  });
  saveUiPreferences({ workspaceSplit: 72 });
  saveUiPreferences({ assistSplit: 54 });
  assert.deepEqual(readUiPreferences(), { audioSourceMode: "meeting", workspaceSplit: 72, assistSplit: 54 });
  for (const value of ["broken json", "null", "[]", "42"]) {
    data.set(UI_PREF_KEY, value);
    assert.deepEqual(readUiPreferences(), {});
  }
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("Storage unavailable"); },
  });
  assert.deepEqual(readUiPreferences(), {});
  assert.doesNotThrow(() => saveUiPreferences({ workspaceSplit: 61 }));
});
