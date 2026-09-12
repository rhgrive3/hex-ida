import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeAddressProofIr } from '../../../js/analysis/alias/address-ir-normalize-v2.js';
import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2-core.js';
import { classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { nativeDispatchAddressValues } from '../../../js/analysis/dispatch/native-memory-targets.js';

const bit64 = { kind: 'bitvector', widthBits: 64 };
const origin = (id) => ({ instructionIds: [`i:${id}`] });

function constant(id, valueId, value, widthBits = 64) {
  const payload = { kind: 'bitvector', widthBits, value: String(value) };
  return {
    node: { id, kind: 'const', blockId: 'b0', inputs: [], outputs: [valueId], attributes: { constant: payload }, completeness: 'complete', origin: origin(id) },
    value: { id: valueId, kind: 'definition', machineType: { kind: 'bitvector', widthBits }, definitionNodeId: id, metadata: { constant: payload }, origin: origin(valueId) },
  };
}

function fixture({ subtract, carry = 0, malformedSubtract = undefined } = {}) {
  const rootNode = {
    id: 'root.read', kind: 'state-read', blockId: 'b0', inputs: [], outputs: ['root'],
    variable: { key: 'root.a', kind: 'logical-state', scope: 'function' },
    attributes: {}, completeness: 'complete', origin: origin('root.read'),
  };
  const rootValue = { id: 'root', kind: 'definition', machineType: bit64, definitionNodeId: rootNode.id, variableKey: 'root.a', origin: origin('root') };
  const rhs = constant('rhs.const', 'rhs', 8);
  const cin = constant('carry.const', 'carry', carry, 1);
  const nodes = [rootNode, rhs.node, cin.node];
  const values = [rootValue, rhs.value, cin.value];

  let rhsInput = 'rhs';
  if (subtract === true && carry === 1) {
    nodes.push({ id: 'rhs.not', kind: 'unary', blockId: 'b0', operator: 'not', inputs: ['rhs'], outputs: ['rhs.not.v'], attributes: {}, completeness: 'complete', origin: origin('rhs.not') });
    values.push({ id: 'rhs.not.v', kind: 'definition', machineType: bit64, definitionNodeId: 'rhs.not', origin: origin('rhs.not.v') });
    rhsInput = 'rhs.not.v';
  }

  const operationMetadata = malformedSubtract !== undefined
    ? { subtract: malformedSubtract }
    : subtract === undefined ? undefined : { subtract };
  const adcAttributes = operationMetadata === undefined ? {} : { machineEffects: { operationMetadata } };
  const adc = {
    id: 'adc', kind: 'intrinsic', blockId: 'b0', operator: 'add-with-carry',
    inputs: ['root', rhsInput, 'carry'], outputs: ['out', 'cout', 'overflow'],
    attributes: adcAttributes, completeness: 'complete', origin: origin('adc'),
  };
  nodes.push(adc);
  values.push({ id: 'out', kind: 'definition', machineType: bit64, definitionNodeId: 'adc', origin: origin('out') });

  const load = {
    id: 'load', kind: 'load', blockId: 'b0', inputs: ['out'], outputs: [],
    memory: { addressSpace: 'memory', addressExpr: { valueId: 'out' }, widthBits: 32, endian: 'little', alignment: null, volatility: false, atomic: false, ordering: 'unknown', faults: [] },
    attributes: {}, completeness: 'complete', origin: origin('load'),
  };
  nodes.push(load);

  return {
    functionId: 'fn:5326', origin: origin('fn'),
    blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id), origin: origin('b0') }],
    values, nodes,
  };
}

function proof(ir) { return deriveCanonicalAddressProof(ir, 'out', { addressSpace: 'memory' }); }
function normalizedProof(ir) { return proof(normalizeAddressProofIr(ir)); }


