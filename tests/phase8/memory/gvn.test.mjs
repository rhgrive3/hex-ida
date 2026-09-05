import assert from 'node:assert/strict';
import test from 'node:test';

import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import {
  GVN_PASS,
  loadIsReusable,
  memoryVersionKey,
  runGvnPass,
} from '../../../js/decompiler/phase8/valuenumber.js';
import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

/**
 * The GVN contract. Every negative case here is a shape that looks like the
 * positive one and is not it: same operator with a different width, the same
 * location behind a barrier, the same call twice. A pass that cannot tell those
 * apart is a pass that rewrites one computation into another.
 */

function analyze(ir) {
  const state = seedAnalysisState(ir);
  const context = { analysis: state, ir };
  runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, context, {});
  const outcome = runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, context, {});
  return { outcome, facts: state.get('valueNumbers'), state };
}

function analyzeWithScalarFacts(ir, facts) {
  const state = seedAnalysisState(ir);
  const resolvedAnalysisIdentity = canonicalAnalysisIdentity({ ir });
  assert.equal(resolvedAnalysisIdentity.valid, true);
  state.__write('ranges', Object.freeze({
    completeness:'complete',
    identity:resolvedAnalysisIdentity.identity,
    facts,
    constants:new Map(),
  }));
  const outcome = runPassTransaction(state, { descriptor:GVN_PASS, run:runGvnPass }, {
    analysis:state,
    ir,
    resolvedAnalysisIdentity,
  }, {});
  assert.equal(outcome.committed, true);
  return { outcome, facts:state.get('valueNumbers'), state };
}

const congruent = (facts, left, right) => facts.numbers.get(left.id) === facts.numbers.get(right.id);

const VALID_IDENTITY = Object.freeze({
  binaryId: 'binary-b',
  functionId: 'function-f',
  snapshotId: 'snapshot-s',
  semanticIrId: 'semantic-ir-1',
  ssaId: 'ssa-1',
  analyzerVersion: 'phase8-test-1',
});

test('the same computation over the same operands is one class', () => {
  const f = fixture('cse');
  f.block(0);
  const a = f.opaque(32);
  const b = f.opaque(32);
  const first = f.binary('add', a, b, 32);
  const second = f.binary('add', a, b, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), true);
  assert.equal(facts.reuseCandidates.some((entry) => entry.valueId === second.id && entry.reuseOf === first.id), true);
});

test('GVN refuses a scalar artifact with stale identity', () => {
  const f = fixture('gvn-stale-ranges');
  f.block(0);
  f.constant(7, 32);
  f.ret();
  const ir = f.build();
  const state = seedAnalysisState(ir);
  state.__write('ranges', Object.freeze({
    completeness: 'complete',
    identity: { ...VALID_IDENTITY, snapshotId: 'old-snapshot' },
    facts: new Map(),
    constants: new Map(),
  }));
  const outcome = runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, {
    analysis: state,
    ir,
    analysisIdentity: VALID_IDENTITY,
  }, {});
  assert.equal(outcome.committed, true);
  assert.equal(outcome.result.status, 'unsupported');
  assert.equal(state.get('valueNumbers'), null, 'stale scalar facts cannot feed a new value-number artifact');
});

test('a commutative operator is congruent with its operands swapped, a non-commutative one is not', () => {
  const f = fixture('commutative');
  f.block(0);
  const a = f.opaque(32);
  const b = f.opaque(32);
  const sum = f.binary('add', a, b, 32);
  const swappedSum = f.binary('add', b, a, 32);
  const difference = f.binary('sub', a, b, 32);
  const swappedDifference = f.binary('sub', b, a, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, sum, swappedSum), true);
  assert.equal(congruent(facts, difference, swappedDifference), false, 'a - b is not b - a');
});

test('the same operator at a different width is a different computation', () => {
  const f = fixture('width');
  f.block(0);
  const a = f.opaque(64);
  const narrow = f.cast('trunc', a, 32);
  const wide = f.copy(a, 64);
  const first = f.binary('add', narrow, narrow, 32);
  const second = f.binary('add', wide, wide, 64);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
});

