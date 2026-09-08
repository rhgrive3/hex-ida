import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class StorageMock {
  constructor() {
    this.map = new Map();
    this.failWrites = false;
    this.failReads = false;
    this.failReadKeys = new Set();
    this.failRemoveKeys = new Set();
  }
  getItem(key) {
    const storageKey = String(key);
    if (this.failReads || this.failReadKeys.has(storageKey)) {
      const error = new Error('storage read failed');
      error.name = 'StorageReadError';
      throw error;
    }
    return this.map.has(storageKey) ? this.map.get(storageKey) : null;
  }
  setItem(key, value) {
    if (this.failWrites) {
      const error = new Error('quota full');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.map.set(String(key), String(value));
  }
  removeItem(key) {
    const storageKey = String(key);
    if (this.failRemoveKeys.has(storageKey)) {
      const error = new Error('storage cleanup failed');
      error.name = 'StorageRemoveError';
      throw error;
    }
    this.map.delete(storageKey);
  }
  clear() { this.map.clear(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}

globalThis.localStorage = new StorageMock();

const { NoteStore, noteKeyFor, legacyV2NoteKeyFor } = await import('../js/names.js');
const { TypeStore } = await import('../js/types.js');

function fileLike(bytes, name = 'game.bin') {
  const blob = new Blob([bytes]);
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

// #476: two same-size files that are identical in the old start/middle/end
// windows but differ elsewhere must never share a current note identity.
{
  const size = 512 * 1024;
  const a = new Uint8Array(size);
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) a[i] = b[i] = (i * 31 + 7) & 0xff;
  b[100 * 1024 + 13] ^= 0x5a; // outside all three legacy 64 KiB sample windows
  const info = { slices: [{ offset: 0n, size: BigInt(size), info: { uuid: 'same-uuid', cpu: 'ARM64', cpuSub: '0' } }] };
  const fa = fileLike(a), fb = fileLike(b);
  const oldA = await legacyV2NoteKeyFor(fa, info, 0);
  const oldB = await legacyV2NoteKeyFor(fb, info, 0);
  assert.equal(oldA, oldB, 'fixture must collide under the legacy sampled v2 identity');
  const newA = await noteKeyFor(fa, info, 0);
  const newB = await noteKeyFor(fb, info, 0);
  assert.notEqual(newA, newB, 'full active-slice content must affect the v3 key');
  assert.match(newA, /sha256tree:v1:/, 'modern runtime should use cryptographic tree SHA-256');
}

// #478 / #2572: a weak legacy identity is recoverable but cannot be promoted
// automatically. After explicit import, clear -> reload must stay empty while
// preserving the old payload for backward compatibility.
{
  localStorage.clear();
  const legacyId = 'legacy-note-key';
  const currentId = 'current-note-key';
  const oldPayload = JSON.stringify({ v: 1, names: { '4096': 'coins' }, comments: { '4096': 'confirmed' } });
  localStorage.setItem('hex.notes.' + legacyId, oldPayload);
  const first = new NoteStore(currentId, [legacyId]);
  assert.equal(first.nameOf(4096n), null, 'weak legacy identity must not auto-promote notes');
  assert.equal(first.migratedFrom, null);
  assert.equal(first.legacyCandidate?.sourceId, legacyId);
  assert.equal(localStorage.getItem('hex.notes.' + currentId), null, 'candidate discovery must not create strong-current storage');

  assert.equal(first.importLegacyCandidate(), true, 'legacy recovery requires an explicit import');
  assert.equal(first.nameOf(4096n), 'coins');
  assert.equal(first.migratedFrom, legacyId);
  assert.equal(first.legacyCandidate, null);
  assert.equal(first.clear(), true);
  assert.equal(localStorage.getItem('hex.notes.' + legacyId), oldPayload, 'clear must not destroy backward-compatible legacy data');
  assert.equal(JSON.parse(localStorage.getItem('hex.notes.' + currentId)).cleared, true, 'current key must contain a migration-blocking tombstone');
  const reopened = new NoteStore(currentId, [legacyId]);
  assert.equal(reopened.count, 0);
  assert.equal(reopened.nameOf(4096n), null, 'deleted migrated notes must not resurrect');
  assert.equal(reopened.legacyCandidate, null, 'strong-current tombstone must block legacy candidate resurrection');
}

// #477: quota failures are observable; the in-memory edit stays dirty so it can
// be exported/retried, and retry clears dirty only after a successful write.
{
  localStorage.clear();
  const notes = new NoteStore('quota-case');
  localStorage.failWrites = true;
  assert.equal(notes.setName(0x1234n, 'damage'), false);
  assert.equal(notes.nameOf(0x1234n), 'damage', 'failed persistence keeps the recoverable in-memory edit');
  assert.equal(notes.dirty, true);
  assert.equal(notes.lastSaveError?.code, 'QuotaExceededError');
  assert.match(notes.toJSON(), /damage/, 'dirty data remains exportable');
  localStorage.failWrites = false;
  assert.equal(notes.save(), true, 'retry must be explicit and observable');
  assert.equal(notes.dirty, false);
  assert.equal(notes.lastSaveError, null);
}

// A valid base still permits ordinary delta persistence and reload. This keeps
// the fail-closed path below from accidentally disabling the normal overlay.
{
  localStorage.clear();
  const notes = new NoteStore('valid-overlay');
  assert.equal(notes.setName(0x1000n, 'original'), true);
  assert.equal(notes.setComment(0x2000n, 'delta survives'), true);
  const reopened = new NoteStore('valid-overlay');
  assert.equal(reopened.nameOf(0x1000n), 'original');
  assert.equal(reopened.comment(0x2000n), 'delta survives');
}

// #7062: a full commit gets a new generation, so a stale overlay left behind
// by a crash or a cleanup failure cannot overwrite the committed base.
{
  localStorage.clear();
  const id = 'generation-transaction';
  const primaryKey = 'hex.notes.' + id;
  const nameDeltaKey = primaryKey + '.delta.names.4096';
  const commentDeltaKey = primaryKey + '.delta.comments.8192';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'before'), true);
  assert.equal(notes.setComment(0x2000n, 'old overlay'), true);
  const before = JSON.parse(localStorage.getItem(primaryKey));
  assert.equal(JSON.parse(localStorage.getItem(commentDeltaKey)).generation, before.generation);

  assert.equal(notes.transaction(() => {
    assert.equal(notes.setName(0x1000n, 'after'), true);
    assert.equal(notes.setComment(0x2000n, 'new overlay'), true);
    return 'committed';
  }), 'committed');
  const after = JSON.parse(localStorage.getItem(primaryKey));
  assert.notEqual(after.generation, before.generation, 'full commit must switch generations');
  assert.equal(localStorage.getItem(nameDeltaKey), null);
  assert.equal(localStorage.getItem(commentDeltaKey), null);
  const reopened = new NoteStore(id);
  assert.equal(reopened.nameOf(0x1000n), 'after');
  assert.equal(reopened.comment(0x2000n), 'new overlay');
}

// Cleanup is garbage collection after the base commit. A partial remove
// failure therefore reports pending cleanup while reload still uses the new
// base, and a later retry accounts for and removes the retained key.
{
  localStorage.clear();
  const id = 'generation-cleanup-failure';
  const primaryKey = 'hex.notes.' + id;
  const nameDeltaKey = primaryKey + '.delta.names.4096';
  const commentDeltaKey = primaryKey + '.delta.comments.8192';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'initial'), true);
  assert.equal(notes.setName(0x1000n, 'before'), true);
  assert.equal(notes.setComment(0x2000n, 'before comment'), true);
  localStorage.failRemoveKeys.add(nameDeltaKey);
  assert.equal(notes.transaction(() => {
    notes.setName(0x1000n, 'after');
    notes.setComment(0x2000n, 'after comment');
  }), undefined);
  assert.equal(notes.lastMutationSaved, true, 'base commit remains durable');
  assert.equal(notes.dirty, false);
  assert.equal(notes.lastSaveError?.code, 'DELTA_CLEANUP_ERROR');
  assert.equal(localStorage.getItem(commentDeltaKey), null, 'successful cleanup may remove one stale overlay');
  assert.ok(localStorage.getItem(nameDeltaKey), 'failed cleanup key must remain for retry');
  const reopened = new NoteStore(id);
  assert.equal(reopened.nameOf(0x1000n), 'after');
  assert.equal(reopened.comment(0x2000n), 'after comment');

  localStorage.failRemoveKeys.clear();
  assert.equal(notes.save(), true, 'cleanup retry should commit and remove retained stale overlays');
  assert.equal(notes.lastSaveError, null);
  assert.equal(localStorage.getItem(nameDeltaKey), null);
}

