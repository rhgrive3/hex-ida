// Regression for #7160: recoverUnreadableDeltas() must revalidate each pending
// record before removing it. A delta that was unreadable at load time but has
// become readable again (transient read failure) is LIVE evidence: recovery
// must block with an explicit reload requirement instead of deleting it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NoteStore } from '../js/names.js';

function storageWithTransientFailure(transientKey) {
  const map = new Map();
  let block = true; // only the FIRST read of the transient key fails
  return {
    map,
    storage: {
      get length() { return map.size; },
      key(i) { return [...map.keys()][i] ?? null; },
      getItem(k) {
        if (k === transientKey && block) {
          block = false;
          throw new Error('transient read failure');
        }
        return map.get(k) ?? null;
      },
      setItem(k, v) { map.set(k, String(v)); },
      removeItem(k) { map.delete(k); },
    },
  };
}

function withStorage(storage, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete globalThis.localStorage;
    });
}

test('#7160 a transiently unreadable delta that repaired stays live after recovery', async () => {
  const harness = storageWithTransientFailure('hex.notes.recovery-7160.delta.names.8192');
  await withStorage(harness.storage, () => {
    const id = 'recovery-7160';
    {
      const seed = new NoteStore(id);
      seed.setName(0x1000n, 'base');
    }
    const notes = new NoteStore(id);
    notes.setName(0x2000n, 'delta-value');
    const deltaKey = [...harness.map.keys()].find((k) => k.includes('.delta.'));
    assert.ok(deltaKey, 'a live delta must exist');

    // Reload while the delta read transiently fails: it lands in the
    // unreadable set.
    const probe = new NoteStore(id);
    assert.equal(probe._unreadableDeltaKeys.has(deltaKey), true);

    // Recovery must NOT delete the now-readable live record.
    assert.equal(probe.recoverUnreadableDeltas(), false, 'recovery stays blocked for a repaired live delta');
    assert.equal(harness.map.has(deltaKey), true, 'the live delta must survive recovery');
    assert.equal(probe.lastSaveError?.code, 'DELTA_RECOVERY_REPAIRED');
    assert.equal(probe.lastSaveError?.recoveryRequired, true);

    // The repaired record is incorporated: a fresh reload reads it normally.
    const reloaded = new NoteStore(id);
    assert.equal(reloaded.nameOf(0x2000n), 'delta-value');
  });
});

test('#7160 genuinely malformed records are still quarantined by recovery', async () => {
  await withStorage((() => {
    const map = new Map();
    return {
      get length() { return map.size; },
      key(i) { return [...map.keys()][i] ?? null; },
      getItem(k) { return map.get(k) ?? null; },
      setItem(k, v) { map.set(k, String(v)); },
      removeItem(k) { map.delete(k); },
      map,
    };
  })(), () => {
    const id = 'recovery-7160-malformed';
    {
      const seed = new NoteStore(id);
      seed.setName(0x1000n, 'base');
    }
    const brokenKey = 'hex.notes.' + id + '.delta.types.broken';
    globalThis.localStorage.setItem(brokenKey, '{not-json');
    const probe = new NoteStore(id);
    assert.equal(probe._unreadableDeltaKeys.has(brokenKey), true);
    assert.equal(probe.recoverUnreadableDeltas(), true, 'malformed evidence is quarantined');
    assert.equal(globalThis.localStorage.getItem(brokenKey), null);
    assert.ok([...globalThis.localStorage.map.keys()].some((key) => key.startsWith('hex.notes.' + id + '.quarantine.')));
  });
});
