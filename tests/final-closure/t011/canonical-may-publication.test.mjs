import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../../js/core/identity/index.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { buildMemorySsa } from '../../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';

const functionId = 'fn_t011_may_publication';
const origin = (id, index = 0) => ({
  instructionIds: [id],
  virtualRanges: [{ start: 0x6000n + BigInt(index * 4), end: 0x6004n + BigInt(index * 4) }],
});
const memory = (addressValueId) => ({
  addressSpace: 'memory',
  addressExpr: { valueId: addressValueId },
  widthBits: 32,
  endian: 'little',
  alignment: 4,
  volatility: false,
  atomic: false,
  ordering: 'unknown',
  faults: [],
});
const callSummary = {
  targetValueIds: [],
  targetEntityIds: [],
  arguments: [],
  returns: [],
  stateReads: [],
  stateWrites: [],
  memoryRead: { scope: 'none' },
  memoryWrite: { scope: 'all', addressSpaces: ['memory'] },
  controlEffects: [{ kind: 'call' }],
  determinism: 'deterministic',
  noreturn: false,
  mayThrow: false,
  summarySource: 'fixture',
  completeness: 'complete',
  unknownEffects: null,
};

function buildFixture({ olderOverlappingMayStore = false } = {}) {
  const values = [
    {
      id: 'stored',
      kind: 'entry',
      machineType: { kind: 'bitvector', widthBits: 32 },
      sourceEntityId: functionId,
      origin: origin('stored', 1),
    },
    {
      id: 'addr_exact',
      kind: 'entry',
      machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' },
      sourceEntityId: functionId,
      origin: origin('addr_exact', 2),
    },
    {
      id: 'addr_may',
      kind: 'entry',
      machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' },
      sourceEntityId: functionId,
      origin: origin('addr_may', 3),
    },
    {
      id: 'loaded',
      kind: 'definition',
      machineType: { kind: 'bitvector', widthBits: 32 },
      definitionNodeId: 'n_load',
      sourceEntityId: 'n_load',
      origin: origin('loaded', 12),
    },
  ];
  const oldMayStore = olderOverlappingMayStore ? [{
    id: 'n_may_old',
    kind: 'store',
    blockId: 'b0',
    inputs: ['addr_may', 'stored'],
    outputs: [],
    memory: memory('addr_may'),
    attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '0' } } } },
    origin: origin('n_may_old', 4),
  }] : [];
  const nodes = [
    ...oldMayStore,
    {
      id: 'n_may_disjoint',
      kind: 'store',
      blockId: 'b0',
      inputs: ['addr_may', 'stored'],
      outputs: [],
      memory: memory('addr_may'),
      attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '4' } } } },
      origin: origin('n_may_disjoint', 5),
    },
    {
      id: 'n_branch',
      kind: 'branch',
      blockId: 'b0',
      inputs: [],
      outputs: [],
      targets: ['b1', 'b2'],
      origin: origin('n_branch', 6),
    },
    {
      id: 'n_call',
      kind: 'call',
      blockId: 'b1',
      inputs: [],
      outputs: [],
      call: callSummary,
      origin: origin('n_call', 7),
    },
    {
      id: 'n_path',
      kind: 'const',
      blockId: 'b2',
      inputs: [],
      outputs: [],
      origin: origin('n_path', 8),
    },
    {
      id: 'n_store_exact',
      kind: 'store',
      blockId: 'b3',
      inputs: ['addr_exact', 'stored'],
      outputs: [],
      memory: memory('addr_exact'),
      attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '0' } } } },
      origin: origin('n_store_exact', 9),
    },
    {
      id: 'n_load',
      kind: 'load',
      blockId: 'b3',
      inputs: ['addr_exact'],
      outputs: ['loaded'],
      memory: memory('addr_exact'),
      attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '0' } } } },
      origin: origin('n_load', 10),
    },
    {
      id: 'n_return',
      kind: 'return',
      blockId: 'b3',
      inputs: ['loaded'],
      outputs: [],
      origin: origin('n_return', 11),
    },
  ];
  const blockNodes = [
    ...oldMayStore.map((node) => node.id),
    'n_may_disjoint', 'n_branch',
  ];
  const ir = createSemanticIrFunction({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId,
    entryBlockId: 'b0',
    blocks: [
      { id: 'b0', nodeIds: blockNodes, origin: origin('b0', 20) },
      { id: 'b1', nodeIds: ['n_call'], origin: origin('b1', 21) },
      { id: 'b2', nodeIds: ['n_path'], origin: origin('b2', 22) },
      { id: 'b3', nodeIds: ['n_store_exact', 'n_load', 'n_return'], origin: origin('b3', 23) },
    ],
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('function', 30),
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: 'b0',
    blocks: [
      { id: 'b0', successors: [{ to: 'b1', kind: 'conditional-true' }, { to: 'b2', kind: 'conditional-false' }] },
      { id: 'b1', successors: [{ to: 'b3', kind: 'branch' }] },
      { id: 'b2', successors: [{ to: 'b3', kind: 'branch' }] },
      { id: 'b3', successors: [] },
    ],
  });
  const exactRegion = createMemoryRegionRef({
    id: 'r_exact',
    kind: 'stack-fixed',
    functionId,
    offset: '0',
    widthBits: 32,
    origin: origin('r_exact', 31),
  });
  const mayRegion = createMemoryRegionRef({
    id: 'r_may',
    kind: 'stack-fixed',
    functionId,
    offset: '0',
    widthBits: 64,
    origin: origin('r_may', 32),
  });
  const identity = {
    binaryId: 'binary_fixture',
    sliceId: 'slice_fixture',
    functionId,
    semanticIrId: 'ir_fixture',
    semanticIrContractVersion: '2.0.0',
    semanticIrDigest: stableDigest(ir),
    scalarSsaId: 'ssa_fixture',
    scalarSsaBuildVersion: '1.0.0',
    scalarSsaDigest: 'ssa_fixture_digest',
    memorySsaId: 'mssa_fixture',
    snapshotId: 'snapshot_fixture',
    memorySsaBuildVersion: '1.0.0',
    analyzerVersion: 'memoryssa-fixture',
  };
  const queryAlias = (_left, right, context) => {
    const nodeId = context.left?.descriptor?.node?.id;
    const relation = nodeId === 'n_load'
      ? (right.id === 'r_exact' ? 'must' : 'may')
      : nodeId === 'n_store_exact'
        ? (right.id === 'r_exact' ? 'must' : 'no')
        : (nodeId === 'n_may_disjoint' || nodeId === 'n_may_old')
          ? (right.id === 'r_exact' ? 'no' : 'may')
          : 'no';
    return {
      relation,
      reasonCodes: [`fixture-${relation}`],
      evidenceIds: [`fixture-${nodeId}-${right.id}`],
      proof: {
        analyzerId: 'phase7.alias.solver',
        analyzerVersion: '1.1.0',
        completeness: 'complete',
        stopReason: null,
      },
    };
  };
  const memorySsa = buildMemorySsa(ir, cfg, {
    regions: [exactRegion, mayRegion],
    resolveRegion: (_memory, context) => {
      if (context.node.id === 'n_load' || context.node.id === 'n_store_exact') return exactRegion;
      if (context.node.id === 'n_may_disjoint' || context.node.id === 'n_may_old') return mayRegion;
      return exactRegion;
    },
    queryAlias,
    identity,
    snapshotId: 'snapshot_fixture',
    canonicalIrIdentity: {
      functionId,
      semanticIrId: 'ir_fixture',
      semanticIrContractVersion: '2.0.0',
      semanticIrDigest: stableDigest(ir),
    },
  });
  return { ir, cfg, memorySsa };
}

