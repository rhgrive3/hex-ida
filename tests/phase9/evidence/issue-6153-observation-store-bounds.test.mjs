import assert from "node:assert/strict";
import test from "node:test";
import { ObservationStore } from "../../../js/ai/tools/storage/observation-store.js";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

test("Issue #6153: non-finite ObservationStore limits cannot disable eviction", () => {
  for (const value of [Infinity, -Infinity, Number.NaN, "Infinity", { valueOf: () => Infinity }]) {
    const store = new ObservationStore({ maxEntries: value, maxAgeMs: value });
    assert.equal(store.maxEntries, DEFAULT_MAX_ENTRIES);
    assert.equal(store.maxAgeMs, DEFAULT_MAX_AGE_MS);
    assert.equal(store.cursorCodec.maxAgeMs, DEFAULT_MAX_AGE_MS);
    assert.equal(Number.isFinite(store.maxEntries), true);
    assert.equal(Number.isFinite(store.maxAgeMs), true);
  }

  const store = new ObservationStore({ maxEntries: Infinity });
  for (let index = 0; index < DEFAULT_MAX_ENTRIES + 8; index++) {
    store.put({ tool: `issue-6153-${index}`, fullResult: { index }, deterministic: false });
  }
  assert.equal(store.records.size, DEFAULT_MAX_ENTRIES);
});

test("Issue #6153: non-finite age falls back to an expiring finite duration", () => {
  const store = new ObservationStore({ maxAgeMs: Infinity });
  const record = store.put({ tool: "issue-6153-age", fullResult: { ok: true }, deterministic: false });
  record.createdAt = Date.now() - store.maxAgeMs - 1;
  store.evict();
  assert.equal(store.records.has(record.id), false);
});
