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
  seedAnalysisState,
} from '../../../js/decompiler/phase8/index.js';
import {
  ANALYSIS_IDENTITY_DIGEST_VERSION,
  ANALYSIS_IDENTITY_VERSION,
  analysisIdentityMatches,
  capturePhase8SemanticSnapshot,
  canonicalAnalysisIdentity,
} from '../../../js/decompiler/phase8/analysis-identity.js';
import { SEMANTIC_IR_DEFAULT_BUDGET } from '../../../js/semantics/ir/common.js';
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

test('one descriptor-only snapshot is the common immutable identity and consumer graph', () => {
  const target = {
    id:1, kind:'arg', bits:8, signed:null, const:null, def:null, uses:[],
    origin:{ instructionIds:['instruction_dynamic_value'] },
  };
  let idDescriptors = 0;
  const value = new Proxy(target, {
    getOwnPropertyDescriptor(object, key) {
      if (key === 'id') {
        idDescriptors += 1;
        object.bits = 16;
      }
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
  });
  const ir = {
    values:[value], blocks:[{ id:'entry' }], entry:'entry',
    origin:{ instructionIds:['instruction_dynamic_function'] },
  };

  const resolved = canonicalAnalysisIdentity({ ir });
  assert.equal(resolved.valid, true);
  assert.equal(idDescriptors, 1);
  assert.equal(target.bits, 16, 'the hostile descriptor may mutate the producer graph');
  assert.equal(resolved.semanticSnapshot.values[0].bits, 8,
    'identity and consumers retain the value captured before the reentrant mutation');
  assert.ok(Object.isFrozen(resolved.semanticSnapshot));
  assert.ok(Object.isFrozen(resolved.semanticSnapshot.values[0]));
});

test('semantic snapshot capture preserves graph sharing and cycles', () => {
  const ir = identityFixture('c2-02-snapshot-sharing');
  const snapshot = capturePhase8SemanticSnapshot(ir);
  const sum = snapshot.values.find((value) => value.def?.op === 'bin' && value.def?.sub === 'add');
  const source = sum.def.args[0].value;
  assert.equal(sum.def.dst, sum);
  assert.equal(source.uses.includes(sum.def), true);
  assert.equal(snapshot.values.find((value) => value.id === source.id), source);
  assert.ok(Object.isFrozen(sum.def.args));
  assert.ok(Object.isFrozen(source.uses));
});

test('a generic-first alias cannot hide fields required by its later semantic role', () => {
  const target = {
    id:1, kind:'arg', bits:8, signed:null, const:null, def:null, uses:[],
    origin:{ instructionIds:['instruction_role_union_value'] },
  };
  const value = new Proxy(target, {
    ownKeys(object) { return Reflect.ownKeys(object).filter((key) => key !== 'bits'); },
  });
  const ir = {
    a:value,
    values:[value], blocks:[{ id:'entry' }], entry:'entry',
    origin:{ instructionIds:['instruction_role_union_function'] },
  };
  const before = canonicalAnalysisIdentity({ ir });
  target.bits = 16;
  const after = canonicalAnalysisIdentity({ ir });
  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.notEqual(before.identity.semanticIrId, after.identity.semanticIrId);
});

test('GVN-consumed scalar and memory fields are known snapshot-role keys', () => {
  const assertChanged = (label, ir, mutate) => {
    const before = identityOf(ir);
    mutate();
    const after = identityOf(ir);
    assert.equal(before.valid, true, `${label}: before`);
    assert.equal(after.valid, true, `${label}: after`);
    assert.notEqual(before.identity.semanticIrId, after.identity.semanticIrId, label);
  };
  const hidden = (target, ...keys) => new Proxy(target, {
    ownKeys(object) {
      return Reflect.ownKeys(object).filter((key) => !keys.includes(key));
    },
  });

  {
    const ir = identityFixture('c2-02-hidden-argument-bits');
    const definition = ir.values.find((value) => value.def?.op === 'bin').def;
    const argument = { ...definition.args[0], bits:8 };
    definition.args[0] = hidden(argument, 'bits');
    assertChanged('argument.bits', ir, () => { argument.bits = 4; });
  }
  for (const field of ['op', 'amount']) {
    const ir = identityFixture(`c2-02-hidden-shift-${field}`);
    const definition = ir.values.find((value) => value.def?.op === 'bin').def;
    const shift = { op:'lsl', amount:1 };
    definition.args[0] = { ...definition.args[0], shift:hidden(shift, field) };
    assertChanged(`argument.shift.${field}`, ir, () => {
      shift[field] = field === 'op' ? 'lsr' : 2;
    });
  }
  {
    const ir = identityFixture('c2-02-hidden-definition-cond');
    const definition = ir.blocks.flatMap((block) => block.insts)
      .find((instruction) => instruction.op === 'cbr');
    const proxy = hidden(Object.assign(definition, { cond:'eq' }), 'cond');
    const block = ir.blocks.find((candidate) => candidate.insts.includes(definition));
    block.insts[block.insts.indexOf(definition)] = proxy;
    assertChanged('definition.cond', ir, () => { definition.cond = 'ne'; });
  }

  const extraFields = [
    ['signed', false, true], ['width', 8, 16], ['widthBits', 8, 16],
    ['widen', 'signed', 'unsigned'], ['toward', 'right', 'left'],
    ['bitfieldKind', 'bfi', 'bfxil'], ['negate', false, true],
    ['comparison', 'eq', 'lt'], ['float', false, true],
    ['completeness', 'complete', 'partial'], ['publicStateIdentity', 'r0', 'r1'],
  ];
  for (const [field, first, second] of extraFields) {
    const ir = identityFixture(`c2-02-hidden-extra-${field}`);
    const definition = ir.values.find((value) => value.def?.op === 'bin').def;
    const extra = { [field]:first };
    definition.extra = hidden(extra, field);
    assertChanged(`extra.${field}`, ir, () => { extra[field] = second; });
  }
  {
    const ir = identityFixture('c2-02-hidden-state-identity');
    const definition = ir.values.find((value) => value.def?.op === 'bin').def;
    const state = { key:'r0', kind:'physical-state', scope:'function' };
    definition.extra = { stateRead:hidden(state, 'key') };
    assertChanged('extra.stateRead.key', ir, () => { state.key = 'r1'; });
  }

  const accessFields = [
    ['addressSpace', 'memory', 'device'], ['widthBits', 8, 16],
    ['endian', 'little', 'big'], ['alignment', null, 4],
    ['volatility', 'unknown', false], ['atomic', false, true],
    ['ordering', 'unknown', 'acquire'], ['faults', [], [{ kind:'fault' }]],
  ];
  for (const [field, first, second] of accessFields) {
    const ir = identityFixture(`c2-02-hidden-memory-access-${field}`);
    const definition = ir.values.find((value) => value.def?.op === 'bin').def;
    const access = { [field]:first };
    definition.extra = { memoryAccess:hidden(access, field) };
    assertChanged(`memoryAccess.${field}`, ir, () => { access[field] = second; });
  }
  {
    const ir = identityFixture('c2-02-hidden-memory-address-expression');
    const definition = ir.values.find((value) => value.def?.op === 'bin').def;
    const addressExpr = { valueId:'address:A' };
    definition.extra = { memoryAccess:{ addressExpr:hidden(addressExpr, 'valueId') } };
    assertChanged('memoryAccess.addressExpr.valueId', ir,
      () => { addressExpr.valueId = 'address:B'; });
  }
  for (const field of ['kind', 'widthBits']) {
    const ir = identityFixture(`c2-02-hidden-machine-type-${field}`);
    const value = ir.values.find((candidate) => candidate.def?.op === 'bin');
    const machineType = { kind:'bitvector', widthBits:8 };
    value.machineType = hidden(machineType, field);
    assertChanged(`value.machineType.${field}`, ir, () => {
      machineType[field] = field === 'kind' ? 'predicate' : 16;
    });
  }
});

test('reference-only roles probe preferred ID aliases after a generic-first visit', () => {
  const ir = identityFixture('c2-02-reference-role-union');
  const target = { instructionId:'store:A', id:7 };
  const reference = new Proxy(target, {
    ownKeys(object) { return Reflect.ownKeys(object).filter((key) => key !== 'instructionId'); },
  });
  ir.a = reference;
  ir.values.find((value) => value.def?.op === 'bin').def.reachingStore = reference;
  const before = canonicalAnalysisIdentity({ ir });
  target.instructionId = 'store:B';
  const after = canonicalAnalysisIdentity({ ir });
  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.notEqual(before.identity.semanticIrId, after.identity.semanticIrId);
});

test('definition destinations and value use edges are bound without expanding graph cycles', () => {
  const ir = identityFixture('c2-02-back-reference-binding');
  const produced = ir.values.find((value) => value.def?.op === 'bin');
  const source = produced.def.args[0].value;

  const beforeDestination = canonicalAnalysisIdentity({ ir });
  produced.def.dst = source;
  const afterDestination = canonicalAnalysisIdentity({ ir });
  assert.equal(beforeDestination.valid, true);
  assert.equal(afterDestination.valid, true);
  assert.notEqual(beforeDestination.identity.semanticIrId, afterDestination.identity.semanticIrId);

  produced.def.dst = produced;
  const beforeUses = canonicalAnalysisIdentity({ ir });
  source.uses = [];
  const afterUses = canonicalAnalysisIdentity({ ir });
  assert.equal(beforeUses.valid, true);
  assert.equal(afterUses.valid, true);
  assert.notEqual(beforeUses.identity.semanticIrId, afterUses.identity.semanticIrId);
});

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

test('canonical identity memoizes a shared metadata DAG only within one mutation-sensitive call', () => {
  const ir = identityFixture('c2-02-shared-metadata-dag');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  const shared = {
    proof: { state: 'before' },
    map: new Map([['alpha', { value: 1 }], ['beta', 2]]),
    set: new Set(['x', 'y']),
  };
  definition.extra = { left: shared, right: shared };
  const before = identityOf(ir);

  shared.proof.state = 'after';
  shared.map.get('alpha').value = 3;
  shared.set.add('z');
  const mutated = identityOf(ir);
  assert.equal(before.valid, true);
  assert.equal(mutated.valid, true);
  assert.notEqual(mutated.identity.semanticIrId, before.identity.semanticIrId,
    'a memo from the prior call must never hide an in-place mutation');

  const clone = () => ({
    set: new Set(['z', 'y', 'x']),
    map: new Map([['beta', 2], ['alpha', { value: 3 }]]),
    proof: { state: 'after' },
  });
  definition.extra = { right: clone(), left: clone() };
  const unshared = identityOf(ir);
  assert.equal(unshared.valid, true);
  assert.equal(unshared.identity.semanticIrId, mutated.identity.semanticIrId,
    'object sharing and Map/Set insertion order are not semantic input');
});

test('equal-digest Map and Set wrappers do not expand a shared DAG in the sort comparator', { timeout:2000 }, () => {
  const ir = identityFixture('c2-02-shared-wrapper-sort');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  const shared = {
    leaves:Array.from({ length:512 }, (_unused, index) => ({ index, state:`leaf-${index}` })),
  };
  const wrappers = Array.from({ length:1024 }, () => ({ payload:shared }));
  definition.extra = {
    map:new Map(wrappers.map((wrapper) => [wrapper, { payload:shared }])),
    set:new Set(wrappers),
  };
  const started = performance.now();
  const resolved = identityOf(ir);
  const elapsed = performance.now() - started;
  assert.equal(resolved.valid, true);
  assert.ok(elapsed < 1000,
    `equal-digest wrappers must stay linear instead of expanding the shared DAG (${elapsed.toFixed(1)} ms)`);
});

test('specialized frozen-origin hashing is invariant to sharing across schema contexts', () => {
  const origin = (shared) => {
    const byteRange = Object.freeze({ start:'0', end:'1' });
    const sourceLocation = shared ? byteRange : Object.freeze({ start:'0', end:'1' });
    return Object.freeze({
      schemaVersion:1,
      byteRanges:Object.freeze([byteRange]),
      virtualRanges:Object.freeze([]),
      instructionIds:Object.freeze([]),
      operationIds:Object.freeze([]),
      sourceLocations:Object.freeze([sourceLocation]),
      parentEntityIds:Object.freeze([]),
      transforms:Object.freeze([]),
    });
  };
  const ir = identityFixture('c2-02-origin-sharing');
  ir.origin = origin(true);
  const sharedIdentity = identityOf(ir);
  ir.origin = origin(false);
  const unsharedIdentity = identityOf(ir);
  assert.equal(sharedIdentity.valid, true);
  assert.equal(unsharedIdentity.valid, true);
  assert.equal(sharedIdentity.identity.semanticIrId, unsharedIdentity.identity.semanticIrId,
    'object sharing cannot change a content identity across specialized schema tags');
});

test('unbranded frozen origins are content identities, not alias identities', () => {
  const origin = () => Object.freeze({
    schemaVersion:1,
    evidence:Object.freeze({ state:'same' }),
  });
  const assign = (ir, shared) => {
    const definitions = ir.values.filter((value) => value.def != null).slice(0, 2);
    const first = origin();
    definitions[0].def.origin = first;
    definitions[1].def.origin = shared ? first : origin();
  };
  const shared = identityFixture('c2-02-unbranded-shared-origin');
  assign(shared, true);
  const sharedIdentity = identityOf(shared);
  assign(shared, false);
  const clonedIdentity = identityOf(shared);
  assert.equal(sharedIdentity.valid, true);
  assert.equal(clonedIdentity.valid, true);
  assert.equal(sharedIdentity.identity.semanticIrId, clonedIdentity.identity.semanticIrId,
    'sharing equal frozen origin content cannot change semantic identity');

  const hostile = { visible:true };
  Object.defineProperty(hostile, 'hidden', { value:true, enumerable:false });
  Object.freeze(hostile);
  shared.values.find((value) => value.def != null).def.origin = hostile;
  assert.equal(identityOf(shared).valid, false,
    'frozen but unbranded origins still take the strict descriptor path');
});

test('canonical identity rejects overridden Map, Set, and Date intrinsics without invoking them', () => {
  let hookCalls = 0;
  class EvilMap extends Map { entries() { hookCalls += 1; return super.entries(); } }
  class EvilSet extends Set { values() { hookCalls += 1; return super.values(); } }
  class EvilDate extends Date { toISOString() { hookCalls += 1; return super.toISOString(); } }
  for (const value of [new EvilMap([['key', 'value']]), new EvilSet(['value']), new EvilDate(0)]) {
    const ir = identityFixture('c2-02-overridden-builtins');
    ir.values.find((candidate) => candidate.def?.op === 'bin').def.extra = { value };
    assert.equal(identityOf(ir).valid, false);
  }
  assert.equal(hookCalls, 0, 'identity validation must never dynamically dispatch container hooks');
});

test('the digest migration makes old transcript identities stale without changing producer versions', () => {
  // Keep this graph independent of the fixture module's process-global IDs so
  // the checked-in v5 evidence is for exactly the same semantic input.
  const ir = {
    values:[{
      id:1, kind:'arg', bits:8, signed:null, const:null, def:null, uses:[],
      origin:{ instructionIds:['instruction_version_value'] },
    }],
    blocks:[{
      id:'entry', index:0, insts:[], phis:[], memPhis:[], successorEdges:[], succ:[], pred:[],
      origin:{ instructionIds:['instruction_version_block'] },
    }],
    entry:0, idom:[null], ipdom:[null], backEdges:[], loops:[],
    origin:{ instructionIds:['instruction_version_function'] },
  };
  const current = identityOf(ir);
  // Captured from this exact graph at b75e23a8 / phase8-analysis-merkle-v5.
  // It includes the durable shape binding, so rejection proves the transcript
  // version invalidates old evidence rather than failing for a missing field.
  const previous = Object.freeze({
    binaryId: 'binary:b6ffce7b0b4e10ab82c11edbe4575c98',
    functionId: 'function:shape:ad4f8c9d9d59a429c98a17dca76695fa',
    snapshotId: 'snapshot:0ddd04915efb4c5c1cd435b158374dc1',
    semanticIrId: 'semantic-ir:81034dc00650d3d97e6f04ae014ccd38',
    ssaId: 'ssa:1a8e0bcae078dcf60e97f7dd248dce0f',
    analyzerVersion: 'phase8-analysis-v1',
    shapeDigest: 'shape:ad4f8c9d9d59a429c98a17dca76695fa',
  });
  assert.equal(current.valid, true);
  assert.equal(ANALYSIS_IDENTITY_VERSION, 'phase8-analysis-v1');
  assert.equal(ANALYSIS_IDENTITY_DIGEST_VERSION, 'phase8-analysis-merkle-v7');
  assert.equal(current.identity.analyzerVersion, ANALYSIS_IDENTITY_VERSION);
  assert.equal(analysisIdentityMatches(previous, current.identity), false);
  assert.equal(canonicalAnalysisIdentity({ ir, analysisIdentity: previous }).valid, false,
    'a full merkle-v5 identity must fail after the v7 transcript migration');
  const previousV6 = Object.freeze({
    binaryId: 'binary:69a1f14325b0c65b2ebfc48c61ef6584',
    functionId: 'function:shape:f8eb8c66bb4b88f2ab4a66d555ba60ad',
    snapshotId: 'snapshot:107a0519e273d642bc1311b57d965c63',
    semanticIrId: 'semantic-ir:9e6a9c909af3e1a827e2d76d58d645d1',
    ssaId: 'ssa:73c22a61dc5e6db5c5e46a4abeb00f78',
    analyzerVersion: 'phase8-analysis-v1',
    shapeDigest: 'shape:f8eb8c66bb4b88f2ab4a66d555ba60ad',
  });
  assert.equal(analysisIdentityMatches(previousV6, current.identity), false);
  assert.equal(canonicalAnalysisIdentity({ ir, analysisIdentity: previousV6 }).valid, false,
    'a full merkle-v6 identity must fail after the v7 key-child transcript migration');
  const customProducer = canonicalAnalysisIdentity({
    ir,
    analysisIdentity:{ ...current.identity, analyzerVersion:'phase8-analysis-custom-producer' },
  });
  assert.equal(customProducer.valid, true,
    'a supplied producer analyzer version remains valid when its full IDs bind to the current shape');
  assert.equal(customProducer.identity.analyzerVersion, 'phase8-analysis-custom-producer');
});

test('every identity authority is snapshotted once and bound to the same IR', () => {
  const ir = identityFixture('c2-02-identity-authorities');
  const issued = identityOf(ir).identity;
  const conflict = { ...issued, binaryId:'conflicting-binary' };
  assert.equal(canonicalAnalysisIdentity({ ir, analysisIdentity:issued, identity:conflict }).valid, false);
  assert.equal(canonicalAnalysisIdentity({ ir, analysisIdentity:issued, artifactIdentity:conflict }).valid, false);
  ir.analysisIdentity = issued;
  ir.artifactIdentity = conflict;
  assert.equal(identityOf(ir).valid, false,
    'an IR artifactIdentity cannot be ignored in favor of another alias');
  delete ir.analysisIdentity;
  delete ir.artifactIdentity;

  for (const malformed of [1, { ...issued, binaryId:1 }]) {
    assert.equal(canonicalAnalysisIdentity({ ir, artifactIdentity:malformed }).valid, false);
  }

  let descriptorReads = 0;
  const changing = new Proxy(issued, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== 'binaryId' || descriptor == null) return descriptor;
      descriptorReads += 1;
      return { ...descriptor, value:descriptorReads === 1 ? descriptor.value : 'changed-after-validation' };
    },
  });
  const snapshotted = canonicalAnalysisIdentity({ ir, analysisIdentity:changing });
  assert.equal(snapshotted.valid, true);
  assert.equal(snapshotted.identity.binaryId, issued.binaryId);
  assert.equal(descriptorReads, 1,
    'a source identity descriptor must not be read again after strict validation');
});

