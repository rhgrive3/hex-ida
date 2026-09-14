import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PASS_STAGES,
  PHASE8_DEFAULT_WORK_BUDGET,
  emptyFact,
  evaluateBinaryFact,
  factFromRange,
  fullFact,
  joinFacts,
  rangeOf,
  refineFactByComparison,
  signExtendFact,
  singleton,
  singletonFact,
  truncateFact,
  widenFacts,
  zeroExtendFact,
  runPhase8Stage,
} from '../../../js/decompiler/phase8/index.js';
import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

const ALIGNMENT = Object.freeze({ modulus: 16n, remainder: 0n });

function pointerProvenance(valueId = 1, baseId = 'base', addressDomain = 'memory') {
  return {
    pointer: true,
    valueId,
    pointerBaseId: baseId,
    addressDomain,
    instructionIds: [`ptr-${String(valueId)}`],
  };
}

function pointerFact({ valueId = 1, baseId = 'base', addressDomain = 'memory', lower = 0n, upper = 63n } = {}) {
  return factFromRange(rangeOf(lower, upper, 8), {
    valueId,
    alignment: ALIGNMENT,
    pointerOffset: { baseId, offset: 0n },
    provenance: pointerProvenance(valueId, baseId, addressDomain),
  });
}

function identityFixture(name = 'c2-02-adversarial-identity') {
  const f = fixture(name);
  f.block(0);
  const input = f.opaque(8);
  const sum = f.binary('add', input, f.constant(1, 8), 8);
  const condition = f.binary('ult', sum, f.constant(10, 8), 1);
  f.conditionalBranch(condition, 1, 2);
  const left = (() => { f.block(1); const value = f.constant(2, 8); f.branch(3); return value; })();
  const right = (() => { f.block(2); const value = f.constant(3, 8); f.branch(3); return value; })();
  f.block(3);
  f.phi([[1, left], [2, right]], 8);
  f.ret();
  return f.build();
}

function identityOf(ir) {
  return canonicalAnalysisIdentity({ ir });
}

function assertNoPointerEvidence(fact, message = '') {
  assert.equal(fact.alignment, null, `${message} alignment`);
  assert.equal(fact.pointerOffset, null, `${message} pointer offset`);
}

test('alignment is rejected consistently by every fact constructor without pointer-domain evidence', () => {
  const options = { alignment: ALIGNMENT };
  assertNoPointerEvidence(factFromRange(rangeOf(0n, 63n, 8), options), 'range');
  assertNoPointerEvidence(fullFact(8, options), 'full');
  assertNoPointerEvidence(emptyFact(8, options), 'empty');
  assertNoPointerEvidence(singletonFact({ value: 1n, bits: 8 }, options), 'singleton');
  for (const fact of [factFromRange(rangeOf(0n, 63n, 8), options), fullFact(8, options), emptyFact(8, options)]) {
    assert.equal(fact.status, 'malformed');
    assert.equal(fact.congruence.modulus, 1n, 'alignment cannot mint an integer residue');
  }
});

test('pointer marker alone is insufficient without a canonical address domain', () => {
  const fact = factFromRange(rangeOf(0n, 63n, 8), {
    valueId: 1,
    alignment: ALIGNMENT,
    pointerOffset: { baseId: 'base', offset: 0n },
    provenance: { pointer: true, valueId: 1, pointerBaseId: 'base' },
  });
  assert.equal(fact.status, 'malformed');
  assertNoPointerEvidence(fact);
  assert.equal(fact.congruence.modulus, 1n);
});

test('canonical pointer evidence is domain-bound for valid constructor families', () => {
  const options = {
    valueId: 1,
    alignment: ALIGNMENT,
    pointerOffset: { baseId: 'base', offset: 0n },
    provenance: pointerProvenance(),
  };
  const facts = [
    factFromRange(rangeOf(0n, 63n, 8), options),
    fullFact(8, options),
    emptyFact(8, options),
    singletonFact({ value: 0n, bits: 8 }, options),
  ];
  for (const fact of facts) {
    assert.deepEqual(fact.alignment, ALIGNMENT);
    assert.deepEqual(fact.pointerOffset, { baseId: 'base', offset: 0n });
    assert.equal(fact.provenance.addressDomain, 'memory');
  }
});

