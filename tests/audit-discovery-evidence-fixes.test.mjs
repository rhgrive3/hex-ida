import test from 'node:test';
import assert from 'node:assert/strict';

import {
  functionDiscoveryArtifact,
  discoveryArtifactForRebuild,
  verifyDiscoveryReparse,
} from '../js/analysis/discovery/artifact.js';
import { createAppAnalysisQueryAdapter } from '../js/analysis/query/product-evidence-adapter.js';

function makeBinding(suffix = 'src') {
  return {
    binaryId: 'binary:audit-discovery-evidence',
    sourceHash: `hash:${suffix}`,
    snapshotId: `snapshot:${suffix}`,
    architectureId: 'x86_64',
  };
}

test('buildCollisionsV1 scales past 1,500+ functions without prematurely exhausting maxCollisionChecks', () => {
  const count = 2_000;
  const functions = Array.from({ length: count }, (_, i) => ({
    address: 0x10000 + i * 0x40,
    source: 'function_starts',
    sizeBytes: 0x40,
  }));
  const jumpTableTargets = Array.from({ length: count }, (_, i) => ({
    address: 0x10000 + i * 0x40,
    tableAddress: 0x200000 + i * 8,
    tableId: `jt:${i}`,
  }));

  const { artifact } = functionDiscoveryArtifact({
    input: { image: { functions, jumpTableTargets } },
    ...makeBinding('scale-2k'),
  });

  assert.equal(artifact.publication.status, 'complete');
  assert.equal(artifact.publication.reason, null);
  assert.equal(artifact.resource.ok, true);
  assert.equal(artifact.functionCandidates.length, count);
  assert.equal(artifact.intervalClaims.length, count);
  assert.equal(artifact.references.length, count);
  assert.equal(artifact.collisionSets.length, 0);
  assert.equal(artifact.resource.observed.collisionChecks, 0);
});

test('buildCollisionsV1 preserves exact collision detection, boundary rules, and deterministic ordering', () => {
  const imageA = {
    functions: [
      { address: 0x1000, source: 'function_starts', sizeBytes: 0x40 },
      { address: 0x1020, source: 'function_starts', sizeBytes: 0x40 },
      { address: 0x1040, source: 'function_starts', sizeBytes: 0x20 },
    ],
    symbols: [
      { address: 0x1010, name: 'mid_symbol', isFunction: true },
    ],
    byteIntervals: [
      { kind: 'data', start: 0x1008, end: 0x1018, producerId: 'fixture.data', origin: 'inline-data' },
    ],
    jumpTableTargets: [
      // Boundary addresses (exact start / exact end) must not trigger code-reference
      { address: 0x1000, tableAddress: 0x9000, tableId: 'jt:at-start' },
      { address: 0x1040, tableAddress: 0x9008, tableId: 'jt:at-end' },
      // Strictly interior to 0x1000..0x1040 (and 0x1020..0x1060 for 0x1028)
      { address: 0x1014, tableAddress: 0x9010, tableId: 'jt:inside-first' },
      { address: 0x1028, tableAddress: 0x9018, tableId: 'jt:inside-both' },
    ],
  };

  // Permuted input order must produce byte-identical collision sets and ordering
  const imageB = {
    functions: [...imageA.functions].reverse(),
    symbols: [...imageA.symbols],
    byteIntervals: [...imageA.byteIntervals],
    jumpTableTargets: [...imageA.jumpTableTargets].reverse(),
  };

  const resA = functionDiscoveryArtifact({ input: { image: imageA }, ...makeBinding('det-a') }).artifact;
  const resB = functionDiscoveryArtifact({ input: { image: imageB }, ...makeBinding('det-a') }).artifact;

  assert.equal(resA.publication.status, 'complete');
  assert.deepEqual(resA.collisionSets, resB.collisionSets);

  const byKind = (kind) => resA.collisionSets.filter((c) => c.kind === kind);
  assert.equal(byKind('code-data').length, 1);
  assert.equal(byKind('function-overlap').length, 2); // (0x1000,0x1020) and (0x1020,0x1040)
  // 0x1010 is inside [0x1000,0x1040); 0x1020 is inside [0x1000,0x1040); 0x1040 is inside [0x1020,0x1060)
  const containedAts = byKind('function-contained-start').map((c) => c.at).sort();
  assert.deepEqual(containedAts, [String(0x1010), String(0x1020), String(0x1040)].sort());

  // 0x1014 inside [0x1000,0x1040); 0x1028 inside [0x1000,0x1040) and [0x1020,0x1060); 0x1040 inside [0x1020,0x1060)
  const refAts = byKind('code-reference').map((c) => c.at).sort();
  assert.deepEqual(refAts, [String(0x1014), String(0x1028), String(0x1028), String(0x1040)].sort());

  // Verify collisionIds are strictly sorted
  const ids = resA.collisionSets.map((c) => c.collisionId);
  const sortedIds = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(ids, sortedIds);
});