test('IR-root identity authorities are captured by one descriptor snapshot', () => {
  const ir = identityFixture('c2-02-root-identity-snapshot');
  const issued = identityOf(ir).identity;
  ir.analysisIdentity = issued;
  const conflicting = { ...issued, binaryId:'conflicting-binary' };
  let descriptorReads = 0;
  let ordinaryReads = 0;
  const changing = new Proxy(ir, {
    get(target, key, receiver) {
      if (key === 'analysisIdentity') ordinaryReads += 1;
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== 'analysisIdentity' || descriptor == null) return descriptor;
      descriptorReads += 1;
      return { ...descriptor, value:descriptorReads === 1 ? issued : conflicting };
    },
  });
  const resolved = canonicalAnalysisIdentity({ ir:changing });
  assert.equal(resolved.valid, true);
  assert.equal(resolved.identity.binaryId, issued.binaryId,
    'an unobserved later descriptor value cannot replace the captured authority');
  assert.equal(descriptorReads, 1);
  assert.equal(ordinaryReads, 0,
    'root authority validation must not execute an ordinary property read');
});

test('IR-root authority objects cannot mutate during a removed second descriptor read', () => {
  const ir = identityFixture('c2-02-root-identity-same-reference');
  const issued = identityOf(ir).identity;
  const authority = { ...issued };
  ir.analysisIdentity = authority;
  let descriptorReads = 0;
  const changing = new Proxy(ir, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== 'analysisIdentity' || descriptor == null) return descriptor;
      descriptorReads += 1;
      if (descriptorReads > 1) authority.binaryId = 'mutated-during-validation';
      return descriptor;
    },
  });
  const resolved = canonicalAnalysisIdentity({ ir:changing });
  assert.equal(resolved.valid, true);
  assert.equal(descriptorReads, 1);
  assert.equal(authority.binaryId, issued.binaryId);
  assert.deepEqual(resolved.identity, issued);
});

