import assert from 'node:assert/strict';

import { createAliasResult, permitsSeparationTransform } from '../../../js/analysis/alias/result.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const complete = createAnalysisStatus({
  snapshotId:'issue-4053',
  analyzerId:'alias-test',
  analyzerVersion:'1',
  completeness:'complete',
});

const separationReason = 'disjoint-stack-interval';
const identityReason = 'identical-region-identity';

const noAlias = createAliasResult({
  relation:'no',
  reasonCodes:[separationReason],
  status:complete,
});
assert.equal(noAlias.relation, 'no');
assert.equal(permitsSeparationTransform(noAlias), true);

const mustAlias = createAliasResult({
  relation:'must',
  reasonCodes:[identityReason],
  status:complete,
});
assert.equal(mustAlias.relation, 'must');

assert.throws(() => createAliasResult({
  relation:'no',
  reasonCodes:[separationReason, identityReason],
  status:complete,
}), /alias-result-no-alias-conflicting-identity-proof/);

assert.throws(() => createAliasResult({
  relation:'must',
  reasonCodes:[identityReason, separationReason],
  status:complete,
}), /alias-result-must-alias-conflicting-separation-proof/);

// Preserve the existing requirement that the matching proof class is present.
assert.throws(() => createAliasResult({
  relation:'no',
  reasonCodes:[identityReason],
  status:complete,
}), /alias-result-no-alias-requires-separation-proof/);
assert.throws(() => createAliasResult({
  relation:'must',
  reasonCodes:[separationReason],
  status:complete,
}), /alias-result-must-alias-requires-identity-proof/);

// Weak answers keep their existing diagnostic reason semantics.
const mayAlias = createAliasResult({
  relation:'may',
  reasonCodes:[separationReason, identityReason],
  status:complete,
});
assert.equal(mayAlias.relation, 'may');
const unknownAlias = createAliasResult({
  relation:'unknown',
  reasonCodes:[separationReason, identityReason],
  status:complete,
});
assert.equal(unknownAlias.relation, 'unknown');

// A contradictory raw result cannot cross the transform-safety boundary.
assert.equal(permitsSeparationTransform({
  relation:'no',
  reasonCodes:[separationReason, identityReason],
  status:complete,
}), false);

console.log('alias contradictory strong proof reasons (#4053): PASS');