test('two calls are never congruent, even with identical operands', () => {
  const f = fixture('calls');
  f.block(0);
  const first = f.call(32);
  const second = f.call(32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
  assert.match(facts.singletonReasons.get(second.id) ?? '', /different value each time/);
});

test('an unrepresented operation is never congruent', () => {
  const f = fixture('unknown');
  f.block(0);
  const first = f.unknown(32);
  const second = f.unknown(32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
});

/**
 * A load with every machine fact proved, spelled in the Semantic IR's own
 * vocabulary: knowledge is `true | false | 'unknown'`, ordering is one of
 * `relaxed | acquire | release | acq-rel | seq-cst | unknown`. Writing `'no'`
 * here would silently never match anything.
 */
const PROVED_LOAD = Object.freeze({
  locKey: 'field:root+0', addressSpace: 'memory', volatility: 'unknown', atomic: false, ordering: 'unknown',
  memDefs: ['store_1'], addressPrecise: true,
});

function provedLoad(f, resultBits, options = PROVED_LOAD, {
  accessBits = resultBits,
  endian = 'little',
  signed = false,
  alignment = null,
  addressValueId = 'address_1',
} = {}) {
  const value = f.load(resultBits, options);
  value.def.extra.size = Math.max(1, Math.ceil(accessBits / 8));
  value.def.extra.widthBits = accessBits;
  value.def.extra.signed = signed;
  value.def.extra.completeness = 'complete';
  value.def.extra.memoryAccess.widthBits = accessBits;
  value.def.extra.memoryAccess.endian = endian;
  value.def.extra.memoryAccess.alignment = alignment;
  value.def.extra.memoryAccess.addressExpr = { valueId:addressValueId };
  if (value.def.loc != null) value.def.loc.size = value.def.extra.size;
  return value;
}

function reusableLoadDefinition(key = 'location') {
  const accessBits = 32;
  const dst = { id:'loaded', kind:'def', bits:32, signed:null, const:null, uses:[] };
  const definition = {
    op:'load', sub:null, block:0, row:0, args:[],
    dst,
    loc:{ key, kind:'field', size:4, disp:null },
    memUse:{ memDefs:[{ inst:{ id:'store_1' } }] },
    extra:{
      size:4,
      widthBits:accessBits,
      signed:false,
      completeness:'complete',
      addressPrecise:true,
      memoryAccess:{
        addressSpace:'memory',
        addressExpr:{ valueId:'address_1' },
        widthBits:accessBits,
        endian:'little',
        alignment:null,
        atomic:false,
        ordering:'unknown',
        volatility:'unknown',
        faults:[],
      },
    },
  };
  dst.def = definition;
  return definition;
}

test('two loads are reused only when the memory facts prove it', () => {
  const f = fixture('load-reuse');
  f.block(0);
  const first = provedLoad(f, 32);
  const second = provedLoad(f, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), true);
  const candidate = facts.reuseCandidates.find((entry) => entry.valueId === second.id);
  assert.ok(candidate, 'the proved case must produce a reuse candidate');
  assert.match(candidate.proof, /same reaching memory definitions/);
});

test('a changed memory version blocks load reuse', () => {
  // The near miss: same location, same width, different reaching store.
  const f = fixture('load-version');
  f.block(0);
  const first = provedLoad(f, 32);
  const second = provedLoad(f, 32, { ...PROVED_LOAD, memDefs: ['store_2'] });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
});

test('memory-version collection framing distinguishes one delimited ID from two IDs', () => {
  const f = fixture('load-version-list-framing');
  f.block(0);
  const first = provedLoad(f, 32, { ...PROVED_LOAD, memDefs:['a|b'] });
  const second = provedLoad(f, 32, { ...PROVED_LOAD, memDefs:['a', 'b'] });
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    'list boundaries must be part of the reaching-memory key');
  assert.equal(memoryVersionKey({ memUse:{ memDefs:[{ id:'a' }, { id:'b' }] } }),
    memoryVersionKey({ memUse:{ memDefs:[{ id:'b' }, { id:'a' }] } }),
    'reaching definitions remain order-independent');
  assert.equal(GVN_PASS.version, '1.0.3');
});

