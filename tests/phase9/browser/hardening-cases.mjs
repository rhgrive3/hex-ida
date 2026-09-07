/** Browser-native regressions for the v3 publication and proof boundaries. */
import * as S from '../../../js/symbolic/index.js';
import { identity, scalarFixture } from '../taint/fixtures.mjs';
import { runAnalysisBrowserCases as runExisting } from './analysis-cases.mjs';
const check = (value, message) => { if (!value) throw new Error(message); };
export async function runAnalysisBrowserCases() {
  const results = await runExisting();
  const record = async (name, action) => {
    const start = performance.now(); const metrics = await action();
    results.push({ name, status: 'PASS', milliseconds: performance.now() - start, metrics });
  };
  await record('conditional-proof-requires-current-consumption-scope', async () => {
    const E = S.expr, x = E.createFreshSymbol(E.bvSort(3), 'browser-conditioned'), zero = E.createBv(3, 0n);
    const preconditions = [E.createCompare('eq', x, zero)];
    const result = await S.verifyDeobfuscationCandidate({ candidateId: 'conditioned', beforeValueId: 'b', afterValueId: 'a',
      identity, before: x, after: zero, preconditions, memoryObservables: [], effectObservables: [] });
    check(result.eligible, result.reason);
    check(!S.isAdoptableCandidate(result), 'conditional proof was redeemed as unconditional');
    check(S.isAdoptableCandidate(result, { preconditions }), 'identical active scope was rejected');
    return { proofAuthority: result.evidence.proofAuthority };
  });
  await record('nested-expression-accessor-not-executed', () => {
    let reads = 0;
    const E = S.expr, child = Object.freeze({ kind: 'const', value: 1n, get sort() { reads++; return E.bvSort(8); } });
    const parent = Object.freeze({ kind: 'binary', sort: E.bvSort(8), op: 'add', left: child, right: E.createBv(8, 0n) });
    const result = S.createByteMemory({ identity }).store(0n, 1, parent);
    check(result.status === 'unknown' && reads === 0, 'validation invoked a getter');
    return { getterReads: reads, reason: result.reason };
  });
  await record('taint-deadline-reaches-executor-preflight', () => {
    let checks = 0;
    const models = S.createTaintModels({ id: 'clock', version: '1', provenance: 'owned:browser' });
    const result = S.queryTaint(scalarFixture(), { identity, models, timeoutMs: 5,
      now: () => checks >= 50 ? 5 : 0, getCurrentIdentity: () => { checks++; return identity; } });
    check(result.status === 'partial' && result.reason === 'deadline', 'deadline not enforced');
    check(!result.evidence && checks <= 64, 'deadline did not interrupt preflight');
    return { lifecycleChecks: checks, ...result.metrics };
  });
  return results;
}
