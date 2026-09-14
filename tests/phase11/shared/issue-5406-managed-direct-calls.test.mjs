import test from 'node:test';
import assert from 'node:assert/strict';

import { buildManagedMethodSummary, analyzeManagedInterprocedural } from '../../../js/managed/shared/bridge-v2.js';
import { summaryIsPure, summaryIdentityMatches, functionSummaryDigest } from '../../../js/analysis/summary/contract.js';

function loweredWithDirectCall() {
  return {
    methodId: 'caller',
    semanticIr: {
      nodes: [{
        id: 'call:0',
        kind: 'call',
        call: { targetEntityIds: ['callee'], completeness: 'complete' },
        metadata: { dispatchKind: 'direct', targetUnresolved: false },
      }],
    },
    cfg: { blocks: [] },
  };
}

test('#5406 confirmed managed direct calls are recorded in the canonical FunctionSummary', () => {
  const result = buildManagedMethodSummary(loweredWithDirectCall());

  assert.equal(result.directCalls.length, 1, 'the bridge report still names the direct call');
  assert.equal(result.summary.directCalls.length, 1,
    'the canonical summary must carry the confirmed direct call (#5406)');
  const call = result.summary.directCalls[0];
  assert.equal(call.callSiteId, 'call:0');
  assert.deepEqual([...call.targetEntityIds], ['callee']);
  assert.equal(call.effectSource, 'abi-rule',
    'the caller-proven dispatch is abi-rule evidence, not a callee summary claim');
});

test('#5406 a direct call keeps the summary in the canonical identity class and is queryable', () => {
  const result = buildManagedMethodSummary(loweredWithDirectCall());

  // The recorded call must survive the canonical identity round-trip and be
  // visible to callers that branch on call effects (the issue's core harm was
  // an empty directCalls array behind a `complete` status).
  assert.equal(summaryIdentityMatches(result.summary), true,
    'the summary with direct calls stays a canonical identity');
  assert.equal(result.summary.status.completeness, 'complete',
    'a proven direct call does not by itself make the method partial');
  assert.equal(result.summary.directCalls[0].targetEntityIds.length, 1,
    'consumers can read the confirmed target from the summary');
});

test('#5406 summaries with and without the direct call have different digests and identities', () => {
  const withCall = buildManagedMethodSummary(loweredWithDirectCall());
  const withoutCall = buildManagedMethodSummary({
    ...loweredWithDirectCall(),
    semanticIr: { nodes: [] },
    methodId: 'caller',
  });

  assert.notEqual(functionSummaryDigest(withCall.summary), functionSummaryDigest(withoutCall.summary),
    'the dependency digest must distinguish call-bearing from call-free methods');
});

test('#5406 a method without direct calls keeps its previous summary shape', () => {
  const result = buildManagedMethodSummary({
    ...loweredWithDirectCall(),
    semanticIr: { nodes: [] },
  });

  assert.equal(result.directCalls.length, 0);
  assert.equal(result.summary.directCalls.length, 0);
  assert.equal(result.summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(result.summary), true,
    'an actually effect-free method remains pure');
});

test('#5406 analyzeManagedInterprocedural can traverse managed direct calls as graph edges', () => {
  const callee = {
    methodId: 'callee',
    semanticIr: { nodes: [] },
    cfg: { blocks: [] },
  };
  const caller = loweredWithDirectCall();
  const analysis = analyzeManagedInterprocedural([caller, callee]);

  assert.equal(analysis.components.length >= 1, true);
  const callerEntry = analysis.summaries.get('caller');
  assert.equal(callerEntry.summary.directCalls.length, 1,
    'the interprocedural pass sees the caller\u0027s direct call');
  assert.ok(callerEntry.directCalls.some((call) => call.target === 'callee'),
    'the condensed call graph can follow the callee edge');
});
