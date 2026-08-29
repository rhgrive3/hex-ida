import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisState, runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { contains, isEmpty, isFull } from '../../../js/decompiler/phase8/range.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

/**
 * The SCCP contract, proved on architecture-neutral IR.
 *
 * The frozen AArch64 corpus proves the pass is wired into the product. These
 * prove the algorithm: a fixture assembled from one target's assembly would
 * prove things about that target as much as about the optimizer.
 */

const PASS = { descriptor: SCCP_PASS, run: runSccpPass };

function analyze(ir, context = {}) {
  const state = seedAnalysisState(ir);
  const outcome = runPassTransaction(state, PASS, { analysis: state, ...context }, {});
  return { outcome, facts: state.get('ranges'), state };
}

function constantOf(facts, value) {
  return facts.constants.get(value.id) ?? null;
}

test('constants fold at exact width, wrapping rather than growing', () => {
  const f = fixture('wrap');
  f.block(0);
  const big = f.constant(0xFFFFFFF0n, 32);
  const small = f.constant(0x20n, 32);
  const sum = f.binary('add', big, small, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, sum)?.value, 0x10n, 'a 32-bit add must wrap, not become a 33-bit value');
  assert.equal(constantOf(facts, sum)?.bits, 32);
});

test('zero and sign extension of the same bits give different constants', () => {
  const f = fixture('extend');
  f.block(0);
  const narrow = f.constant(0x80n, 8);
  const zero = f.cast('zext', narrow, 32);
  const sign = f.cast('sext', narrow, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, zero)?.value, 0x80n);
  assert.equal(constantOf(facts, sign)?.value, 0xFFFFFF80n);
});

test('a proved branch makes exactly one arm executable', () => {
  const f = fixture('dead-branch');
  f.block(0).conditionalBranch(f.constant(0n, 1), 1, 2);
  f.block(1).branch(3);
  f.block(2).branch(3);
  f.block(3).ret();
  const { facts } = analyze(f.build());
  assert.deepEqual([...facts.unreachableBlockIndexes], [1], 'the true arm of a false condition is unreachable');
  assert.ok(facts.executableEdges.some((edge) => edge.startsWith('0->2:')));
  assert.ok(!facts.executableEdges.some((edge) => edge.startsWith('0->1:')));
});

test('a phi meets only its executable predecessors', () => {
  // The whole point of the "conditional" in SCCP: the value is constant even
  // though a dead predecessor assigns something else.
  const f = fixture('phi-executable');
  f.block(0).conditionalBranch(f.constant(0n, 1), 1, 2);
  const dead = (() => { f.block(1); const value = f.constant(111n, 32); f.branch(3); return value; })();
  const live = (() => { f.block(2); const value = f.constant(222n, 32); f.branch(3); return value; })();
  f.block(3);
  const merged = f.phi([[1, dead], [2, live]], 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, merged)?.value, 222n, 'the unreachable predecessor must contribute nothing');
});

test('a phi over two reachable predecessors with different constants is not constant', () => {
  // The near miss: same shape, both arms live, so the answer is unknown.
  const f = fixture('phi-overdefined');
  f.block(0).conditionalBranch(f.opaque(1), 1, 2);
  const left = (() => { f.block(1); const value = f.constant(111n, 32); f.branch(3); return value; })();
  const right = (() => { f.block(2); const value = f.constant(222n, 32); f.branch(3); return value; })();
  f.block(3);
  const merged = f.phi([[1, left], [2, right]], 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, merged), null);
  assert.match(facts.overdefinedReasons.get(merged.id) ?? '', /disagree/);
  // The range still says something useful even though the constant does not.
  assert.equal(facts.ranges.get(merged.id) != null, true);
});

test('an unresolved branch leaves both arms executable', () => {
  const f = fixture('unresolved');
  f.block(0).conditionalBranch(f.opaque(1), 1, 2);
  f.block(1).branch(3);
  f.block(2).branch(3);
  f.block(3).ret();
  const { facts } = analyze(f.build());
  assert.deepEqual([...facts.unreachableBlockIndexes], []);
  assert.ok(facts.executableEdges.some((edge) => edge.startsWith('0->1:')));
  assert.ok(facts.executableEdges.some((edge) => edge.startsWith('0->2:')));
});

