import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisSurface } from '../../../js/analysis/index.js';
import { deriveMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';
import {
  createFunctionSummary,
  summaryMayWriteRegion,
} from '../../../js/analysis/summary/contract.js';
import { buildFixture } from '../corpus/fixtures.mjs';

const complete = createAnalysisStatus({
  snapshotId: 's4064',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.1.0',
  completeness: 'complete',
});
const partial = createAnalysisStatus({
  snapshotId: 's4064',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.1.0',
  completeness: 'partial',
  stopReason: 'evidence-missing',
});

const origin = (name) => ({ instructionIds: [`instruction_${name}`] });

function stack(name, offset, widthBits) {
  return deriveMemoryRegion({
    functionId: 'fn4064',
    widthBits,
    origin: origin(name),
    regionEvidence: { kind: 'stack-fixed', offset },
  });
}

function globalRegion(name, address, widthBits) {
  return deriveMemoryRegion({
    functionId: 'fn4064',
    binaryId: 'bin4064',
    widthBits,
    origin: origin(name),
    regionEvidence: { kind: 'global-absolute', address },
  });
}

function rooted(name, rootEntityId, offset, widthBits) {
  return deriveMemoryRegion({
    functionId: 'fn4064',
    binaryId: 'bin4064',
    widthBits,
    origin: origin(name),
    regionEvidence: { kind: 'rooted-offset', rootEntityId, offset },
  });
}

function io(name, addressSpace, rootIdentity) {
  return deriveMemoryRegion({
    functionId: 'fn4064',
    binaryId: 'bin4064',
    widthBits: 32,
    origin: origin(name),
    addressSpace,
    regionEvidence: { kind: 'io', addressSpace, rootIdentity },
  });
}

function summaryWithWrite(region, { status = complete } = {}) {
  return createFunctionSummary({
    functionId: 'fn4064',
    status,
    noreturn: false,
    mayThrow: false,
    memoryWriteRegions: [{
      regionId: region.id,
      regionKind: region.kind,
      region,
      broad: false,
      addressSpaces: [region.addressSpace ?? 'memory'],
      source: 'proven-summary',
    }],
  });
}

test('exact identity remains a may-write shortcut', () => {
  const write = stack('exact-write', 0, 64);
  const summary = summaryWithWrite(write);
  assert.equal(summaryMayWriteRegion(summary, write.id), true);
  assert.equal(summaryMayWriteRegion(summary, write), true);
});

test('stack partial overlap is may-write while a proven disjoint interval is not', () => {
  const write = stack('stack-write', 0, 64);      // [0, 8)
  const overlap = stack('stack-overlap', 4, 32); // [4, 8)
  const disjoint = stack('stack-disjoint', 8, 32); // [8, 12)
  const summary = summaryWithWrite(write);
  assert.notEqual(write.id, overlap.id);
  assert.equal(summaryMayWriteRegion(summary, overlap), true);
  assert.equal(summaryMayWriteRegion(summary, disjoint), false);
});

test('global and rooted-offset partial overlaps are may-write', () => {
  const globalWrite = globalRegion('global-write', '0x1000', 64);
  const globalOverlap = globalRegion('global-overlap', '0x1004', 32);
  assert.equal(summaryMayWriteRegion(summaryWithWrite(globalWrite), globalOverlap), true);

  const rootedWrite = rooted('rooted-write', 'root_shared', 0, 64);
  const rootedOverlap = rooted('rooted-overlap', 'root_shared', 4, 32);
  assert.equal(summaryMayWriteRegion(summaryWithWrite(rootedWrite), rootedOverlap), true);
});

test('proven disjoint global and same-root intervals retain NoWrite precision', () => {
  const globalWrite = globalRegion('global-disjoint-write', '0x1000', 32);
  const globalQuery = globalRegion('global-disjoint-query', '0x1010', 32);
  assert.equal(summaryMayWriteRegion(summaryWithWrite(globalWrite), globalQuery), false);

  const rootedWrite = rooted('rooted-disjoint-write', 'root_shared', 0, 32);
  const rootedQuery = rooted('rooted-disjoint-query', 'root_shared', 16, 32);
  assert.equal(summaryMayWriteRegion(summaryWithWrite(rootedWrite), rootedQuery), false);
});

test('different rooted identities do not become a separation proof by themselves', () => {
  const write = rooted('root-a', 'root_a', 0, 32);
  const query = rooted('root-b', 'root_b', 0, 32);
  assert.equal(summaryMayWriteRegion(summaryWithWrite(write), query), true);
});

test('positive physical-address-space separation can prove no-write', () => {
  const write = io('io-a', 'mmio-a', { port: 'a' });
  const query = io('io-b', 'mmio-b', { port: 'b' });
  assert.equal(summaryMayWriteRegion(summaryWithWrite(write), query), false);
});

test('legacy specific effects without canonical geometry fail open on an id mismatch', () => {
  const summary = createFunctionSummary({
    functionId: 'fn4064', status: complete, noreturn: false, mayThrow: false,
    memoryWriteRegions: [{
      regionId: 'legacy_region_id', regionKind: 'stack-fixed', broad: false,
      addressSpaces: ['memory'], source: 'proven-summary',
    }],
  });
  assert.equal(summaryMayWriteRegion(summary, stack('legacy-query', 128, 32)), true);
  assert.equal(summaryMayWriteRegion(summary, 'some_other_region_id'), true);
});

test('broad and incomplete summaries stay fail-open', () => {
  const query = stack('broad-query', 0, 32);
  const broad = createFunctionSummary({
    functionId: 'fn4064', status: complete, noreturn: false, mayThrow: false,
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'abi-rule' }],
  });
  assert.equal(summaryMayWriteRegion(broad, query), true);

  const incomplete = createFunctionSummary({
    functionId: 'fn4064', status: partial, noreturn: 'unknown', mayThrow: 'unknown',
    unknownCallEffects: [{ callSiteId: 'call4064', reason: 'summary-missing' }],
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback' }],
  });
  assert.equal(summaryMayWriteRegion(incomplete, query), true);
});