// Legacy v2 snapshots and generationless deltas remain readable, but the
// first mutation migrates them to one generation before writing any delta.
{
  localStorage.clear();
  const id = 'legacy-generation';
  const primaryKey = 'hex.notes.' + id;
  const deltaKey = primaryKey + '.delta.names.4096';
  localStorage.setItem(primaryKey, JSON.stringify({ v: 2, names: { '4096': 'base' } }));
  localStorage.setItem(deltaKey, JSON.stringify({ kind: 'names', key: '4096', deleted: false, value: 'legacy overlay' }));
  const notes = new NoteStore(id);
  assert.equal(notes.nameOf(0x1000n), 'legacy overlay');
  assert.equal(notes.setName(0x1000n, 'migrated'), true);
  const migrated = JSON.parse(localStorage.getItem(primaryKey));
  assert.equal(typeof migrated.generation, 'string');
  assert.equal(localStorage.getItem(deltaKey), null);
  assert.equal(new NoteStore(id).nameOf(0x1000n), 'migrated');
}

// A deletion from an older generation is stale evidence and must not delete a
// newer value. This also models a process crash between base and cleanup.
{
  localStorage.clear();
  const id = 'stale-generation-deletion';
  const primaryKey = 'hex.notes.' + id;
  const deltaKey = primaryKey + '.delta.names.4096';
  localStorage.setItem(primaryKey, JSON.stringify({
    v: 2, generation: 'new-generation', names: { '4096': 'new value' },
  }));
  localStorage.setItem(deltaKey, JSON.stringify({
    kind: 'names', key: '4096', deleted: true, generation: 'old-generation',
  }));
  const notes = new NoteStore(id);
  assert.equal(notes.nameOf(0x1000n), 'new value');
  assert.ok(notes._deltaTotalBytes > 0, 'stale raw overlay still counts toward capacity');
  assert.equal(notes.save(), true);
  assert.equal(localStorage.getItem(deltaKey), null);
  assert.equal(new NoteStore(id).nameOf(0x1000n), 'new value');
}