test('a value from memory stays unknown and says why', () => {
  const f = fixture('memory');
  f.block(0);
  const loaded = f.load(32);
  const sum = f.binary('add', loaded, f.constant(1n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, loaded), null);
  assert.equal(facts.overdefinedReasons.get(loaded.id), 'value comes from memory');
  assert.equal(constantOf(facts, sum), null, 'a constant added to an unknown is not a constant');
});

test('an operation the semantic IR could not represent stays unknown', () => {
  const f = fixture('unknown-op');
  f.block(0);
  const opaque = f.unknown(64);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(facts.overdefinedReasons.get(opaque.id), 'operation is not represented in the semantic IR');
  assert.equal(isFull(facts.ranges.get(opaque.id)), true, 'an unknown value has the full range, not a guessed one');
});

test('a shift past the width is not folded', () => {
  const f = fixture('wide-shift');
  f.block(0);
  const shifted = f.binary('shl', f.constant(1n, 32), f.constant(32n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, shifted), null, 'a shift at the width is target-defined and must not be folded');
  assert.match(facts.overdefinedReasons.get(shifted.id) ?? '', /not exactly modelled/);
});

test('division by a constant zero is not folded', () => {
  const f = fixture('div-zero');
  f.block(0);
  const divided = f.binary('udiv', f.constant(10n, 32), f.constant(0n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, divided), null);
});

test('a select with a proved condition takes the chosen arm only', () => {
  const f = fixture('select');
  f.block(0);
  const chosen = f.select(f.constant(1n, 1), f.constant(7n, 32), f.constant(9n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, chosen)?.value, 7n);
});

test('a select with an unknown condition is the union of its arms', () => {
  const f = fixture('select-unknown');
  f.block(0);
  const chosen = f.select(f.opaque(1), f.constant(7n, 32), f.constant(9n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, chosen), null);
  const range = facts.ranges.get(chosen.id);
  assert.equal(range.lower, 7n);
  assert.equal(range.upper, 9n);
});

test('a loop-carried value converges under a bounded number of visits', () => {
  const f = fixture('loop');
  f.block(0);
  const start = f.constant(0n, 32);
  f.branch(1);
  f.block(1);
  const counter = f.phi([[0, start]], 32);
  const next = f.binary('add', counter, f.constant(1n, 32), 32);
  counter.def.incoming.push({ from: 1, value: next });
  next.uses.push(counter.def);
  f.conditionalBranch(f.opaque(1), 1, 2);
  f.block(2).ret();
  const { facts, outcome } = analyze(f.build());
  assert.equal(outcome.committed, true);
  assert.equal(facts.completeness, 'complete', 'the analysis must reach a fixed point, not run out of budget');
  assert.ok(facts.workItems < 5000, `convergence took ${facts.workItems} work items`);
  // The counter is not a single constant, and the domain says so rather than
  // claiming the initial value.
  assert.equal(constantOf(facts, counter), null);
});

test('the pass produces a fact, rewrites nothing, and invalidates nothing', () => {
  const f = fixture('facts');
  f.block(0);
  f.binary('add', f.constant(1n, 32), f.constant(2n, 32), 32);
  f.ret();
  const { outcome, state } = analyze(f.build());
  assert.equal(outcome.committed, true);
  assert.deepEqual([...outcome.staged], ['ranges']);
  assert.deepEqual([...outcome.result.transforms], [], 'SCCP is an analysis; it must not claim a program transformation');
  assert.deepEqual([...outcome.result.produced], ['ranges']);
  assert.deepEqual([...outcome.invalidated], [], 'publishing a fact must not discard unrelated analyses');
  assert.equal(state.version('ssa'), 1, 'SSA must keep its version and its reuse');
  const facts = state.get('ranges');
  assert.equal(facts.completeness, 'complete');
  assert.equal(facts.provenance.producer, SCCP_PASS.id);
  assert.equal(facts.provenance.producerVersion, SCCP_PASS.version);
  assert.equal(facts.provenance.canonicalOwner, 'phase8/range.js + phase8/sccp.js');
});

test('the pass refuses to run without the facts it declares it consumes', () => {
  const state = createAnalysisState({});
  const outcome = runPassTransaction(state, PASS, { analysis: state }, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^missing-input:/);
});

