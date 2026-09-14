import assert from 'node:assert/strict';
import { __symmetricWorkspaceInternalsForTests } from '../js/diff/symmetric-workspace-runtime.js';

const { workspaceCompleteness } = __symmetricWorkspaceInternalsForTests;
const full = { complete:true, fingerprintVersion:4, total:2, scanned:2, missingEvidence:0 };

{
  const completeness = workspaceCompleteness({ complete:false, truncated:false, ambiguous:true }, full, full);
  assert.equal(completeness.complete, false);
  assert.ok(completeness.reasons.includes('matcher-ambiguous'));
}
{
  const completeness = workspaceCompleteness({ complete:false, truncated:false, ambiguous:false }, full, full);
  assert.equal(completeness.complete, false);
  assert.ok(completeness.reasons.includes('matcher-incomplete'));
}
{
  const completeness = workspaceCompleteness({ complete:true, truncated:false, ambiguous:false }, full, full);
  assert.equal(completeness.complete, true);
  assert.deepEqual(completeness.reasons, []);
}
{
  const incompleteBefore = { ...full, complete:false, truncationReason:'baseline-budget' };
  const completeness = workspaceCompleteness({ complete:true, truncated:false, ambiguous:false }, incompleteBefore, full);
  assert.equal(completeness.complete, false);
  assert.ok(completeness.reasons.includes('baseline-budget'));
}

console.log('issue-3625 symmetric workspace completeness: PASS');