// An incomplete delta read blocks a full rewrite, preserving the unreadable
// evidence for an explicit retry instead of declaring a partial view durable.
{
  localStorage.clear();
  const id = 'incomplete-delta-scan';
  const primaryKey = 'hex.notes.' + id;
  const deltaKey = primaryKey + '.delta.comments.8192';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'base'), true);
  assert.equal(notes.setComment(0x2000n, 'unreadable'), true);
  const baseBefore = localStorage.getItem(primaryKey);
  const oldDelta = localStorage.getItem(deltaKey);
  localStorage.failReadKeys.add(deltaKey);
  const reopened = new NoteStore(id);
  assert.equal(reopened._deltaScanComplete, false);
  assert.equal(reopened.setName(0x3000n, 'safe edit'), true);
  assert.equal(reopened.save(), false);
  assert.equal(reopened.lastSaveError?.code, 'DELTA_SCAN_INCOMPLETE');
  assert.equal(localStorage.getItem(primaryKey), baseBefore, 'base remains untouched');
  localStorage.failReadKeys.clear();
  assert.equal(localStorage.getItem(deltaKey), oldDelta, 'unreadable delta evidence remains available');
}

// A delta that would cross MAX_BYTES compacts into a bounded new base, and
// the resulting edit survives reload after the old overlay is removed.
{
  localStorage.clear();
  const id = 'generation-capacity-compaction';
  const primaryKey = 'hex.notes.' + id;
  const generation = 'legacy-generation-token-000000000000000000';
  const names = {};
  const maxBytes = 2 * 1024 * 1024;
  for (let index = 0; index < 41200; index++) names[String(index)] = 'x'.repeat(40);
  for (let index = 0; index < 53; index++) names[String(41200 + index)] = 'y'.repeat(120);
  const baseText = JSON.stringify({ v: 2, generation, names });
  const oldDelta = JSON.stringify({ kind: 'names', key: '0', deleted: false, generation, value: 'old' });
  const newDelta = JSON.stringify({ kind: 'names', key: '0', deleted: false, generation, value: 'y'.repeat(40) });
  assert.ok(new TextEncoder().encode(baseText).byteLength < maxBytes);
  assert.ok(new TextEncoder().encode(baseText).byteLength + new TextEncoder().encode(newDelta).byteLength > maxBytes);
  localStorage.setItem(primaryKey, baseText);
  localStorage.setItem(primaryKey + '.delta.names.0', oldDelta);
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0n, 'y'.repeat(40)), true);
  assert.equal(notes.lastMutationSaved, true);
  assert.equal(JSON.parse(localStorage.getItem(primaryKey)).names['0'], 'y'.repeat(40));
  assert.equal(localStorage.getItem(primaryKey + '.delta.names.0'), null);
  assert.equal(new NoteStore(id).nameOf(0n), 'y'.repeat(40));
}

