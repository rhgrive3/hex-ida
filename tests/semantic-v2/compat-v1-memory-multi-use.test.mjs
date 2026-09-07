import assert from 'node:assert/strict';

import { stableDigest } from '../../js/core/identity/index.js';
import { OP } from '../../js/ir-core.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { forwardExactStackOperandIdentity } from '../../js/semantics/memoryssa/operand-forwarding.js';

const functionId = 'compat_multi_region_load';
const origin = (id, index = 0) => ({
  instructionIds: [id],
  virtualRanges: [{ start: 0x1000n + BigInt(index * 4), end: 0x1004n + BigInt(index * 4) }],
});
const machineEffects = (addressDisplacement) => ({
  machineEffects: { operationMetadata: { addressing: { addressDisplacement: String(addressDisplacement) } } },
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

const ir = createSemanticIrFunction({
  schemaVersion: 2,
  contractVersion: '2.0.0',
  functionId,
  entryBlockId: 'b0',
  blocks: [{ id: 'b0', nodeIds: ['n_store', 'n_load', 'n_ret'], origin: origin('block') }],
  values: [
    { id: 'store_addr', kind: 'entry', machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' }, sourceEntityId: functionId, origin: origin('store_addr') },
    { id: 'load_addr', kind: 'entry', machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' }, sourceEntityId: functionId, origin: origin('load_addr', 1) },
    { id: 'stored', kind: 'entry', machineType: { kind: 'bitvector', widthBits: 32 }, sourceEntityId: functionId, origin: origin('stored', 2) },
    { id: 'loaded', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 32 }, definitionNodeId: 'n_load', sourceEntityId: 'n_load', origin: origin('loaded', 4) },
  ],
  nodes: [
    { id: 'n_store', kind: 'store', blockId: 'b0', inputs: ['store_addr', 'stored'], outputs: [], memory: memory('store_addr'), attributes: machineEffects(0), origin: origin('n_store', 3) },
    { id: 'n_load', kind: 'load', blockId: 'b0', inputs: ['load_addr'], outputs: ['loaded'], memory: memory('load_addr'), attributes: machineEffects(8), origin: origin('n_load', 4) },
    { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: ['loaded'], outputs: [], origin: origin('n_ret', 5) },
  ],
  completeness: 'complete',
  unknowns: [],
  origin: origin('function'),
});
const cfg = createSemanticCfg({
  functionId,
  entryBlockId: 'b0',
  blocks: [{ id: 'b0', successors: [] }],
});
const exactRegion = createMemoryRegionRef({
  id: 'a_stack',
  kind: 'stack-fixed',
  functionId,
  offset: '8',
  widthBits: 32,
  metadata: { canonicalAddressIncludesOperationDisplacement: true },
  origin: origin('exact_region'),
});
const alternateRegion = createMemoryRegionRef({
  id: 'candidate2',
  kind: 'stack-fixed',
  functionId,
  offset: '0',
  widthBits: 32,
  origin: origin('alternate_region'),
});

function accessInterval(region, descriptor) {
  const encoded = descriptor?.node?.attributes?.machineEffects?.operationMetadata?.addressing?.addressDisplacement ?? 0;
  const displacement = region.metadata?.canonicalAddressIncludesOperationDisplacement === true
    ? 0n
    : BigInt(encoded);
  const start = BigInt(region.offset) + displacement;
  const widthBits = Number(descriptor?.memory?.widthBits ?? region.widthBits);
  return { start, end: start + BigInt(widthBits / 8) };
}

function queryAlias(left, right, context) {
  const l = accessInterval(left, context.left.descriptor);
  const r = accessInterval(right, context.right.descriptor);
  const relation = l.start === r.start && l.end === r.end
    ? 'must'
    : (l.end <= r.start || r.end <= l.start ? 'no' : 'may');
  return {
    relation,
    reasonCodes: ['fixture-range-relation'],
    evidenceIds: [`${l.start}:${l.end}:${r.start}:${r.end}`],
    proof: {
      analyzerId: 'phase7.alias.solver',
      analyzerVersion: '1.1.0',
      completeness: 'complete',
      stopReason: null,
    },
  };
}

function build(multi) {
  const semanticIrDigest = stableDigest(ir);
  return buildMemorySsa(ir, cfg, {
    regions: multi ? [exactRegion, alternateRegion] : [exactRegion],
    resolveRegion(_access, context) {
      return context.node.id === 'n_load' && multi
        ? [exactRegion, alternateRegion]
        : exactRegion;
    },
    queryAlias,
    identity: {
      binaryId: 'binary',
      sliceId: 'slice',
      functionId,
      semanticIrId: 'ir',
      snapshotId: `snapshot-${multi}`,
      semanticIrContractVersion: '2.0.0',
      semanticIrDigest,
      scalarSsaId: 'ssa',
      scalarSsaBuildVersion: '1.0.0',
      scalarSsaDigest: 'ssa-digest',
      memorySsaId: `mssa-${multi}`,
      memorySsaBuildVersion: '1.0.0',
      analyzerVersion: 'fixture',
    },
    snapshotId: `snapshot-${multi}`,
    canonicalIrIdentity: {
      functionId,
      semanticIrId: 'ir',
      semanticIrContractVersion: '2.0.0',
      semanticIrDigest,
    },
  });
}

const multi = build(true);
const sharedUses = multi.uses.filter((use) => use.sourceEntityId === 'n_load');
assert.equal(sharedUses.length, 2);
assert.equal(sharedUses[0].regionId, exactRegion.id);
assert.equal(forwardExactStackOperandIdentity(multi, sharedUses[0], ir)?.exact, true,
  'the first use must exercise the exact operand-forwarding candidate');

const multiProjection = projectSemanticIrV2ToLegacyV1(ir, { memorySsa: multi, cfg });
const multiLoad = multiProjection.instructions.find((inst) => inst.semanticNodeId === 'n_load');
assert.equal(multiLoad.op, OP.LOAD,
  'one projected instruction cannot publish a per-region operand proof for a multi-use load');
assert.equal(multiLoad.memoryOperandForwarding, undefined);
assert.equal(multiLoad.addr.base.semanticValueId, 'load_addr');

const single = build(false);
const singleProjection = projectSemanticIrV2ToLegacyV1(ir, { memorySsa: single, cfg });
const singleLoad = singleProjection.instructions.find((inst) => inst.semanticNodeId === 'n_load');
assert.equal(singleLoad.op, OP.MOV, 'the sound single-use forwarding path must remain enabled');
assert.equal(singleLoad.sub, 'memory-forward');
assert.equal(singleLoad.memoryOperandForwarding.storedValueId, 'stored');
assert.equal(singleLoad.args[0].value.semanticValueId, 'stored');

console.log('semantic-v2 deferred multi-use forwarding: PASS');