test('buildCollisionsV1 enforces maxCollisionChecks budget semantics on overlapping work', () => {
  const image = {
    functions: [
      { address: 0x1000, source: 'function_starts', sizeBytes: 0x100 },
      { address: 0x1010, source: 'function_starts', sizeBytes: 0x100 },
      { address: 0x1020, source: 'function_starts', sizeBytes: 0x100 },
    ],
  };

  const { artifact } = functionDiscoveryArtifact({
    input: { image },
    ...makeBinding('budget-fail'),
    artifactBudget: { maxCollisionChecks: 2 },
  });

  assert.equal(artifact.publication.status, 'withheld');
  assert.equal(artifact.publication.reason, 'artifact-budget-exhausted:collisionV1-work');
  assert.equal(artifact.resource.ok, false);
  assert.equal(artifact.resource.reason, 'collisionV1-work');
  assert.equal(artifact.resource.observed.collisionChecks, 3);
});

test('verifyDiscoveryReparse V1 preserves missing collision/reference checks efficiently at scale', () => {
  const count = 600;
  const functions = Array.from({ length: count }, (_, i) => ({
    address: 0x20000 + i * 0x40,
    source: 'function_starts',
    sizeBytes: 0x40,
  }));
  const jumpTableTargets = Array.from({ length: count }, (_, i) => ({
    address: 0x20000 + i * 0x40 + 0x10,
    tableAddress: 0x300000 + i * 8,
    tableId: `jt:${i}`,
  }));

  const sourceArtifact = functionDiscoveryArtifact({
    input: { image: { functions, jumpTableTargets } },
    ...makeBinding('reparse-src'),
  }).artifact;
  assert.equal(sourceArtifact.publication.status, 'complete');
  assert.equal(sourceArtifact.collisionSets.length, count);

  const binding = discoveryArtifactForRebuild(sourceArtifact, {
    binaryId: 'binary:audit-discovery-evidence',
    sourceHash: 'hash:reparse-src',
    snapshotId: 'snapshot:reparse-src',
    architectureId: 'x86_64',
  });

  const matchingReparse = functionDiscoveryArtifact({
    input: { image: { functions, jumpTableTargets } },
    ...makeBinding('reparse-out'),
  }).artifact;
  const okResult = verifyDiscoveryReparse(binding, matchingReparse, { expectedOutputHash: 'hash:reparse-out' });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.missingCollisionIds.length, 0);
  assert.equal(okResult.missingReferenceIds.length, 0);

  const droppedReparse = functionDiscoveryArtifact({
    input: { image: { functions, jumpTableTargets: jumpTableTargets.slice(1) } },
    ...makeBinding('reparse-drop'),
  }).artifact;
  const failResult = verifyDiscoveryReparse(binding, droppedReparse, { expectedOutputHash: 'hash:reparse-drop' });
  assert.equal(failResult.ok, false);
  assert.equal(failResult.missingCollisionIds.length, 1);
  assert.equal(failResult.missingReferenceIds.length, 1);
});

test('product-evidence-adapter avoids invoking base.functionById on intermediate pages where suffix is discarded', async () => {
  const address = 0x1000n;
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, verdict: 'supported' }));
  let analyzeCalls = 0;

  const adapter = createAppAnalysisQueryAdapter({
    async getEvidence() { return rows; },
    async analyzeFunction() {
      analyzeCalls += 1;
      return {
        evidence: [{ id: 'analysis-0', verdict: 'supported' }],
        rewriteProof: [{ id: 'rewrite-0', verdict: 'supported', rule: 'r0' }],
      };
    },
    symbols: {
      nameAt(addr) { return addr === address ? 'fn_1000' : null; },
      nameEvidence(addr) { return addr === address ? { id: 'name-0', verdict: 'confirmed' } : null; },
      functionEvidence(addr) { return addr === address ? { id: 'boundary-0', verdict: 'confirmed' } : null; },
    },
  });

  const collected = [];
  let offset = 0;
  let pages = 0;
  while (pages < 20) {
    pages += 1;
    const res = await adapter.evidence({}, { address }, { offset, limit: 10 });
    collected.push(...res.value.map((r) => r.evidenceId));
    if (res.page.next == null) {
      assert.equal(res.status.completeness, 'complete');
      assert.equal(res.page.total, 54);
      break;
    }
    offset = res.page.next;
  }

  assert.equal(pages, 6);
  assert.equal(analyzeCalls, 1, 'base.functionById must only be called on the final page that needs suffix');
  assert.deepEqual(collected, [
    'name-0',
    'boundary-0',
    ...rows.map((r) => r.id),
    'analysis-0',
    'rewrite-0',
  ]);
});