// Async transactions use the same generation switch and report the committed
// state after their final save.
{
  localStorage.clear();
  const id = 'generation-async';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'base'), true);
  await notes.transactionAsync(async () => {
    await Promise.resolve();
    notes.setComment(0x2000n, 'async edit');
  });
  assert.equal(notes.lastMutationSaved, true);
  assert.equal(notes.dirty, false);
  assert.equal(new NoteStore(id).comment(0x2000n), 'async edit');
}

// An unreadable primary is recovery-required evidence, not an empty store.
// Ordinary edits must remain exportable while preserving the raw base and any
// pre-existing deltas for an explicit recovery decision.
{
  localStorage.clear();
  const id = 'invalid-base';
  const primaryKey = 'hex.notes.' + id;
  const deltaKey = primaryKey + '.delta.comments.8192';
  const rawBase = '{malformed snapshot';
  const oldDelta = JSON.stringify({ kind: 'comments', key: '8192', deleted: false, value: 'old' });
  localStorage.setItem(primaryKey, rawBase);
  localStorage.setItem(deltaKey, oldDelta);

  const notes = new NoteStore(id);
  assert.equal(notes._snapshotBytes, 0, 'unreadable base must not publish durable byte accounting');
  assert.equal(notes.lastSaveError?.code, 'INVALID_SNAPSHOT');
  assert.equal(notes.setComment(0x3000n, 'must be recoverable'), false);
  assert.equal(notes.lastMutationSaved, false);
  assert.equal(notes.dirty, true);
  assert.match(notes.toJSON(), /must be recoverable/);
  assert.equal(localStorage.getItem(primaryKey), rawBase, 'failed recovery must preserve raw base evidence');
  assert.equal(localStorage.getItem(deltaKey), oldDelta, 'failed recovery must preserve existing deltas');
  assert.equal(localStorage.getItem(primaryKey + '.delta.comments.12288'), null,
    'failed mutation must not create a delta without a validated base');
  assert.equal(notes.save(), false, 'ordinary full-save retry must stay blocked until explicit recovery');
  assert.equal(localStorage.getItem(primaryKey), rawBase, 'save failure must not overwrite malformed evidence');
}

// A parsed but schema-invalid payload is equally unsafe to use as a base.
{
  localStorage.clear();
  const id = 'invalid-shape';
  const primaryKey = 'hex.notes.' + id;
  const rawBase = JSON.stringify({ v: 2, names: [] });
  localStorage.setItem(primaryKey, rawBase);
  const notes = new NoteStore(id);
  assert.equal(notes._snapshotBytes, 0);
  assert.equal(notes.lastSaveError?.code, 'INVALID_SNAPSHOT');
  assert.equal(notes.setName(0x4000n, 'schema-safe'), false);
  assert.equal(localStorage.getItem(primaryKey), rawBase);
}

// A failed primary read cannot be treated as a new empty namespace either.
{
  localStorage.clear();
  const id = 'read-failure';
  const primaryKey = 'hex.notes.' + id;
  const rawBase = JSON.stringify({ v: 2, comments: { '4096': 'keep' } });
  localStorage.setItem(primaryKey, rawBase);
  localStorage.failReads = true;
  const notes = new NoteStore(id);
  assert.equal(notes._snapshotBytes, 0);
  assert.equal(notes.lastSaveError?.code, 'SNAPSHOT_READ_ERROR');
  assert.equal(notes.setName(0x5000n, 'read-safe'), false);
  assert.equal(notes.lastMutationSaved, false);
  localStorage.failReads = false;
  assert.equal(localStorage.getItem(primaryKey), rawBase, 'read failure must not overwrite an unreadable base');
  assert.equal(localStorage.getItem(primaryKey + '.delta.names.20480'), null);
}

