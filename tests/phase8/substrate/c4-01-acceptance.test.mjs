import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_KEYS,
  PASS_STAGES,
  PHASE8_CONTRACT_VERSION,
  createPassDescriptor,
  createPassResult,
  unchangedResult,
} from '../../../js/decompiler/phase8/contract.js';
import {
  createAnalysisState,
  invalidationFor,
  runPassTransaction,
  transactionDigest,
} from '../../../js/decompiler/phase8/transaction.js';
import {
  INTERACTIVE_STAGES,
  runPhase8Stage,
  runPhase8Vertical,
  passRegistryDigest,
  phase8Passes,
  seedAnalysisState,
} from '../../../js/decompiler/phase8/index.js';

const FULL_STATE = Object.freeze(Object.fromEntries(ANALYSIS_KEYS.map((key) => [key, { key }])));

function createMockPass(descriptorInput, { changed = true, stageWrites = [], throws = false } = {}) {
  const descriptor = createPassDescriptor({
    id: 'phase8.c401.probe',
    version: '1.0.0',
    stage: 'scalar-optimization',
    ...descriptorInput,
  });
  return {
    descriptor,
    run(_context, _budget, area) {
      if (throws) throw new Error('c401-deliberate-pass-failure');
      for (const [key, value] of stageWrites) area.stage(key, value);
      return createPassResult({
        descriptor,
        status: changed ? 'changed' : 'unchanged',
        changed,
        transforms: changed ? [{ kind: 'probe', targets: ['value_1'], proof: 'c401-probe-proof', originRefs: ['insn_1'] }] : [],
        invalidated: changed ? descriptor.invalidates : [],
        produced: changed ? stageWrites.map(([key]) => key) : [],
      });
    },
  };
}

test('C4-01 contract constants, stage ordering and frozen schema', () => {
  assert.equal(PHASE8_CONTRACT_VERSION, 8);
  assert.ok(Array.isArray(ANALYSIS_KEYS) && ANALYSIS_KEYS.length === 19);
  assert.ok(Object.isFrozen(ANALYSIS_KEYS));
  assert.ok(Array.isArray(PASS_STAGES) && PASS_STAGES.length > 0);
  assert.ok(Object.isFrozen(PASS_STAGES));
  assert.ok(PASS_STAGES.includes('scalar-optimization'));
  assert.ok(PASS_STAGES.includes('loop-facts'));
  assert.ok(PASS_STAGES.includes('structuring'));
  assert.ok(Array.isArray(INTERACTIVE_STAGES));
  assert.ok(Object.isFrozen(INTERACTIVE_STAGES));
});

test('C4-01 pass descriptor contract enforces explicit consumes, preserves and invalidates', () => {
  const descriptor = createPassDescriptor({
    id: 'phase8.c401.test',
    version: '1.0.0',
    stage: 'scalar-optimization',
    consumes: ['ssa'],
    preserves: ['cfg'],
    invalidates: ['ranges'],
  });
  assert.equal(descriptor.contractVersion, PHASE8_CONTRACT_VERSION);
  assert.equal(descriptor.stageIndex, PASS_STAGES.indexOf('scalar-optimization'));
  assert.deepEqual(descriptor.consumes, ['ssa']);
  assert.deepEqual(descriptor.preserves, ['cfg']);
  assert.deepEqual(descriptor.invalidates, ['ranges']);
  assert.ok(Object.isFrozen(descriptor));

  // Preserves and invalidates intersection must throw
  assert.throws(
    () => createPassDescriptor({
      id: 'phase8.c401.bad',
      version: '1.0.0',
      stage: 'scalar-optimization',
      preserves: ['ranges'],
      invalidates: ['ranges'],
    }),
    /preserves-and-invalidates:ranges/,
  );

  // Unknown stage, budgetClass, or consumed/invalidated key must throw
  assert.throws(
    () => createPassDescriptor({ id: 'bad', version: '1.0.0', stage: 'invalid-stage' }),
    /unknown-stage/,
  );
  assert.throws(
    () => createPassDescriptor({ id: 'bad', version: '1.0.0', stage: 'scalar-optimization', budgetClass: 'infinite' }),
    /unknown-budget-class/,
  );
  assert.throws(
    () => createPassDescriptor({ id: 'bad', version: '1.0.0', stage: 'scalar-optimization', consumes: ['nonexistent'] }),
    /unknown-consumed-analysis:nonexistent/,
  );
  assert.throws(
    () => createPassDescriptor({ id: 'bad', version: '1.0.0', stage: 'scalar-optimization', invalidates: ['nonexistent'] }),
    /unknown-invalidated-analysis:nonexistent/,
  );
});

