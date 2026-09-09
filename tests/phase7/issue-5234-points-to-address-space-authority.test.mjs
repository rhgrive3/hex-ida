// Issue #5234 regression: analyzeLocalPointsTo() derived canonical address
// proofs without passing the value's own machineType.addressSpace, so
// deriveCanonicalAddressProof defaulted every constant to the 'memory' space.
// Two address constants with the same numeric address but different physical
// spaces ('memory' vs 'io') collapsed into one points-to target — a false
// MustAlias across address spaces. Identity of an absolute pointer includes
// its space.
import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../js/analysis/pointsto/local.js';

function sameAddressDifferentSpacesIr() {
  const vMem = {
    id: 'v_mem', kind: 'const', definitionNodeId: 'def_mem',
    machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' },
    metadata: { constant: '4096' },
  };
  const vIo = {
    id: 'v_io', kind: 'const', definitionNodeId: 'def_io',
    machineType: { kind: 'address', widthBits: 64, addressSpace: 'io' },
    metadata: { constant: '4096' },
  };
  return {
    functionId: 'f',
    values: [vMem, vIo],
    nodes: [
      { id: 'def_mem', kind: 'const', blockId: 'entry', outputs: ['v_mem'], completeness: 'complete' },
      { id: 'def_io', kind: 'const', blockId: 'entry', outputs: ['v_io'], completeness: 'complete' },
    ],
    blocks: [],
  };
}

test('#5234 the value machineType addressSpace carries into the canonical proof', () => {
  const result = analyzeLocalPointsTo(sameAddressDifferentSpacesIr(), null, { definitions: [], uses: [] }, {});
  const memTarget = result.pointsTo.get('v_mem')?.targets?.[0];
  const ioTarget = result.pointsTo.get('v_io')?.targets?.[0];
  assert.ok(memTarget && ioTarget, 'both constants must resolve to exact absolute targets');
  assert.equal(memTarget.addressSpace, 'memory');
  assert.equal(ioTarget.addressSpace, 'io', 'the io constant must not be projected into the memory space');
  assert.notEqual(memTarget.rootKey, ioTarget.rootKey, 'different spaces are different targets');
});

test('#5234 a plain memory-space constant keeps the canonical memory projection', () => {
  const ir = sameAddressDifferentSpacesIr();
  const result = analyzeLocalPointsTo(ir, null, { definitions: [], uses: [] }, {});
  const target = result.pointsTo.get('v_mem')?.targets?.[0];
  assert.equal(target.rootKind, 'absolute');
  assert.equal(target.address, '4096');
});
