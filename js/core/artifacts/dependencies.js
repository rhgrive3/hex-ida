/** Versioned membership dependencies, including reads of ABSENCE. Not a fact DB. */
import { createEntityId, deepFreeze, stableStringify } from '../identity/index.js';
import { assertWorldScope } from '../identity/world.js';
import { snapshotContractData, exactString, exactInteger, exactEnum, recordFields, stringSet, compareIdentity, contractFail } from '../identity/structured.js';

export const DEPENDENCY_SCOPE_SCHEMA = 'artifact-dependency-scope/v1';
export const MEMBERSHIP_KINDS = Object.freeze([
  'binary-images', 'dispatch-targets', 'objc-categories', 'swift-conformances',
  'external-models', 'knowledge-records', 'function-membership', 'type-layout',
  'runtime-generation', 'byte-ranges', 'scope-assumptions', 'semantic-profile',
]);
const REGISTRIES = new WeakSet();
const TOKEN_CAP = 8192;

export function createMembershipSelector(value) {
  const data = snapshotContractData(value, { maxBytes: 32768, maxNodes: 64 });
  recordFields(data, ['kind', 'ownerId', 'partition'], 'dependency-selector-fields');
  return deepFreeze({ kind: exactEnum(data.kind, MEMBERSHIP_KINDS, 'dependency-selector-kind'),
    ownerId: exactString(data.ownerId, 'dependency-selector-owner', 1024), partition: exactString(data.partition, 'dependency-selector-partition', 1024) });
}
const selectorKey = (value) => stableStringify(createMembershipSelector(value));

/** Normalize serialized tokens without asserting that they are CURRENT. */
export function normalizeDependencyScope(value) {
  const data = snapshotContractData(value, { maxBytes: 8 * 1024 * 1024 });
  recordFields(data, ['schema', 'worldId', 'registryId', 'resetEpoch', 'globalEpoch', 'positiveArtifactIds', 'reads'], 'dependency-scope-fields');
  if (data.schema !== DEPENDENCY_SCOPE_SCHEMA) contractFail('dependency-scope-schema');
  if (!Array.isArray(data.reads) || data.reads.length > TOKEN_CAP) contractFail('dependency-read-budget');
  const keys = new Set();
  const reads = data.reads.map((read) => {
    recordFields(read, ['selector', 'epoch', 'polarity'], 'dependency-read-fields');
    const selector = createMembershipSelector(read.selector);
    const key = selectorKey(selector);
    if (keys.has(key)) contractFail('dependency-duplicate-selector');
    keys.add(key);
    return { selector, epoch: exactInteger(read.epoch, 'dependency-read-epoch'),
      polarity: exactEnum(read.polarity, ['positive-membership', 'negative-membership', 'complete-membership'], 'dependency-read-polarity') };
  }).sort((a, b) => compareIdentity(selectorKey(a.selector), selectorKey(b.selector)));
  return deepFreeze({ schema: DEPENDENCY_SCOPE_SCHEMA,
    worldId: exactString(data.worldId, 'dependency-world'), registryId: exactString(data.registryId, 'dependency-registry'),
    resetEpoch: exactInteger(data.resetEpoch, 'dependency-reset-epoch'),
    globalEpoch: data.globalEpoch === null ? null : exactInteger(data.globalEpoch, 'dependency-global-epoch'),
    positiveArtifactIds: stringSet(data.positiveArtifactIds ?? [], 'dependency-positive-artifacts', TOKEN_CAP), reads });
}

function freshRegistryId(world, nonce) {
  if (nonce == null) {
    if (typeof globalThis.crypto?.getRandomValues !== 'function') contractFail('dependency-registry-random-unavailable');
    nonce = [...globalThis.crypto.getRandomValues(new Uint32Array(4))].map((x) => x.toString(16).padStart(8, '0')).join('');
  }
  return createEntityId({ binaryId: world.binarySet[0].binaryId, kind: 'membership-registry', identity: { world: world.id, nonce: exactString(nonce, 'dependency-registry-nonce') } });
}

/**
 * Canonical owners call advance() synchronously BEFORE publishing membership
 * changes. Captures are invalidation tokens, never evidence of semantic absence.
 * Unclassified changes call reset(); they cannot silently miss a negative read.
 * A fresh registry nonce makes persisted tokens stale after process restart.
 */
