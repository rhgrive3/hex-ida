import assert from 'node:assert/strict';
import { loadProgress, saveProgress } from '../js/learn.js';

// Setup mock localStorage in globalThis if needed
const storage = new Map();
const mockLocalStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
};

globalThis.localStorage = mockLocalStorage;

const KEY = 'hexviewer.learn.v1';

// Case 1: Array stored in localStorage
mockLocalStorage.setItem(KEY, JSON.stringify(['ch1', 'ch2']));
let progress = loadProgress();
assert.deepEqual(progress, {}, 'loadProgress should reject array data and return empty object');

// Verify mutating progress and saving doesn't corrupt as array
progress['ch1'] = true;
saveProgress(progress);
assert.deepEqual(loadProgress(), { ch1: true });

// Case 2: Array-like / other non-plain objects in JSON (e.g. primitives)
mockLocalStorage.setItem(KEY, JSON.stringify('string-value'));
assert.deepEqual(loadProgress(), {});

mockLocalStorage.setItem(KEY, JSON.stringify(12345));
assert.deepEqual(loadProgress(), {});

mockLocalStorage.setItem(KEY, JSON.stringify(true));
assert.deepEqual(loadProgress(), {});

mockLocalStorage.setItem(KEY, JSON.stringify(null));
assert.deepEqual(loadProgress(), {});

// Case 3: Valid plain object
mockLocalStorage.setItem(KEY, JSON.stringify({ ch1: true, ch2: false }));
assert.deepEqual(loadProgress(), { ch1: true, ch2: false });

console.log('issue-9507-learn-load-progress: PASS');