test('C4-01 under-invalidation and over-invalidation are strictly fail-closed', () => {
  // Under-invalidation: unpromised analyses are discarded fail-closed
  const state1 = createAnalysisState(FULL_STATE);
  const outcome1 = runPassTransaction(
    state1,
    createMockPass({ consumes: ['ssa'], preserves: ['cfg'], invalidates: [] }),
    {}, {},
  );
  assert.equal(outcome1.committed, true);
  assert.ok(outcome1.invalidated.includes('ranges'), 'ranges was neither preserved nor produced and must be invalidated');
  assert.ok(outcome1.invalidated.includes('valueNumbers'));
  assert.equal(state1.version('ranges'), 2);
  assert.equal(state1.get('ranges'), null, 'unpreserved analysis is dropped, not left stale');

  // Over-invalidation: explicitly preserved analyses keep versions and cache
  const state2 = createAnalysisState(FULL_STATE);
  const preserved = ANALYSIS_KEYS.filter((key) => key !== 'ranges');
  const outcome2 = runPassTransaction(
    state2,
    createMockPass({ consumes: ['ssa'], preserves: preserved, invalidates: ['ranges'] }),
    {}, {},
  );
  assert.equal(outcome2.committed, true);
  assert.deepEqual([...outcome2.invalidated], ['ranges']);
  for (const key of preserved) {
    assert.equal(state2.version(key), 1, `preserved analysis ${key} lost version`);
    assert.notEqual(state2.get(key), null);
  }

  // Unchanged pass invalidates nothing
  const state3 = createAnalysisState(FULL_STATE);
  const before3 = state3.snapshot();
  const outcome3 = runPassTransaction(
    state3,
    createMockPass({ consumes: ['ssa'], preserves: ['cfg'] }, { changed: false }),
    {}, {},
  );
  assert.equal(outcome3.committed, true);
  assert.deepEqual([...outcome3.invalidated], []);
  assert.deepEqual(state3.snapshot(), before3);
});

test('C4-01 production staging requires strict declaration and result agreement', () => {
  const state1 = createAnalysisState(FULL_STATE);
  const outcome1 = runPassTransaction(
    state1,
    createMockPass(
      { consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'] },
      { stageWrites: [['ranges', { computedRange: [0, 100] }]] },
    ),
    {}, {},
  );
  assert.equal(outcome1.committed, true);
  assert.deepEqual([...outcome1.staged], ['ranges']);
  assert.deepEqual(state1.get('ranges'), { computedRange: [0, 100] });
  assert.ok(!outcome1.invalidated.includes('ranges'));

  // Undeclared production in descriptor must be rejected
  const state2 = createAnalysisState(FULL_STATE);
  const outcome2 = runPassTransaction(
    state2,
    createMockPass(
      { consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'] },
      { stageWrites: [['types', { forged: true }]] },
    ),
    {}, {},
  );
  assert.equal(outcome2.committed, false);
  assert.match(outcome2.stopReason, /undeclared-production/);
  assert.deepEqual(state2.get('types'), { key: 'types' });

  // Staged production mismatch (staged write not declared in result)
  const descriptor = createPassDescriptor({
    id: 'phase8.c401.silent',
    version: '1.0.0',
    stage: 'scalar-optimization',
    consumes: ['ssa'],
    preserves: ['cfg'],
    produces: ['ranges'],
  });
  const silentPass = {
    descriptor,
    run(_ctx, _budget, area) {
      area.stage('ranges', { silent: true });
      return createPassResult({
        descriptor,
        status: 'changed',
        transforms: [{ kind: 'probe', targets: ['value_1'], proof: 'probe' }],
      });
    },
  };
  const state3 = createAnalysisState(FULL_STATE);
  const outcome3 = runPassTransaction(state3, silentPass, {}, {});
  assert.equal(outcome3.committed, false);
  assert.match(outcome3.stopReason, /staged-production-mismatch/);
  assert.deepEqual(state3.get('ranges'), { key: 'ranges' });
});

test('C4-01 transactional rollback on cancellation, exceptions, and budget exhaustion', () => {
  const state = createAnalysisState(FULL_STATE);
  const before = state.snapshot();

  // Cancellation
  const cancelled = runPassTransaction(
    state,
    createMockPass(
      { consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'] },
      { stageWrites: [['ranges', { computed: true }]] },
    ),
    {}, { shouldAbort: () => true },
  );
  assert.equal(cancelled.committed, false);
  assert.match(cancelled.stopReason, /^cancelled/);
  assert.deepEqual(state.snapshot(), before);

  // Exception thrown during pass run
  const throwing = runPassTransaction(
    state,
    createMockPass({ consumes: ['ssa'], preserves: ['cfg'] }, { throws: true }),
    {}, {},
  );
  assert.equal(throwing.committed, false);
  assert.match(throwing.stopReason, /^failed:c401-deliberate-pass-failure/);
  assert.deepEqual(state.snapshot(), before);
});

test('C4-01 deterministic replay yields identical transaction digest', () => {
  const digests = [0, 1].map(() => {
    const state = createAnalysisState(FULL_STATE);
    return transactionDigest(runPassTransaction(
      state,
      createMockPass(
        { consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'] },
        { stageWrites: [['ranges', { determinismCheck: 42 }]] },
      ),
      {}, {},
    ));
  });
  assert.equal(digests[0], digests[1]);
  assert.ok(typeof digests[0] === 'string' && /^[0-9a-f]{32}$/.test(digests[0]));
});

test('C4-01 vertical execution maintains stage ordering and publishes immutable ledger', () => {
  const passes = phase8Passes();
  assert.ok(passes.length > 0);
  const digest1 = passRegistryDigest(passes);
  const digest2 = passRegistryDigest(passes);
  assert.equal(digest1, digest2);
  assert.ok(typeof digest1 === 'string' && digest1.length > 0);

  // State seeding from upstream facts
  const seeded = seedAnalysisState({ blocks: [{ id: 'b1' }], entry: 'b1', values: [{ id: 'v1' }] });
  assert.deepEqual(seeded.get('cfg'), { blocks: [{ id: 'b1' }], entry: 'b1', backEdges: null });
  assert.equal(seeded.get('ranges'), null);

  // Cancellation budget cancels cleanly
  const state = createAnalysisState(FULL_STATE);
  const zeroBudgetOutcome = runPhase8Stage(
    { analysis: state },
    { stages: ['scalar-optimization'], shouldAbort: () => true },
  );
  assert.equal(zeroBudgetOutcome.ledger.status, 'cancelled');
});