export class DependencyEpochRegistry {
  #world; #id; #reset = 0; #global = 0; #epoch = new Map(); #maxSelectors;
  #watchers = new Map(); #reverse = new Map(); #globalWatchers = new Set(); #nextWatcher = 0; #maxWatchers;
  #closed = false;
  constructor({ world, nonce = null, maxSelectors = 65536, maxWatchers = 1024 } = {}) {
    this.#world = assertWorldScope(world);
    this.#id = freshRegistryId(world, nonce);
    this.#maxSelectors = exactInteger(maxSelectors, 'dependency-selector-limit', { min: 1, max: 1000000 });
    this.#maxWatchers = exactInteger(maxWatchers, 'dependency-watcher-limit', { max: 100000 });
    REGISTRIES.add(this);
  }
  get worldId() { return this.#world.id; }
  get registryId() { return this.#id; }
  #live() { if (this.#closed) contractFail('dependency-registry-closed'); }
  capture(reads = [], { positiveArtifactIds = [], snapshotOnly = false } = {}) {
    this.#live();
    if (typeof snapshotOnly !== 'boolean') contractFail('dependency-snapshot-only');
    if (!Array.isArray(reads) || reads.length > TOKEN_CAP) contractFail('dependency-read-budget');
    const normalized = reads.map((read) => {
      const detached = snapshotContractData(read);
      recordFields(detached, ['selector', 'polarity'], 'dependency-capture-fields');
      const selector = createMembershipSelector(detached.selector);
      const key = selectorKey(selector);
      return { selector, polarity: detached.polarity, epoch: this.#epoch.get(key) ?? 0 };
    });
    return normalizeDependencyScope({ schema: DEPENDENCY_SCOPE_SCHEMA, worldId: this.worldId, registryId: this.#id,
      resetEpoch: this.#reset, globalEpoch: snapshotOnly ? this.#global : null, positiveArtifactIds, reads: normalized });
  }
  validate(value) {
    let token;
    try { token = normalizeDependencyScope(value); } catch { return false; }
    if (this.#closed || token.worldId !== this.worldId || token.registryId !== this.#id || token.resetEpoch !== this.#reset) return false;
    if (token.globalEpoch !== null && token.globalEpoch !== this.#global) return false;
    return token.reads.every((read) => (this.#epoch.get(selectorKey(read.selector)) ?? 0) === read.epoch);
  }
  advance(selectors) {
    this.#live();
    if (!Array.isArray(selectors) || selectors.length > TOKEN_CAP) contractFail('dependency-change-budget');
    const changed = stringSet(selectors.map(selectorKey), 'dependency-change-selectors', TOKEN_CAP);
    const newCount = changed.filter((key) => !this.#epoch.has(key)).length;
    if (this.#epoch.size + newCount > this.#maxSelectors || this.#global === Number.MAX_SAFE_INTEGER
      || changed.some((key) => this.#epoch.get(key) === Number.MAX_SAFE_INTEGER)) {
      this.reset('membership-capacity-reset');
      return deepFreeze({ status: 'global-invalidation', count: changed.length });
    }
    if (!changed.length) return deepFreeze({ status: 'unchanged', count: 0 });
    this.#global++;
    const watchers = new Set(this.#globalWatchers);
    for (const key of changed) {
      this.#epoch.set(key, (this.#epoch.get(key) ?? 0) + 1);
      for (const id of this.#reverse.get(key) ?? []) watchers.add(id);
    }
    for (const id of watchers) this.#invalidate(id, 'membership-changed');
    return deepFreeze({ status: 'invalidated', count: changed.length });
  }
  reset(reason = 'unclassified-membership-change') {
    this.#live(); exactString(reason, 'dependency-reset-reason');
    if (this.#reset === Number.MAX_SAFE_INTEGER) {
      this.close(); contractFail('dependency-registry-epoch-overflow');
    }
    this.#reset++; this.#global = 0; this.#epoch.clear();
    for (const id of [...this.#watchers.keys()]) this.#invalidate(id, reason);
  }
  watch(value, onInvalidate) {
    this.#live();
    if (typeof onInvalidate !== 'function') contractFail('dependency-watch-callback');
    const token = normalizeDependencyScope(value);
    if (!this.validate(token)) { onInvalidate('already-stale'); return () => {}; }
    if (this.#watchers.size >= this.#maxWatchers) contractFail('dependency-watch-budget');
    const id = ++this.#nextWatcher;
    const keys = token.reads.map((read) => selectorKey(read.selector));
    this.#watchers.set(id, { keys, callback: onInvalidate });
    for (const key of keys) {
      if (!this.#reverse.has(key)) this.#reverse.set(key, new Set());
      this.#reverse.get(key).add(id);
    }
    if (token.globalEpoch !== null) this.#globalWatchers.add(id);
    return () => this.#remove(id);
  }
  #remove(id) {
    const watcher = this.#watchers.get(id);
    if (!watcher) return null;
    this.#watchers.delete(id); this.#globalWatchers.delete(id);
    for (const key of watcher.keys) {
      const set = this.#reverse.get(key); set?.delete(id);
      if (set?.size === 0) this.#reverse.delete(key);
    }
    return watcher;
  }
  #invalidate(id, reason) {
    const watcher = this.#remove(id);
    if (!watcher) return;
    // Consumer callbacks cannot interrupt invalidation of other consumers.
    try { watcher.callback(reason); } catch { /* invalidation already committed */ }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of [...this.#watchers.keys()]) this.#invalidate(id, 'registry-closed');
    this.#epoch.clear();
  }
  stats() { return deepFreeze({ registryId: this.#id, worldId: this.worldId, resetEpoch: this.#reset,
    globalEpoch: this.#global, selectors: this.#epoch.size, watchers: this.#watchers.size, closed: this.#closed }); }
}
export function assertDependencyRegistry(registry) {
  if (!REGISTRIES.has(registry)) contractFail('dependency-registry-noncanonical');
  return registry;
}