function projectedLoad(fixture) {
  const projected = projectSemanticIrV2ToLegacyV1(fixture.ir, {
    memorySsa: fixture.memorySsa,
    cfg: fixture.cfg,
  });
  const load = projected.instructions.find((instruction) => instruction.semanticNodeId === 'n_load');
  return { projected, load };
}

test('T011 canonical MAY disjoint proof publishes on a joined physical LOAD and rejects older overlap', () => {
  const valid = buildFixture();
  const validCoverage = valid.memorySsa.byteCoverage.find((row) => row.nodeId === 'n_load');
  const validMayState = validCoverage?.regionStates.find((state) => state.aliasRelation === 'may');
  const validMayDefinition = valid.memorySsa.definitions.find((definition) =>
    definition.id === validMayState?.definitionId);
  const validMayMetadata = valid.memorySsa.accessMetadata.find((metadata) =>
    metadata.memorySsaEntityId === validMayState?.definitionId);
  assert.equal(validMayState?.regionId, 'r_may');
  assert.equal(validMayDefinition?.kind, 'may-alias-clobber');
  assert.deepEqual(validMayMetadata?.byteRange && [validMayMetadata.byteRange.start, validMayMetadata.byteRange.end], ['4', '8']);

  const validProjection = projectedLoad(valid);
  assert.equal(validProjection.projected.blocks.find((block) => block.semanticBlockId === 'b3')?.pred.length, 2);
  assert.equal(validProjection.projected.instructions.some((instruction) => instruction.op === 'call'), true);
  assert.equal(validProjection.load?.op, 'load');
  assert.equal(validProjection.load?.loc?.kind, 'stack');
  assert.equal(validProjection.load?.memoryOperandForwarding?.status, 'exact');
  assert.equal(validProjection.load?.memoryOperandForwarding?.proofKind, 'canonical-memoryssa-operand-forwarding');
  assert.equal(validProjection.load?.memoryOperandForwarding?.storedValueId, 'stored');

  const invalid = buildFixture({ olderOverlappingMayStore: true });
  const invalidProjection = projectedLoad(invalid);
  assert.equal(invalidProjection.load?.op, 'load');
  assert.equal(invalidProjection.load?.memoryOperandForwarding, undefined);
  assert.notEqual(invalidProjection.load?.memoryForwarding?.status, 'exact');
});