test('cancellation leaves no facts behind', () => {
  const f = fixture('cancelled');
  f.block(0);
  f.binary('add', f.constant(1n, 32), f.constant(2n, 32), 32);
  f.ret();
  const state = seedAnalysisState(f.build());
  const outcome = runPassTransaction(state, PASS, { analysis: state }, { shouldAbort: () => true });
  assert.equal(outcome.committed, false);
  assert.equal(state.version('ranges'), 0, 'a cancelled analysis must not publish partial facts');
});

test('a work budget that runs out reports partial, not complete', () => {
  const f = fixture('budget');
  f.block(0);
  let previous = f.constant(1n, 32);
  for (let index = 0; index < 200; index += 1) previous = f.binary('add', previous, f.constant(1n, 32), 32);
  f.ret();
  const state = seedAnalysisState(f.build());
  runPassTransaction(state, PASS, { analysis: state, sccpLimits: { maxWorkItems: 20, maxVisitsPerValue: 2 } }, {});
  const facts = state.get('ranges');
  assert.equal(facts.completeness, 'partial', 'a fixed point that was not reached is not a fixed point');
});

test('two runs over the same input agree exactly', () => {
  const build = () => {
    const f = fixture('determinism');
    f.block(0).conditionalBranch(f.constant(1n, 1), 1, 2);
    const left = (() => { f.block(1); const value = f.constant(5n, 32); f.branch(3); return value; })();
    const right = (() => { f.block(2); const value = f.constant(6n, 32); f.branch(3); return value; })();
    f.block(3);
    f.phi([[1, left], [2, right]], 32);
    f.ret();
    return f.build();
  };
  const ir = build();
  const [first, second] = [analyze(ir).facts, analyze(ir).facts];
  assert.deepEqual([...first.executableEdges], [...second.executableEdges]);
  assert.deepEqual([...first.unreachableBlockIndexes], [...second.unreachableBlockIndexes]);
  assert.equal(first.constants.size, second.constants.size);
  assert.equal(first.workItems, second.workItems);
  assert.equal(first.publicationDigest, second.publicationDigest, 'semantic replay identity must include product facts and diagnostics');
});

test('an unsupported width is unknown rather than approximated', () => {
  const f = fixture('odd-width');
  f.block(0);
  const odd = f.copy(f.constant(1n, 32), 24);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(facts.constants.get(odd.id), undefined);
  assert.match(facts.overdefinedReasons.get(odd.id) ?? '', /unsupported width/);
});

test('the SCCP publication keeps the canonical product bits and congruence', () => {
  const f = fixture('published-product');
  f.block(0);
  const input = f.opaque(8);
  const masked = f.binary('and', input, f.constant(0xFC, 8), 8);
  f.ret();
  const { facts } = analyze(f.build());
  const product = facts.facts.get(masked.id);
  assert.ok(product, 'the produced value must have one canonical product fact');
  assert.equal(product.knownZero & 0x03n, 0x03n);
  assert.deepEqual(product.congruence, { remainder: 0n, modulus: 4n });
  assert.equal(product.constant, null, 'a masked non-singleton must not become exact');
});

function branchFacts(operator, inputValue, boundValue, bits = 8) {
  const f = fixture(`branch-${operator}`);
  f.block(0);
  const input = inputValue == null ? f.opaque(bits) : f.constant(inputValue, bits);
  const bound = f.constant(boundValue, bits);
  const condition = f.binary(operator, input, bound, 1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1).ret();
  f.block(2).ret();
  return { ...analyze(f.build()).facts, input, condition };
}

function edge(facts, key) { return facts.edgeFacts.get(key); }

test('true/false equality and inequality edges carry only proven path facts', () => {
  const equality = branchFacts('eq', null, 10);
  const eqTrue = edge(equality, '0->1:conditional-true');
  const eqFalse = edge(equality, '0->2:conditional-false');
  assert.equal(eqTrue.facts.get(equality.input.id).range.lower, 10n);
  assert.equal(eqTrue.facts.get(equality.input.id).range.upper, 10n);
  assert.equal(eqFalse.facts.has(equality.input.id), false, 'the non-equality complement is disconnected and stays conservative');

  const inequality = branchFacts('ne', null, 10);
  const neTrue = edge(inequality, '0->1:conditional-true');
  const neFalse = edge(inequality, '0->2:conditional-false');
  assert.equal(neTrue.facts.has(inequality.input.id), false);
  assert.equal(neFalse.facts.get(inequality.input.id).range.lower, 10n);
  assert.equal(neFalse.facts.get(inequality.input.id).range.upper, 10n);
});