test('externally authoritative public IDs survive self-issued identity replay', () => {
  const ir = identityFixture('c2-02-external-identity-roundtrip');
  ir.binaryId = 'binary:external';
  ir.snapshotId = 'snapshot:external';
  const first = identityOf(ir);
  assert.equal(first.valid, true);
  ir.analysisIdentity = first.identity;
  const replayed = identityOf(ir);
  assert.equal(replayed.valid, true);
  assert.deepEqual(replayed.identity, first.identity,
    'consumer fallback formulas cannot override authoritative producer IDs');
});

test('issued identities retain an upstream producer shape binding', () => {
  const ir = identityFixture('c2-02-upstream-shape-binding');
  const shapeDigest = identityOf(ir).identity.shapeDigest;
  const upstream = {
    binaryId:'binary:upstream',
    functionId:'function:upstream',
    snapshotId:'snapshot:upstream',
    semanticIrId:'semantic-ir:upstream',
    ssaId:'ssa:upstream',
    analyzerVersion:'phase8-upstream-v1',
    shapeDigest,
  };
  const accepted = canonicalAnalysisIdentity({ ir, analysisIdentity:upstream });
  assert.equal(accepted.valid, true);
  assert.deepEqual(accepted.identity, upstream);

  ir.analysisIdentity = accepted.identity;
  assert.equal(identityOf(ir).valid, true,
    'the issued identity must retain enough proof for unchanged-IR replay');
  ir.values.find((value) => value.def?.op === 'bin').def.extra.bindingMutation = true;
  assert.equal(identityOf(ir).valid, false,
    'the retained producer binding must reject a semantic shape mutation');
});

