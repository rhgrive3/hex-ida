import assert from 'node:assert/strict';
import { stableDigest } from '../../js/core/identity/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { MEMORY_SSA_BUILD_VERSION, buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  forwardMemoryValue,
} from '../../js/semantics/memoryssa/queries.js';

const functionId = 'function_issue_8979';
const origin = (id, index = 0) => ({
  instructionIds: [id],
  virtualRanges: [{ start: 0x1000n + BigInt(index * 4), end: 0x1004n + BigInt(index * 4) }],
});
const memory = (valueId) => ({
  addressSpace: 'memory',
  addressExpr: { valueId },
  widthBits: 32,
  endian: 'little',
  alignment: 4,
  volatility: false,
  atomic: false,
  ordering: 'unknown',
  faults: [],
});

function buildIr(pairCount) {
  const values = [];
  const nodes = [];
  for (let index = 0; index < pairCount; index += 1) {
    values.push(
      { id: `saddr_${index}`, kind: 'entry', machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' }, sourceEntityId: functionId, origin: origin(`saddr_${index}`, index) },
      { id: `laddr_${index}`, kind: 'entry', machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' }, sourceEntityId: functionId, origin: origin(`laddr_${index}`, index) },
      { id: `stored_${index}`, kind: 'entry', machineType: { kind: 'bitvector', widthBits: 32 }, sourceEntityId: functionId, origin: origin(`stored_${index}`, index) },
      { id: `loaded_${index}`, kind: 'definition', machineType: { kind: 'bitvector', widthBits: 32 }, definitionNodeId: `load_${index}`, sourceEntityId: `load_${index}`, origin: origin(`loaded_${index}`, index) },
    );
    nodes.push(
      { id: `store_${index}`, kind: 'store', blockId: 'b0', inputs: [`saddr_${index}`, `stored_${index}`], outputs: [], memory: memory(`saddr_${index}`), attributes: {}, origin: origin(`store_${index}`, index) },
      { id: `load_${index}`, kind: 'load', blockId: 'b0', inputs: [`laddr_${index}`], outputs: [`loaded_${index}`], memory: memory(`laddr_${index}`), attributes: {}, origin: origin(`load_${index}`, index) },
    );
  }
  values.push({ id: 'sink', kind: 'entry', machineType: { kind: 'bitvector', widthBits: 32 }, sourceEntityId: functionId, origin: origin('sink', pairCount) });
  return createSemanticIrFunction({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId,
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id).concat('ret'), origin: origin('block') }],
    values,
    nodes: nodes.concat([{ id: 'ret', kind: 'return', blockId: 'b0', inputs: values.filter((value) => value.id.startsWith('loaded_')).map((value) => value.id).concat('sink'), outputs: [], origin: origin('ret', pairCount) }]),
    completeness: 'complete',
    unknowns: [],
    origin: origin('function'),
  });
}

const cfg = createSemanticCfg({
  functionId,
  entryBlockId: 'b0',
  blocks: [{ id: 'b0', successors: [] }],
});

function buildPair(pairCount) {
  const ir = buildIr(pairCount);
  const regions = [];
  for (let index = 0; index < pairCount; index += 1) {
    regions.push(createMemoryRegionRef({
      id: `region_${index}`,
      kind: 'stack-fixed',
      functionId,
      offset: String(8 + index * 8),
      widthBits: 32,
      origin: origin(`region_${index}`, index),
    }));
  }
  const regionIndex = new Map();
  for (let index = 0; index < pairCount; index += 1) {
    regionIndex.set(`saddr_${index}`, index);
    regionIndex.set(`laddr_${index}`, index);
  }
  const intervalOf = (region) => ({ start: BigInt(region.offset), end: BigInt(region.offset) + 4n });
  const semanticIrDigest = stableDigest(ir);
  const artifact = buildMemorySsa(ir, cfg, {
    regions,
    resolveRegion(access) {
      const index = regionIndex.get(String(access?.addressExpr?.valueId ?? ''));
      if (index == null) throw new Error('unresolved-address');
      return regions[index];
    },
    queryAlias(left, right) {
      if (String(left.id) === String(right.id)) return 'must';
      const l = intervalOf(left);
      const r = intervalOf(right);
      return l.end <= r.start || r.end <= l.start ? 'no' : 'may';
    },
    identity: {
      binaryId: 'binary-8979',
      sliceId: 'slice-8979',
      functionId,
      semanticIrId: 'ir-8979',
      snapshotId: 'snapshot-8979',
      semanticIrContractVersion: '2.0.0',
      semanticIrDigest,
      scalarSsaId: 'ssa-8979',
      scalarSsaBuildVersion: '1.0.0',
      scalarSsaDigest: 'ssa-digest-8979',
      memorySsaId: 'mssa-8979',
      memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
      analyzerVersion: 'fixture',
    },
    snapshotId: 'snapshot-8979',
    canonicalIrIdentity: {
      functionId,
      semanticIrId: 'ir-8979',
      semanticIrContractVersion: '2.0.0',
      semanticIrDigest,
    },
  });
  return { ir, artifact };
}

