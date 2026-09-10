import assert from 'node:assert/strict';
import test from 'node:test';

import { factFromRange, normalizeCongruence, rangeOf } from '../../../js/decompiler/phase8/range.js';

/**
 * #5222 — proof-bearing scalar evidence crosses an analysis boundary. Its
 * values are a primitive integer contract: bigint, safe-integer number, or a
 * strict integer literal string. The parser used to re-derive the value with
 * `BigInt(value)`, whose ToPrimitive coercion turns `true` into 1n and
 * `['8']` into 8n — caller-supplied schema violations became exact evidence.
 */

const WIDTH = 8;

function evidenceFact(options) {
  return factFromRange(rangeOf(0n, BigInt((1 << WIDTH) - 1), WIDTH), { status: 'exact', ...options });
}

test('#5222: boolean known-bit evidence is malformed, not 1n/0n', () => {
  for (const [field, value] of [['knownOne', true], ['knownOne', false], ['knownZero', false], ['knownZero', true]]) {
    const fact = evidenceFact({ [field]: value });
    assert.equal(fact.status, 'malformed', `${field}: ${String(value)}`);
    assert.equal(fact.knownOne, 0n);
    assert.equal(fact.knownZero, 0n);
    assert.ok(fact.reason, 'the malformed publication carries its reason');
  }
});

test('#5222: array/boxed known-bit evidence is malformed', () => {
  for (const value of [['8'], [['0x10']], [{}], [1n]]) {
    const fact = evidenceFact({ knownOne: value });
    assert.equal(fact.status, 'malformed');
    assert.equal(fact.knownOne, 0n);
  }
});

test('#5222: array/boolean congruence residue is malformed, not a class', () => {
  const fact = evidenceFact({ congruence: { modulus: [8], remainder: false } });
  assert.equal(fact.status, 'malformed');
  assert.equal(fact.congruence.modulus, 1n, 'no residue survives the failed contract');
  assert.equal(fact.congruence.remainder, 0n);
});

test('#5222: boolean/array pointer-offset evidence is malformed', () => {
  const provenance = { pointer: true, valueId: 'v1', baseId: 'b1', addressDomain: 'data' };
  for (const offset of [true, ['16'], 'not-an-integer', 1.5]) {
    const fact = factFromRange(rangeOf(0n, 255n, WIDTH), {
      status: 'exact',
      provenance,
      pointerOffset: { baseId: 'b1', sourceValueId: 'v1', offset },
    });
    assert.equal(fact.status, 'malformed', `offset: ${String(typeof offset === 'object' ? JSON.stringify(offset) : offset)}`);
    assert.equal(fact.pointerOffset, null);
  }
});

test('#5222: malformed range bounds fail closed, including frozen ranges', () => {
  for (const range of [
    { bits: [WIDTH], kind: 'interval', lower: false, upper: 3 },
    { bits: WIDTH, kind: 'interval', lower: ['0'], upper: 3 },
    { bits: WIDTH, kind: 'interval', lower: 0, upper: Number.NaN },
  ]) {
    const fact = factFromRange(Object.isFrozen(range) ? range : { ...range }, { status: 'exact' });
    assert.equal(fact.status, 'malformed');
    assert.equal(fact.reason, 'malformed range',
      'the publication widens to full and marks itself malformed, never exact');
  }
});

test('#5222: compatibility constant evidence keeps its scalar contract', () => {
  const fact = factFromRange(rangeOf(0n, 3n, WIDTH), {
    status: 'exact',
    constant: { bits: WIDTH, value: true },
  });
  assert.equal(fact.status, 'malformed');
});

test('#5222: normalizeCongruence rejects coercible shapes', () => {
  for (const congruence of [{ modulus: [8], remainder: false }, { modulus: true, remainder: 0n }, { modulus: '0x8', remainder: 0n }]) {
    assert.deepEqual(normalizeCongruence(congruence, WIDTH), { remainder: 0n, modulus: 1n },
      `the residue collapses to no-congruence for ${String(congruence.modulus)}`);
  }
});

test('#5222: the explicit integer spellings keep working', () => {
  const fact = evidenceFact({ congruence: { modulus: 4n, remainder: 2n } });
  assert.equal(fact.status, 'exact');
  assert.equal(fact.congruence.modulus, 4n);
  assert.equal(fact.congruence.remainder, 2n);

  const numeric = evidenceFact({ knownOne: 1 });
  assert.equal(numeric.status, 'exact');
  assert.equal(numeric.knownOne, 1n);
});