// A clear tombstone is valid, but the next edit must rewrite a real snapshot
// because load() intentionally short-circuits delta replay for tombstones.
{
  localStorage.clear();
  const id = 'post-clear-edit';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x6000n, 'before clear'), true);
  assert.equal(notes.clear(), true);
  assert.equal(notes.setComment(0x7000n, 'after clear'), true);
  const reopened = new NoteStore(id);
  assert.equal(reopened.nameOf(0x6000n), null);
  assert.equal(reopened.comment(0x7000n), 'after clear');
}

// MAX_BYTES must fail closed and preserve dirty/export state.
{
  localStorage.clear();
  const notes = new NoteStore('oversize-case');
  notes.structs = [{ name: 'huge', members: [], note: 'x'.repeat(2 * 1024 * 1024 + 4096) }];
  notes.dirty = true;
  assert.equal(notes.save(), false);
  assert.equal(notes.dirty, true);
  assert.equal(notes.lastSaveError?.code, 'TOO_LARGE');
  assert.ok(notes.lastSaveError?.bytes > notes.lastSaveError?.maxBytes);
}

// TypeStore keeps its existing success return types but throws on persistence
// failure so a caller cannot show a false success message.
{
  localStorage.clear();
  const notes = new NoteStore('type-quota');
  const types = new TypeStore(notes);
  localStorage.failWrites = true;
  assert.throws(() => types.add('Player', []), (error) =>
    error?.name === 'PersistenceError' && error?.code === 'QuotaExceededError');
  assert.equal(notes.dirty, true);
  assert.equal(types.lastPersisted, false);
  localStorage.failWrites = false;
  assert.equal(notes.save(), true);
}

await import('./issue-6227-notes-legacy-v3-digest.mjs');

console.log('issues #476-#478 note identity/persistence regressions PASS');


// An unreadable delta can be quarantined without discarding readable overlay
// records, after which full compaction is allowed to resume.
{
  localStorage.clear();
  const id = 'delta-recovery-quarantine';
  const primaryKey = 'hex.notes.' + id;
  const brokenKey = primaryKey + '.delta.types.broken';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'base'), true);
  assert.equal(notes.setComment(0x2000n, 'readable overlay'), true);
  localStorage.setItem(brokenKey, '{not-json');

  const reopened = new NoteStore(id);
  assert.equal(reopened.save(), false, 'unreadable delta evidence initially blocks compaction');
  assert.equal(reopened.recoverUnreadableDeltas(), true,
    'explicit recovery should quarantine only unreadable delta records');
  assert.equal(localStorage.getItem(brokenKey), null);
  assert.ok([...localStorage.map.keys()].some((key) => key.startsWith(primaryKey + '.quarantine.')),
    'quarantine preserves the raw unreadable evidence outside the live delta namespace');
  assert.equal(reopened.save(), true, 'recovery should re-enable full snapshot compaction');
  assert.equal(new NoteStore(id).comment(0x2000n), 'readable overlay',
    'readable deltas must survive recovery and compaction');
}

// A transiently unreadable delta may be repaired before explicit recovery.
// Revalidate it, leave it live, and require a fresh ordered reload before
// compaction can replace the base snapshot.
{
  localStorage.clear();
  const id = 'delta-recovery-repaired';
  const primaryKey = 'hex.notes.' + id;
  const repairedKey = primaryKey + '.delta.comments.8192';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'base'), true);
  const generation = JSON.parse(localStorage.getItem(primaryKey)).generation;
  localStorage.setItem(repairedKey, '{transiently unreadable');
  const originalGetItem = localStorage.getItem.bind(localStorage);
  localStorage.getItem = (key) => {
    if (key === repairedKey) throw new Error('transient read');
    return originalGetItem(key);
  };

  const reopened = new NoteStore(id);
  assert.equal(reopened._unreadableDeltaKeys.has(repairedKey), true);
  localStorage.getItem = originalGetItem;
  const repaired = JSON.stringify({
    kind: 'comments', key: '8192', deleted: false, generation, value: 'repaired',
  });
  localStorage.setItem(repairedKey, repaired);

  assert.equal(reopened.recoverUnreadableDeltas(), false,
    'recovery must require a fresh reload for a repaired delta');
  assert.equal(reopened.lastSaveError?.reloadRequired, true);
  assert.equal(reopened.comment(0x2000n), null,
    'recovery must not replay a repaired delta out of order');
  assert.equal(reopened.dirty, false);
  assert.equal(localStorage.getItem(repairedKey), repaired,
    'a repaired live delta must remain available until a replacement base is durable');
  const repairedBytes = new TextEncoder().encode(repaired).byteLength;
  assert.equal(reopened._deltaBytes.get(repairedKey), repairedBytes,
    'the repaired live delta must remain accounted by key');
  assert.equal(reopened._deltaTotalBytes, repairedBytes,
    'the repaired live delta must remain accounted toward capacity');
  assert.equal(reopened.save(), false,
    'the pre-reload store must not compact a repaired delta');

  // A fresh store replays the live overlay in normal key order even before an
  // explicit save, so a crash between recovery and compaction cannot lose it.
  const reloaded = new NoteStore(id);
  assert.equal(reloaded.comment(0x2000n), 'repaired');

  // A failed replacement-base write must leave the overlay untouched. Once
  // the write succeeds, normal snapshot cleanup may remove it.
  const originalSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === primaryKey) throw new Error('quota full');
    return originalSetItem(key, value);
  };
  assert.equal(reloaded.save(), false, 'a quota failure must report persistence failure');
  localStorage.setItem = originalSetItem;
  assert.equal(localStorage.getItem(repairedKey), repaired,
    'a failed replacement-base write must preserve the live delta');
  assert.equal(new NoteStore(id).comment(0x2000n), 'repaired');
  assert.equal(reloaded.save(), true);
  assert.equal(localStorage.getItem(repairedKey), null,
    'live delta cleanup is allowed only after the replacement base commits');
  assert.equal(new NoteStore(id).comment(0x2000n), 'repaired');
}