test('memory-version item framing distinguishes numeric and string IDs', () => {
  const f = fixture('load-version-type-framing');
  f.block(0);
  const first = provedLoad(f, 32, { ...PROVED_LOAD, memDefs:[1] });
  const second = provedLoad(f, 32, { ...PROVED_LOAD, memDefs:['1'] });
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    'different primitive ID types must never share a load class');
  assert.notEqual(
    memoryVersionKey({ memUse:{ memDefs:[{ id:1 }] } }),
    memoryVersionKey({ memUse:{ memDefs:[{ id:1n }] } }),
    'number and bigint IDs have distinct frames',
  );
  for (const unsupported of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.equal(memoryVersionKey({ memUse:{ memDefs:[{ id:unsupported }] } }), null);
  }
});

test('the outer load key frames location, width, and memory-version boundaries', () => {
  const f = fixture('load-outer-key-framing');
  f.block(0);
  const first = provedLoad(f, 32, {
    ...PROVED_LOAD,
    locKey:'x',
    memDefs:['64:memory-version:1:16:string:7:store_2'],
  });
  const second = provedLoad(f, 64, {
    ...PROVED_LOAD,
    locKey:'x:32:memory-version:1:49:string:39',
    memDefs:['store_2'],
  });
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    'field text cannot move across the location/width/memory-version boundaries');
  assert.equal(facts.reuseCandidates.some((entry) => entry.valueId === second.id), false);
});

test('load congruence binds access width, endian, and extension semantics', () => {
  const f = fixture('load-value-semantics');
  f.block(0);
  const first = provedLoad(f, 32, PROVED_LOAD, { accessBits:8, signed:false });
  const second = provedLoad(f, 32, PROVED_LOAD, { accessBits:8, signed:true });
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    '0x80 zero-extends and sign-extends to different 32-bit values');
  assert.equal(facts.reuseCandidates.some((entry) => entry.valueId === second.id), false);
});

test('load congruence binds address, alignment, volatility, fault, and completeness facts', () => {
  const variants = [
    {
      name:'address-expression',
      configure(value) { value.def.extra.memoryAccess.addressExpr.valueId = 'address_2'; },
    },
    {
      name:'alignment',
      configure(value) { value.def.extra.memoryAccess.alignment = 4; },
    },
    {
      name:'volatility-knowledge',
      configure(value) { value.def.extra.memoryAccess.volatility = false; },
    },
    {
      name:'fault',
      configure(value) { value.def.extra.memoryAccess.faults = [{ kind:'page-fault' }]; },
    },
    {
      name:'completeness',
      configure(value) { value.def.extra.completeness = 'partial'; },
    },
  ];
  for (const variant of variants) {
    const f = fixture(`load-${variant.name}`);
    f.block(0);
    const first = provedLoad(f, 32);
    const second = provedLoad(f, 32);
    variant.configure(second);
    f.ret();
    const { facts } = analyze(f.build());
    assert.equal(congruent(facts, first, second), false, variant.name);
    assert.equal(facts.reuseCandidates.some((entry) => entry.valueId === second.id), false,
      variant.name);
  }
});

test('structured location identities remain singleton load classes', () => {
  const f = fixture('load-structured-location-key');
  f.block(0);
  const locationKey = { namespace:'stack', slot:1 };
  const first = provedLoad(f, 32, { ...PROVED_LOAD, locKey:locationKey });
  const second = provedLoad(f, 32, { ...PROVED_LOAD, locKey:locationKey });
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    'GVN has no producer-owned equality contract for structured locations');
  assert.match(facts.singletonReasons.get(second.id) ?? '', /location identity/);
});

test('location identities retain their primitive type', () => {
  const f = fixture('load-location-key-type');
  f.block(0);
  const first = provedLoad(f, 32, { ...PROVED_LOAD, locKey:1 });
  const second = provedLoad(f, 32, { ...PROVED_LOAD, locKey:'1' });
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    'a numeric location is not the string spelling of that location');
});