test('product-evidence-adapter skips functionById when prefix fills page and upstream rows remain', async () => {
  const address = 0x2000n;
  let analyzeCalls = 0;

  // Single upstream row so baseHasNext is false, yet localCursor (2) < prefix (2) + upstream (1)
  const adapter = createAppAnalysisQueryAdapter({
    async getEvidence() { return [{ id: 'e0', verdict: 'supported' }]; },
    async analyzeFunction() {
      analyzeCalls += 1;
      return { evidence: [{ id: 'analysis-0', verdict: 'supported' }] };
    },
    symbols: {
      nameAt(addr) { return addr === address ? 'fn_2000' : null; },
      nameEvidence(addr) { return addr === address ? { id: 'name-0', verdict: 'confirmed' } : null; },
      functionEvidence(addr) { return addr === address ? { id: 'boundary-0', verdict: 'confirmed' } : null; },
    },
  });

  const page1 = await adapter.evidence({}, { address }, { offset: 0, limit: 2 });
  assert.deepEqual(page1.value.map((r) => r.evidenceId), ['name-0', 'boundary-0']);
  assert.equal(page1.page.next, 2);
  assert.equal(page1.page.total, null);
  assert.equal(page1.status.completeness, 'partial');
  assert.equal(analyzeCalls, 0);

  const page2 = await adapter.evidence({}, { address }, { offset: page1.page.next, limit: 10 });
  assert.deepEqual(page2.value.map((r) => r.evidenceId), ['e0', 'analysis-0']);
  assert.equal(page2.page.next, null);
  assert.equal(page2.page.total, 4);
  assert.equal(page2.status.completeness, 'complete');
  assert.equal(analyzeCalls, 1);
});

test('product-evidence-adapter handles exact upstream boundary without dropping suffix or creating phantom continuation', async () => {
  const address = 0x3000n;

  // Case 1: exact boundary with non-empty suffix must continue to suffix page
  {
    const adapter = createAppAnalysisQueryAdapter({
      async getEvidence() { return [{ id: 'e0', verdict: 'supported' }, { id: 'e1', verdict: 'supported' }]; },
      async analyzeFunction() {
        return { evidence: [{ id: 'analysis-0', verdict: 'supported' }] };
      },
      symbols: {
        nameAt(addr) { return addr === address ? 'fn_3000' : null; },
        nameEvidence(addr) { return addr === address ? { id: 'name-0', verdict: 'confirmed' } : null; },
      },
    });

    const page1 = await adapter.evidence({}, { address }, { offset: 0, limit: 3 });
    assert.deepEqual(page1.value.map((r) => r.evidenceId), ['name-0', 'e0', 'e1']);
    assert.equal(page1.page.next, 3);

    const page2 = await adapter.evidence({}, { address }, { offset: page1.page.next, limit: 3 });
    assert.deepEqual(page2.value.map((r) => r.evidenceId), ['analysis-0']);
    assert.equal(page2.page.next, null);
    assert.equal(page2.page.total, 4);
  }

  // Case 2: exact boundary with empty suffix must terminate cleanly without phantom continuation
  {
    const adapter = createAppAnalysisQueryAdapter({
      async getEvidence() { return [{ id: 'e0', verdict: 'supported' }, { id: 'e1', verdict: 'supported' }]; },
      async analyzeFunction() { return { evidence: [] }; },
      symbols: {
        nameAt(addr) { return addr === address ? 'fn_3000' : null; },
        nameEvidence(addr) { return addr === address ? { id: 'name-0', verdict: 'confirmed' } : null; },
      },
    });

    const page1 = await adapter.evidence({}, { address }, { offset: 0, limit: 3 });
    assert.deepEqual(page1.value.map((r) => r.evidenceId), ['name-0', 'e0', 'e1']);
    assert.equal(page1.page.next, null);
    assert.equal(page1.page.total, 3);
    assert.equal(page1.status.completeness, 'complete');
  }
});
