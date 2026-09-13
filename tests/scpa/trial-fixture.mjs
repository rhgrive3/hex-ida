// Explicit test adapters: never competitor or oracle evidence.
import { protocolInput, H } from './benchmark-fixture.mjs';
import { createCompetitiveProtocol } from '../../js/analysis/benchmark/competitive-protocol.js';
import { createAstraTrialPlan } from '../../js/analysis/benchmark/scoped-trials.js';
export function trialFixture(overrides = {}) {
  const protocols = Object.fromEntries(['T0', 'T1', 'T2', 'T3'].map(mode => { const input = protocolInput();
    input.track = { T0: 'scripted-substrate', T1: 'native-best', T2: 'knowledge-equalized', T3: 'native-best' }[mode];
    return [mode, createCompetitiveProtocol(input)]; }));
  const config = { seed: 71, cacheStates: ['cold'], tasks: protocols.T0.cases.map(row => ({ caseId: row.caseId, request: { kind: 'demand', request: { query: { scope: { functionIds: ['0x1000'] }, resultLimit: 4 } } } })),
    resources: { deadlineMs: 100, cleanupMs: 25 }, ...overrides };
  return { protocols, config, plan: createAstraTrialPlan(protocols, config) };
}
export function trialHosts(f, change = () => {}) {
  let namespaces = 0, queries = 0, cancels = 0, closes = 0;
  const getAdapter = (binding, { trial, limits }) => {
    let current = true;
    const context = { binding, isCurrent: () => current, stale: () => current = false,
      prepare: async () => ({ schema: 'same-astra-trial-preparation/v1', binding, cacheState: trial.cacheState,
        cachePolicySha256: f.protocols[trial.mode].warmStatePolicySha256, cacheGeneration: 'generation-' + namespaces,
        namespaceId: 'isolated-' + namespaces++, evidenceId: 'TEST-PREPARATION', limits,
        boundedExecution: true, cancellationSupported: true, modelCallsDisabled: trial.mode === 'T0',
        knowledge: { manifestSha256: H, availability: 'AVAILABLE', licenseEvidenceId: 'TEST-LICENSE', networkPolicy: 'deny', costPolicySha256: H, runtimeObservationBudget: 0 } }),
      adapter: { capabilities: async () => ({ testOnly: true }), query: async () => { queries++; return { mode: trial.mode === 'T0' ? 'T0-model-free' : trial.mode, exact: false }; },
        explain: async () => ({}), cancel: async () => { cancels++; } },
      close: async () => { closes++; current = false; } };
    change(context, trial, limits); return context;
  };
  return { getAdapter, stats: () => ({ queries, cancels, closes }) };
}