test('unsupported location identities are rejected without coercion hooks', () => {
  let coercions = 0;
  const coercible = { toString() { coercions += 1; return 'same-location'; } };
  for (const key of [
    coercible,
    () => 'same-location',
    Symbol('same-location'),
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
  ]) {
    const reusable = loadIsReusable(reusableLoadDefinition(key));
    assert.equal(reusable.ok, false);
    assert.match(reusable.reason, /location identity/);
  }
  assert.equal(coercions, 0);
  for (const key of ['location', 1, 1n]) {
    assert.equal(loadIsReusable(reusableLoadDefinition(key)).ok, true,
      `${typeof key} is a supported primitive location identity`);
  }
});

test('scalar operation and sub-kind boundaries cannot collide', () => {
  const f = fixture('scalar-operation-key-framing');
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const first = f.binary('placeholder', left, right, 32);
  const second = f.binary('placeholder', left, right, 32);
  first.def.op = 'alpha/beta';
  first.def.sub = 'gamma';
  second.def.op = 'alpha';
  second.def.sub = 'beta/gamma';
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    'operator text cannot move across the operation/sub-kind boundary');
});

test('structured scalar sub-kinds remain singleton without string coercion', () => {
  const f = fixture('scalar-structured-sub-kind');
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const first = f.binary('placeholder', left, right, 32);
  const second = f.binary('placeholder', left, right, 32);
  first.def.sub = { operator:'first' };
  second.def.sub = { operator:'second' };
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
  assert.match(facts.singletonReasons.get(second.id) ?? '', /operation identity/);
});

test('structured scalar operation kinds remain singleton without string coercion', () => {
  const f = fixture('scalar-structured-operation-kind');
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const first = f.binary('placeholder', left, right, 32);
  const second = f.binary('placeholder', left, right, 32);
  first.def.op = { operation:'first' };
  first.def.sub = null;
  second.def.op = { operation:'second' };
  second.def.sub = null;
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
  assert.match(facts.singletonReasons.get(second.id) ?? '', /operation identity/);
});

test('produced widths retain their primitive type', () => {
  const f = fixture('scalar-width-type-framing');
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const first = f.binary('add', left, right, 32);
  const second = f.binary('add', left, right, 32);
  second.bits = '32';
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    'a malformed textual width cannot reuse a numeric-width result');
  assert.match(facts.singletonReasons.get(second.id) ?? '', /operation identity/);
});

test('malformed constant tuple components cannot create a congruent class', () => {
  const f = fixture('scalar-constant-key-framing');
  f.block(0);
  const first = f.unknown(32);
  const second = f.unknown(32);
  f.ret();
  const ir = f.build();
  const scalarFacts = new Map([
    [first.id, { status:'exact', constant:{ bits:32, value:1n } }],
    [second.id, { status:'exact', constant:{ bits:32, value:'1' } }],
  ]);

  const { facts } = analyzeWithScalarFacts(ir, scalarFacts);
  assert.equal(congruent(facts, first, second), false,
    'an untyped template cannot equate a bigint constant with malformed text');
  assert.match(facts.singletonReasons.get(second.id) ?? '', /constant identity/);
});

test('operand width and shift metadata are part of scalar congruence', () => {
  const f = fixture('scalar-operand-wrapper-semantics');
  f.block(0);
  const left = f.opaque(64);
  const right = f.opaque(64);
  const narrow = f.binary('add', left, right, 64);
  const wide = f.binary('add', left, right, 64);
  narrow.def.args[0].bits = 32;
  narrow.def.args[1].bits = 64;
  wide.def.args[0].bits = 64;
  wide.def.args[1].bits = 64;
  const plain = f.binary('add', left, right, 64);
  const shifted = f.binary('add', left, right, 64);
  shifted.def.args[1].shift = { op:'lsl', amount:1 };
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, narrow, wide), false,
    'operand-local truncation changes the computation even at the same result width');
  assert.equal(congruent(facts, plain, shifted), false,
    'an architecture-defined operand shift cannot disappear from the key');
});

test('legacy binary negate metadata is part of scalar congruence', () => {
  const f = fixture('scalar-bin-negate');
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const ordinary = f.binary('add', left, right, 32);
  const negated = f.binary('add', left, right, 32);
  negated.def.extra.negate = true;
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, ordinary, negated), false);
});