test('pointer evidence rejects a value-id mismatch even when the root and domain look valid', () => {
  const fact = factFromRange(rangeOf(0n, 63n, 8), {
    valueId: 2,
    alignment: ALIGNMENT,
    provenance: pointerProvenance(1),
  });
  assert.equal(fact.status, 'malformed');
  assertNoPointerEvidence(fact);
});

test('pointer-offset evidence cannot cross a canonical root', () => {
  const fact = factFromRange(rangeOf(0n, 63n, 8), {
    valueId: 1,
    alignment: ALIGNMENT,
    pointerOffset: { baseId: 'other', offset: 0n },
    provenance: pointerProvenance(1, 'base'),
  });
  assert.equal(fact.status, 'malformed');
  assert.equal(fact.pointerOffset, null);
  assert.deepEqual(fact.alignment, ALIGNMENT, 'independent valid alignment may remain inspectable');
});

test('joining pointers from different address domains drops alignment rather than laundering one domain', () => {
  const memory = pointerFact({ addressDomain: 'memory' });
  const io = pointerFact({ addressDomain: 'io' });
  const joined = joinFacts(memory, io);
  assertNoPointerEvidence(joined);
  assert.equal(joined.status, 'conservative');
});

test('joining same-domain pointers preserves the one canonical alignment claim', () => {
  const first = pointerFact({ lower: 0n, upper: 31n });
  const second = pointerFact({ lower: 32n, upper: 63n });
  const joined = joinFacts(first, second);
  assert.deepEqual(joined.alignment, ALIGNMENT);
  assert.deepEqual(joined.pointerOffset, { baseId: 'base', offset: 0n });
  assert.equal(joined.provenance.addressDomain, 'memory');
});

test('widening is conservative and never carries pointer alignment across a widening boundary', () => {
  const widened = widenFacts(pointerFact({ lower: 0n, upper: 15n }), pointerFact({ lower: 32n, upper: 63n }));
  assertNoPointerEvidence(widened);
  assert.equal(widened.congruence.modulus, 1n);
});

test('casts do not reinterpret an address alignment as an integer cast proof', () => {
  const source = pointerFact();
  const truncSource = factFromRange(rangeOf(0n, 63n, 16), {
    valueId: 1,
    alignment: ALIGNMENT,
    pointerOffset: { baseId: 'base', offset: 0n },
    provenance: pointerProvenance(),
  });
  for (const [cast, input, bits] of [[zeroExtendFact, source, 16], [signExtendFact, source, 16], [truncateFact, truncSource, 8]]) {
    const target = cast(input, bits);
    assertNoPointerEvidence(target);
  }
});

test('pointer arithmetic shifts alignment only when the pointer product is canonical', () => {
  const amount = singletonFact({ value: 4n, bits: 8 });
  const shifted = evaluateBinaryFact('add', pointerFact(), amount);
  assert.deepEqual(shifted.alignment, { modulus: 16n, remainder: 4n });
  assert.deepEqual(shifted.pointerOffset, { baseId: 'base', offset: 4n });
  const numeric = evaluateBinaryFact('add', factFromRange(rangeOf(0n, 63n, 8)), amount);
  assertNoPointerEvidence(numeric);
});

test('subtraction, bitwise operations, and comparisons do not mint pointer evidence', () => {
  const pointer = pointerFact();
  const amount = singletonFact({ value: 4n, bits: 8 });
  const subtracted = evaluateBinaryFact('sub', pointer, amount);
  assert.deepEqual(subtracted.alignment, { modulus: 16n, remainder: 12n });
  assertNoPointerEvidence(evaluateBinaryFact('xor', pointer, amount));
  assertNoPointerEvidence(evaluateBinaryFact('eq', pointer, amount));
});

test('comparison refinement preserves a valid pointer domain but cannot create one', () => {
  const refined = refineFactByComparison(pointerFact(), 'ult', 32n, true);
  assert.deepEqual(refined.alignment, ALIGNMENT);
  const numeric = refineFactByComparison(factFromRange(rangeOf(0n, 63n, 8)), 'ult', 32n, true);
  assertNoPointerEvidence(numeric);
});