// A read failure during both the initial load and recovery must remain a
// blocking scan failure even when the metadata-only retry can read the raw
// record. The retry cannot prove that this instance applied that value.
{
  localStorage.clear();
  const id = 'delta-recovery-one-shot-read';
  const primaryKey = 'hex.notes.' + id;
  const deltaKey = primaryKey + '.delta.comments.8192';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'base'), true);
  assert.equal(notes.setComment(0x2000n, 'live overlay'), true);
  const raw = localStorage.getItem(deltaKey);
  let failures = 2;
  const originalGetItem = localStorage.getItem.bind(localStorage);
  localStorage.getItem = (key) => {
    if (key === deltaKey && failures > 0) {
      failures--;
      throw new Error('one-shot storage read failure');
    }
    return originalGetItem(key);
  };

  const reopened = new NoteStore(id);
  assert.equal(reopened._deltaScanComplete, false);
  assert.equal(reopened._unreadableDeltaKeys.has(deltaKey), true);
  assert.equal(reopened.recoverUnreadableDeltas(), false,
    'a failed recovery read must remain a persistence failure');
  assert.equal(failures, 0);
  assert.equal(reopened._deltaScanComplete, false,
    'a metadata-only retry must not certify an unapplied overlay');
  assert.equal(reopened._unreadableDeltaKeys.has(deltaKey), true,
    'the failed key must remain a retryable scan blocker');
  assert.equal(reopened.save(), false,
    'the stale instance must not compact after a failed recovery read');

  localStorage.getItem = originalGetItem;
  assert.equal(localStorage.getItem(deltaKey), raw,
    'the failed recovery read must preserve the raw overlay');
  assert.equal(new NoteStore(id).comment(0x2000n), 'live overlay',
    'a fresh ordered load must still recover the overlay');
}

// If localStorage.key() fails before any delta can be enumerated, a later
// metadata-only scan still cannot certify that the original in-memory view
// incorporated the overlay. Keep compaction blocked until a fresh reload.
{
  localStorage.clear();
  const id = 'delta-recovery-enumeration-failure';
  const primaryKey = 'hex.notes.' + id;
  const deltaKey = primaryKey + '.delta.comments.8192';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'base'), true);
  assert.equal(notes.setComment(0x2000n, 'enumerated overlay'), true);
  const raw = localStorage.getItem(deltaKey);
  let failEnumeration = true;
  const originalKey = localStorage.key.bind(localStorage);
  localStorage.key = (index) => {
    if (failEnumeration) {
      failEnumeration = false;
      throw new Error('delta key enumeration failure');
    }
    return originalKey(index);
  };

  const reopened = new NoteStore(id);
  assert.equal(reopened._deltaScanComplete, false);
  assert.equal(reopened._unreadableDeltaKeys.size, 0);
  assert.equal(reopened.comment(0x2000n), null);
  assert.equal(reopened.recoverUnreadableDeltas(), false,
    'enumeration uncertainty must require a fresh reload');
  assert.equal(reopened.lastSaveError?.reloadRequired, true);
  assert.equal(reopened._deltaScanComplete, false);
  assert.equal(reopened.save(), false,
    'enumeration uncertainty must block compaction');

  localStorage.key = originalKey;
  assert.equal(localStorage.getItem(deltaKey), raw,
    'enumeration failure must preserve the raw overlay');
  assert.equal(new NoteStore(id).comment(0x2000n), 'enumerated overlay',
    'a fresh ordered load must recover after enumeration failure');
}