test('open-ended producer attributes keep scalar operations singleton', () => {
  const f = fixture('scalar-open-attributes');
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const ordinary = f.binary('add', left, right, 32);
  const saturating = f.binary('add', left, right, 32);
  ordinary.def.extra.attributes = { saturating:false };
  saturating.def.extra.attributes = { saturating:true };
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, ordinary, saturating), false,
    'an uncontracted producer metadata bag cannot be omitted from congruence');
  assert.match(facts.singletonReasons.get(saturating.id) ?? '', /operation identity/);
});

test('unmodeled top-level scalar modifiers keep operations singleton', () => {
  const f = fixture('scalar-top-level-modifiers');
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const first = f.binary('add', left, right, 32);
  const second = f.binary('add', left, right, 32);
  first.def.cond = 'eq';
  second.def.cond = 'ne';
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    'conditional execution cannot be omitted from a scalar equality proof');
  assert.match(facts.singletonReasons.get(second.id) ?? '', /operation identity/);
});

test('scalar congruence accepts only canonical definition and produced-value schemas', () => {
  const pair = (name, mutate) => {
    const f = fixture(`scalar-strict-schema-${name}`);
    f.block(0);
    const left = f.opaque(32);
    const right = f.opaque(32);
    const first = f.binary('add', left, right, 32);
    const second = f.binary('add', left, right, 32);
    mutate(first, second);
    f.ret();
    return { first, second, facts:analyze(f.build()).facts };
  };

  for (const [name, mutate] of [
    ['definition-extra-key', (first, second) => {
      first.def.semanticModifier = 'first';
      second.def.semanticModifier = 'second';
    }],
    ['value-extra-key', (first, second) => {
      first.semanticModifier = 'first';
      second.semanticModifier = 'second';
    }],
    ...['arg', 'phi', 'undef', 'unknown'].map((kind) => [
      `value-kind-${kind}`,
      (first, second) => { first.kind = kind; second.kind = kind; },
    ]),
  ]) {
    const { first, second, facts } = pair(name, mutate);
    assert.equal(congruent(facts, first, second), false, name);
    assert.match(facts.singletonReasons.get(second.id) ?? '',
      /operation identity|produced value/, name);
  }
});

test('complex scalar families remain singleton until their full semantics are represented', () => {
  const cases = [
    {
      name:'cmp-predicate', op:'cmp', sub:'sub',
      first:{ comparison:'eq', signed:false, float:false },
      second:{ comparison:'lt', signed:false, float:false },
    },
    {
      name:'cmp-conditional-nzcv', op:'cmp', sub:'sub',
      first:{ comparison:'eq', signed:true, float:false, conditional:true, cond:'eq', fallbackNzcv:4 },
      second:{ comparison:'eq', signed:true, float:false, conditional:true, cond:'ne', fallbackNzcv:0 },
    },
    { name:'bit-extract', op:'bfx', sub:'extract', first:{ lsb:0, width:8 }, second:{ lsb:8, width:8 } },
    { name:'bit-insert', op:'bfi', sub:'insert', first:{ lsb:0, width:8 }, second:{ lsb:0, width:16 } },
    { name:'multiply-widen', op:'mac', sub:'madd', first:{ widen:'signed' }, second:{ widen:'unsigned' } },
  ];
  for (const entry of cases) {
    const f = fixture(`scalar-${entry.name}`);
    f.block(0);
    const left = f.opaque(32);
    const right = f.opaque(32);
    const first = f.binary('add', left, right, 32);
    const second = f.binary('add', left, right, 32);
    Object.assign(first.def, { op:entry.op, sub:entry.sub, extra:entry.first });
    Object.assign(second.def, { op:entry.op, sub:entry.sub, extra:entry.second });
    f.ret();
    const { facts } = analyze(f.build());
    assert.equal(congruent(facts, first, second), false, entry.name);
    assert.match(facts.singletonReasons.get(second.id) ?? '', /operation identity/, entry.name);
  }
});

