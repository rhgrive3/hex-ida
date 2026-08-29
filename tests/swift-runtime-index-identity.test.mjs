import assert from 'node:assert/strict';
import { buildSwiftRuntimeIndex, resolveSwiftDispatch } from '../js/swift.js';

const typeA = {
  address: 0x1000n,
  name: 'Worker',
  moduleName: 'Alpha',
  vtable: [{ index: 0, impl: 0xa001n }],
};
const typeB = {
  address: 0x2000n,
  name: 'Worker',
  moduleName: 'Beta',
  vtable: [{ index: 0, impl: 0xb001n }],
};
const protoA = { address: 0x3000n, name: 'Runnable', moduleName: 'Alpha' };
const protoB = { address: 0x4000n, name: 'Runnable', moduleName: 'Beta' };
const confA = {
  typeReferenceKind: 0,
  typeRef: typeA.address,
  protocol: protoA.address,
  witnessTable: 0x5000n,
};
const confB = {
  typeReferenceKind: 0,
  typeRef: typeB.address,
  protocol: protoB.address,
  witnessTable: 0x6000n,
};
const witnessA = { address: 0x5000n, entries: [{ index: 0, target: 0xa101n }] };
const witnessB = { address: 0x6000n, entries: [{ index: 0, target: 0xb101n }] };

const index = buildSwiftRuntimeIndex({
  types: [typeA, typeB],
  protocols: [protoA, protoB],
  conformances: [confA, confB],
  witnessTables: [witnessA, witnessB],
});

assert.equal(index.typesByName.has('Worker'), false, 'ambiguous simple type aliases must not resolve');
assert.equal(index.protocolsByName.has('Runnable'), false, 'ambiguous simple protocol aliases must not resolve');

assert.equal(
  resolveSwiftDispatch(index, { kind: 'vtable', typeName: 'Worker', slot: 0 }).resolved,
  null,
  'ambiguous simple type name must fail closed',
);
assert.equal(
  resolveSwiftDispatch(index, { kind: 'vtable', typeName: 'Alpha.Worker', slot: 0 }).resolved?.impl,
  0xa001n,
  'unique qualified alias must resolve the intended type',
);
assert.equal(
  resolveSwiftDispatch(index, { kind: 'vtable', typeAddress: typeB.address, slot: 0 }).resolved?.impl,
  0xb001n,
  'descriptor identity must resolve deterministically',
);

assert.equal(
  resolveSwiftDispatch(index, {
    kind: 'witness',
    typeName: 'Worker',
    protocolName: 'Runnable',
    slot: 0,
  }).resolved,
  null,
  'ambiguous display names must not select a witness table',
);
assert.equal(
  resolveSwiftDispatch(index, {
    kind: 'witness',
    typeName: 'Alpha.Worker',
    protocolName: 'Alpha.Runnable',
    slot: 0,
  }).resolved?.target,
  0xa101n,
  'qualified aliases must resolve the matching conformance and witness table',
);
assert.equal(
  resolveSwiftDispatch(index, {
    kind: 'existential',
    typeAddress: typeB.address,
    protocolAddress: protoB.address,
    slot: 0,
  }).resolved?.target,
  0xb101n,
  'descriptor identities must resolve the matching existential witness entry',
);

console.log('swift runtime dispatch identity collision regression passed');
