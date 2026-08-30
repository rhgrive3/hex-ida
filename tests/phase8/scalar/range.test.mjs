import assert from 'node:assert/strict';
import test from 'node:test';

import { bitvector, signedOf } from '../../../js/decompiler/phase8/bitvector.js';
import {
  cardinality, contains, describeRange, emptyFact, emptyRange, evaluateBinaryFact,
  evaluateBinaryRange, factFromRange, fullFact, fullRange, intersectRange, isEmpty,
  isFull, join, joinFacts, rangeOf, refineFactByComparison, sameRange, signExtendRange,
  singleton, singletonFact, truncateRange, widen, widenFacts, zeroExtendRange,
} from '../../../js/decompiler/phase8/range.js';

/**
 * The rule under test everywhere: when the domain cannot represent an answer
 * exactly it widens, and it never invents a tighter one. False precision in a
 * decompiler becomes a confident wrong claim in the interface.
 */

test('a wrapped range is a real set, not an empty one', () => {
  const wrapped = rangeOf(0xFFFFFFF0n, 0x0Fn, 32);
  assert.equal(wrapped.kind, 'wrapped');
  assert.equal(cardinality(wrapped), 32n);
  assert.equal(contains(wrapped, 0xFFFFFFF8n), true);
  assert.equal(contains(wrapped, 0x00n), true);
  assert.equal(contains(wrapped, 0x10n), false);
  assert.equal(contains(wrapped, 0x8000_0000n), false);
});

test('an interval covering the whole width is full however it is spelled', () => {
  assert.equal(isFull(rangeOf(0n, 0xFFFFFFFFn, 32)), true);
  assert.equal(isFull(rangeOf(5n, 4n, 32)), true, 'a wrapped range that meets itself is everything');
  assert.equal(cardinality(fullRange(8)), 256n);
});

test('the empty range contains nothing and is not the full range', () => {
  const empty = emptyRange(32);
  assert.equal(cardinality(empty), 0n);
  assert.equal(contains(empty, 0n), false);
  assert.equal(sameRange(empty, fullRange(32)), false);
});

test('join covers both operands and prefers the smaller hull', () => {
  const left = rangeOf(0n, 10n, 32);
  const right = rangeOf(20n, 30n, 32);
  const united = join(left, right);
  for (const point of [0n, 10n, 20n, 30n]) assert.equal(contains(united, point), true);
  assert.equal(cardinality(united) <= cardinality(fullRange(32)), true);
  // Joining with the full range is the full range; joining with empty is a no-op.
  assert.equal(isFull(join(left, fullRange(32))), true);
  assert.equal(sameRange(join(left, emptyRange(32)), left), true);
});

test('join is idempotent, which is what makes the ascending chain finite', () => {
  const range = rangeOf(0xFFFFFFF0n, 0x0Fn, 32);
  assert.equal(sameRange(join(range, range), range), true);
  assert.equal(sameRange(join(join(range, range), range), range), true);
});

test('wrapped join contains every member of both circular ranges', () => {
  const left = rangeOf(0n, 2n, 8);
  const right = rangeOf(2n, 0n, 8);
  const merged = join(left, right);
  assert.equal(isFull(merged), true, 'the union covers the complete 8-bit domain');
  assert.equal(contains(merged, 1n), true, 'the interval interior cannot be dropped');
});

test('widening goes to full rather than climbing forever', () => {
  const previous = rangeOf(0n, 10n, 32);
  assert.equal(sameRange(widen(previous, previous), previous), true, 'a stable range is not widened');
  assert.equal(isFull(widen(previous, rangeOf(0n, 11n, 32))), true);
});

test('zero extension is exact for an interval and honest about a wrapped source', () => {
  const exact = zeroExtendRange(rangeOf(1n, 100n, 32), 64);
  assert.equal(exact.exact, true);
  assert.equal(exact.range.lower, 1n);
  assert.equal(exact.range.upper, 100n);

  const unconstrained = zeroExtendRange(fullRange(32), 64);
  assert.equal(unconstrained.exact, true, 'zero extension of every source bit pattern is one representable interval');
  assert.deepEqual([unconstrained.range.lower, unconstrained.range.upper], [0n, 0xFFFF_FFFFn]);

  // A wrapped 32-bit range becomes two disjoint intervals at 64 bits, which this
  // domain cannot represent. The bound that survives is the source width.
  const wrapped = zeroExtendRange(rangeOf(0xFFFFFFF0n, 0x0Fn, 32), 64);
  assert.equal(wrapped.exact, false);
  assert.ok(wrapped.reason);
  assert.equal(contains(wrapped.range, 0xFFFFFFF0n), true);
  assert.equal(contains(wrapped.range, 0x1_0000_0000n), false, 'the extension must not claim values above the source width');
});