test('selection condition and state-read identity cannot be omitted from congruence', () => {
  const selection = fixture('scalar-selection-condition');
  selection.block(0);
  const left = selection.opaque(32);
  const right = selection.opaque(32);
  const firstCondition = selection.opaque(1);
  const secondCondition = selection.opaque(1);
  const first = selection.binary('add', left, right, 32);
  const second = selection.binary('add', left, right, 32);
  Object.assign(first.def, { op:'sel', sub:'sel', conditionValue:firstCondition, cond:'eq' });
  Object.assign(second.def, { op:'sel', sub:'sel', conditionValue:secondCondition, cond:'ne' });
  selection.ret();
  const selectionFacts = analyze(selection.build()).facts;
  assert.equal(congruent(selectionFacts, first, second), false);

  const state = fixture('scalar-state-read-identity');
  state.block(0);
  const r0 = state.stateWrite(32);
  const r1 = state.stateWrite(32);
  r0.def.extra = { stateRead:{ key:'r0' }, publicStateIdentity:'r0' };
  r1.def.extra = { stateRead:{ key:'r1' }, publicStateIdentity:'r1' };
  state.ret();
  const stateFacts = analyze(state.build()).facts;
  assert.equal(congruent(stateFacts, r0, r1), false);
});

test('float constants and non-bitvector machine types never reuse bitvector classes', () => {
  const f = fixture('scalar-machine-types');
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const integer = f.binary('add', left, right, 32);
  const vector = f.binary('add', left, right, 32);
  integer.machineType = { kind:'bitvector', widthBits:32 };
  vector.machineType = {
    kind:'vector', laneCount:4, elementType:{ kind:'bitvector', widthBits:8 },
  };
  const firstFloat = f.unknown(32);
  const secondFloat = f.unknown(32);
  Object.assign(firstFloat, { float:1.5, floatConst:1.5, constKind:'float' });
  Object.assign(secondFloat, { float:2.5, floatConst:2.5, constKind:'float' });
  Object.assign(firstFloat.def, { op:'const', sub:null, extra:{ float:1.5, constKind:'float' } });
  Object.assign(secondFloat.def, { op:'const', sub:null, extra:{ float:2.5, constKind:'float' } });
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, integer, vector), false);
  assert.equal(congruent(facts, firstFloat, secondFloat), false);
});

test('structured memory-definition IDs remain singletons', () => {
  const structuredId = { namespace:'store', value:1 };
  assert.equal(memoryVersionKey({
    memUse:{ memDefs:[{ inst:{ id:structuredId } }] },
  }), null, 'GVN must not invent equality for structured IDs');
  let coercions = 0;
  const coercibleId = { toString() { coercions += 1; return 'store'; } };
  assert.equal(memoryVersionKey({
    memUse:{ memDefs:[{ inst:{ id:coercibleId } }] },
  }), null);
  assert.equal(coercions, 0, 'unsupported IDs are rejected without invoking coercion hooks');
  assert.equal(memoryVersionKey({
    memUse:{ memDefs:[{ inst:{ id:'store:A' }, id:'store:B' }] },
  }), null, 'conflicting aliases cannot choose one untrusted memory identity');

  const f = fixture('load-version-structured-id');
  f.block(0);
  const first = provedLoad(f, 32, { ...PROVED_LOAD, memDefs:[structuredId] });
  const second = provedLoad(f, 32, { ...PROVED_LOAD, memDefs:[structuredId] });
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false,
    'unsupported memory IDs must conservatively block reuse');
  assert.match(facts.singletonReasons.get(second.id) ?? '', /not determined/);
});

test('hidden memDefs cannot be replaced by the lower-priority reaching alias', () => {
  const f = fixture('load-hidden-memory-version');
  f.block(0);
  const first = provedLoad(f, 32);
  const second = provedLoad(f, 32);
  f.ret();
  const ir = f.build();
  const target = {
    memDefs:[{ inst:{ id:'store_B' } }],
    reaching:[{ inst:{ id:'store_1' } }],
  };
  second.def.memUse = new Proxy(target, {
    ownKeys(object) { return Reflect.ownKeys(object).filter((key) => key !== 'memDefs'); },
  });

  const before = canonicalAnalysisIdentity({ ir });
  const { facts } = analyze(ir);
  assert.equal(congruent(facts, first, second), false,
    'the preferred hidden memDefs version must block reuse');
  target.memDefs[0].inst.id = 'store_C';
  const after = canonicalAnalysisIdentity({ ir });
  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.notEqual(before.identity.semanticIrId, after.identity.semanticIrId);
});