// A repaired delta must not overwrite an unsaved in-memory edit. Leave its
// bytes live and require a fresh reload; the unsaved edit remains in memory
// only until that reload and a subsequent successful save.
{
  localStorage.clear();
  const id = 'delta-recovery-dirty-edit';
  const primaryKey = 'hex.notes.' + id;
  const repairedKey = primaryKey + '.delta.comments.8192';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'base'), true);
  const generation = JSON.parse(localStorage.getItem(primaryKey)).generation;
  localStorage.setItem(repairedKey, '{originally unreadable');

  const reopened = new NoteStore(id);
  assert.equal(reopened.setComment(0x3000n, 'dirty edit', { save: false }), true);
  const repaired = JSON.stringify({
    kind: 'comments', key: '8192', deleted: false, generation, value: 'repaired',
  });
  localStorage.setItem(repairedKey, repaired);

  assert.equal(reopened.recoverUnreadableDeltas(), false,
    'dirty in-memory edits must block repaired-delta incorporation');
  assert.equal(reopened.lastSaveError?.code, 'DELTA_RECOVERY_REPAIRED');
  assert.equal(reopened.lastSaveError?.reloadRequired, true);
  assert.equal(reopened.comment(0x3000n), 'dirty edit');
  assert.equal(localStorage.getItem(repairedKey), repaired,
    'a repaired live delta must remain available for reload');
  assert.equal(localStorage.getItem(primaryKey).includes('dirty edit'), false);
  assert.equal(reopened.save(), false, 'reload-required recovery must keep compaction blocked');
  assert.equal(new NoteStore(id).comment(0x2000n), 'repaired');
}

// Read and remove failures remain retryable without deleting the raw record.
{
  localStorage.clear();
  const id = 'delta-recovery-read-retry';
  const primaryKey = 'hex.notes.' + id;
  const brokenKey = primaryKey + '.delta.types.broken';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'base'), true);
  assert.equal(notes.setComment(0x2000n, 'readable overlay'), true);
  const raw = '{read failure';
  localStorage.setItem(brokenKey, raw);
  const originalGetItem = localStorage.getItem.bind(localStorage);
  localStorage.getItem = (key) => {
    if (key === brokenKey) throw new Error('read failure');
    return originalGetItem(key);
  };
  const reopened = new NoteStore(id);
  assert.equal(reopened.recoverUnreadableDeltas(), false);
  localStorage.getItem = originalGetItem;
  assert.equal(localStorage.getItem(brokenKey), raw);
  assert.equal(reopened.recoverUnreadableDeltas(), true);
  assert.equal(reopened.save(), true);
  assert.equal(new NoteStore(id).comment(0x2000n), 'readable overlay');
}

{
  localStorage.clear();
  const id = 'delta-recovery-remove-retry';
  const primaryKey = 'hex.notes.' + id;
  const brokenKey = primaryKey + '.delta.types.broken';
  const notes = new NoteStore(id);
  assert.equal(notes.setName(0x1000n, 'base'), true);
  assert.equal(notes.setComment(0x2000n, 'readable overlay'), true);
  localStorage.setItem(brokenKey, '{remove failure');
  const originalRemoveItem = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = (key) => {
    if (key === brokenKey) throw new Error('remove failure');
    return originalRemoveItem(key);
  };
  const reopened = new NoteStore(id);
  assert.equal(reopened.recoverUnreadableDeltas(), false);
  assert.equal(localStorage.getItem(brokenKey), '{remove failure');
  assert.equal(localStorage.getItem(
    primaryKey + '.quarantine.' + encodeURIComponent(brokenKey),
  ), '{remove failure');
  localStorage.removeItem = originalRemoveItem;
  assert.equal(reopened.recoverUnreadableDeltas(), true);
  assert.equal(localStorage.getItem(brokenKey), null);
  assert.equal(reopened.save(), true);
  assert.equal(new NoteStore(id).comment(0x2000n), 'readable overlay');
}
