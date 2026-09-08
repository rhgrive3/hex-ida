import assert from 'node:assert/strict';
import test from 'node:test';

import { createPointsToTarget, createPointsToSet } from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

// #6063: createPointsToTarget() validated rootEntityId with trim() but stored
// the raw string, so 'A' and ' A' produced different rootKeys — two identities
// for the same root — and strong NoAlias could be minted between them. The
// target boundary now stores the trimmed canonical token.

const complete = createAnalysisStatus({
  snapshotId: 'snapshot_issue_6063',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

const base = {
  addressSpace: 'memory',
  rootKind: 'rooted',
  rootIdentity: { id: 'shared-root' },
};

test('rootEntityId is stored as the canonical trimmed token (#6063)', () => {
  const target = createPointsToTarget({ ...base, rootEntityId: '  A  ' });
  assert.equal(target.rootEntityId, 'A', 'the raw whitespace-padded id must not survive into the target');
});

test('padded and unpadded ids of the same root share one root key (#6063)', () => {
  const padded = createPointsToTarget({ ...base, rootEntityId: '  A  ' });
  const plain = createPointsToTarget({ ...base, rootEntityId: 'A' });
  assert.equal(padded.rootKey, plain.rootKey, 'same root must not get two identities');
});

test('padded ids cannot mint strong NoAlias against their canonical form (#6063)', () => {
  // Escape analysis recorded the canonical root 'A' as non-escaping. The
  // padded spelling has a different rootKey on main, so the pair reads as two
  // distinct non-escaping roots — a false separation between one root.
  const padded = createPointsToTarget({ ...base, rootEntityId: '  A  ' });
  const plain = createPointsToTarget({ ...base, rootEntityId: 'A' });
  const result = pointsToAlias(
    createPointsToSet({ targets: [padded] }),
    createPointsToSet({ targets: [plain] }),
    { status: complete, widthBitsLeft: 64, widthBitsRight: 64, nonEscapingRoots: new Set(['A']) },
  );
  assert.notEqual(result.relation, 'no', 'a whitespace alias must not create a separation proof');
  assert.ok(!result.reasonCodes.includes('distinct-non-escaping-allocation'),
    'the roots are identical after canonicalization, so no allocation separation applies');
});

test('blank rootEntityId still degrades to null (#6063)', () => {
  const target = createPointsToTarget({ ...base, rootEntityId: '   ' });
  assert.equal(target.rootEntityId, null, 'existing whitespace-only semantics are unchanged');
});