test('load congruence requires exact definition, location, address, and memory-use schemas', () => {
  const check = (name, mutate) => {
    const f = fixture(`load-strict-schema-${name}`);
    f.block(0);
    const first = provedLoad(f, 32);
    const second = provedLoad(f, 32);
    mutate(first.def, second.def);
    f.ret();
    const { facts } = analyze(f.build());
    assert.equal(congruent(facts, first, second), false, name);
  };

  check('unknown-definition-field', (first, second) => {
    first.semanticModifier = 'first';
    second.semanticModifier = 'second';
  });
  check('unknown-location-field', (first, second) => {
    first.loc.metadata = 'first';
    second.loc.metadata = 'second';
  });
  check('location-displacement', (first, second) => {
    first.loc.disp = 0n;
    second.loc.disp = 8n;
  });
  check('address-displacement', (first, second) => {
    first.addr = { base:null, index:null, disp:0n, scale:0 };
    second.addr = { base:null, index:null, disp:8n, scale:0 };
  });
  check('missing-completeness', (first, second) => {
    delete first.extra.completeness;
    delete second.extra.completeness;
  });
  check('unknown-location-kind', (first, second) => {
    first.loc.kind = 'unknown';
    second.loc.kind = 'unknown';
  });
  check('unknown-memory-alias', (first, second) => {
    first.memUse.unknownAlias = true;
    second.memUse.unknownAlias = true;
  });
  check('clobber-memory-use', (first, second) => {
    first.memUse.kind = 'clobber';
    second.memUse.kind = 'clobber';
  });
  check('conflicting-memory-aliases', (first, second) => {
    first.memUse.reaching = [{ inst:{ id:'store:A' } }];
    second.memUse.reaching = [{ inst:{ id:'store:B' } }];
  });
});

test('negative-zero and positive-zero value IDs remain separately addressable', () => {
  const f = fixture('gvn-typed-zero-ids');
  f.block(0);
  const negativeZero = f.opaque(32);
  const positiveZero = f.opaque(32);
  negativeZero.id = -0;
  positiveZero.id = 0;
  const fromNegativeZero = f.copy(negativeZero, 32);
  const fromPositiveZero = f.copy(positiveZero, 32);
  f.ret();

  const { facts } = analyzeWithScalarFacts(f.build(), new Map());
  assert.notEqual(facts.numbers.get(-0), facts.numbers.get(0),
    'the outward value-number map must not use SameValueZero ID equality');
  assert.equal(congruent(facts, fromNegativeZero, fromPositiveZero), false,
    'distinct zero-signed input IDs cannot collapse operand lookups');
});

test('negative-zero and positive-zero block IDs cannot authorize reuse', () => {
  const f = fixture('gvn-typed-zero-blocks');
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const first = f.binary('add', left, right, 32);
  const second = f.binary('add', left, right, 32);
  first.def.block = -0;
  second.def.block = 0;
  f.ret();

  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), true,
    'block identity does not change the computed scalar value');
  assert.equal(facts.reuseCandidates.some((entry) => entry.valueId === second.id), false,
    'SameValueZero dominance evidence cannot prove that distinct signed-zero blocks dominate');
});

test('an unknown store between the loads blocks reuse', () => {
  const f = fixture('load-barrier');
  f.block(0);
  const first = provedLoad(f, 32);
  const second = provedLoad(f, 32, { ...PROVED_LOAD, barrier: { id:'unknown-store', op:'store' } });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
  assert.match(facts.singletonReasons.get(second.id) ?? '', /unknown store/);
});