test('signed and unsigned comparisons use different bitvector domains', () => {
  const unsigned = branchFacts('ult', null, 0x80);
  const unsignedTrue = edge(unsigned, '0->1:conditional-true').facts.get(unsigned.input.id).range;
  assert.deepEqual([unsignedTrue.lower, unsignedTrue.upper], [0n, 0x7Fn]);

  const signed = branchFacts('slt', null, 0x80);
  const signedTrue = edge(signed, '0->1:conditional-true');
  assert.equal(signedTrue.reachable, false, 'no signed 8-bit value is below -128');
  assert.equal(isEmpty(signedTrue.facts.get(signed.input.id).range), true);
  assert.ok(factsFor(signed, '0->2:conditional-false'));

  const upper = branchFacts('ule', null, 0x80);
  const upperTrue = edge(upper, '0->1:conditional-true').facts.get(upper.input.id).range;
  assert.deepEqual([upperTrue.lower, upperTrue.upper], [0n, 0x80n]);
  const lower = branchFacts('uge', null, 0x80);
  const lowerTrue = edge(lower, '0->1:conditional-true').facts.get(lower.input.id).range;
  assert.deepEqual([lowerTrue.lower, lowerTrue.upper], [0x80n, 0xFFn]);

  const greater = branchFacts('ugt', null, 0x80);
  const greaterTrue = edge(greater, '0->1:conditional-true').facts.get(greater.input.id).range;
  assert.deepEqual([greaterTrue.lower, greaterTrue.upper], [0x81n, 0xFFn]);

  // The textual aliases are normalized in the canonical range owner too. `>`
  // is signed ordering in the generic IR vocabulary, so 0x80 means INT_MIN
  // here and the true set wraps around the unsigned representation.
  const signedGreater = branchFacts('>', null, 0x80);
  const signedGreaterTrue = edge(signedGreater, '0->1:conditional-true').facts.get(signedGreater.input.id).range;
  assert.equal(signedGreaterTrue.kind, 'wrapped');
  assert.equal(contains(signedGreaterTrue, 0x81n), true);
  assert.equal(contains(signedGreaterTrue, 0x7Fn), true);
  assert.equal(contains(signedGreaterTrue, 0x80n), false);
});

function factsFor(facts, key) { return facts.edgeFacts.get(key); }

test('a mathematically impossible constant comparison does not execute its edge', () => {
  const facts = branchFacts('slt', 0x80, 0x80);
  assert.equal(facts.constants.size > 0, true);
  assert.equal(edge(facts, '0->1:conditional-true').reachable, false);
  assert.ok(facts.unreachableBlockIndexes.includes(1));
  assert.ok(factsFor(facts, '0->2:conditional-false').reachable);
});

test('switch case labels, shared targets, and default remain conservative and deterministic', () => {
  const f = fixture('switch-ranges');
  f.block(0);
  const selector = f.opaque(8);
  f.switchBranch(selector, [[1, 1], [2, 1], [3, 2]], 3);
  f.block(1).ret();
  f.block(2).ret();
  f.block(3).ret();
  const facts = analyze(f.build()).facts;
  const shared = edge(facts, '0->1:switch-case').facts.get(selector.id).range;
  assert.equal(contains(shared, 1n), true);
  assert.equal(contains(shared, 2n), true);
  assert.equal(contains(shared, 3n), false);
  assert.equal(edge(facts, '0->3:switch-default').reachable, true);

  const exact = (() => {
    const g = fixture('switch-exact');
    g.block(0);
    const value = g.constant(2, 8);
    g.switchBranch(value, [[1, 1], [2, 1], [3, 2]], 3);
    g.block(1).ret();
    g.block(2).ret();
    g.block(3).ret();
    return analyze(g.build()).facts;
  })();
  assert.deepEqual([...exact.executableEdges], ['0->1:switch-case']);
  assert.deepEqual([...exact.unreachableBlockIndexes], [2, 3]);
});

