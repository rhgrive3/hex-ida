import assert from 'node:assert/strict';
import test from 'node:test';
import { planAnalysisGoal } from '../../../js/query/planner.js';

const QUERY = Object.freeze({
  action:'read',
  entity:Object.freeze({ terms:Object.freeze(['needle']) }),
  context:Object.freeze({ terms:Object.freeze([]) }),
  event:Object.freeze({ terms:Object.freeze([]) }),
  dataflow:Object.freeze({ shape:'read' }),
  expect:Object.freeze({ calls:Object.freeze([]) }),
  confident:true,
});

const A = 0x1000n;
const B = 0x2000n;

function searchResult(addresses) {
  return {
    results:addresses.map((address) => ({ address, name:`needle_${address.toString(16)}` })),
    complete:true,
    returned:addresses.length,
    total:addresses.length,
    coverage:1,
  };
}

function successFunction(address) {
  return {
    address,
    name:`needle_${address.toString(16)}`,
    found:true,
    instructions:1,
    cost:{ functions:1, disassembly:0 },
    summary:{ calls:[] },
  };
}

function directTools({ addresses = [A], fail = new Set(), errorFactory = null } = {}) {
  return {
    async search_functions() { return searchResult(addresses); },
    async search_strings() { return searchResult([]); },
    async get_function(address) {
      const key = BigInt(address);
      if (fail.has(key)) {
        if (errorFactory) throw errorFactory(key);
        throw Object.assign(new Error('backend unavailable'), { code:'backend-error' });
      }
      return successFunction(key);
    },
    async get_semantic_facts() {
      return { results:[], complete:true, returned:0, total:0, coverage:1 };
    },
    async verify_field_update() { return { verified:false, evidence:[] }; },
    async find_thresholds() { return searchResult([]); },
  };
}

function options(tools) {
  return {
    ...(tools ? { tools } : {}),
    maxFunctions:8,
    maxDisassembly:64,
    maxSearchResults:8,
    maxExpansions:0,
    timeoutMs:5000,
  };
}

test('#4264 all discovered candidates failing analysis remain partial and are not called absent', async () => {
  const result = await planAnalysisGoal(QUERY, {}, options(directTools({ fail:new Set([A]) })));

  assert.equal(result.completeness.complete, false);
  assert.equal(result.partial, true);
  assert.ok(result.missingEvidence.includes('candidate-analysis-error'));
  assert.ok(!result.missingEvidence.includes('no-candidate-function'));
  assert.equal(result.stats.candidateFunctions, 1);
  assert.equal(result.stats.analyzedFunctions, 0);
  assert.equal(result.stats.failedFunctions, 1);
  assert.deepEqual(result.candidateAnalysisFailures, [{ address:A, code:'backend-error' }]);
});

test('#4264 candidate discovery absence remains distinct from candidate analysis failure', async () => {
  const result = await planAnalysisGoal(QUERY, {}, options(directTools({ addresses:[] })));

  assert.equal(result.completeness.complete, true);
  assert.equal(result.stats.candidateFunctions, 0);
  assert.equal(result.stats.failedFunctions, 0);
  assert.ok(result.missingEvidence.includes('no-candidate-function'));
  assert.ok(!result.missingEvidence.includes('candidate-analysis-error'));
  assert.deepEqual(result.candidateAnalysisFailures, []);
});

test('#4264 one failed candidate makes an otherwise successful candidate set partial', async () => {
  const result = await planAnalysisGoal(QUERY, {}, options(directTools({ addresses:[A, B], fail:new Set([B]) })));

  assert.equal(result.stats.candidateFunctions, 2);
  assert.equal(result.stats.analyzedFunctions, 1);
  assert.equal(result.stats.failedFunctions, 1);
  assert.ok(result.best, 'the successfully analyzed candidate remains usable');
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.reason, 'candidate-analysis-error');
  assert.ok(result.missingEvidence.includes('candidate-analysis-error'));
});

test('#4264 successful candidate analysis preserves the complete path', async () => {
  const result = await planAnalysisGoal(QUERY, {}, options(directTools({ addresses:[A, B] })));

  assert.equal(result.completeness.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.stats.failedFunctions, 0);
  assert.ok(!result.missingEvidence.includes('candidate-analysis-error'));
  assert.deepEqual(result.candidateAnalysisFailures, []);
});

test('#4264 known budget termination remains budget-owned, not candidate-analysis failure', async () => {
  for (const code of ['function-budget', 'disassembly-budget']) {
    const result = await planAnalysisGoal(QUERY, {}, options(directTools({
      fail:new Set([A]),
      errorFactory:() => Object.assign(new Error(code), { code }),
    })));
    assert.equal(result.completeness.complete, false, code);
    assert.ok(result.missingEvidence.includes(code), code);
    assert.ok(!result.missingEvidence.includes('candidate-analysis-error'), code);
    assert.equal(result.stats.failedFunctions, 0, code);
  }
});

test('#4264 failure diagnostics are bounded and never retain error stacks or objects', async () => {
  const addresses = Array.from({ length:20 }, (_, index) => A + BigInt(index * 0x10));
  const huge = 'x'.repeat(1024);
  const result = await planAnalysisGoal(QUERY, {}, {
    ...options(directTools({
      addresses,
      fail:new Set(addresses),
      errorFactory:() => Object.assign(new Error(huge), { code:huge, secret:{ token:'do-not-retain' } }),
    })),
    maxFunctions:64,
  });

  assert.equal(result.completeness.complete, false);
  assert.equal(result.stats.failedFunctions, 20);
  assert.ok(result.candidateAnalysisFailures.length <= 8);
  for (const diagnostic of result.candidateAnalysisFailures) {
    assert.deepEqual(Object.keys(diagnostic).sort(), ['address', 'code']);
    assert.ok(diagnostic.code.length <= 128);
    assert.equal(Object.hasOwn(diagnostic, 'stack'), false);
    assert.equal(Object.hasOwn(diagnostic, 'error'), false);
  }
});

test('#4264 first-party createAgentTools path propagates analyze failures into planner completeness', async () => {
  const result = await planAnalysisGoal(QUERY, {
    async searchFunctions() { return searchResult([A]); },
    async searchStrings() { return searchResult([]); },
    async analyze() {
      throw Object.assign(new Error('backend unavailable'), { code:'backend-error' });
    },
  }, options());

  assert.equal(result.completeness.complete, false);
  assert.equal(result.stats.failedFunctions, 1);
  assert.ok(result.missingEvidence.includes('candidate-analysis-error'));
  assert.ok(!result.missingEvidence.includes('no-candidate-function'));
});

test('#4264 hostile failure identity accessors cannot gain diagnostic authority through coercion', async () => {
  let toStringCalls = 0;
  const hostileCode = { toString() { toStringCalls += 1; return 'function-budget'; } };
  const hostileError = {};
  Object.defineProperty(hostileError, 'code', { get() { return hostileCode; } });
  Object.defineProperty(hostileError, 'message', { get() { throw new Error('message getter must not escape'); } });

  const result = await planAnalysisGoal(QUERY, {}, options(directTools({
    fail:new Set([A]),
    errorFactory:() => hostileError,
  })));

  assert.equal(toStringCalls, 0);
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.reason, 'candidate-analysis-error');
  assert.equal(result.stats.failedFunctions, 1);
  assert.deepEqual(result.candidateAnalysisFailures, [{ address:A, code:'candidate-analysis-error' }]);
  assert.ok(!result.missingEvidence.includes('function-budget'));
});
