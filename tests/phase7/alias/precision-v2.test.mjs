import assert from 'node:assert/strict';
import test from 'node:test';

import { ALIAS_QUERIES_V2, buildFixture, memoryAccessOf, regionOf, scoreAliasQueriesV2 } from '../../../tools/validation/phase7/scoring.mjs';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';

test('alias v2 solver achieves 100% exact precision and recall on v2 ground truth corpus', () => {
  const solverCache = new Map();
  function candidateAnswer(query) {
    const built = buildFixture(query.fixture);
    if (!solverCache.has(built)) {
      solverCache.set(built, createPhase7AliasSolver({
        ir: built.ir,
        cfg: built.cfg,
        ssa: built.ssa,
        options: built.rootDescriptors == null ? {} : { canonicalOptions: { rootDescriptors: built.rootDescriptors } },
      }));
    }
    const solver = solverCache.get(built);
    return solver.alias(regionOf(built, query.left), regionOf(built, query.right), {
      leftAccess: memoryAccessOf(built, query.left),
      rightAccess: memoryAccessOf(built, query.right),
    });
  }

  const score = scoreAliasQueriesV2(candidateAnswer, { queries: ALIAS_QUERIES_V2 });

  // #8809 sync: three corpus entries (v2-frame-non-escaping, v2-callee-ret,
  // v2-tls-vs-stack) were re-evaluated against the current evidence contract:
  // #4977's both-roots non-escaping AND rule, the callee-return escape
  // boundary, and the missing canonical TLS proof authority (#6066) each turn
  // a formerly-`no` truth into a conservative `may`. The v2 corpus truth was
  // redefined accordingly (see tests/phase7/corpus/fixtures.mjs). The gate's
  // actual invariant is unchanged: zero false strong answers, and every
  // exact claim correct.
  assert.equal(score.queryCount, 30);
  assert.equal(score.exactAvailable, 12);
  assert.equal(score.exactClaimed, 12);
  assert.equal(score.exactCorrect, 12);
  assert.equal(score.exactPrecision, 1.0);
  assert.equal(score.exactRecall, 1.0);
  assert.equal(score.falseMustAlias, 0);
  assert.equal(score.falseNoAlias, 0);
  assert.equal(score.unknownCount, 0);
});
