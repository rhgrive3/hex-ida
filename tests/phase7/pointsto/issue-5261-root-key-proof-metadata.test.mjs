import assert from 'node:assert/strict';
import {
  createPointsToTarget,
  createPointsToSet,
  exactRange,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const status = createAnalysisStatus({
  snapshotId: 'snapshot_issue_5261',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

// #5261: separation proof metadata is evidence ABOUT a root, not its storage
// identity. The same allocation observed through a producing path that carries
// the proof and one that does not must share one rootKey.
function baseInput() {
  return {
    addressSpace: 'memory',
    rootKind: 'heap-like',
    rootIdentity: 'alloc-1',
    rootEntityId: 'alloc-1',
    offsetRange: exactRange(0),
  };
}

{
  const plain = createPointsToTarget(baseInput());
  // Note: raw separationAuthority options are unproven self-claims (#6066) and
  // are stripped at the boundary; only separationClass survives as a passive
  // descriptor annotation. Both spellings must land on one rootKey.
  const annotated = createPointsToTarget({ ...baseInput(), separationClass: 'heap-like', separationAuthority: 'root-descriptor' });
  assert.equal(annotated.rootKey, plain.rootKey,
    'proof metadata must not fork the root identity key');
}

// The alias consequence: with one target's (forked) rootKey listed as proven
// non-escaping, main produced a false strong `no`. With one shared key the
// same storage at the same exact offset aliases identically.
{
  const a = createPointsToSet({ targets: [createPointsToTarget(baseInput())] });
  const b = createPointsToSet({ targets: [createPointsToTarget({ ...baseInput(), separationClass: 'heap-like' })] });
  const forkedKey = b.targets[0].rootKey;
  const rel = pointsToAlias(a, b, {
    status,
    widthBitsLeft: 64,
    widthBitsRight: 64,
    nonEscapingRoots: new Set([forkedKey]),
  });
  assert.equal(rel.relation, 'must',
    'identical storage at identical exact offset must not become a false NoAlias via a forked root key');
  assert.deepEqual(rel.reasonCodes, ['identical-root-and-exact-offset']);
}

// Genuinely distinct roots stay distinct (identity still in the key).
{
  const a = createPointsToSet({ targets: [createPointsToTarget(baseInput())] });
  const other = createPointsToSet({ targets: [createPointsToTarget({ ...baseInput(), rootEntityId: 'alloc-2', rootIdentity: 'alloc-2' })] });
  assert.notEqual(a.targets[0].rootKey, other.targets[0].rootKey);
}

// Offset differences still keep one root while separating exact ranges.
{
  const zero = createPointsToTarget(baseInput());
  const eight = createPointsToTarget({ ...baseInput(), offsetRange: exactRange(8) });
  assert.equal(zero.rootKey, eight.rootKey, 'offset is not part of the root key');
}

console.log('phase7 pointsto issue-5261 root-key proof-metadata fork: PASS');
