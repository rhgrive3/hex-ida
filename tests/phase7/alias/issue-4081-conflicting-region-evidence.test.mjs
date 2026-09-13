import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aliasMemoryRegions,
  classifySemanticMemoryRegion,
  deriveMemoryRegion,
} from '../../../js/analysis/alias/index-v2.js';

const functionId = 'function_issue_4081';
const binaryId = 'binary_issue_4081';
const origin = { instructionIds: ['instruction_issue_4081'] };

function classify(nodeDescriptor, valueDescriptor, { swap = false } = {}) {
  const first = swap ? valueDescriptor : nodeDescriptor;
  const second = swap ? nodeDescriptor : valueDescriptor;
  const ir = {
    functionId,
    binaryId,
    origin,
    values: [{
      id: 'addr',
      kind: 'definition',
      definitionNodeId: 'addr-def',
      origin,
      metadata: { memoryRegion: second },
    }],
    nodes: [
      { id: 'addr-def', kind: 'address', blockId: 'entry', origin },
      {
        id: 'load0',
        kind: 'load',
        blockId: 'entry',
        origin,
        memory: {
          widthBits: 64,
          addressSpace: 'memory',
          addressExpr: { valueId: 'addr' },
        },
        attributes: { memoryRegion: first },
      },
    ],
  };
  return classifySemanticMemoryRegion(ir, 'load0', { binaryId });
}

test('#4081 canonically identical descriptor sources keep precise stack evidence', () => {
  const result = classify(
    { kind: 'stack-fixed', offset: 0 },
    { kind: 'stack-fixed', offset: '0' },
  );
  assert.equal(result.kind, 'stack-fixed');
  assert.equal(result.offset, '0');
});

test('#4081 contradictory stack offsets fail closed independent of descriptor source order', () => {
  for (const swap of [false, true]) {
    const result = classify(
      { kind: 'stack-fixed', offset: 0 },
      { kind: 'stack-fixed', offset: 8 },
      { swap },
    );
    assert.equal(result.kind, 'unknown');
    assert.equal(result.metadata?.reason, 'conflicting-region-evidence');

    const other = deriveMemoryRegion({
      functionId,
      binaryId,
      memory: { widthBits: 64, addressSpace: 'memory', addressExpr: { valueId: 'other' } },
      origin,
      regionEvidence: { kind: 'stack-fixed', offset: 8 },
      sourceEntityId: 'other-load',
    });
    const relation = aliasMemoryRegions(result, other);
    assert.notEqual(relation, 'must', 'conflicting evidence cannot mint MustAlias');
    assert.notEqual(relation, 'no', 'conflicting evidence cannot mint NoAlias');
  }
});

test('#4081 contradictory global addresses fail closed', () => {
  const result = classify(
    { kind: 'global-absolute', address: '0x1000' },
    { kind: 'global-absolute', address: '0x2000' },
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(result.metadata?.reason, 'conflicting-region-evidence');
});

test('#4081 contradictory rooted identities fail closed', () => {
  const result = classify(
    { kind: 'rooted-offset', rootEntityId: 'root-a', offset: 16 },
    { kind: 'rooted-offset', rootEntityId: 'root-b', offset: 16 },
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(result.metadata?.reason, 'conflicting-region-evidence');
});

test('#4081 contradictory rooted offsets fail closed', () => {
  const result = classify(
    { kind: 'rooted-offset', rootEntityId: 'root-a', offset: 16 },
    { kind: 'rooted-offset', rootEntityId: 'root-a', offset: 24 },
  );
  assert.equal(result.kind, 'unknown');
});

test('#4081 contradictory precise kinds fail closed', () => {
  const result = classify(
    { kind: 'stack-fixed', offset: 0 },
    { kind: 'global-absolute', address: '0x1000' },
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(result.metadata?.reason, 'conflicting-region-evidence');
});

test('#4081 compatible rooted address-space detail merges independent of source order', () => {
  let expectedId = null;
  for (const swap of [false, true]) {
    const result = classify(
      { kind: 'rooted-offset', rootEntityId: 'root-a', offset: 16 },
      { kind: 'rooted-offset', rootEntityId: 'root-a', offset: 16, addressSpace: 'memory' },
      { swap },
    );
    assert.equal(result.kind, 'rooted-offset');
    assert.equal(result.addressSpace, 'memory');
    expectedId ??= result.id;
    assert.equal(result.id, expectedId);
  }
});

test('#4081 malformed same-kind secondary metadata cannot crash or revoke valid primary proof', () => {
  const result = classify(
    { kind: 'stack-fixed', offset: 0 },
    { kind: 'stack-fixed', offset: { malformed: true } },
  );
  assert.equal(result.kind, 'stack-fixed');
  assert.equal(result.offset, '0');
});