test('sign extension refuses a range that straddles the sign boundary', () => {
  const positive = signExtendRange(rangeOf(1n, 100n, 32), 64);
  assert.equal(positive.exact, true);
  assert.equal(positive.range.lower, 1n);

  const negative = signExtendRange(rangeOf(0xFFFFFF00n, 0xFFFFFFF0n, 32), 64);
  assert.equal(negative.exact, true);
  assert.equal(contains(negative.range, 0xFFFFFFFF_FFFFFF00n), true);

  const straddling = signExtendRange(rangeOf(0x7FFFFFFFn, 0x80000000n, 32), 64);
  assert.equal(straddling.exact, false);
  assert.equal(isFull(straddling.range), true);
});

test('truncation is exact only when the range fits the narrower width', () => {
  const fits = truncateRange(rangeOf(1n, 100n, 32), 8);
  assert.equal(fits.exact, true);
  assert.equal(fits.range.upper, 100n);

  const overflows = truncateRange(rangeOf(1n, 1000n, 32), 8);
  assert.equal(overflows.exact, false);
  assert.equal(isFull(overflows.range), true);
});

test('addition is exact while the result fits one interval and unknown after', () => {
  const exact = evaluateBinaryRange('add', rangeOf(1n, 10n, 32), rangeOf(2n, 3n, 32));
  assert.equal(exact.exact, true);
  assert.equal(exact.range.lower, 3n);
  assert.equal(exact.range.upper, 13n);

  // Two halves of the space still sum to one interval: [0,0x7FFFFFFF] twice
  // cannot reach 0xFFFFFFFF, and saying so is exact, not optimistic.
  const halves = evaluateBinaryRange('add', rangeOf(0n, 0x7FFFFFFFn, 32), rangeOf(0n, 0x7FFFFFFFn, 32));
  assert.equal(halves.exact, true);
  assert.equal(halves.range.upper, 0xFFFFFFFEn);

  // Once the operands together cover more than the width, the sum is every
  // value; claiming an interval there would exclude values the program reaches.
  const wide = evaluateBinaryRange('add', rangeOf(0n, 0x80000000n, 32), rangeOf(0n, 0x80000000n, 32));
  assert.equal(wide.exact, false);
  assert.equal(isFull(wide.range), true);
  assert.ok(wide.reason);
});

test('addition wraps rather than growing the width', () => {
  // 0xFFFFFFF0..0xFFFFFFF8 plus 0x10 lands on 0x00..0x08. A domain that grew the
  // width instead would claim 0x1_0000_0000, which no 32-bit register holds.
  const wrapped = evaluateBinaryRange('add', rangeOf(0xFFFFFFF0n, 0xFFFFFFF8n, 32), rangeOf(0x10n, 0x10n, 32));
  assert.equal(wrapped.exact, true);
  assert.equal(wrapped.range.lower, 0n);
  assert.equal(wrapped.range.upper, 8n);
  assert.equal(contains(wrapped.range, 0n), true);
  assert.equal(contains(wrapped.range, 9n), false);
  assert.equal(contains(wrapped.range, 0xFFFFFFF0n), false);
});

test('operations with no exact model report full and say why', () => {
  for (const operator of ['mul', 'or', 'xor', 'udiv', 'shl', 'lshr']) {
    const result = evaluateBinaryRange(operator, rangeOf(1n, 10n, 32), rangeOf(1n, 10n, 32));
    assert.equal(isFull(result.range), true, `${operator} must not invent precision`);
    assert.ok(result.reason, `${operator} must record why nothing was proven`);
  }
});

test('masking by a constant bounds the result', () => {
  const masked = evaluateBinaryRange('and', fullRange(32), singleton(bitvector(0xFFn, 32)));
  assert.equal(masked.range.upper, 0xFFn);
  assert.equal(contains(masked.range, 0x100n), false);
});

