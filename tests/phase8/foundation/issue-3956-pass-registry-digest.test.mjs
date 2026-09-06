import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_PASS,
  createAnalysisState,
  createProvider,
  passRegistryDigest,
  phase8Passes,
  runPhase8Vertical,
} from '../../../js/decompiler/phase8/index.js';

function provider(id, { version = '1.0.0', interfaceVersion = 1, kinds = ['idiom'] } = {}) {
  return Object.freeze({ id, version, interfaceVersion, kinds: Object.freeze([...kinds]) });
}

const providerPass = Object.freeze({ descriptor: PROVIDER_PASS });

test('pass registry identity includes the declared production contract', () => {
  const changedProduces = Object.freeze({
    descriptor: Object.freeze({ ...PROVIDER_PASS, produces: Object.freeze(['providerHints', 'ranges']) }),
  });

  assert.notEqual(
    passRegistryDigest([providerPass], []),
    passRegistryDigest([changedProduces], []),
    'changing descriptor.produces must invalidate the registry identity',
  );
});

test('provider registry identity covers version, interface and kinds independent of order', () => {
  const baseline = [
    provider('phase8.provider.beta', { kinds: ['render', 'idiom'] }),
    provider('phase8.provider.alpha'),
  ];
  const reordered = [...baseline].reverse().map((entry) => provider(entry.id, {
    version: entry.version,
    interfaceVersion: entry.interfaceVersion,
    kinds: [...entry.kinds].reverse(),
  }));
  const baselineDigest = passRegistryDigest([providerPass], baseline);

  assert.equal(passRegistryDigest([providerPass], reordered), baselineDigest,
    'registry and kind ordering must not change identity');
  assert.notEqual(passRegistryDigest([providerPass], baseline.map((entry) => (
    entry.id === 'phase8.provider.alpha' ? provider(entry.id, { version: '1.0.1' }) : entry
  ))), baselineDigest, 'provider version must change identity');
  assert.notEqual(passRegistryDigest([providerPass], baseline.map((entry) => (
    entry.id === 'phase8.provider.alpha' ? provider(entry.id, { interfaceVersion: 2 }) : entry
  ))), baselineDigest, 'provider interface version must change identity');
  assert.notEqual(passRegistryDigest([providerPass], baseline.map((entry) => (
    entry.id === 'phase8.provider.alpha' ? provider(entry.id, { kinds: ['render'] }) : entry
  ))), baselineDigest, 'declared provider kinds must change identity');
});

test('provider registry changes do not invalidate stage sets without the provider pass', () => {
  const passes = phase8Passes({ stages: ['canonical-facts'] });
  const before = [provider('phase8.provider.alpha')];
  const after = [provider('phase8.provider.alpha', { version: '2.0.0' })];

  assert.equal(passRegistryDigest(passes, before), passRegistryDigest(passes, after));
});

test('provider-free vertical does not observe provider authority', () => {
  const createCanonicalAnalysis = () => createAnalysisState({ cfg: {}, ssa: {}, origins: {} });
  let providerReads = 0;
  const throwingOutcome = runPhase8Vertical({
    enabledStages: ['canonical-facts'],
    analysis: createCanonicalAnalysis(),
    get providers() {
      providerReads += 1;
      throw new Error('unused-provider-authority');
    },
  });

  assert.equal(providerReads, 0, 'provider-free stage sets must not read provider authority');
  assert.equal(throwingOutcome.ledger.published, true,
    'an unused throwing provider getter must not affect a provider-free vertical');

  const nonIterableOutcome = runPhase8Vertical({
    enabledStages: ['canonical-facts'],
    analysis: createCanonicalAnalysis(),
    providers: 42,
  });
  assert.equal(nonIterableOutcome.ledger.published, true,
    'an unused non-iterable provider value must not affect a provider-free vertical');
});

test('duplicate provider ids fail closed before registry identity or execution can diverge', () => {
  let executions = 0;
  const first = createProvider({
    id: 'phase8.provider.same',
    version: '1.0.0',
    kinds: ['idiom'],
    refine() { executions += 1; return []; },
  });
  const second = createProvider({
    id: 'phase8.provider.same',
    version: '2.0.0',
    kinds: ['idiom'],
    refine() { executions += 1; return []; },
  });

  for (const providers of [[first, second], [second, first]]) {
    assert.throws(
      () => passRegistryDigest([providerPass], providers),
      { name: 'TypeError', message: 'phase8-provider-id-duplicate:phase8.provider.same' },
      'duplicate provider ids must not produce a reusable registry identity',
    );
    assert.throws(
      () => runPhase8Vertical({ providers }),
      { name: 'TypeError', message: 'phase8-provider-id-duplicate:phase8.provider.same' },
      'the vertical must reject the same duplicate registry before any provider can execute',
    );
  }

  assert.equal(executions, 0, 'duplicate providers must fail closed before refinement starts');
});

test('vertical snapshots provider authority once for digest and execution', () => {
  const executions = [];
  const first = createProvider({
    id: 'phase8.provider.snapshot-a',
    version: '1.0.0',
    kinds: ['idiom'],
    refine() { executions.push('a'); return []; },
  });
  const second = createProvider({
    id: 'phase8.provider.snapshot-b',
    version: '1.0.0',
    kinds: ['idiom'],
    refine() { executions.push('b'); return []; },
  });
  const analysis = createAnalysisState({
    cfg: {},
    ssa: {},
    induction: { loops: [] },
    aggregates: { regions: [] },
    structuredRegions: {
      edgesByConstruct: {},
      edgeCount: 0,
      residualGotoCount: 0,
      constraintEdgeCount: 0,
      regions: [],
    },
  });
  let providerReads = 0;
  const context = {
    enabledStages: ['providers'],
    analysis,
    get providers() {
      providerReads += 1;
      return providerReads === 1 ? [first] : [second];
    },
  };

  const outcome = runPhase8Vertical(context);
  const expectedDigest = passRegistryDigest([providerPass], [first]);
  const providerFacts = outcome.analysis.get('providerHints');

  assert.equal(providerReads, 1, 'provider authority must be read exactly once per vertical');
  assert.equal(outcome.ledger.published, true);
  assert.equal(outcome.ledger.registryDigest, expectedDigest,
    'published identity must describe the provider snapshot that actually ran');
  assert.deepEqual(executions, ['a'], 'only the provider from the snapshotted registry may execute');
  assert.deepEqual(
    providerFacts.providers.map(({ id, version }) => ({ id, version })),
    [{ id: first.id, version: first.version }],
    'published provider material must use the same provider snapshot as the digest',
  );
});