// Instrument an immutable IR by reading through a frozen pass-through proxy so
// every canonical digest / structural pass over the whole artifact is visible
// as a top-level property read.
function instrumentIr(ir) {
  let reads = 0;
  const proxy = new Proxy(ir, {
    get(target, property, receiver) {
      if (typeof property === 'string') reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxy, reads: () => reads };
}

function queryOptions(ir, extra = {}) {
  return {
    functionId,
    memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
    ir,
    ...extra,
  };
}

// 1. After the first (cold) query, warm queries must not walk the whole IR.
{
  const { ir, artifact } = buildPair(12);
  const { proxy, reads } = instrumentIr(ir);
  const uses = artifact.uses.filter((use) => String(use.id).length > 0);
  assert.ok(uses.length >= 12, 'fixture must publish one use per load');

  const before = reads();
  forwardMemoryValue(artifact, uses[0], queryOptions(proxy));
  const coldDelta = reads() - before;
  assert.ok(coldDelta > 0, 'the cold query must canonically read the IR');

  const warmStart = reads();
  for (let round = 0; round < 3; round += 1) {
    for (const use of uses) forwardMemoryValue(artifact, use, queryOptions(proxy));
  }
  const warmDelta = reads() - warmStart;
  const queryCount = uses.length * 3;
  // A full canonical IR digest costs one read per top-level IR key (coldDelta).
  // Warm queries may keep tiny local property reads, but must never re-derive
  // the whole artifact: per-query cost has to stay far below one digest.
  assert.ok(warmDelta <= queryCount * 2 && warmDelta * 2 < coldDelta * queryCount,
    `warming must not re-digest the IR per query: ${warmDelta} reads across ${queryCount} queries vs ${coldDelta} for one cold digest`);
}

// 2. Repeated queries over the same immutable artifact return byte-identical
//    forwarding evidence, and the whole artifact view keeps working after warm
//    reuse (validation / index / digests are shared, never weakened).
{
  const { ir, artifact } = buildPair(6);
  const uses = artifact.uses;
  const cold = uses.map((use) => JSON.parse(JSON.stringify(forwardMemoryValue(artifact, use, queryOptions(ir)))));
  const warm = uses.map((use) => JSON.parse(JSON.stringify(forwardMemoryValue(artifact, use, queryOptions(ir)))));
  assert.deepEqual(warm, cold, 'cached precomputation must not change any forwarding outcome');
}

// 3. A different (also valid, frozen) IR object still receives the full
//    staleness gate: a mismatched canonical IR digest must fail closed.
{
  const { ir, artifact } = buildPair(4);
  const use = artifact.uses[0];
  forwardMemoryValue(artifact, use, queryOptions(ir));
  const diverged = createSemanticIrFunction({
    ...ir,
    origin: origin('function-diverged'),
  });
  assert.notEqual(diverged.origin.operationIds[0] ?? diverged.origin.instructionIds[0],
    ir.origin.operationIds[0] ?? ir.origin.instructionIds[0]);
  const stale = forwardMemoryValue(artifact, use, queryOptions(diverged));
  assert.notEqual(stale.status, 'exact', 'mismatched IR must never produce an exact forwarding fact');
  assert.ok(String(stale.reason ?? '').includes('canonical-ir'),
    `expected canonical IR staleness rejection, got ${stale.status}/${stale.reason}`);
}

// 4. Per-query control state still wins over any cached result: a shared
//    expired deadline must stop every warm query.
{
  const { ir, artifact } = buildPair(4);
  const use = artifact.uses[0];
  forwardMemoryValue(artifact, use, queryOptions(ir));
  const limited = forwardMemoryValue(artifact, use, queryOptions(ir, { deadline: Date.now() - 1000 }));
  assert.notEqual(limited.status, 'exact');
  assert.ok(String(limited.reason ?? '').includes('deadline')
    || String(limited.status ?? '') === 'budget-limited',
  `expired deadline must budget-limit a warm query, got ${limited.status}/${limited.reason}`);
}

// 5. A non-canonically-issued (cloned, unfrozen) artifact never receives a
//    cached pass and keeps the standalone fail-closed behaviour.
{
  const { ir, artifact } = buildPair(4);
  const use = artifact.uses[0];
  const clone = { ...artifact };
  const first = forwardMemoryValue(artifact, use, queryOptions(ir));
  const cloned = forwardMemoryValue(artifact, use, queryOptions(ir, { skipValidation: false }));
  const viaClone = forwardMemoryValue(clone, String(use.id), queryOptions(ir));
  assert.equal(JSON.stringify(cloned), JSON.stringify(first));
  assert.notEqual(viaClone.status, 'exact', 'a serialized clone has no producer binding and must not mint exactness');
}

console.log('issue-8979 compat forwarding per-load revalidation: PASS');