test('pure integer congruence survives an unrelated malformed alignment as separate evidence', () => {
  const fact = factFromRange(rangeOf(0n, 63n, 8), {
    alignment: ALIGNMENT,
    congruence: { remainder: 0n, modulus: 4n },
  });
  assert.equal(fact.status, 'malformed');
  assertNoPointerEvidence(fact);
  assert.deepEqual(fact.congruence, { remainder: 0n, modulus: 4n });
});

test('non-enumerable and symbol alignment metadata fail closed before evidence publication', () => {
  const hidden = { modulus: 16n, remainder: 0n };
  Object.defineProperty(hidden, 'proof', { value: 'hidden', enumerable: false });
  const symbol = { modulus: 16n, remainder: 0n };
  symbol[Symbol('proof')] = 'hidden';
  for (const alignment of [hidden, symbol]) {
    const fact = factFromRange(rangeOf(0n, 63n, 8), {
      valueId: 1,
      alignment,
      provenance: pointerProvenance(),
    });
    assert.equal(fact.status, 'malformed');
    assertNoPointerEvidence(fact);
  }
});

test('canonical identity is invariant to insertion order at every nested metadata map', () => {
  const ir = identityFixture();
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  definition.extra = {
    alpha: 1,
    nested: { left: 2, right: 3 },
    map: new Map([['first', 1], ['second', { a: 2, b: 3 }]]),
    set: new Set(['x', 'y']),
  };
  const first = identityOf(ir);
  definition.extra = {
    set: new Set(['y', 'x']),
    map: new Map([['second', { b: 3, a: 2 }], ['first', 1]]),
    nested: { right: 3, left: 2 },
    alpha: 1,
  };
  const second = identityOf(ir);
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.equal(first.identity.semanticIrId, second.identity.semanticIrId);
});