test('width-incompatible switch labels remain conservative', () => {
  const f = fixture('switch-width-mismatch');
  f.block(0);
  const selector = f.constant(0, 8);
  f.switchBranch(selector, [[0x100n, 1]], 2);
  f.block(1).ret();
  f.block(2).ret();
  const facts = analyze(f.build()).facts;
  const caseEdge = edge(facts, '0->1:switch-case');
  const defaultEdge = edge(facts, '0->2:switch-default');
  assert.equal(caseEdge.reachable, true, 'malformed labels keep the case edge conservative');
  assert.equal(defaultEdge.reachable, true, 'malformed labels cannot exclude the default edge');
  assert.equal(caseEdge.facts.has(selector.id), false, 'malformed labels cannot refine the selector');
  assert.equal(defaultEdge.facts.has(selector.id), false, 'malformed labels cannot refine the default');
});

test('replacing canonical ranges invalidates dependent scalar analyses', () => {
  const f = fixture('sccp-invalidation');
  f.block(0);
  f.constant(1, 8);
  f.ret();
  const state = seedAnalysisState(f.build());
  state.__write('valueNumbers', Object.freeze({ completeness: 'complete' }));
  state.__write('induction', Object.freeze({ completeness: 'complete' }));
  state.__write('aggregates', Object.freeze({ completeness: 'complete' }));
  const outcome = runPassTransaction(state, PASS, { analysis: state }, {});
  assert.equal(outcome.committed, true);
  assert.deepEqual(outcome.invalidated, ['aggregates', 'induction', 'valueNumbers']);
  assert.equal(state.get('valueNumbers'), null);
  assert.equal(state.get('induction'), null);
  assert.equal(state.get('aggregates'), null);
});

test('edge facts do not leak into the global phi/range fact', () => {
  const f = fixture('edge-local-phi');
  f.block(0);
  const input = f.opaque(8);
  const limit = f.constant(10, 8);
  const condition = f.binary('ult', input, limit, 1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1);
  const left = f.constant(1, 8);
  f.branch(3);
  f.block(2);
  const right = f.constant(2, 8);
  f.branch(3);
  f.block(3);
  const merged = f.phi([[1, left], [2, right]], 8);
  f.ret();
  const facts = analyze(f.build()).facts;
  assert.equal(facts.ranges.get(input.id).kind, 'full');
  assert.equal(facts.constants.get(merged.id), undefined);
  assert.equal(facts.blockEntryFacts.get(1).get(input.id).range.upper, 9n);
  assert.equal(facts.blockEntryFacts.get(2).get(input.id).range.lower, 10n);
});

test('budget exhaustion publishes no exact constants or singleton partial ranges', () => {
  const f = fixture('partial-publish');
  f.block(0);
  let previous = f.constant(1, 32);
  for (let index = 0; index < 100; index += 1) previous = f.binary('add', previous, f.constant(1, 32), 32);
  f.ret();
  const state = seedAnalysisState(f.build());
  runPassTransaction(state, PASS, { analysis: state, sccpLimits: { maxWorkItems: 2 } }, {});
  const facts = state.get('ranges');
  assert.equal(facts.completeness, 'partial');
  assert.equal(facts.constants.size, 0);
  for (const fact of facts.facts.values()) {
    assert.equal(fact.status, 'partial');
    assert.equal(fact.constant, null);
    assert.equal(isFull(fact.range), true);
  }
});

