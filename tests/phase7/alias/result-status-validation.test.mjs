import assert from 'node:assert/strict';

import { createAliasResult, permitsSeparationTransform } from '../../../js/analysis/alias/result.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const complete = createAnalysisStatus({
  snapshotId:'issue-1913',
  analyzerId:'alias-test',
  analyzerVersion:'1',
  completeness:'complete',
});

const valid = createAliasResult({
  relation:'no',
  reasonCodes:['distinct-address-space'],
  status:complete,
});
assert.equal(valid.relation, 'no');
assert.equal(permitsSeparationTransform(valid), true);
assert.equal(valid.status.snapshotId, 'issue-1913');

assert.throws(() => createAliasResult({
  relation:'no',
  reasonCodes:['distinct-address-space'],
  status:{
    schemaVersion:1,
    snapshotId:'issue-1913',
    analyzerId:'alias-test',
    analyzerVersion:'1',
    completeness:'bounded',
    stopReason:null,
  },
}), /analysis-status-incomplete-requires-stop-reason/);

assert.throws(() => createAliasResult({
  relation:'no',
  reasonCodes:['distinct-address-space'],
  status:{
    schemaVersion:1,
    completeness:'complete',
    stopReason:null,
  },
}), /analysis-status-snapshot-required/);

console.log('alias result status revalidation (#1913): PASS');