test('an empty operand produces an empty result, not a full one', () => {
  const result = evaluateBinaryRange('add', emptyRange(32), rangeOf(1n, 2n, 32));
  assert.equal(cardinality(result.range), 0n);
});

test('the description distinguishes the three shapes', () => {
  assert.match(describeRange(fullRange(32)), /^full:32$/);
  assert.match(describeRange(emptyRange(32)), /^empty:32$/);
  assert.match(describeRange(rangeOf(1n, 2n, 32)), /^interval:32/);
  assert.match(describeRange(rangeOf(0xFFFFFFF0n, 1n, 32)), /^wrapped:32/);
});

test('unsigned add and subtract retain modular wrap at the declared width', () => {
  const add = evaluateBinaryRange('add', rangeOf(0xF8n, 0xFFn, 8), rangeOf(0x10n, 0x10n, 8));
  assert.equal(add.exact, true);
  assert.equal(add.range.kind, 'interval');
  assert.deepEqual([add.range.lower, add.range.upper], [0x08n, 0x0Fn]);

  const subtract = evaluateBinaryRange('sub', rangeOf(0n, 3n, 8), rangeOf(8n, 8n, 8));
  assert.equal(subtract.exact, true);
  assert.equal(subtract.range.kind, 'interval');
  assert.deepEqual([subtract.range.lower, subtract.range.upper], [0xF8n, 0xFBn]);
});

test('signed extrema remain distinct from unsigned extrema', () => {
  assert.equal(signedOf(0x80n, 8), -128n);
  assert.equal(signedOf(0x7Fn, 8), 127n);
  const all = fullFact(8, { valueId: 1 });
  const signed = refineFactByComparison(all, 'slt', 0x80n, true);
  const unsigned = refineFactByComparison(all, 'ult', 0x80n, true);
  assert.equal(isEmpty(signed.range), true, 'no signed 8-bit value is below INT_MIN');
  assert.deepEqual([unsigned.range.lower, unsigned.range.upper], [0n, 0x7Fn]);
});

test('known bits and congruence are projections of the same masked/shifted value set', () => {
  const input = fullFact(8, { valueId: 10 });
  const mask = singletonFact(bitvector(0xFCn, 8), { valueId: 11 });
  const masked = evaluateBinaryFact('and', input, mask);
  assert.equal(masked.range.kind, 'interval');
  assert.equal(masked.range.upper, 0xFCn);
  assert.equal(masked.knownZero & 0x03n, 0x03n);
  assert.deepEqual(masked.congruence, { remainder: 0n, modulus: 4n });

  const shifted = evaluateBinaryFact('shl', masked, singletonFact(bitvector(1n, 8), { valueId: 12 }));
  assert.equal(shifted.knownZero & 0x01n, 0x01n);
  assert.equal(shifted.congruence.modulus, 8n);
});

test('non-divisor congruence is dropped before modular wrap propagation', () => {
  const left = factFromRange(rangeOf(255n, 255n, 8), {
    valueId: 13,
    deriveKnownBits: false,
    congruence: { remainder: 0n, modulus: 3n },
  });
  const right = factFromRange(rangeOf(1n, 1n, 8), {
    valueId: 14,
    deriveKnownBits: false,
    congruence: { remainder: 1n, modulus: 3n },
  });
  const result = evaluateBinaryFact('add', left, right);
  assert.deepEqual(result.congruence, { remainder: 0n, modulus: 1n });
  assert.equal(result.status, 'exact');
});

test('cross-fact evidence rejects truncation and contradictions', () => {
  const outOfWidth = factFromRange(rangeOf(0n, 1n, 8), { knownZero: 0x100n });
  assert.equal(outOfWidth.status, 'malformed');
  assert.equal(outOfWidth.knownZero, 0n, 'out-of-width masks are not silently truncated');
  assert.equal(outOfWidth.constant, null);

  const impossibleBits = factFromRange(rangeOf(0n, 2n, 8), { knownOne: 4n });
  assert.equal(impossibleBits.status, 'malformed');
  assert.equal(impossibleBits.knownOne, 0n, 'known bits must be implied by every value in the range');

  const impossibleResidue = factFromRange(rangeOf(0n, 2n, 8), {
    congruence: { remainder: 3n, modulus: 4n },
  });
  assert.equal(impossibleResidue.status, 'malformed');
  assert.deepEqual(impossibleResidue.congruence, { remainder: 0n, modulus: 1n });
});