test('analysis identity matching rejects equal upstream IDs from different shapes', () => {
  const ir = identityFixture('c2-02-cross-shape-binding');
  const common = {
    binaryId:'binary:shared-upstream',
    functionId:'function:shared-upstream',
    snapshotId:'snapshot:shared-upstream',
    semanticIrId:'semantic-ir:shared-upstream',
    ssaId:'ssa:shared-upstream',
    analyzerVersion:'phase8-upstream-v1',
  };
  ir.semanticFlag = 'shape-a';
  const shapeA = identityOf(ir).identity.shapeDigest;
  const first = canonicalAnalysisIdentity({
    ir, analysisIdentity:{ ...common, shapeDigest:shapeA },
  });
  ir.semanticFlag = 'shape-b';
  const shapeB = identityOf(ir).identity.shapeDigest;
  const second = canonicalAnalysisIdentity({
    ir, analysisIdentity:{ ...common, shapeDigest:shapeB },
  });
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.notEqual(first.identity.shapeDigest, second.identity.shapeDigest);
  assert.equal(analysisIdentityMatches(first.identity, second.identity), false);
});

test('issued identity metadata can be replayed without becoming semantic input', () => {
  const ir = identityFixture('c2-02-issued-identity-replay');
  const issued = identityOf(ir);
  assert.equal(issued.valid, true);

  ir.analysisIdentity = issued.identity;
  Object.assign(ir, issued.identity);
  ir.semanticIrShapeDigest = issued.identity.functionId.slice('function:'.length);
  const replayed = identityOf(ir);
  assert.equal(replayed.valid, true);
  assert.deepEqual(replayed.identity, issued.identity);

  ir.analysisIdentity = { ...issued.identity, snapshotId:'mutated-snapshot' };
  assert.equal(identityOf(ir).valid, false,
    'mutating replayed authority metadata must still fail stale validation');
});

test('semantic schema input is not an analyzer-version alias', () => {
  const ir = identityFixture('c2-02-semantic-schema-contract');
  const schemaOnly = canonicalAnalysisIdentity({
    ir,
    analysisIdentity:{ semanticSchemaVersion:'semantic-ir/v2' },
  });
  assert.equal(schemaOnly.valid, true);
  assert.equal(schemaOnly.identity.analyzerVersion, ANALYSIS_IDENTITY_VERSION);

  ir.semanticSchemaVersion = 'semantic-ir/v2';
  const schemaBound = identityOf(ir);
  assert.equal(schemaBound.valid, true);
  assert.notEqual(schemaBound.identity.semanticIrId, schemaOnly.identity.semanticIrId,
    'an IR semantic schema version remains part of the semantic transcript');
  assert.equal(canonicalAnalysisIdentity({
    ir,
    analysisIdentity:{ semanticSchemaVersion:'semantic-ir/v3' },
  }).valid, false, 'conflicting semantic schema contracts must fail closed');
});

test('identity authorities must be plain descriptor records', () => {
  const ir = identityFixture('c2-02-identity-source-container');
  for (const source of [new Map(), new Set(), new Date(0)]) {
    assert.equal(canonicalAnalysisIdentity({ ir, analysisIdentity:source }).valid, false);
  }
});

test('identity authority prototypes are observed once without dropping fields', () => {
  const ir = identityFixture('c2-02-identity-source-prototype');
  let prototypeReads = 0;
  const source = new Proxy({ binaryId:'binary:external-proxy' }, {
    getPrototypeOf() {
      prototypeReads += 1;
      return prototypeReads === 1 ? Object.prototype : Map.prototype;
    },
  });
  const resolved = canonicalAnalysisIdentity({ ir, analysisIdentity:source });
  assert.equal(resolved.valid, true);
  assert.equal(resolved.identity.binaryId, 'binary:external-proxy',
    'a later container prototype cannot launder a captured authority field');
  assert.equal(prototypeReads, 1);

  const hiddenFromOwnKeys = new Proxy({ binaryId:'binary:own-keys-proxy' }, {
    ownKeys() { return []; },
  });
  const knownField = canonicalAnalysisIdentity({ ir, analysisIdentity:hiddenFromOwnKeys });
  assert.equal(knownField.valid, true);
  assert.equal(knownField.identity.binaryId, 'binary:own-keys-proxy',
    'known authority fields are probed independently of Proxy ownKeys');
});