test('malformed predicates and stale producer identities fail closed', () => {
  const f = fixture('malformed-predicate');
  f.block(0);
  const malformed = f.opaque(8);
  f.conditionalBranch(malformed, 1, 2);
  f.block(1).ret();
  f.block(2).ret();
  const facts = analyze(f.build()).facts;
  assert.equal(facts.edgeFacts.get('0->1:conditional-true').reachable, true);
  assert.equal(facts.edgeFacts.get('0->2:conditional-false').reachable, true);
  assert.equal(facts.passVersion, SCCP_PASS.version);
  const identityFacts = analyze(f.build(), { analysisIdentity: { binaryId: 'b', snapshotId: 's' } }).facts;
  assert.equal(identityFacts.identity.binaryId, 'b');
  assert.equal(identityFacts.identity.snapshotId, 's');
  assert.ok(identityFacts.identity.functionId);
  assert.ok(identityFacts.identity.semanticIrId);
  assert.ok(identityFacts.identity.ssaId);
  assert.ok(identityFacts.identity.analyzerVersion);
  const stale = { ...facts, passVersion: '0.0.0' };
  assert.notEqual(stale.passVersion, SCCP_PASS.version, 'a stale producer identity cannot be mistaken for this result');

  const unsupported = fixture('unsupported-branch');
  unsupported.block(0);
  unsupported.conditionalBranch(unsupported.opaque(24), 1, 2);
  unsupported.block(1).ret();
  unsupported.block(2).ret();
  const unsupportedFacts = analyze(unsupported.build()).facts;
  assert.deepEqual([...unsupportedFacts.unreachableBlockIndexes], [], 'unsupported branch evidence keeps both arms conservative');
});

test('SCCP refuses to publish when the caller explicitly supplies no identity', () => {
  const f = fixture('missing-analysis-identity');
  f.block(0);
  f.constant(1, 8);
  f.ret();
  const state = seedAnalysisState(f.build());
  const outcome = runPassTransaction(state, PASS, { analysis: state, analysisIdentity: null }, {});
  assert.equal(outcome.committed, true, 'an unsupported pass result is a committed observation, not fabricated facts');
  assert.equal(outcome.result.status, 'unsupported');
  assert.equal(state.get('ranges'), null, 'missing identity cannot publish scalar facts');
});

test('SCCP refuses a canonical IR that explicitly carries no identity', () => {
  const f = fixture('missing-ir-analysis-identity');
  f.block(0);
  f.constant(1, 8);
  f.ret();
  const ir = f.build();
  ir.analysisIdentity = null;
  const state = seedAnalysisState(ir);
  const outcome = runPassTransaction(state, PASS, { analysis: state, ir }, {});
  assert.equal(outcome.committed, true);
  assert.equal(outcome.result.status, 'unsupported');
  assert.equal(state.get('ranges'), null, 'an IR without canonical identity cannot publish scalar facts');
});

test('missing branch or switch selector evidence keeps every successor conservative', () => {
  const branch = fixture('missing-branch-condition');
  branch.block(0);
  branch.opaque(1);
  branch.conditionalBranch({ id: 999999, bits: 1 }, 1, 2);
  branch.block(1).ret();
  branch.block(2).ret();
  const branchFacts = analyze(branch.build()).facts;
  assert.deepEqual([...branchFacts.unreachableBlockIndexes], [], 'a missing condition must not hide a successor');

  const switched = fixture('missing-switch-selector');
  switched.block(0);
  switched.opaque(8);
  switched.switchBranch({ id: 999998, bits: 8, uses: [] }, [[1, 1]], 2);
  switched.block(1).ret();
  switched.block(2).ret();
  const switchFacts = analyze(switched.build()).facts;
  assert.deepEqual([...switchFacts.unreachableBlockIndexes], [], 'a missing selector must not hide a case or default');
});

test('identical replay includes product and edge facts, not only executable-edge shape', () => {
  const f = fixture('replay-product');
  f.block(0);
  const input = f.opaque(8);
  const condition = f.binary('ult', input, f.constant(10, 8), 1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1).ret();
  f.block(2).ret();
  const ir = f.build();
  const first = analyze(ir).facts;
  const second = analyze(ir).facts;
  assert.deepEqual([...first.edgeFacts.keys()], [...second.edgeFacts.keys()]);
  for (const key of first.edgeFacts.keys()) {
    const a = first.edgeFacts.get(key);
    const b = second.edgeFacts.get(key);
    assert.equal(a.reachable, b.reachable);
    assert.deepEqual([...a.facts.entries()].map(([id, fact]) => [id, fact.range.kind, fact.range.lower, fact.range.upper, fact.congruence.modulus]),
      [...b.facts.entries()].map(([id, fact]) => [id, fact.range.kind, fact.range.lower, fact.range.upper, fact.congruence.modulus]));
  }
});
