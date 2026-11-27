import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISCOVERY_TYPED_VALUE_SCHEMA,
  canonicalTypedValue,
  canonicalTypedString,
  canonicalTypedDigest,
} from '../js/analysis/discovery/canonical-value.js';
import {
  claimsConflict,
  createTypeClaim,
} from '../js/analysis/types/constraints.js';
import {
  compareCanonicalAliasCells,
} from '../js/analysis/query/semantic/demand-alias.js';
import { createPointsToSet } from '../js/analysis/pointsto/lattice.js';
import { createAnalysisStatus } from '../js/analysis/status.js';

// =============================================================================
// 1. P2-S13-001: canonical-value.js non-enumerable toJSON bypass & tampering
// =============================================================================

test('P2-S13-001: canonicalTypedValue ignores non-enumerable toJSON on outer frame and nested nodes', () => {
  let called = 0;
  const poison = (obj, label) => {
    Object.defineProperty(obj, 'toJSON', {
      enumerable: false,
      configurable: true,
      value() {
        called += 1;
        return { forged: label };
      },
    });
    return obj;
  };

  const leafNum = poison({ t: 'number', v: '42' }, 'leaf-num');
  const leafStr = poison({ t: 'string', v: 'ok' }, 'leaf-str');
  const entryA = poison(['a', leafNum], 'entry-a');
  const entryB = poison(['b', leafStr], 'entry-b');
  const entries = poison([entryA, entryB], 'entries');
  const objNode = poison({ t: 'object', v: entries }, 'obj-node');
  const arrItems = poison([objNode, poison({ t: 'null' }, 'null-node'), poison({ t: 'hole' }, 'hole-node')], 'arr-items');
  const rootNode = poison({ t: 'array', v: arrItems }, 'root-node');
  const frame = poison({ schema: DISCOVERY_TYPED_VALUE_SCHEMA, value: rootNode }, 'outer-frame');

  const cleanFrame = {
    schema: DISCOVERY_TYPED_VALUE_SCHEMA,
    value: {
      t: 'array',
      v: [
        { t: 'object', v: [['a', { t: 'number', v: '42' }], ['b', { t: 'string', v: 'ok' }]] },
        { t: 'null' },
        { t: 'hole' },
      ],
    },
  };

  const canonical = canonicalTypedValue(frame);
  assert.equal(called, 0, 'non-enumerable toJSON must never be invoked');
  assert.deepStrictEqual(canonical, cleanFrame);
  assert.equal(Object.isFrozen(canonical), true);
  assert.equal(Object.isFrozen(canonical.value), true);
  assert.equal(Object.isFrozen(canonical.value.v), true);
  assert.equal(Object.hasOwn(canonical, 'toJSON'), false);
  assert.equal(Object.hasOwn(canonical.value, 'toJSON'), false);

  assert.equal(canonicalTypedString(frame), canonicalTypedString(cleanFrame));
  assert.equal(canonicalTypedDigest(frame), canonicalTypedDigest(cleanFrame));
  assert.equal(called, 0, 'canonicalTypedString/Digest must not invoke input toJSON');

  // Mutating original input after canonicalization must not affect canonical output
  arrItems.push({ t: 'boolean', v: true });
  assert.equal(canonical.value.v.length, 3);
});

test('P2-S13-001: null/hole node with non-enumerable t and extra enumerable key is rejected', () => {
  const forgedNull = { extra: 1 };
  Object.defineProperty(forgedNull, 't', { value: 'null', enumerable: false });
  const frame = { schema: DISCOVERY_TYPED_VALUE_SCHEMA, value: forgedNull };
  assert.throws(() => canonicalTypedValue(frame), /discovery-typed-value-frame-invalid/);
});

// =============================================================================
// 2. P1-S04-001: constraints.js top-level structural pointer conflict detection
// =============================================================================

function structuralClaim(descriptor, entityId = 'entity:ptr') {
  return createTypeClaim({ layer: 'structural', entityId, descriptor });
}