test('cross-fact evidence rejects a mask/residue intersection with no value', () => {
  const contradictory = factFromRange(fullRange(8), {
    deriveKnownBits: false,
    knownZero: 1n,
    congruence: { remainder: 1n, modulus: 2n },
  });
  assert.equal(contradictory.status, 'malformed');
  assert.equal(contradictory.knownZero, 0n, 'conflicting evidence must not be retained as a scalar fact');
  assert.deepEqual(contradictory.congruence, { remainder: 0n, modulus: 1n });
});

test('cyclic evidence is rejected without recursive failure', () => {
  const cycle = {};
  cycle.self = cycle;
  assert.doesNotThrow(() => {
    const malformed = factFromRange(rangeOf(0n, 1n, 8), { provenance: cycle });
    assert.equal(malformed.status, 'malformed');
    assert.equal(malformed.constant, null);
    assert.deepEqual(malformed.provenance, {});
  });
});

test('product joins and widening never promote a non-singleton to an exact constant', () => {
  const left = factFromRange(rangeOf(1n, 1n, 8), { valueId: 1 });
  const right = factFromRange(rangeOf(2n, 2n, 8), { valueId: 1 });
  const joined = joinFacts(left, right);
  assert.equal(joined.constant, null);
  assert.equal(joined.status, 'conservative');
  const widened = widenFacts(left, right);
  assert.equal(widened.constant, null);
  assert.equal(widened.status, 'conservative');
});

test('alignment and pointer-offset evidence survives only an agreeing join and edge restriction', () => {
  const alignment = { modulus: 16n, remainder: 0n };
  const pointerOffset = { baseId: 'p', offset: 4n };
  const first = factFromRange(rangeOf(0n, 10n, 32), { valueId: 4, alignment, pointerOffset });
  const second = factFromRange(rangeOf(20n, 30n, 32), { valueId: 4, alignment, pointerOffset });
  const joined = joinFacts(first, second);
  assert.deepEqual(joined.alignment, alignment);
  assert.deepEqual(joined.pointerOffset, pointerOffset);
  const restricted = refineFactByComparison(joined, 'ult', 25n, true);
  assert.deepEqual(restricted.alignment, alignment);
  assert.deepEqual(restricted.pointerOffset, pointerOffset);
  const disagreement = joinFacts(first, factFromRange(rangeOf(40n, 50n, 32), {
    valueId: 4, alignment: { modulus: 8n, remainder: 0n }, pointerOffset,
  }));
  assert.equal(disagreement.alignment, null);
});

test('pointer arithmetic shifts canonical offset and alignment without minting provenance', () => {
  const pointer = factFromRange(rangeOf(0n, 10n, 32), {
    valueId: 5,
    alignment: { modulus: 16n, remainder: 0n },
    pointerOffset: { baseId: 'p', offset: 4n },
  });
  const amount = singletonFact(bitvector(4n, 32), { valueId: 6 });
  const advanced = evaluateBinaryFact('add', pointer, amount);
  assert.deepEqual(advanced.pointerOffset, { baseId: 'p', offset: 8n });
  assert.deepEqual(advanced.alignment, { modulus: 16n, remainder: 4n });

  const rewound = evaluateBinaryFact('sub', advanced, amount);
  assert.deepEqual(rewound.pointerOffset, { baseId: 'p', offset: 4n });
  assert.deepEqual(rewound.alignment, { modulus: 16n, remainder: 0n });

  const numericOnly = evaluateBinaryFact('add', factFromRange(rangeOf(0n, 10n, 32)), amount);
  assert.equal(numericOnly.pointerOffset, null, 'numeric facts alone cannot mint pointer provenance');
});

