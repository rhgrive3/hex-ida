from pathlib import Path

proof = Path('js/semantics/memoryssa/proof-core.js')
text = proof.read_text()

anchor = """function weakObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function withoutDigest(value, key = 'proofDigest') {
"""
replacement = """function weakObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const deeplyFrozenObjects = new WeakSet();
const memorySsaDigestCache = new WeakMap();
const accessBindingCache = new WeakMap();

function isDeeplyFrozenPlainData(value, active = new WeakSet()) {
  if (value == null || typeof value !== 'object') return true;
  if (deeplyFrozenObjects.has(value)) return true;
  if (active.has(value)) return false;
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) return false;
    if (!Object.isFrozen(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    active.add(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || !isDeeplyFrozenPlainData(descriptor.value, active)) {
        active.delete(value);
        return false;
      }
    }
    active.delete(value);
    deeplyFrozenObjects.add(value);
    return true;
  } catch {
    active.delete(value);
    return false;
  }
}

function isCacheablePlainRecord(value) {
  if (value == null || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
  } catch {
    return false;
  }
  return isDeeplyFrozenPlainData(value);
}

function withoutDigest(value, key = 'proofDigest') {
"""
assert text.count(anchor) == 1, 'weakObject anchor mismatch'
text = text.replace(anchor, replacement)

old = """export function canonicalMemorySsaDigest(artifact) {
  return stableDigest(canonicalMemorySsaPayload(artifact));
}
"""
new = """export function canonicalMemorySsaDigest(artifact) {
  if (isCacheablePlainRecord(artifact)) {
    const cached = memorySsaDigestCache.get(artifact);
    if (cached !== undefined) return cached;
    const digest = stableDigest(canonicalMemorySsaPayload(artifact));
    memorySsaDigestCache.set(artifact, digest);
    return digest;
  }
  return stableDigest(canonicalMemorySsaPayload(artifact));
}
"""
assert text.count(old) == 1, 'digest anchor mismatch'
text = text.replace(old, new)

old = """export function canonicalAccessBinding({
  memorySsaEntityId,
  entityKind,
  sourceEntityId,
  nodeId,
  regionId,
  sourceKind,
  role,
  accessIndex,
  order,
  broad,
  memory,
  sequencing,
  origin,
  byteRange,
  rangeProof,
  accessProof,
  aliasRelation,
  aliasProof,
  canonicalValue,
}) {
  const base = {
"""
new = """export function canonicalAccessBinding(access) {
  const cacheable = isCacheablePlainRecord(access);
  if (cacheable) {
    const cached = accessBindingCache.get(access);
    if (cached !== undefined) return cached;
  }
  const {
    memorySsaEntityId,
    entityKind,
    sourceEntityId,
    nodeId,
    regionId,
    sourceKind,
    role,
    accessIndex,
    order,
    broad,
    memory,
    sequencing,
    origin,
    byteRange,
    rangeProof,
    accessProof,
    aliasRelation,
    aliasProof,
    canonicalValue,
  } = access;
  const base = {
"""
assert text.count(old) == 1, 'access signature anchor mismatch'
text = text.replace(old, new)

old = """    canonicalValueDigest: stableDigest(canonicalValue ?? null),
  };
  return {
    ...base,
    bindingDigest: stableDigest(base),
  };
}
"""
new = """    canonicalValueDigest: stableDigest(canonicalValue ?? null),
  };
  const binding = {
    ...base,
    bindingDigest: stableDigest(base),
  };
  if (!cacheable) return binding;
  const frozen = Object.freeze(binding);
  accessBindingCache.set(access, frozen);
  return frozen;
}
"""
assert text.count(old) == 1, 'access return anchor mismatch'
text = text.replace(old, new)
proof.write_text(text)

worker = Path('tests/accuracy-pseudoc-worker.mjs')
text = worker.read_text()
old = "import { openBinary } from './harness.mjs';"
new = "import { NodeBackend, openBinary } from './harness.mjs';"
assert text.count(old) == 1, 'worker import anchor mismatch'
text = text.replace(old, new)
old = """const bootStart = Date.now();
const world = await openBinary(target);
process.send({ type: 'ready', bootMs: Date.now() - bootStart });
"""
new = """const bootStart = Date.now();
// Pseudoc scoring consumes per-function analysis, region geometry and symbol
// lookup only. Skip the expensive global program/string indexes in this
// process-local worker boot, then restore the prototype before serving tasks.
const originalScanProgram = NodeBackend.prototype.scanProgram;
NodeBackend.prototype.scanProgram = async () => null;
let world;
try {
  world = await openBinary(target, { strings: false });
} finally {
  NodeBackend.prototype.scanProgram = originalScanProgram;
}
process.send({ type: 'ready', bootMs: Date.now() - bootStart });
"""
assert text.count(old) == 1, 'worker boot anchor mismatch'
worker.write_text(text.replace(old, new))

