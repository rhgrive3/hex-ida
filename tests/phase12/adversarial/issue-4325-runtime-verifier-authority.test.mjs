import assert from 'node:assert/strict';
import test from 'node:test';
import { createHexToolRegistry } from '../../../js/ai/tools/registry.js';
import { EvidenceStore } from '../../../js/ai/evidence.js';
import { classifyHypothesis } from '../../../js/dynamic/experiments.js';

function confirmedResult(overrides = {}) {
  const coverage = {
    planned: 3,
    executed: 3,
    complete: true,
    truncated: false,
    cancelled: false,
    stoppedOnContradiction: false,
    unsupported: 0,
    reasons: [],
    ...(overrides.coverage || {}),
  };
  const cases = overrides.cases || [0, 1, 2].map((index) => ({
    case: { id: `case-${index}` },
    comparison: { status: 'supported' },
    evidence: { id: `runtime-evidence-${index}`, function: '0x1000', verdict: 'supported' },
  }));
  return {
    experimentId: 'exp-4325',
    verdict: {
      ...classifyHypothesis(cases, coverage),
      ...(overrides.verdict || {}),
    },
    coverage,
    cases,
    evidence: cases.map((row) => row.evidence).filter(Boolean),
    ...overrides.result,
  };
}

function registryFor(result) {
  const evidenceStore = new EvidenceStore();
  const registry = createHexToolRegistry({
    binaryId: 'issue-4325-runtime-verifier',
    analysisRevision: 'rev-1',
    addressExists: () => true,
    runtime: { async verifyHypothesis() { return result; } },
  }, { evidenceStore });
  return { registry, evidenceStore };
}

async function execute(result) {
  const { registry, evidenceStore } = registryFor(result);
  const output = await registry.execute('verify_runtime_hypothesis', {
    hypothesis: { id: 'h-4325', functionAddress: '0x1000' },
  }, { scope: 'runtime' });
  return { output, evidenceStore };
}

test('Issue #4325: canonical confirmed runtime verdict gains deterministic verifier authority', async () => {
  const { output, evidenceStore } = await execute(confirmedResult());

  assert.equal(output.result.verified, true);
  assert.equal(output.result.verification?.verified, true);
  assert.equal(output.result.verification?.authority, 'runtime-confirmed-verdict');
  assert.ok(output.evidence.length > 0, 'confirmed runtime verification must mint evidence');
  assert.ok(output.evidence.every((row) => row.status === 'verified'));
  assert.ok(evidenceStore.byStatus('verified').length > 0, 'verified runtime evidence must be visible to confirmedFacts consumers');
  assert.equal(output.modelData.verified, true, 'model projection must observe the same authority decision');
});

test('Issue #4325: malformed confirmed verdict cannot self-assert deterministic authority', async () => {
  const incomplete = confirmedResult({
    coverage: { planned: 3, executed: 2, complete: false, truncated: true },
    cases: [0, 1].map((index) => ({
      case: { id: `case-${index}` },
      comparison: { status: 'supported' },
      evidence: { id: `runtime-evidence-${index}`, function: '0x1000', verdict: 'supported' },
    })),
  });
  const { output } = await execute(incomplete);

  assert.notEqual(output.result.verified, true);
  assert.equal(output.evidence.some((row) => row.status === 'verified'), false);
});

test('Issue #4325: an explicit negative verification verdict is never overwritten', async () => {
  const denied = confirmedResult({
    result: { verified: false, verification: { verified: false, authority: 'runtime-denied' } },
  });
  const { output } = await execute(denied);

  assert.equal(output.result.verified, false);
  assert.equal(output.result.verification?.verified, false);
  assert.equal(output.evidence.some((row) => row.status === 'verified'), false);
});

test('Issue #4325: non-confirmed runtime verdicts remain non-authoritative', async () => {
  for (const status of ['supported', 'inconclusive', 'contradicted', 'unsupported']) {
    const result = confirmedResult({ verdict: { status } });
    const { output } = await execute(result);
    assert.notEqual(output.result.verified, true, status);
    assert.equal(output.evidence.some((row) => row.status === 'verified'), false, status);
  }
});

test('Issue #4325: EvidenceStore does not globally trust nested confirmed vocabulary', () => {
  const store = new EvidenceStore();
  const created = store.ingest('other-verifier', {
    functionAddress: '0x1000',
    verdict: { status: 'confirmed' },
  }, { verifier: true });

  assert.equal(created.length, 1);
  assert.equal(created[0].status, 'supported');
});
