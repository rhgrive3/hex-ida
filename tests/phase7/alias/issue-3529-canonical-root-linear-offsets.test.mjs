import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalAddressProofToRegionEvidence,
  deriveCanonicalAddressProof,
} from '../../../js/analysis/alias/canonical-address-v2-core.js';

function entryIr() {
  return {
    functionId: 'f',
    values: [{
      id: 'p',
      kind: 'entry',
      variableKey: 'p',
      machineType: { widthBits: 64 },
    }],
    nodes: [],
    blocks: [],
  };
}

function proofFor(descriptor) {
  return deriveCanonicalAddressProof(entryIr(), 'p', {
    rootDescriptors: { p: descriptor },
  });
}

test('linearOffsets authority accepts only primitive booleans while preserving the nullish default', () => {
  for (const value of [undefined, null, true]) {
    const descriptor = {
      kind: 'rooted-object',
      rootEntityId: 'root',
      baseOffset: 0,
      ...(value === undefined ? {} : { linearOffsets: value }),
    };
    const proof = proofFor(descriptor);
    assert.equal(proof.kind, 'rooted');
    assert.equal(proof.separationSafe, true);
  }

  const disabled = proofFor({
    kind: 'rooted-object',
    rootEntityId: 'root',
    baseOffset: 0,
    linearOffsets: false,
  });
  assert.equal(disabled.kind, 'rooted');
  assert.equal(disabled.separationSafe, false);
});

test('malformed rooted-object linearOffsets cannot mint separation authority', () => {
  let coercionCalls = 0;
  const coercible = {
    valueOf() {
      coercionCalls += 1;
      return true;
    },
    toString() {
      coercionCalls += 1;
      return 'true';
    },
  };

  for (const malformed of [[], {}, 1, 0, 'false', new Boolean(true), coercible]) {
    const proof = proofFor({
      kind: 'rooted-object',
      rootEntityId: 'root',
      baseOffset: 0,
      linearOffsets: malformed,
    });
    assert.equal(proof.kind, 'unknown');
    assert.equal(proof.reason, 'canonical-root-descriptor-invalid');
    assert.equal(canonicalAddressProofToRegionEvidence(proof), null);
  }
  assert.equal(coercionCalls, 0);
});

test('stack-like descriptors apply the same strict linearOffsets authority boundary', () => {
  const exact = proofFor({ kind: 'stack-like', baseOffset: 8, linearOffsets: true });
  assert.equal(exact.kind, 'stack-like');
  assert.equal(exact.separationSafe, true);

  const conservative = proofFor({ kind: 'stack-like', baseOffset: 8, linearOffsets: false });
  assert.equal(conservative.kind, 'stack-like');
  assert.equal(conservative.separationSafe, false);

  const malformed = proofFor({ kind: 'stack-like', baseOffset: 8, linearOffsets: [] });
  assert.equal(malformed.kind, 'unknown');
  assert.equal(malformed.reason, 'canonical-root-descriptor-invalid');
});

test('absolute descriptors do not gain a new linearOffsets contract', () => {
  const proof = proofFor({
    kind: 'absolute-address',
    address: '0x1000',
    linearOffsets: [],
  });
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.address, 0x1000n);
});