Path('tests/semantic-v2/memoryssa-proof-cache.test.mjs').write_text("""import assert from 'node:assert/strict';
import {
  canonicalAccessBinding,
  canonicalMemorySsaDigest,
} from '../../js/semantics/memoryssa/proof.js';

function deepFreeze(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function artifact(functionId = 'fn_cache') {
  return {
    contractVersion: '1.0.0', functionId, buildVersion: '1.0.0', completeness: 'complete',
    unknowns: [], identity: { functionId, memorySsaId: 'mssa_cache' },
    canonicalIrIdentity: { functionId, semanticIrDigest: 'ir-cache' }, snapshotId: 'snapshot-cache',
    regions: [], definitions: [], uses: [], reachingDefinitionLinks: [], useDefLinks: [], defUseLinks: [],
    accessMetadata: [], canonicalAccessBindings: [], byteCoverage: [], blockStates: [],
  };
}

function access(sourceEntityId = 'n_load') {
  return {
    memorySsaEntityId: 'use_cache', entityKind: 'use', sourceEntityId, nodeId: sourceEntityId,
    regionId: 'region_cache', sourceKind: 'load', role: 'read', accessIndex: 0, order: 1, broad: false,
    memory: { addressSpace: 'memory', widthBits: 32, endian: 'little' },
    sequencing: { volatility: false, atomic: false, ordering: 'unknown' },
    origin: { instructionIds: ['ins_load'], virtualRanges: [] },
    byteRange: { domain: 'cache', start: '0', end: '4' },
    rangeProof: { kind: 'canonical-memory-byte-range', proofDigest: 'range' },
    accessProof: { kind: 'canonical-memory-access-qualifiers', proofDigest: 'access' },
    aliasRelation: 'must', aliasProof: { kind: 'canonical-memory-alias-proof', proofDigest: 'alias' },
    canonicalValue: null,
  };
}

const frozenArtifact = deepFreeze(artifact());
const frozenDigest = canonicalMemorySsaDigest(frozenArtifact);
assert.equal(canonicalMemorySsaDigest(frozenArtifact), frozenDigest,
  'deep-frozen canonical payloads must replay an identical digest');

const mutableArtifact = artifact();
const mutableDigest = canonicalMemorySsaDigest(mutableArtifact);
mutableArtifact.functionId = 'fn_changed';
assert.notEqual(canonicalMemorySsaDigest(mutableArtifact), mutableDigest,
  'mutable artifacts must never receive a stale memoized digest');

let accessorFunctionId = 'fn_accessor_a';
const accessorArtifact = artifact();
Object.defineProperty(accessorArtifact, 'functionId', {
  enumerable: true, configurable: false, get: () => accessorFunctionId,
});
Object.freeze(accessorArtifact);
const accessorDigest = canonicalMemorySsaDigest(accessorArtifact);
accessorFunctionId = 'fn_accessor_b';
assert.notEqual(canonicalMemorySsaDigest(accessorArtifact), accessorDigest,
  'frozen accessor objects must not be treated as immutable plain data');

const frozenAccess = deepFreeze(access());
const frozenBinding = canonicalAccessBinding(frozenAccess);
assert.equal(Object.isFrozen(frozenBinding), true, 'memoized access bindings must be immutable');
assert.equal(canonicalAccessBinding(frozenAccess), frozenBinding,
  'deep-frozen access rows may reuse the exact immutable binding');

const mutableAccess = access();
const mutableBinding = canonicalAccessBinding(mutableAccess);
mutableAccess.sourceEntityId = 'n_changed';
assert.notEqual(canonicalAccessBinding(mutableAccess).bindingDigest, mutableBinding.bindingDigest,
  'mutable access rows must be revalidated after mutation');

const proxyTarget = deepFreeze(access('n_proxy'));
const hostilePrototypeProxy = new Proxy(proxyTarget, {
  getPrototypeOf() { throw new Error('prototype trap'); },
});
assert.doesNotThrow(() => canonicalAccessBinding(hostilePrototypeProxy),
  'cache eligibility traps must fall back to uncached computation');
assert.notEqual(canonicalAccessBinding(hostilePrototypeProxy), canonicalAccessBinding(hostilePrototypeProxy),
  'objects whose cache eligibility cannot be proven must not reuse a cached binding');

console.log('semantic-v2 MemorySSA immutable proof cache: PASS');
""")