test('unknown atomicity, real ordering, device memory or known volatility each block reuse', () => {
  for (const [field, value, pattern] of [
    ['atomic', 'unknown', /atomicity is unknown/],
    ['atomic', true, /atomicity is yes/],
    ['ordering', 'acquire', /ordering/],
    ['ordering', 'seq-cst', /ordering/],
    ['addressSpace', 'device', /not ordinary memory/],
    ['volatility', true, /known to be volatile/],
  ]) {
    const f = fixture(`load-${field}-${value}`);
    f.block(0);
    const first = provedLoad(f, 32);
    const second = provedLoad(f, 32, { ...PROVED_LOAD, [field]: value });
    f.ret();
    const { facts } = analyze(f.build());
    assert.equal(congruent(facts, first, second), false, `${field}=${value} must block reuse`);
    assert.match(facts.singletonReasons.get(second.id) ?? '', pattern);
  }
});

test('unproved volatility does not block reuse, because it is not machine-recoverable', () => {
  // `volatile` is a source annotation. Demanding proof of its absence would make
  // load reuse unreachable on every stripped binary forever, rather than merely
  // until an upstream fact lands. What governs re-execution at machine level is
  // the address space, atomicity and ordering, and those are all proved above.
  const f = fixture('load-unknown-volatility');
  f.block(0);
  const first = provedLoad(f, 32);
  const second = provedLoad(f, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(PROVED_LOAD.volatility, 'unknown');
  assert.equal(congruent(facts, first, second), true);
});

test('the predicate uses the Semantic IR vocabulary, not an invented one', () => {
  // A predicate written against `'no'` or `'unordered'` compiles, runs, and
  // never matches anything the IR emits.
  const invented = reusableLoadDefinition('k');
  invented.extra.memoryAccess.atomic = 'no';
  invented.extra.memoryAccess.ordering = 'unordered';
  assert.equal(loadIsReusable(invented).ok, false,
    "'no' is not a value the Semantic IR ever produces for atomicity");
  assert.equal(loadIsReusable(reusableLoadDefinition('k')).ok, true);
  const noncanonicalRelaxed = reusableLoadDefinition('k');
  noncanonicalRelaxed.extra.memoryAccess.ordering = 'relaxed';
  assert.equal(loadIsReusable(noncanonicalRelaxed).ok, false,
    'atomic=false with relaxed ordering is not a canonical Semantic IR access');
});

test('an imprecise address blocks reuse', () => {
  const f = fixture('load-imprecise');
  f.block(0);
  const first = provedLoad(f, 32);
  const second = provedLoad(f, 32, { ...PROVED_LOAD, addressPrecise: false });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
  assert.match(facts.singletonReasons.get(second.id) ?? '', /address is not proved precise/);
});

test('reuse requires the earlier definition to dominate the later one', () => {
  // Both arms compute the same expression, but neither dominates the other, so
  // neither may be replaced by the other.
  const f = fixture('dominance');
  f.block(0);
  const a = f.opaque(32);
  const b = f.opaque(32);
  f.conditionalBranch(f.opaque(1), 1, 2);
  f.block(1);
  const left = f.binary('add', a, b, 32);
  f.branch(3);
  f.block(2);
  const right = f.binary('add', a, b, 32);
  f.branch(3);
  f.block(3).ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, left, right), true, 'they are the same computation');
  assert.equal(facts.reuseCandidates.some((entry) => entry.valueId === right.id), false,
    'but neither block dominates the other, so neither may be reused');
});

test('every proved constant of the same width is one class, however it was produced', () => {
  const f = fixture('constants');
  f.block(0);
  const direct = f.constant(7n, 32);
  const computed = f.binary('add', f.constant(3n, 32), f.constant(4n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, direct, computed), true);
});

test('the pass refuses to run before the facts it consumes exist', () => {
  const f = fixture('no-sccp');
  f.block(0);
  f.binary('add', f.opaque(32), f.opaque(32), 32);
  f.ret();
  const state = seedAnalysisState(f.build());
  const outcome = runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, { analysis: state }, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^missing-input:.*ranges/);
});

test('the load reusability predicate answers with a reason, never a bare false', () => {
  assert.equal(loadIsReusable(reusableLoadDefinition('k')).ok, true);
  const refused = loadIsReusable({ extra: {} });
  assert.equal(refused.ok, false);
  assert.ok(refused.reason.length > 0);
});
