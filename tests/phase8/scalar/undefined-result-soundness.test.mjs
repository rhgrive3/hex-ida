import assert from 'node:assert/strict';
import test from 'node:test';

import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { isFull } from '../../../js/decompiler/phase8/range.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

const descriptors = Object.freeze([
  { schemaVersion: 'machine-effects-undefined-result/v1', widthBits: 8, mask: '0xff', class: 'fully', reason: 'fully-undefined' },
  { schemaVersion: 'machine-effects-undefined-result/v1', widthBits: 8, mask: '0x80', class: 'conditional', reason: 'conditional-undefined', condition: { kind: 'divisor-zero', operandIndex: 1 } },
  { schemaVersion: 'machine-effects-undefined-result/v1', widthBits: 8, mask: '0xf0', class: 'partial', reason: 'partial-undefined' },
  { schemaVersion: 'machine-effects-undefined-result/v1', widthBits: 8, mask: '0x0f', class: 'operand-dependent', reason: 'operand-dependent-undefined', condition: { kind: 'count-at-least-width', operandIndex: 1 } },
]);

const PASS = { descriptor: SCCP_PASS, run: runSccpPass };

function analyze(ir) {
  const state = seedAnalysisState(ir);
  const outcome = runPassTransaction(state, PASS, { analysis: state, ir }, {});
  assert.equal(outcome.committed, true);
  return state.get('ranges');
}

function assertUnknownFull(facts, value) {
  assert.equal(facts.constants.has(value.id), false);
  assert.equal(isFull(facts.ranges.get(value.id)), true);
  assert.match(facts.overdefinedReasons.get(value.id) ?? '', /architecturally undefined result bits/);
}

for (const undefinedResult of descriptors) {
  test(`SCCP never folds the ${undefinedResult.class} undefined-result class`, () => {
    const f = fixture(`undefined-result-${undefinedResult.class}`);
    f.block(0);
    const value = f.binary('add', f.constant(1n, 8), f.constant(2n, 8), 8);
    value.def.extra = {
      ...(value.def.extra ?? {}),
      attributes: { machineEffects: { undefinedResult } },
    };
    f.ret();
    assertUnknownFull(analyze(f.build()), value);
  });
}

test('malformed descriptors fail closed instead of enabling a constant', () => {
  for (const [name, malformed] of [
    ['empty', {}], ['primitive', 'invalid-descriptor'], ['null', null], ['undefined', undefined],
  ]) {
    const f = fixture(`malformed-undefined-result-${name}`);
    f.block(0);
    const value = f.binary('add', f.constant(1n, 8), f.constant(2n, 8), 8);
    value.def.extra = { undefinedResult: malformed };
    f.ret();
    assertUnknownFull(analyze(f.build()), value);
  }
});

test('all v1 descriptor locations fail closed', () => {
  for (const location of ['semantic-attributes', 'compat-extra', 'direct-top-level']) {
    const f = fixture(`undefined-result-location-${location}`);
    f.block(0);
    const value = f.binary('add', f.constant(1n, 8), f.constant(2n, 8), 8);
    const marker = descriptors[2];
    if (location === 'semantic-attributes') value.def.extra = { attributes: { machineEffects: { undefinedResult: marker } } };
    if (location === 'compat-extra') value.def.extra = { undefinedResult: marker };
    if (location === 'direct-top-level') value.def.undefinedResult = marker;
    f.ret();
    assertUnknownFull(analyze(f.build()), value);
  }
});

test('own null and undefined markers fail closed at every v1 descriptor location', () => {
  for (const marker of [null, undefined]) {
    for (const location of ['semantic-attributes', 'compat-extra', 'direct-top-level']) {
      const f = fixture(`malformed-presence-${String(marker)}-${location}`);
      f.block(0);
      const value = f.binary('add', f.constant(1n, 8), f.constant(2n, 8), 8);
      if (location === 'semantic-attributes') value.def.extra = { attributes:{ machineEffects:{ undefinedResult:marker } } };
      if (location === 'compat-extra') value.def.extra = { undefinedResult:marker };
      if (location === 'direct-top-level') value.def.undefinedResult = marker;
      f.ret();
      assertUnknownFull(analyze(f.build()), value);
    }
  }
});

test('undefined input uncertainty cannot narrow through a dependent operation or phi', () => {
  const f = fixture('undefined-result-propagation');
  f.block(0).conditionalBranch(f.opaque(1), 1, 2);
  f.block(1);
  const uncertain = f.binary('add', f.constant(1n, 8), f.constant(2n, 8), 8);
  uncertain.def.extra = { attributes: { machineEffects: { undefinedResult: descriptors[2] } } };
  const dependent = f.binary('add', uncertain, f.constant(1n, 8), 8);
  f.branch(3);
  f.block(2);
  const other = f.constant(4n, 8);
  f.branch(3);
  f.block(3);
  const merged = f.phi([[1, dependent], [2, other]], 8);
  f.ret();

  const facts = analyze(f.build());
  assertUnknownFull(facts, uncertain);
  assert.equal(facts.constants.has(dependent.id), false);
  assert.equal(isFull(facts.ranges.get(dependent.id)), true);
  assert.equal(facts.constants.has(merged.id), false);
  assert.equal(isFull(facts.ranges.get(merged.id)), true);
});

test('descriptor-free exact arithmetic still folds exactly', () => {
  const f = fixture('undefined-result-exact-control');
  f.block(0);
  const value = f.binary('add', f.constant(1n, 8), f.constant(2n, 8), 8);
  f.ret();
  const facts = analyze(f.build());
  assert.equal(facts.constants.get(value.id)?.value, 3n);
  assert.equal(facts.constants.get(value.id)?.bits, 8);
});
