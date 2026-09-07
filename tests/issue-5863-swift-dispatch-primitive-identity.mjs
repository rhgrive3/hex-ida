import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSwiftRuntimeIndex, resolveSwiftDispatch } from '../js/swift.js';

const method = { index: 0, name: 'method0', impl: 0x2000n };
const witness = { index: 0, name: 'witness0', impl: 0x3000n };
const witness1 = { index: 1, name: 'witness1', impl: 0x3001n };
const type = { kind: 'struct', name: 'S', address: 4096n };
const protocol = { kind: 'protocol', name: 'P', address: 4097n };
const index = buildSwiftRuntimeIndex({
  complete: true,
  types: [type],
  protocols: [protocol],
  conformances: [{
    typeReferenceKind: 0,
    typeRef: 4096n,
    protocol: 4097n,
    witnessTable: 8192n,
  }],
  vtables: [{ typeAddress: 4096n, methods: [method] }],
  witnessTables: [{
    address: 8192n,
    typeAddress: 4096n,
    protocolAddress: 4097n,
    entries: [witness, witness1],
  }],
});

function assertNoExactDispatch(result, message) {
  assert.equal(result.resolved, null, message);
  assert.deepEqual(result.candidates, [], `${message}: no exact candidate may be published`);
  assert.equal(result.complete === true && result.resolved != null, false, `${message}: malformed evidence must not mint complete exact dispatch`);
}

test('#5863 vtable rejects malformed identity with an independently valid slot', () => {
  const malformedIdentity = resolveSwiftDispatch(index, {
    kind: 'vtable',
    typeAddress: ['4096'],
    slot: 0,
  });
  assertNoExactDispatch(malformedIdentity, 'array typeAddress with a valid slot must not resolve');
  assert.equal(malformedIdentity.confidence, 0.2);
});

test('#5863 vtable rejects malformed slot with an independently valid identity', () => {
  const malformedSlot = resolveSwiftDispatch(index, {
    kind: 'vtable',
    typeAddress: 4096n,
    slot: ['0'],
  });
  assertNoExactDispatch(malformedSlot, 'valid typeAddress with an array slot must not resolve');
  assert.equal(malformedSlot.confidence, 0.2);
});

test('#5863 primitive identity and slot forms keep resolving exactly', () => {
  const byString = resolveSwiftDispatch(index, { kind: 'vtable', typeAddress: '4096', slot: 0 });
  assert.equal(byString.resolved?.name, 'method0');
  assert.equal(byString.complete, true);

  const byBigInt = resolveSwiftDispatch(index, { kind: 'vtable', typeAddress: 4096n, slot: 0 });
  assert.equal(byBigInt.resolved?.name, 'method0');

  const byNumber = resolveSwiftDispatch(index, { kind: 'vtable', typeAddress: 4096, slot: 0 });
  assert.equal(byNumber.resolved?.name, 'method0');

  const tagged = resolveSwiftDispatch(index, { kind: 'vtable', typeAddress: 'type@4096', slot: 0 });
  assert.equal(tagged.resolved?.name, 'method0');
});

test('#5863 witness/existential canonical primitive identities and numeric slots keep resolving', () => {
  for (const kind of ['witness', 'existential']) {
    const result = resolveSwiftDispatch(index, {
      kind,
      typeAddress: 4096n,
      protocolAddress: 4097n,
      slot: 0,
    });
    assert.equal(result.resolved?.name, 'witness0', `${kind}: canonical witness entry must resolve`);
    assert.equal(result.complete, true, `${kind}: canonical exact dispatch remains complete`);
    assert.equal(result.confidence, 0.86);
    assert.equal(result.conformance?.witnessTable, 8192n);
  }
});

test('#5863 structured protocol identity cannot alias a real witness/existential protocol', () => {
  for (const kind of ['witness', 'existential']) {
    const result = resolveSwiftDispatch(index, {
      kind,
      typeAddress: 4096n,
      protocolAddress: ['4097'],
      slot: 0,
    });
    assertNoExactDispatch(result, `${kind}: array protocolAddress must not alias protocol@4097`);
    assert.equal(result.confidence, 0.2);
    assert.equal(result.conformance, null);
  }
});

test('#5863 structured/boolean/object slots cannot select real witness/existential entries', () => {
  const malformedSlots = [
    ['0'],
    true,
    { valueOf: () => 0 },
  ];
  for (const kind of ['witness', 'existential']) {
    for (const slot of malformedSlots) {
      const result = resolveSwiftDispatch(index, {
        kind,
        typeAddress: 4096n,
        protocolAddress: 4097n,
        slot,
      });
      assertNoExactDispatch(result, `${kind}: malformed slot ${Object.prototype.toString.call(slot)} must not select a real witness entry`);
      assert.equal(result.confidence, 0.2);
      assert.equal(result.conformance, null);
    }
  }
});