test('external identity-authority traversal has a fresh Semantic IR reference budget', () => {
  const ir = identityFixture('c2-02-external-authority-reference-budget');
  const issued = identityOf(ir).identity;
  const authority = {
    ...issued,
    nested:{ sparse:new Array(SEMANTIC_IR_DEFAULT_BUDGET.maxReferences + 1) },
  };

  assert.equal(canonicalAnalysisIdentity({ ir, analysisIdentity:authority }).valid, false,
    'a hostile authority graph must fail before traversing an unbounded sparse array');
  assert.equal(canonicalAnalysisIdentity({ ir, analysisIdentity:issued }).valid, true,
    'authority traversal budget is fresh for each canonicalization call');
});

test('identity text work is cumulatively bounded for authorities and raw Semantic IR', () => {
  const limit = SEMANTIC_IR_DEFAULT_BUDGET.maxReferences;
  const oversizedText = 'x'.repeat(limit + 1);
  const oversizedBigint = 1n << BigInt(Math.ceil(limit * 3.3219280948873626) + 64);
  const baseIr = identityFixture('c2-02-text-work-budget-authority');
  const issued = identityOf(baseIr).identity;

  for (const [label, nested] of [
    ['string', oversizedText],
    ['property-key', { [oversizedText]:true }],
    ['bigint', oversizedBigint],
  ]) {
    assert.equal(canonicalAnalysisIdentity({
      ir:baseIr,
      analysisIdentity:{ ...issued, nested },
    }).valid, false, `external authority ${label}`);
  }
  assert.equal(identityOf(baseIr).valid, true,
    'an exhausted authority call cannot spend the next call\'s fresh budget');

  for (const [label, payload] of [
    ['string', { text:oversizedText }],
    ['property-key', { [oversizedText]:true }],
    ['bigint', { count:oversizedBigint }],
  ]) {
    const ir = identityFixture(`c2-02-text-work-budget-ir-${label}`);
    ir.values.find((value) => value.def?.op === 'bin').def.extra = payload;
    assert.equal(identityOf(ir).valid, false, `raw Semantic IR ${label}`);
  }
  assert.equal(identityOf(identityFixture('c2-02-text-work-budget-fresh')).valid, true,
    'snapshot and graph-digest work budgets are call-local');
});

