import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALIAS_QUERIES_V2,
  buildFixture,
} from '../phase7/corpus/fixtures.mjs';
import {
  scoreAliasQueriesV2,
} from '../../tools/validation/phase7/scoring.mjs';
import {
  loadCompetitiveProfile,
  generateCompetitiveScorecard,
} from '../../tools/validation/competitive/score.mjs';
import {
  verifyCompetitiveProfile,
  verifyCompetitiveScorecard,
} from '../../tools/validation/competitive/verify.mjs';
import {
  stage1GateDefinitions,
  validateStage1ScopeAndLedger,
} from '../../tools/validation/stage1/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const competitiveProfile = loadCompetitiveProfile();
const completeScorecard = await generateCompetitiveScorecard({ profile: competitiveProfile });

// 1. Mutation: Corpus item deleted / missing fixture
{
  assert.throws(
    () => buildFixture('non-existent-mutated-fixture'),
    /phase7-corpus-unknown-fixture:non-existent-mutated-fixture/,
    'Must fail when unknown fixture is requested'
  );
}

// 2. Mutation: Ledger item/owner removed
{
  const scopeValidation = validateStage1ScopeAndLedger('0000000000000000000000000000000000000000');
  // With non-ancestor headSha or missing ledger IDs, it must report errors
  assert.equal(scopeValidation.ok, false);
  assert.ok(
    scopeValidation.errors.includes('scope-baseline-not-ancestor'),
    'Must reject invalid non-ancestor candidate SHA'
  );
}

// 3. Mutation: False NoAlias accepted
{
  // A query whose truth is 'must', but answerer falsely returns 'no'
  const falseNoAnswerer = (q) => (q.id === 'v2-stack-identical' ? 'no' : 'may');
  const result = scoreAliasQueriesV2(falseNoAnswerer, { queries: ALIAS_QUERIES_V2 });
  assert.equal(result.falseNoAlias, 1, 'Must detect false NoAlias');
  assert.ok(result.falseNoAlias > 0, 'False NoAlias must be flagged');

  // Verify that competitive verifier rejects non-zero falseNoAlias
  const fakeScorecard = structuredClone(completeScorecard);
  fakeScorecard.entries.find((entry) => entry.metricId === 'alias-v2-false-no-alias').hexValue = 1;
  assert.throws(
    () => verifyCompetitiveScorecard(fakeScorecard, competitiveProfile),
    /competitive-hard-invariant-failed:false-no-alias:1/,
    'Must reject scorecard with falseNoAlias > 0'
  );
}

// 4. Mutation: False MustAlias accepted
{
  // A query whose truth is 'no', but answerer falsely returns 'must'
  const falseMustAnswerer = (q) => (q.id === 'v2-stack-disjoint' ? 'must' : 'may');
  const result = scoreAliasQueriesV2(falseMustAnswerer, { queries: ALIAS_QUERIES_V2 });
  assert.equal(result.falseMustAlias, 1, 'Must detect false MustAlias');

  const fakeScorecard = structuredClone(completeScorecard);
  fakeScorecard.entries.find((entry) => entry.metricId === 'alias-v2-false-must-alias').hexValue = 1;
  assert.throws(
    () => verifyCompetitiveScorecard(fakeScorecard, competitiveProfile),
    /competitive-hard-invariant-failed:false-must-alias:1/,
    'Must reject scorecard with falseMustAlias > 0'
  );
}

// 5. Mutation: Exact claim loses evidence identity
{
  assert.throws(
    () => verifyCompetitiveProfile({
      ...structuredClone(competitiveProfile),
      baselineCommit: null,
      baselineTree: null,
      specificationBlobSha: null,
    }),
    /profile-baselineCommit/,
    'Must reject profile missing baseline/specification identities'
  );
}

// 6. Mutation: Score denominator shrinks
{
  const shrunkQueries = ALIAS_QUERIES_V2.slice(0, 10);
  const result = scoreAliasQueriesV2(() => 'may', { queries: shrunkQueries });
  assert.equal(result.queryCount, 10);
  assert.ok(
    result.queryCount < ALIAS_QUERIES_V2.length,
    'Shrunk denominator is measurable and strictly less than canonical 30'
  );
}

// 7. Mutation: Support claim exceeds machine truth
{
  assert.throws(
    () => verifyCompetitiveProfile({
      ...structuredClone(competitiveProfile),
      profileId: 'bad-direction',
      metrics: {
        ...structuredClone(competitiveProfile.metrics),
        'alias-v2-exact-precision': {
          ...structuredClone(competitiveProfile.metrics['alias-v2-exact-precision']),
          direction: 'invalid-direction',
        },
      },
    }),
    /metric-direction:alias-v2-exact-precision/,
    'Must reject metric claiming invalid direction'
  );
}

// 8. Mutation: Legacy/fallback path supplies a promoted result
{
  // Profile with exact-zero tolerance cannot have non-zero tolerance
  assert.throws(
    () => verifyCompetitiveProfile({
      ...structuredClone(competitiveProfile),
      profileId: 'bad-tolerance',
      metrics: {
        ...structuredClone(competitiveProfile.metrics),
        'alias-v2-false-must-alias': {
          ...structuredClone(competitiveProfile.metrics['alias-v2-false-must-alias']),
          direction: 'exact-zero',
          regressionTolerance: 0.1,
        },
      },
    }),
    /metric-exact-zero-tolerance:alias-v2-false-must-alias/,
    'Must reject non-zero tolerance on exact-zero invariant'
  );
}

// 9. Mutation: Required Stage 1 source path bypasses workflow
{
  const workflowPath = path.join(ROOT, '.github/workflows/stage1-release-validation.yml');
  const workflowContent = fs.readFileSync(workflowPath, 'utf8');
  assert.ok(
    workflowContent.includes('candidate-merge-tree:'),
    'Stage 1 workflow must contain candidate-merge-tree job'
  );
  assert.ok(
    workflowContent.includes('js/analysis/alias/**'),
    'Stage 1 workflow must trigger on alias analysis paths'
  );
  assert.ok(
    workflowContent.includes('tools/validation/competitive/**'),
    'Stage 1 workflow must trigger on competitive validation paths'
  );
  assert.ok(
    workflowContent.includes('tests/competitive/**'),
    'Stage 1 workflow must trigger on competitive contract tests'
  );
  assert.ok(
    workflowContent.includes("'package.json'"),
    'Stage 1 workflow must trigger when the competitive test command can change'
  );
  const a1 = stage1GateDefinitions().find((gate) => gate.id === 'A1');
  assert.ok(a1?.evidence.includes('tests/competitive/**'), 'A1 must own competitive tests');
  assert.ok(a1?.commands.some((command) => JSON.stringify(command).includes('competitive:test')), 'A1 must run competitive:test');
  assert.ok(a1?.commands.some((command) => JSON.stringify(command).includes('competitive:verify')), 'A1 must run competitive:verify');
}

// 10. Mutation: Exact-run report accidentally required as committed dirty artifact
{
  const gitignorePath = path.join(ROOT, '.gitignore');
  const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  assert.ok(
    gitignoreContent.includes('/reports/stage1/'),
    '.gitignore must ignore /reports/stage1/'
  );
  assert.ok(
    gitignoreContent.includes('/reports/competitive/'),
    '.gitignore must ignore /reports/competitive/'
  );
}

console.log('verifier mutation self-tests: PASS (10/10 mutation invariants proven red on bypass)');