test('P1-S04-001: claimsConflict detects incompatible top-level structural pointer claims', () => {
  const ptrA = structuralClaim({ kind: 'pointer', targetEntityId: 'type:A', sizeBytes: 8 });
  const ptrB = structuralClaim({ kind: 'pointer', targetEntityId: 'type:B', sizeBytes: 8 });
  assert.equal(claimsConflict(ptrA, ptrB), true, 'different targetEntityId must conflict');
  assert.equal(claimsConflict(ptrB, ptrA), true);

  const ptrInt = structuralClaim({ kind: 'pointer', pointeeType: { kind: 'integer', widthBits: 32, signed: true } });
  const ptrFloat = structuralClaim({ kind: 'pointer', pointeeType: { kind: 'float', widthBits: 64 } });
  assert.equal(claimsConflict(ptrInt, ptrFloat), true, 'different pointeeType must conflict');

  const ptrRam = structuralClaim({ kind: 'pointer', addressSpace: 'ram' });
  const ptrStack = structuralClaim({ kind: 'pointer', addressSpace: 'stack' });
  assert.equal(claimsConflict(ptrRam, ptrStack), true, 'different addressSpace must conflict');

  const ptrNullable = structuralClaim({ kind: 'pointer', nullable: true });
  const ptrNonNull = structuralClaim({ kind: 'pointer', nullable: false });
  assert.equal(claimsConflict(ptrNullable, ptrNonNull), true, 'different nullable must conflict');

  const ptr64 = structuralClaim({ kind: 'pointer', widthBits: 64 });
  const ptr32 = structuralClaim({ kind: 'pointer', widthBits: 32 });
  assert.equal(claimsConflict(ptr64, ptr32), true, 'different widthBits must conflict');

  const ptrConst = structuralClaim({ kind: 'pointer', const: true });
  const ptrMut = structuralClaim({ kind: 'pointer', const: false });
  assert.equal(claimsConflict(ptrConst, ptrMut), true, 'different const qualifier must conflict');

  const nestedPtrA = structuralClaim({
    kind: 'pointer',
    pointeeType: { kind: 'pointer', addressSpace: 'ram', nullable: false },
  });
  const nestedPtrB = structuralClaim({
    kind: 'pointer',
    pointeeType: { kind: 'pointer', addressSpace: 'stack', nullable: false },
  });
  assert.equal(claimsConflict(nestedPtrA, nestedPtrB), true, 'nested pointer addressSpace mismatch must conflict');
});

test('P1-S04-001: claimsConflict detects pointer vs field/struct/union/array conflicts', () => {
  const ptr = structuralClaim({ kind: 'pointer', targetEntityId: 'type:A', sizeBytes: 8 });
  const implicitField = structuralClaim({ offset: 0, sizeBytes: 4, memberType: { kind: 'integer', widthBits: 32 } });
  const explicitField = structuralClaim({ kind: 'field', offset: 0, sizeBytes: 4 });
  const structClaim = structuralClaim({ kind: 'struct', totalSizeBytes: 8 });
  const unionClaim = structuralClaim({ kind: 'union', totalSizeBytes: 8 });
  const arrayClaim = structuralClaim({ kind: 'array', strideBytes: 4, length: 2 });

  for (const [label, other] of [
    ['implicit field', implicitField],
    ['explicit field', explicitField],
    ['struct', structClaim],
    ['union', unionClaim],
    ['array', arrayClaim],
  ]) {
    assert.equal(claimsConflict(ptr, other), true, `pointer vs ${label} must conflict`);
    assert.equal(claimsConflict(other, ptr), true, `${label} vs pointer must conflict`);
  }
});

test('P1-S04-001: claimsConflict allows compatible additive top-level structural pointer claims', () => {
  const ptrTarget = structuralClaim({ kind: 'pointer', targetEntityId: 'type:Node', sizeBytes: 8 });
  const ptrDetail = structuralClaim({
    kind: 'pointer',
    targetEntityId: 'type:Node',
    pointeeType: { kind: 'struct', totalSizeBytes: 16 },
    addressSpace: 'ram',
    nullable: false,
    sizeBytes: '8',
  });
  assert.equal(claimsConflict(ptrTarget, ptrDetail), false);
  assert.equal(claimsConflict(ptrDetail, ptrTarget), false);
});