test('local producer retains canonical region proof for every specific access', () => {
  const built = buildFixture('stack-disjoint');
  const { summary } = buildLocalFunctionSummary(built.ir, built.cfg, built.ssa, built.memorySsa, {
    snapshotId: 's4064-local',
    resolveRegion: built.resolveRegion,
  });
  const specific = summary.memoryWriteRegions.filter((effect) => !effect.broad);
  assert.ok(specific.length > 0);
  for (const effect of specific) {
    assert.ok(effect.region, `missing region proof for ${effect.regionId}`);
    assert.equal(effect.region.id, effect.regionId);
    assert.equal(effect.region.kind, effect.regionKind);
  }
});

test('interprocedural composition retains region geometry used by overlap queries', () => {
  const write = stack('interproc-write', 0, 64);
  const overlap = stack('interproc-overlap', 4, 32);
  const disjoint = stack('interproc-disjoint', 8, 32);
  const leaf = summaryWithWrite(write);
  const caller = createFunctionSummary({
    functionId: 'caller4064', status: complete, noreturn: false, mayThrow: false,
    directCalls: [{
      callSiteId: 'call4064-interproc',
      targetEntityIds: ['fn4064'],
      summaryId: 'fn4064',
      effectSource: 'proven-summary',
    }],
  });
  const solved = solveInterproceduralSummaries({
    roots: ['caller4064'],
    localSummaries: new Map([['caller4064', caller], ['fn4064', leaf]]),
  });
  const result = solved.summaries.get('caller4064');
  const propagated = result.memoryWriteRegions.find((effect) => effect.regionId === write.id);
  assert.ok(propagated?.region);
  assert.equal(propagated.region.id, write.id);
  assert.equal(summaryMayWriteRegion(result, overlap), true);
  assert.equal(summaryMayWriteRegion(result, disjoint), false);
});

test('effect/query geometry is revalidated against canonical identity before proving separation', () => {
  const write = stack('tamper-write', 0, 64);
  assert.throws(() => createFunctionSummary({
    functionId: 'fn4064', status: complete, noreturn: false, mayThrow: false,
    memoryWriteRegions: [{
      regionId: write.id,
      regionKind: write.kind,
      region: { ...write, offset: '128' },
      broad: false,
      addressSpaces: ['memory'],
      source: 'proven-summary',
    }],
  }), /function-summary-invalid-region-proof/);

  const summary = summaryWithWrite(write);
  const forged = {
    ...summary,
    memoryWriteRegions: [{
      ...summary.memoryWriteRegions[0],
      region: { ...summary.memoryWriteRegions[0].region, offset: '128' },
    }],
  };
  const query = stack('tamper-query', 256, 32);
  assert.equal(summaryMayWriteRegion(forged, query), true,
    'forged geometry must fail open instead of manufacturing NoWrite');
  assert.equal(summaryMayWriteRegion(summary, { ...query, offset: '0' }), true,
    'a tampered query must also fail open');
});


test('public analysis surface accepts a canonical region query and fails open for id-only mismatch', () => {
  const built = buildFixture('stack-disjoint');
  const surface = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 's4064-surface',
    resolveRegion: built.resolveRegion,
  });
  const writes = surface.functionSummary().summary.memoryWriteRegions.filter((effect) => !effect.broad);
  assert.ok(writes.length >= 2);
  const first = writes[0].region;
  assert.ok(first);
  assert.equal(surface.memoryEffects({ region: first }).mayWrite, true);
  assert.equal(surface.memoryEffects({ regionId: 'unrelated-id-without-geometry' }).mayWrite, true);
  assert.equal(surface.memoryEffects({ regionId: 'wrong-id', region: first }).mayWrite, true,
    'conflicting id/object authority must fail open');
});
