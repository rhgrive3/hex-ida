// Issue #5339 regression: reconstructStructuralType() rounded canonical exact
// BigInt layout values through Number(), so a legal offset/size above
// Number.MAX_SAFE_INTEGER (e.g. 2^53 + 1) was published one byte early as a
// rounded Number. The projection must preserve exact integers.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createTypeClaim } from '../../../js/analysis/types/constraints.js';
import { createTypeResult, reconstructStructuralType } from '../../../js/analysis/types/graph.js';

const HUGE = 9007199254740993n; // 2^53 + 1

function hugeTypeResult() {
  const selected = createTypeClaim({
    layer: 'structural',
    entityId: 'Huge',
    descriptor: {
      kind: 'struct',
      alignBytes: 8n,
      totalSizeBytes: HUGE + 8n,
      members: [
        { offset: HUGE, sizeBytes: 1n, alignBytes: 1n, memberType: { kind: 'integer', widthBits: 8 } },
        { offset: 0n, sizeBytes: 8n, alignBytes: 8n, memberType: { kind: 'pointer', widthBits: 64 } },
      ],
    },
  });
  const status = createAnalysisStatus({
    snapshotId: 's',
    analyzerId: 'phase7.types.constraint-graph',
    analyzerVersion: '1.1.0',
    completeness: 'complete',
    stopReason: null,
  });
  return createTypeResult({
    entityId: 'Huge',
    status,
    layers: {
      structural: {
        selected,
        confidence: 'certain',
        contradictions: [],
        candidates: [],
        hardConstraints: [],
        softEvidence: [],
      },
    },
  });
}

test('#5339 out-of-safe-range layout integers stay exact through the projection', () => {
  const projected = reconstructStructuralType(hugeTypeResult(), 'Huge');
  const hugeMember = projected.members.find((m) => m.offset > Number.MAX_SAFE_INTEGER || m.offset === HUGE);
  assert.ok(hugeMember, 'the huge-offset member must survive projection');
  assert.equal(hugeMember.offset, HUGE, 'offset 2^53+1 must not be rounded to 2^53');
  assert.equal(typeof hugeMember.offset, 'bigint');
  assert.equal(projected.sizeBytes, HUGE + 8n, 'total size stays exact above the safe range');
  assert.equal(projected.alignBytes, 8);
});

test('#5339 safe-range layouts keep the exact prior Number projection', () => {
  const selected = createTypeClaim({
    layer: 'structural',
    entityId: 'Small',
    descriptor: {
      kind: 'struct',
      alignBytes: 8n,
      totalSizeBytes: 16n,
      members: [
        { offset: 0n, sizeBytes: 8n, alignBytes: 8n, memberType: { kind: 'pointer', widthBits: 64 } },
        { offset: 8n, sizeBytes: 4n, alignBytes: 4n, memberType: { kind: 'integer', widthBits: 32 } },
      ],
    },
  });
  const status = createAnalysisStatus({
    snapshotId: 's',
    analyzerId: 'phase7.types.constraint-graph',
    analyzerVersion: '1.1.0',
    completeness: 'complete',
    stopReason: null,
  });
  const result = createTypeResult({
    entityId: 'Small',
    status,
    layers: { structural: { selected, confidence: 'certain', contradictions: [], candidates: [], hardConstraints: [], softEvidence: [] } },
  });
  const projected = reconstructStructuralType(result, 'Small');
  assert.equal(projected.sizeBytes, 16);
  assert.equal(typeof projected.sizeBytes, 'number', 'safe-range totals keep projecting to Number');
  assert.deepEqual(projected.members.map((m) => m.offset), [0, 8]);
  assert.deepEqual(projected.members.map((m) => m.sizeBytes), [8, 4]);
});

test('#5339 derived total size stays exact when only the descriptor span is huge', () => {
  const selected = createTypeClaim({
    layer: 'structural',
    entityId: 'Span',
    descriptor: {
      kind: 'struct',
      alignBytes: 4n,
      members: [
        { offset: 0n, sizeBytes: 4n, alignBytes: 4n, memberType: { kind: 'integer', widthBits: 32 } },
        { offset: HUGE, sizeBytes: 2n, alignBytes: 1n, memberType: { kind: 'integer', widthBits: 8 } },
      ],
    },
  });
  const status = createAnalysisStatus({
    snapshotId: 's',
    analyzerId: 'phase7.types.constraint-graph',
    analyzerVersion: '1.1.0',
    completeness: 'complete',
    stopReason: null,
  });
  const result = createTypeResult({
    entityId: 'Span',
    status,
    layers: { structural: { selected, confidence: 'certain', contradictions: [], candidates: [], hardConstraints: [], softEvidence: [] } },
  });
  const projected = reconstructStructuralType(result, 'Span');
  // span = 2^53 + 3 (offset HUGE + 2 bytes), aligned up to 4 → 2^53 + 4n is
  // NOT 4-aligned; the exact aligned value is 9007199254740996 (HUGE + 3).
  assert.equal(projected.sizeBytes, HUGE + 3n);
});