function nativeScalarAddresses(operationMetadata) {
  const values = new Map([
    ['lhs', { id: 'lhs', machineType: bit64, definitionNodeId: 'lhs.const', metadata: { constant: { kind: 'bitvector', widthBits: 64, value: '4096' } } }],
    ['rhs', { id: 'rhs', machineType: bit64, definitionNodeId: 'rhs.const', metadata: { constant: { kind: 'bitvector', widthBits: 64, value: '8' } } }],
    ['carry', { id: 'carry', machineType: { kind: 'bitvector', widthBits: 1 }, definitionNodeId: 'carry.const', metadata: { constant: { kind: 'bitvector', widthBits: 1, value: '0' } } }],
    ['out', { id: 'out', machineType: bit64, definitionNodeId: 'adc' }],
  ]);
  const definitions = new Map([
    ['lhs.const', { id: 'lhs.const', kind: 'const', inputs: [], outputs: ['lhs'], attributes: { constant: { kind: 'bitvector', widthBits: 64, value: '4096' } } }],
    ['rhs.const', { id: 'rhs.const', kind: 'const', inputs: [], outputs: ['rhs'], attributes: { constant: { kind: 'bitvector', widthBits: 64, value: '8' } } }],
    ['carry.const', { id: 'carry.const', kind: 'const', inputs: [], outputs: ['carry'], attributes: { constant: { kind: 'bitvector', widthBits: 1, value: '0' } } }],
    ['adc', {
      id: 'adc', kind: 'intrinsic', operator: 'add-with-carry', inputs: ['lhs', 'rhs', 'carry'], outputs: ['out'],
      attributes: operationMetadata === undefined ? {} : { machineEffects: { operationMetadata } }, completeness: 'complete',
    }],
  ]);
  const projection = {
    canonicalValue: (id) => values.get(id) ?? null,
    entityReference: (kind, id) => kind === 'semantic-ir' && definitions.has(id) ? `ref:${id}` : null,
    source: (ref) => typeof ref === 'string' && ref.startsWith('ref:') ? definitions.get(ref.slice(4)) ?? null : null,
    adjacent: () => [],
    edge: () => null,
  };
  const work = { charge() {} };
  return nativeDispatchAddressValues(projection, 'out', { ranges: { bindings: [], values: [] } }, work).addresses;
}

function assertRootedOffset(actual, offset) {
  assert.equal(actual.kind, 'rooted');
  assert.equal(actual.offset, BigInt(offset));
}

test('#5326 explicit addition-form carry=0 keeps canonical add projection', () => {
  const ir = fixture({ subtract: false, carry: 0 });
  assertRootedOffset(proof(ir), 8);
  assertRootedOffset(normalizedProof(ir), 8);
  assert.notEqual(normalizeAddressProofIr(ir), ir);
});

test('#5326 subtract-form carry=0 cannot be laundered into binary add', () => {
  const ir = fixture({ subtract: true, carry: 0 });
  assert.equal(proof(ir).kind, 'unknown');
  assert.equal(normalizedProof(ir).kind, 'unknown');
  assert.equal(normalizeAddressProofIr(ir), ir);
});

test('#5326 missing operation metadata is not addition authority', () => {
  const ir = fixture({ carry: 0 });
  assert.equal(proof(ir).kind, 'unknown');
  assert.equal(normalizedProof(ir).kind, 'unknown');
  assert.equal(normalizeAddressProofIr(ir), ir);
});

test('#5326 malformed subtract metadata is not addition authority', () => {
  const ir = fixture({ malformedSubtract: 'false', carry: 0 });
  assert.equal(proof(ir).kind, 'unknown');
  assert.equal(normalizedProof(ir).kind, 'unknown');
  assert.equal(normalizeAddressProofIr(ir), ir);
});

test('#5326 canonical subtract-form carry=1 stays on the core subtraction path', () => {
  const ir = fixture({ subtract: true, carry: 1 });
  assertRootedOffset(proof(ir), -8);
  assertRootedOffset(normalizedProof(ir), -8);
  assert.equal(normalizeAddressProofIr(ir), ir);
});

test('#5326 regions-v2 fails closed for subtract-form carry=0', () => {
  const region = classifySemanticMemoryRegion(fixture({ subtract: true, carry: 0 }), 'load', { binaryId: 'bin:5326' });
  assert.equal(region.kind, 'unknown');
});

test('#5326 regions-v2 preserves explicit addition-form carry=0 precision', () => {
  const region = classifySemanticMemoryRegion(fixture({ subtract: false, carry: 0 }), 'load', { binaryId: 'bin:5326' });
  assert.equal(region.kind, 'rooted-offset');
  assert.equal(region.metadata?.canonicalAddressIncludesOperationDisplacement, true);
});


test('#5326 native dispatch scalar recovery accepts only explicit addition-form metadata', () => {
  assert.deepEqual(nativeScalarAddresses({ subtract: false }), ['4104']);
  assert.deepEqual(nativeScalarAddresses({ subtract: true }), []);
});

test('#5326 native dispatch scalar recovery rejects missing or malformed addition authority', () => {
  assert.deepEqual(nativeScalarAddresses(undefined), []);
  assert.deepEqual(nativeScalarAddresses({ subtract: 'false' }), []);
});