test('canonical identity includes flat instruction, block-edge, loop, and root object-map mutations', () => {
  const mutations = [
    (ir) => { ir.instructions = { first: { op: 'const', value: 1 }, second: { op: 'const', value: 2 } }; },
    (ir) => { ir.blocks[0].successorEdges[0].kind = 'exceptional'; },
    (ir) => { ir.backEdges = [{ from: 1, to: 0, kind: 'loop' }]; },
    (ir) => { ir.loops = [{ header: 0, body: [0, 1], kind: 'natural' }]; },
    (ir) => { ir.metadata = { first: 1, second: { nested: true } }; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const ir = identityFixture(`c2-02-identity-mutation-${index}`);
    const before = identityOf(ir);
    assert.equal(before.valid, true);
    mutate(ir);
    const after = identityOf(ir);
    assert.equal(after.valid, true);
    assert.notEqual(after.identity.semanticIrId, before.identity.semanticIrId);
  }
});

test('canonical identity rejects hidden, symbol, accessor, and nested host metadata recursively', () => {
  const cases = [
    (extra) => Object.defineProperty(extra, 'hidden', { value: 1, enumerable: false }),
    (extra) => { extra[Symbol('hidden')] = 1; },
    (extra) => Object.defineProperty(extra, 'accessor', { get() { return 1; }, enumerable: true }),
    (extra) => { extra.nested = new Map([['ok', 1]]); extra.nested[Symbol('hidden')] = 2; },
  ];
  for (const mutate of cases) {
    const ir = identityFixture();
    const definition = ir.values.find((value) => value.def?.op === 'bin').def;
    const extra = { visible: 1, nested: { value: 2 } };
    mutate(extra);
    definition.extra = extra;
    assert.equal(identityOf(ir).valid, false);
  }
});

test('canonical identity rejects unsupported descriptors on every identity source', () => {
  const cases = [
    (source) => Object.defineProperty(source, 'hidden', { value: 1, enumerable: false }),
    (source) => { source[Symbol('hidden')] = 1; },
    (source) => Object.defineProperty(source, 'accessor', { get() { return 1; }, enumerable: true }),
  ];
  for (const mutate of cases) {
    const ir = identityFixture();
    const source = { binaryId: 'binary' };
    mutate(source);
    assert.equal(identityOf(ir).valid, true);
    assert.equal(canonicalAnalysisIdentity({ ir, analysisIdentity: source }).valid, false);
  }
});

test('canonical identity includes value and memory metadata outside the compatibility projection', () => {
  const valueIr = identityFixture('c2-02-value-metadata');
  const input = valueIr.values.find((value) => value.kind === 'arg');
  const beforeValue = identityOf(valueIr);
  input.extra = { nested: { before: true } };
  const afterValue = identityOf(valueIr);
  assert.equal(beforeValue.valid, true);
  assert.equal(afterValue.valid, true);
  assert.notEqual(afterValue.identity.semanticIrId, beforeValue.identity.semanticIrId);

  const f = fixture('c2-02-memory-metadata');
  f.block(0);
  const loaded = f.load(8, { locKey: 'slot' });
  f.ret();
  const ir = f.build();
  loaded.def.memUse = { definitionId: 'memory-1' };
  const beforeLocation = identityOf(ir);
  loaded.def.loc.metadata = { nested: true };
  const afterLocation = identityOf(ir);
  assert.equal(beforeLocation.valid, true);
  assert.equal(afterLocation.valid, true);
  assert.notEqual(afterLocation.identity.semanticIrId, beforeLocation.identity.semanticIrId,
    'enumerable memory-location metadata must participate in identity');
  Object.defineProperty(loaded.def.loc, 'hidden', { value: 1, enumerable: false });
  assert.equal(identityOf(ir).valid, false, 'non-enumerable memory-location metadata must fail closed');
});

test('canonical identity keeps sparse arrays distinct and types undefined separately from null', () => {
  const ir = identityFixture();
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  const sparse = [];
  sparse.length = 1;
  definition.extra = { sparse };
  const sparseIdentity = identityOf(ir);
  assert.equal(sparseIdentity.valid, true);
  definition.extra = { sparse: [undefined] };
  const undefinedIdentity = identityOf(ir);
  assert.equal(undefinedIdentity.valid, true);
  definition.extra = { sparse: [null] };
  const nullIdentity = identityOf(ir);
  assert.equal(nullIdentity.valid, true);
  assert.notEqual(undefinedIdentity.identity.semanticIrId, nullIdentity.identity.semanticIrId);
});

test('default Phase 8 execution uses the deterministic bounded-work policy', () => {
  assert.equal(Number.isSafeInteger(PHASE8_DEFAULT_WORK_BUDGET), true);
  assert.ok(PHASE8_DEFAULT_WORK_BUDGET > 0);
  const f = fixture('c2-02-default-budget');
  f.block(0).ret();
  const context = { ir: f.build(), opts: {} };
  const first = runPhase8Stage(context, { stages: PASS_STAGES });
  const second = runPhase8Stage(context, { stages: PASS_STAGES, timeBudgetMs: null });
  assert.equal(first.ledger.published, true);
  assert.equal(second.ledger.published, true);
  assert.equal(first.ledger.publicationDigest, second.ledger.publicationDigest);
});

test('a deterministic work budget of zero withholds the full vertical', () => {
  const f = fixture('c2-02-zero-work');
  f.block(0).ret();
  const outcome = runPhase8Stage({ ir: f.build(), opts: {} }, { stages: PASS_STAGES, maxWorkItems: 0 });
  assert.equal(outcome.ledger.published, false);
  assert.equal(outcome.ledger.status, 'cancelled');
});

test('invalid explicit wall deadlines fail closed while null selects deterministic work', () => {
  const f = fixture('c2-02-invalid-deadline');
  f.block(0).ret();
  const context = { ir: f.build(), opts: {} };
  assert.equal(runPhase8Stage(context, { stages: PASS_STAGES, timeBudgetMs: Number.NaN }).ledger.published, false);
  assert.equal(runPhase8Stage(context, { stages: PASS_STAGES, timeBudgetMs: null }).ledger.published, true);
});

test('the cumulative range counterexamples remain fail-closed across wrapped and incompatible facts', () => {
  const wrapped = factFromRange(rangeOf(250n, 5n, 8));
  assert.equal(wrapped.range.kind, 'wrapped');
  const contradictory = factFromRange(rangeOf(0n, 31n, 8), {
    knownZero: 1n,
    knownOne: 1n,
    congruence: { remainder: 1n, modulus: 2n },
  });
  assert.equal(contradictory.status, 'malformed');
  assert.equal(contradictory.constant, null);
  assert.equal(joinFacts(wrapped, contradictory).constant, null);
});