test('identity comparison consumes validated descriptor snapshots without ordinary reads', () => {
  const issued = identityOf(identityFixture('c2-02-identity-match-snapshot')).identity;
  let ordinaryReads = 0;
  const observed = new Proxy(issued, {
    get(target, key, receiver) {
      ordinaryReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(analysisIdentityMatches(observed, issued), true);
  assert.equal(ordinaryReads, 0);
});

test('direct projections validate descriptors even on skipped graph edges', () => {
  const cases = [
    (ir, definition) => Object.defineProperty(definition, 'uses', {
      get() { throw new Error('a skipped accessor must never execute'); },
      enumerable:true,
      configurable:true,
    }),
    (ir, definition) => Object.defineProperty(definition, 'uses', {
      value:[],
      enumerable:false,
      configurable:true,
    }),
    (ir, definition) => { definition[Symbol('skipped-edge-metadata')] = true; },
    (ir) => Object.defineProperty(ir, 'blocks', {
      get() { throw new Error('a derived accessor must never execute'); },
      enumerable:true,
      configurable:true,
    }),
  ];
  for (const mutate of cases) {
    const ir = identityFixture('c2-02-skipped-descriptor');
    const definition = ir.values.find((value) => value.def?.op === 'bin').def;
    mutate(ir, definition);
    assert.equal(identityOf(ir).valid, false);
  }
});

test('direct projection digests remain mutation-sensitive across calls', () => {
  const ir = identityFixture('c2-02-projection-mutation');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  definition.customIdentityMetadata = { nested:{ state:'before' } };
  const before = identityOf(ir);
  definition.customIdentityMetadata.nested.state = 'after';
  const after = identityOf(ir);
  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.notEqual(after.identity.semanticIrId, before.identity.semanticIrId,
    'a digest from a prior call cannot hide an included nested mutation');
});

test('specialized semantic lists reject descriptors without executing accessors', () => {
  const cases = [
    (ir) => ir.values.find((value) => value.def?.op === 'bin').def.args,
    (ir) => ir.blocks,
  ];
  for (const select of cases) {
    for (const mutate of [
      (list) => { list[Symbol('hidden')] = true; },
      (list) => Object.defineProperty(list, 'hidden', { value:true, enumerable:false }),
      (list) => { delete list[0]; },
    ]) {
      const ir = identityFixture('c2-02-specialized-list-descriptor');
      mutate(select(ir));
      assert.equal(identityOf(ir).valid, false);
    }

    const ir = identityFixture('c2-02-specialized-list-accessor');
    const list = select(ir);
    const first = list[0];
    let getterReads = 0;
    Object.defineProperty(list, '0', {
      get() { getterReads += 1; return first; },
      enumerable:true,
      configurable:true,
    });
    assert.equal(identityOf(ir).valid, false);
    assert.equal(getterReads, 0, 'identity validation must never execute a list accessor');
  }
});

test('generic array identity is independent of Proxy own-key order', () => {
  const reversed = new Proxy([1, 2], {
    ownKeys() { return ['1', '0', 'length']; },
  });
  const ir = identityFixture('c2-02-array-key-order');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  definition.extra = { items:reversed };
  const ordered = identityOf(ir);
  definition.extra = { items:[1, 2] };
  const ordinary = identityOf(ir);
  definition.extra = { items:[, 2] };
  const sparse = identityOf(ir);
  assert.equal(ordered.valid, true);
  assert.equal(ordinary.valid, true);
  assert.equal(sparse.valid, true);
  assert.equal(ordered.identity.semanticIrId, ordinary.identity.semanticIrId);
  assert.notEqual(ordered.identity.semanticIrId, sparse.identity.semanticIrId,
    'reordered descriptors cannot make a dense array collide with a sparse array');

  const outOfRange = new Proxy([1, 2], {
    ownKeys() { return ['0', '1', '2', 'length']; },
    getOwnPropertyDescriptor(target, key) {
      if (key === '2') return { value:3, enumerable:true, configurable:true, writable:true };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  definition.extra = { items:outOfRange };
  assert.equal(identityOf(ir).valid, false,
    'an own array index outside the captured length must not disappear from identity');
});

test('generic array capture probes dense indexes omitted by Proxy ownKeys', () => {
  const target = [1];
  const hiddenDenseIndex = new Proxy(target, {
    ownKeys() { return ['length']; },
  });
  const ir = identityFixture('c2-02-array-hidden-dense-index');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  definition.extra = { items:hiddenDenseIndex };

  const before = identityOf(ir);
  target[0] = 2;
  const after = identityOf(ir);

  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.notEqual(before.identity.semanticIrId, after.identity.semanticIrId,
    'a dense element omitted from ownKeys must remain part of the semantic identity');
});

test('semantic snapshot array probing is bounded by the Semantic IR reference budget', () => {
  const maxReferences = SEMANTIC_IR_DEFAULT_BUDGET.maxReferences;
  const hiddenSparse = (length) => new Proxy(new Array(length), {
    ownKeys() { return ['length']; },
  });
  const ir = identityFixture('c2-02-array-reference-budget');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;

  definition.extra = { items:hiddenSparse(maxReferences + 1) };
  assert.equal(identityOf(ir).valid, false,
    'a hostile sparse length must fail before an unbounded descriptor loop');

  const half = Math.floor(maxReferences / 2);
  definition.extra = { items:[hiddenSparse(half), hiddenSparse(half)] };
  assert.equal(identityOf(ir).valid, false,
    'several arrays share one call-local reference budget');

  definition.extra = { items:hiddenSparse(1) };
  const hole = identityOf(ir);
  const denseTarget = [7];
  definition.extra = { items:new Proxy(denseTarget, { ownKeys() { return ['length']; } }) };
  const dense = identityOf(ir);
  assert.equal(hole.valid, true);
  assert.equal(dense.valid, true);
  assert.notEqual(hole.identity.semanticIrId, dense.identity.semanticIrId,
    'a true hole and a hidden dense element remain distinct below the budget');
});

test('public semantic snapshot capture owns its work budget', () => {
  const sparse = new Proxy(new Array(SEMANTIC_IR_DEFAULT_BUDGET.maxReferences + 1), {
    ownKeys() { return ['length']; },
  });
  const forgedBudget = {
    consume() {},
    consumeText() {},
    bigintText(value) { return String(value); },
  };
  assert.throws(
    () => capturePhase8SemanticSnapshot({ payload:sparse }, forgedBudget),
    /identity-work-budget-exceeded|identity-semantic-snapshot-reference-budget-exceeded/,
    'a caller-provided no-op budget cannot widen the fixed public cap',
  );
  assert.equal(identityOf(identityFixture('c2-02-public-capture-budget-fresh')).valid, true,
    'a rejected public capture cannot spend another call\'s budget');
});

test('the immediate-post-dominator alias is probed and must agree with ipdom', () => {
  const target = identityFixture('c2-02-ipdom-alias');
  const alias = target.ipdom.slice();
  delete target.ipdom;
  target.immediatePostDominators = alias;
  const ir = new Proxy(target, {
    ownKeys(object) {
      return Reflect.ownKeys(object).filter((key) => key !== 'immediatePostDominators');
    },
  });
  const before = identityOf(ir);
  alias[0] = alias[0] == null ? 1 : null;
  const after = identityOf(ir);
  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.notEqual(before.identity.semanticIrId, after.identity.semanticIrId,
    'a known post-dominator alias cannot disappear behind Proxy ownKeys');

  const conflict = identityFixture('c2-02-ipdom-alias-conflict');
  conflict.immediatePostDominators = conflict.ipdom.slice();
  conflict.immediatePostDominators[0] = conflict.ipdom[0] == null ? 1 : null;
  assert.equal(identityOf(conflict).valid, false,
    'two present immediate-post-dominator fields must not disagree');

});

test('absent and proved-empty loop inputs have distinct identities and seed states', () => {
  const ir = identityFixture('c2-02-loop-presence');
  delete ir.loops;
  delete ir.backEdges;
  const absent = identityOf(ir);
  const absentState = seedAnalysisState(ir);

  ir.loops = [];
  const emptyLoops = identityOf(ir);
  const emptyLoopsState = seedAnalysisState(ir);
  delete ir.loops;
  ir.backEdges = [];
  const emptyBackEdges = identityOf(ir);
  const emptyBackEdgesState = seedAnalysisState(ir);

  assert.equal(absent.valid, true);
  assert.equal(emptyLoops.valid, true);
  assert.equal(emptyBackEdges.valid, true);
  assert.notEqual(absent.identity.semanticIrId, emptyLoops.identity.semanticIrId);
  assert.notEqual(absent.identity.semanticIrId, emptyBackEdges.identity.semanticIrId);
  assert.equal(absentState.version('loops'), 0);
  assert.equal(emptyLoopsState.version('loops'), 1);
  assert.equal(absentState.get('cfg').backEdges, null);
  assert.deepEqual(emptyBackEdgesState.get('cfg').backEdges, []);
});

test('projected shape fields are consumed from descriptor snapshots', () => {
  const ir = identityFixture('c2-02-projection-snapshot');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  let ordinaryReads = 0;
  const wrapped = new Proxy(definition, {
    get(target, key, receiver) {
      ordinaryReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  for (const block of ir.blocks) {
    for (let index = 0; index < block.insts.length; index += 1) {
      if (block.insts[index] === definition) block.insts[index] = wrapped;
    }
    for (let index = 0; index < block.phis.length; index += 1) {
      if (block.phis[index] === definition) block.phis[index] = wrapped;
    }
  }
  for (const value of ir.values) if (value.def === definition) value.def = wrapped;
  if (Array.isArray(ir.instructions)) {
    for (let index = 0; index < ir.instructions.length; index += 1) {
      if (ir.instructions[index] === definition) ir.instructions[index] = wrapped;
    }
  }
  assert.equal(identityOf(ir).valid, true);
  assert.equal(ordinaryReads, 0,
    'shape construction must use the values captured while validating descriptors');
});

test('schema projections probe known fields omitted by Proxy ownKeys', () => {
  const ir = identityFixture('c2-02-known-key-probe');
  const targetValue = ir.values[0];
  let ordinaryReads = 0;
  ir.values[0] = new Proxy(targetValue, {
    ownKeys(target) { return Reflect.ownKeys(target).filter((key) => key !== 'bits'); },
    get(target, key, receiver) {
      if (key === 'bits') ordinaryReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const first = identityOf(ir);
  assert.equal(first.valid, true);
  targetValue.bits = 16;
  const second = identityOf(ir);
  assert.equal(second.valid, true);
  assert.notEqual(second.identity.semanticIrId, first.identity.semanticIrId,
    'omitting a known value field from ownKeys cannot hide its mutation');
  assert.equal(ordinaryReads, 0);

  const root = identityFixture('c2-02-known-root-key-probe');
  const proxiedRoot = new Proxy(root, {
    ownKeys(target) { return Reflect.ownKeys(target).filter((key) => key !== 'entry'); },
  });
  const beforeEntry = canonicalAnalysisIdentity({ ir:proxiedRoot });
  root.entry = 1;
  const afterEntry = canonicalAnalysisIdentity({ ir:proxiedRoot });
  assert.equal(beforeEntry.valid, true);
  assert.equal(afterEntry.valid, true);
  assert.notEqual(afterEntry.identity.semanticIrId, beforeEntry.identity.semanticIrId,
    'omitting the known root entry field cannot hide its mutation');
});

test('canonical shape ordering uses exact code-unit order', () => {
  const ir = identityFixture('c2-02-code-unit-order');
  ir.values[0].id = 'a\u0323\u0301';
  ir.values[1].id = 'a\u0301\u0323';
  const forwardValues = identityOf(ir);
  ir.values.reverse();
  const reverseValues = identityOf(ir);
  assert.equal(forwardValues.valid, true);
  assert.equal(reverseValues.valid, true);
  assert.equal(forwardValues.identity.semanticIrId, reverseValues.identity.semanticIrId,
    'locale-equivalent value IDs cannot preserve input order in the canonical shape');

  ir.blocks[0].index = '\u212b';
  ir.blocks[1].index = '\u00c5';
  const forwardBlocks = identityOf(ir);
  ir.blocks.reverse();
  const reverseBlocks = identityOf(ir);
  assert.equal(forwardBlocks.valid, true);
  assert.equal(reverseBlocks.valid, true);
  assert.equal(forwardBlocks.identity.semanticIrId, reverseBlocks.identity.semanticIrId,
    'locale-equivalent block indexes cannot preserve input order in the canonical shape');

  const typed = identityFixture('c2-02-typed-block-order');
  typed.blocks[0].index = 1;
  typed.blocks[1].index = '1';
  const typedForward = identityOf(typed);
  typed.blocks.reverse();
  const typedReverse = identityOf(typed);
  assert.equal(typedForward.valid, true);
  assert.equal(typedReverse.valid, true);
  assert.equal(typedForward.identity.semanticIrId, typedReverse.identity.semanticIrId,
    'number and string block keys need distinct framed sort keys');

  const duplicateBlock = identityFixture('c2-02-duplicate-block');
  duplicateBlock.blocks[1].index = duplicateBlock.blocks[0].index;
  assert.equal(identityOf(duplicateBlock).valid, false);
  const duplicateValue = identityFixture('c2-02-duplicate-value');
  duplicateValue.values[1].id = duplicateValue.values[0].id;
  assert.equal(identityOf(duplicateValue).valid, false);

  const hostile = identityFixture('c2-02-hostile-block-index');
  let coercions = 0;
  hostile.blocks[0].index = {
    [Symbol.toPrimitive]() { coercions += 1; return '0'; },
  };
  assert.equal(identityOf(hostile).valid, false);
  assert.equal(coercions, 0, 'block ordering must not coerce hostile identifiers');
});

test('value tokens are required, injective, and type-framed', () => {
  for (const malformed of [Infinity, NaN, 1.5, '', null, undefined, () => 1, Symbol('id')]) {
    const ir = identityFixture('c2-02-malformed-value-id');
    ir.values[0].id = malformed;
    assert.equal(identityOf(ir).valid, false, `malformed value ID ${String(malformed)} must fail closed`);
  }

  const ir = identityFixture('c2-02-token-framing');
  const first = ir.values[0];
  first.id = 'number:1';
  const reserved = identityOf(ir);
  first.id = 'string:number:1';
  const literalFrame = identityOf(ir);
  first.id = -0;
  const negativeZero = identityOf(ir);
  first.id = 0;
  const positiveZero = identityOf(ir);
  for (const resolved of [reserved, literalFrame, negativeZero, positiveZero]) {
    assert.equal(resolved.valid, true);
  }
  assert.notEqual(reserved.identity.semanticIrId, literalFrame.identity.semanticIrId);
  assert.notEqual(negativeZero.identity.semanticIrId, positiveZero.identity.semanticIrId);

  ir.functionId = { key:'value' };
  assert.equal(identityOf(ir).valid, false,
    'public artifact identity fields accept strings only');
  ir.functionId = 'object:32:literal-public-id';
  const literalFunction = identityOf(ir);
  assert.equal(literalFunction.valid, true);
  assert.equal(literalFunction.identity.functionId, ir.functionId,
    'legitimate public string IDs are preserved verbatim');

  delete ir.values.find((value) => value.def != null).def.conditionValue;
  assert.equal(identityOf(ir).valid, true, 'an absent optional reference remains valid');
});

test('structured object IDs are snapshotted once per canonical call', () => {
  let descriptorReads = 0;
  const sharedId = new Proxy({ key:'a' }, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== 'key' || descriptor == null) return descriptor;
      descriptorReads += 1;
      return { ...descriptor, value:descriptorReads === 1 ? 'a' : 'b' };
    },
  });
  const ir = {
    blocks:[{ id:'entry' }],
    values:[{ id:sharedId }, { id:sharedId }],
    entry:'entry',
  };
  assert.equal(identityOf(ir).valid, false,
    'one shared object ID cannot evade duplicate detection by changing descriptors');
  assert.equal(descriptorReads, 1);
});

test('value projections and references share one ID descriptor snapshot', () => {
  const ir = identityFixture('c2-02-shared-dynamic-value-id');
  const target = ir.values.find((value) => value.kind === 'arg');
  const baseline = identityOf(ir);
  let descriptorReads = 0;
  let ordinaryReads = 0;
  const shared = new Proxy(target, {
    getOwnPropertyDescriptor(object, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      if (key !== 'id' || descriptor == null) return descriptor;
      descriptorReads += 1;
      return { ...descriptor, value:descriptorReads === 1 ? descriptor.value : descriptor.value + 1000 };
    },
    get(object, key, receiver) {
      if (key === 'id') ordinaryReads += 1;
      return Reflect.get(object, key, receiver);
    },
  });
  ir.values[ir.values.indexOf(target)] = shared;
  for (const value of ir.values) {
    for (const argument of value.def?.args ?? []) {
      if (argument.value === target) argument.value = shared;
    }
  }
  const resolved = identityOf(ir);
  assert.equal(resolved.valid, true);
  assert.equal(resolved.identity.semanticIrId, baseline.identity.semanticIrId);
  assert.equal(descriptorReads, 1);
  assert.equal(ordinaryReads, 0);
});

test('non-null semantic references and required nodes cannot collapse to absence', () => {
  for (const malformed of [Symbol('condition'), {}, () => 1]) {
    const ir = identityFixture('c2-02-malformed-reference');
    const branch = ir.blocks.flatMap((block) => block.insts)
      .find((instruction) => Object.hasOwn(instruction, 'conditionValue'));
    branch.conditionValue = malformed;
    assert.equal(identityOf(ir).valid, false);
  }

  for (const malformed of [Symbol('definition'), 'definition', () => 1]) {
    const ir = identityFixture('c2-02-malformed-definition');
    ir.values.find((value) => value.def != null).def = malformed;
    assert.equal(identityOf(ir).valid, false);
  }
  const optional = identityFixture('c2-02-optional-definition');
  optional.values.find((value) => value.def != null).def = null;
  assert.equal(identityOf(optional).valid, true);

  for (const key of ['blocks', 'values']) {
    const ir = identityFixture(`c2-02-malformed-root-${key}`);
    ir[key][0] = null;
    assert.equal(identityOf(ir).valid, false);
  }
});

test('reference aliases skip null candidates but reject missing required identities', () => {
  const ir = identityFixture('c2-02-reference-alias-fallthrough');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  definition.reachingStore = { instructionId:null, id:7 };
  const first = identityOf(ir);
  assert.equal(first.valid, true);
  definition.reachingStore.id = 8;
  const second = identityOf(ir);
  assert.equal(second.valid, true);
  assert.notEqual(second.identity.semanticIrId, first.identity.semanticIrId);

  for (const malformed of [null, undefined, {}]) {
    const candidate = identityFixture('c2-02-required-list-reference');
    candidate.blocks[0].succ = [malformed];
    assert.equal(identityOf(candidate).valid, false);
  }
});

test('unknown-store barriers bind their nested instruction identity', () => {
  const ir = identityFixture('c2-02-unknown-store-barrier');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  const instructionTarget = { id:99 };
  const instruction = new Proxy(instructionTarget, { ownKeys() { return []; } });
  const barrierTarget = { inst:instruction };
  definition.unknownAliasBarrier = new Proxy(barrierTarget, { ownKeys() { return []; } });

  const before = identityOf(ir);
  instructionTarget.id = 100;
  const after = identityOf(ir);
  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.notEqual(after.identity.semanticIrId, before.identity.semanticIrId);

  definition.unknownAliasBarrier = { inst:'instruction:100' };
  assert.equal(identityOf(ir).valid, false,
    'a malformed nested instruction reference must fail closed');
});

test('present semantic lists cannot collapse to absent lists', () => {
  const selectors = [
    (ir) => [ir, 'blocks'],
    (ir) => [ir, 'values'],
    (ir) => [ir, 'instructions'],
    (ir) => [ir.blocks[0], 'succ'],
    (ir) => [ir.blocks[0], 'pred'],
    (ir) => [ir.blocks[0], 'successorEdges'],
    (ir) => [ir.blocks[0], 'insts'],
    (ir) => [ir.blocks[0], 'phis'],
    (ir) => [ir.values.find((value) => value.def?.args?.length > 0).def, 'args'],
    (ir) => [ir.values.find((value) => value.def?.incoming?.length > 0).def, 'incoming'],
  ];
  for (const malformed of [null, undefined]) {
    for (const [index, select] of selectors.entries()) {
      const ir = identityFixture(`c2-02-present-list-${index}`);
      const [owner, key] = select(ir);
      owner[key] = malformed;
      assert.equal(identityOf(ir).valid, false, `${key}:${String(malformed)} must fail closed`);
    }
  }

  const absent = identityFixture('c2-02-absent-compatible-lists');
  delete absent.instructions;
  delete absent.blocks[0].memPhis;
  assert.equal(identityOf(absent).valid, true);
});

test('required list elements reject null and empty semantic nodes', () => {
  const selectors = [
    (ir) => ir.blocks[0].insts,
    (ir) => ir.blocks[3].phis,
  ];
  for (const malformed of [null, {}]) {
    for (const [index, select] of selectors.entries()) {
      const ir = identityFixture(`c2-02-required-node-${index}`);
      select(ir)[0] = malformed;
      assert.equal(identityOf(ir).valid, false);
    }
    const memoryPhiIr = identityFixture('c2-02-required-memory-phi');
    memoryPhiIr.blocks[0].memPhis = [malformed];
    assert.equal(identityOf(memoryPhiIr).valid, false);
  }

  for (const key of ['memDefs', 'memKills']) {
    for (const malformed of [null, {}]) {
      const f = fixture('c2-02-required-memory-node');
      f.block(0);
      const loaded = f.load(8, { locKey:'slot' });
      f.ret();
      const ir = f.build();
      loaded.def[key] = [malformed];
      assert.equal(identityOf(ir).valid, false, `${key} elements are required semantic nodes`);
    }
  }
});

test('present loop metadata must retain its required list shape', () => {
  for (const key of ['loops', 'backEdges']) {
    for (const malformed of [null, undefined, {}, 'not-a-list']) {
      const ir = identityFixture(`c2-02-malformed-${key}`);
      ir[key] = malformed;
      assert.equal(identityOf(ir).valid, false);
    }
  }
  const absent = identityFixture('c2-02-absent-loop-metadata');
  delete absent.loops;
  delete absent.backEdges;
  assert.equal(identityOf(absent).valid, true);
});

test('canonical identity never retries a descriptor rejected by the strict digester', () => {
  const ir = identityFixture('c2-02-one-shot-descriptor');
  const definition = ir.values.find((value) => value.def?.op === 'bin').def;
  let descriptorReads = 0;
  definition.extra = new Proxy({ state:'semantic' }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'state' && descriptorReads++ === 0) {
        return {
          get() { throw new Error('an accessor must never execute'); },
          enumerable:true,
          configurable:true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.equal(identityOf(ir).valid, false,
    'a first strict rejection cannot be laundered through a second projection walk');
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

test('memory incoming wrappers are strict semantic projections', () => {
  const memoryIr = (incoming) => {
    const f = fixture('c2-02-memory-incoming-identity');
    f.block(0);
    const loaded = f.load(8, { locKey:'slot' });
    f.ret();
    const ir = f.build();
    loaded.def.memUse = { definitionId:'memory-1', incoming:[incoming] };
    return ir;
  };

  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'from', {
    get() { getterReads += 1; return 0; },
    enumerable:true,
    configurable:true,
  });
  assert.equal(identityOf(memoryIr(accessor)).valid, false);
  assert.equal(getterReads, 0, 'identity validation must never execute an incoming-edge accessor');

  for (const mutate of [
    (edge) => Object.defineProperty(edge, 'hidden', { value:true, enumerable:false }),
    (edge) => { edge[Symbol('hidden')] = true; },
  ]) {
    const edge = { from:0, definitionId:'memory-0' };
    mutate(edge);
    assert.equal(identityOf(memoryIr(edge)).valid, false,
      'hidden incoming-edge metadata must fail closed');
  }

  const edge = { from:0, definitionId:'memory-0', proof:{ state:'before' } };
  const ir = memoryIr(edge);
  const before = identityOf(ir);
  edge.proof.state = 'after';
  const after = identityOf(ir);
  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.notEqual(before.identity.semanticIrId, after.identity.semanticIrId,
    'enumerable incoming-edge metadata must participate in identity');

  for (const malformedNode of [Symbol('node'), {}, () => 1]) {
    const malformed = memoryIr({ from:0, node:malformedNode });
    assert.equal(identityOf(malformed).valid, false,
      'a present memory reference must not collapse to an absent definition ID');
  }

  const primitiveNode = memoryIr({ from:0, node:'memory-0' });
  assert.equal(identityOf(primitiveNode).valid, true,
    'a primitive memory reference is itself a typed ID');

  const conflicting = { from:0, node:{ definitionId:'node-id' }, definitionId:'edge-id' };
  const conflictIr = memoryIr(conflicting);
  const beforeConflict = identityOf(conflictIr);
  conflicting.definitionId = 'changed-edge-id';
  const afterConflict = identityOf(conflictIr);
  assert.equal(beforeConflict.valid, true);
  assert.equal(afterConflict.valid, true);
  assert.notEqual(beforeConflict.identity.semanticIrId, afterConflict.identity.semanticIrId,
    'node and edge definition IDs are distinct semantic inputs even when both are present');
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