// =============================================================================
// 3. P1-S12-002: demand-alias.js compareCanonicalAliasCells right.ownerStatus
// =============================================================================

function makeCell(address, ownerStatus) {
  return {
    valueId: `val:${address}`,
    ownerStatus,
    pointsTo: createPointsToSet({
      targets: [{
        rootKind: 'absolute',
        address: String(address),
        addressSpace: 'memory',
        widthBits: 64,
        offsetRange: { min: 0n, max: 0n },
      }],
    }),
  };
}

function makeStatus(overrides = {}) {
  return createAnalysisStatus({
    snapshotId: 'snap-track4',
    analyzerId: 'phase7.pointsto.a2-local',
    analyzerVersion: '1.2.1',
    completeness: 'complete',
    ...overrides,
  });
}

test('P1-S12-002: compareCanonicalAliasCells respects right.ownerStatus when incomplete or missing', () => {
  const complete = makeStatus();
  const partial = makeStatus({ completeness: 'partial', stopReason: 'widened' });
  const truncated = makeStatus({ completeness: 'truncated', stopReason: 'iteration-limit' });
  const unsupported = makeStatus({ completeness: 'unsupported', stopReason: 'unsupported-input' });
  const bounded = makeStatus({ completeness: 'bounded', stopReason: 'widened' });
  const otherSnap = makeStatus({ snapshotId: 'snap-other' });

  // Disjoint addresses (would falsely return 'no' + 'complete' if right.ownerStatus were ignored)
  for (const [label, rightStatus, expectedCompleteness] of [
    ['partial', partial, 'partial'],
    ['truncated', truncated, 'truncated'],
    ['unsupported', unsupported, 'unsupported'],
    ['missing', null, 'unsupported'],
    ['snapshot-mismatch', otherSnap, 'unsupported'],
  ]) {
    const res = compareCanonicalAliasCells(makeCell(0x1000, complete), makeCell(0x2000, rightStatus));
    assert.equal(res.relation, 'unknown', `${label} right.ownerStatus must yield unknown relation`);
    assert.equal(res.status.completeness, expectedCompleteness, `${label} right.ownerStatus must downgrade completeness`);
  }

  // Same address (would falsely return 'must' + 'complete' if right.ownerStatus were ignored)
  const samePartial = compareCanonicalAliasCells(makeCell(0x1000, complete), makeCell(0x1000, partial));
  assert.equal(samePartial.relation, 'unknown');
  assert.equal(samePartial.status.completeness, 'partial');

  // Bounded right status must not publish as 'complete'
  const boundedRes = compareCanonicalAliasCells(makeCell(0x1000, complete), makeCell(0x2000, bounded));
  assert.equal(boundedRes.status.completeness, 'bounded');

  // Malformed partial status without stopReason still fails closed
  const malformedPartial = { ...complete, completeness: 'partial', stopReason: null };
  const malformedRes = compareCanonicalAliasCells(makeCell(0x1000, complete), makeCell(0x2000, malformedPartial));
  assert.equal(malformedRes.relation, 'unknown');
  assert.notEqual(malformedRes.status.completeness, 'complete');
});

test('P1-S12-002: compareCanonicalAliasCells preserves complete no/must when both ownerStatus are complete', () => {
  const complete = makeStatus();
  const noAlias = compareCanonicalAliasCells(makeCell(0x1000, complete), makeCell(0x2000, complete));
  assert.equal(noAlias.relation, 'no');
  assert.equal(noAlias.status.completeness, 'complete');

  const mustAlias = compareCanonicalAliasCells(makeCell(0x1000, complete), makeCell(0x1000, complete));
  assert.equal(mustAlias.relation, 'must');
  assert.equal(mustAlias.status.completeness, 'complete');
});