test('malformed widths and unsupported operations stay conservative', () => {
  assert.throws(() => fullRange(24), /unsupported-width/);
  const malformed = factFromRange({ bits: 24, kind: 'interval', lower: 0n, upper: 1n });
  assert.equal(malformed.status, 'malformed');
  for (const evidence of [
    { congruence: { modulus: 'not-an-integer', remainder: 0n } },
    { alignment: { modulus: 'not-an-integer' } },
    { pointerOffset: { baseId: 'p', offset: 'not-an-integer' } },
    { knownOne: 2n },
    { congruence: { modulus: 4n, remainder: 1n } },
  ]) {
    const malformedEvidence = factFromRange(singleton(bitvector(0n, 8)), evidence);
    assert.equal(malformedEvidence.status, 'malformed');
    assert.equal(malformedEvidence.constant, null, 'malformed scalar evidence must not publish an exact singleton');
  }
  const unsupported = evaluateBinaryFact('rotl', fullFact(32), fullFact(32));
  assert.equal(isFull(unsupported.range), true);
  assert.equal(unsupported.constant, null);
  const unsupportedSingleton = singletonFact(bitvector(7n, 8), { status: 'unsupported' });
  assert.equal(unsupportedSingleton.constant, null, 'unsupported singleton-shaped evidence must not become exact');
  const incomplete = emptyFact(8, { status: 'partial' });
  assert.equal(incomplete.constant, null);
  for (const status of ['partial', 'unknown', 'stale', 'cancelled', 'truncated', 'budget']) {
    const incompleteSingleton = singletonFact(bitvector(7n, 8), { status });
    const propagated = evaluateBinaryFact('add', incompleteSingleton, singletonFact(bitvector(1n, 8)));
    assert.equal(propagated.status, status);
    assert.equal(propagated.constant, null, `${status} evidence must not launder into an exact binary result`);
  }
});

test('fact inputs reject contradictory supplied constants instead of folding them', () => {
  const contradictory = {
    bits: 8,
    range: rangeOf(0n, 0n, 8),
    status: 'exact',
    constant: bitvector(1n, 8),
    knownZero: 0xFFn,
    knownOne: 0n,
    congruence: { remainder: 0n, modulus: 256n },
    alignment: null,
    pointerOffset: null,
    provenance: {},
  };
  const result = evaluateBinaryFact('eq', contradictory, singletonFact(bitvector(1n, 8)));
  assert.equal(result.bits, 1);
  assert.equal(result.constant, null, 'contradictory evidence must not become an exact comparison');
  assert.notEqual(result.status, 'exact');
});

test('fact ranges are canonical immutable snapshots, not aliases to mutable caller objects', () => {
  const mutableRange = { bits: 8, kind: 'interval', lower: 0n, upper: 1n };
  const fact = factFromRange(mutableRange, { valueId: 99 });
  assert.equal(fact.status, 'conservative');
  assert.notEqual(fact.range, mutableRange);
  assert.equal(Object.isFrozen(fact.range), true);
  mutableRange.lower = 7n;
  assert.equal(fact.range.lower, 0n);
  assert.throws(() => { fact.range.upper = 7n; }, TypeError);
});

test('no-op product joins snapshot mutable facts and reject host evidence containers', () => {
  const mutableFact = {
    bits: 8,
    range: { bits: 8, kind: 'interval', lower: 0n, upper: 3n },
    status: 'conservative',
    knownZero: 0n,
    knownOne: 0n,
    congruence: { remainder: 0n, modulus: 1n },
    alignment: { modulus: 4n, remainder: 0n },
    pointerOffset: { baseId: 'p', offset: 2n },
    provenance: { source: { instructionId: 'i0' } },
  };
  const joined = joinFacts(null, mutableFact);
  assert.notEqual(joined, mutableFact);
  assert.equal(Object.isFrozen(joined), true);
  assert.equal(Object.isFrozen(joined.range), true);
  assert.equal(Object.isFrozen(joined.congruence), true);
  assert.equal(Object.isFrozen(joined.alignment), true);
  assert.equal(Object.isFrozen(joined.pointerOffset), true);
  assert.equal(Object.isFrozen(joined.provenance), true);
  assert.equal(Object.isFrozen(joined.provenance.source), true);
  mutableFact.range.lower = 7n;
  mutableFact.alignment.modulus = 2n;
  mutableFact.provenance.source.instructionId = 'mutated';
  assert.equal(joined.range.lower, 0n);
  assert.equal(joined.alignment.modulus, 4n);
  assert.equal(joined.provenance.source.instructionId, 'i0');

  const hostEvidence = new Map([['instructionId', 'i0']]);
  Object.freeze(hostEvidence);
  const malformed = factFromRange(singleton(bitvector(1n, 8)), { provenance: hostEvidence });
  assert.equal(malformed.status, 'malformed');
  assert.equal(malformed.constant, null);

  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const revoked = factFromRange(singleton(bitvector(1n, 8)), { provenance: proxy });
  assert.equal(revoked.status, 'malformed');
  assert.equal(revoked.constant, null);
});
