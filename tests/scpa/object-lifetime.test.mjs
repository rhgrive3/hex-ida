import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor } from './helpers.mjs';
import { captured, callee, scope } from './native-owner-fixture.mjs';
import { createAnalysisSurface } from '../../js/analysis/index.js';
import { createCanonicalObjectLifetimeOwner } from '../../js/analysis/pointsto/object-lifetime.js';
import { createObjectPartition, createObjectContext, strongUpdateEligibility } from '../../js/analysis/pointsto/objects.js';
import { createPointsToTarget, createRootDescriptorSeparatedTarget, exactRange } from '../../js/analysis/pointsto/lattice.js';
import { deriveCanonicalAddressProof } from '../../js/analysis/alias/canonical-address-v2.js';
import { analyzeEscape } from '../../js/analysis/summary/escape.js';
import { createFunctionSummary } from '../../js/analysis/summary/contract.js';
import { projectScopedDemandOwners } from '../../js/analysis/scoped-demand-projection.js';

function source(t, { kind = 'stack-like', returned = false, incomplete = false, frees = [], tls = false } = {}) {
  const f = fixture(), functionId = 'function', binaryId = f.world.binarySet[0].binaryId;
  let target = createPointsToTarget({ rootKind: kind, rootEntityId: 'object', addressSpace: 'memory', offsetRange: exactRange(0n), evidenceIds: ['i'] });
  if (tls) {
    const proof = deriveCanonicalAddressProof({ functionId, values: [{ id: 'p', kind: 'entry', variableKey: 'tls',
      machineType: { kind: 'address', widthBits: 64 }, metadata: { canonicalRoot: { kind: 'tls-like', rootEntityId: 'tls', baseOffset: 0, addressSpace: 'memory', linearOffsets: true } } }], nodes: [], blocks: [] }, 'p');
    target = createRootDescriptorSeparatedTarget({ offsetRange: exactRange(0n), evidenceIds: ['tls-source'] }, proof);
  }
  const origin = { byteRanges: [{ binaryId, start: '0', end: '8' }], instructionIds: ['i'] };
  const nodes = [{ id: 'use', kind: 'load', blockId: 'entry', inputs: ['p'], outputs: [], origin },
    { id: 'return', kind: 'return', blockId: 'entry', inputs: returned ? ['p'] : [], outputs: [], origin }];
  const ir = { functionId, entryBlockId: 'entry', blocks: [{ id: 'entry', nodeIds: ['use', 'return'] }], nodes,
    values: [{ id: 'p', kind: 'entry', machineType: { kind: 'address', widthBits: 64 } }], origin };
  const cfg = { functionId, entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [], predecessors: [] }] };
  const status = { snapshotId: 'snap', analyzerId: 'fixture', analyzerVersion: '1', completeness: incomplete ? 'partial' : 'complete', stopReason: incomplete ? 'evidence-missing' : null };
  const pointsToRun = { pointsTo: new Map([['p', { top: false, targets: [target] }]]), status };
  // Real escape owner runs over explicit canonical roots. This fixture exercises
  // descriptor transfer; native machine roots are covered separately below.
  const escapeResult = analyzeEscape(ir, cfg, {}, pointsToRun, { snapshotId: 'snap' });
  const summary = createFunctionSummary({ functionId, status, noreturn: false, mayThrow: false, frees });
  const owner = createCanonicalObjectLifetimeOwner({ ir, cfg, pointsToRun, escapeResult, summary, ...f, binaryId, snapshotId: 'snap', work: workFor(t) });
  const partition = context => createObjectPartition(target, { ...f, lifetimeOwner: owner, context: context ?? createObjectContext() });
  return { ...f, owner, target, partition, escapeResult };
}
test('canonical nonescaping local frame has bounded normal activation lifetime but no singleton proof', t => {
  const f = source(t), p = f.partition();
  assert.equal(p.kind, 'stack'); assert.equal(p.cardinality, 'summary-many'); assert.equal(p.lifetime.status, 'bounded');
  assert.deepEqual(p.lifetime.begin, ['entry']); assert.deepEqual(p.lifetime.end, ['return']);
  assert.equal(p.lifetimeEvidence.escape.upperComplete, true);
  assert.equal(strongUpdateEligibility(p, { accessId: 'store' }).eligible, false);
});
test('returned frame uses actual escape owner evidence and cannot retain bounded local lifetime', t => {
  const f = source(t, { returned: true }), p = f.partition();
  assert.equal(p.lifetime.status, 'escaping'); assert.equal(p.lifetimeEvidence.escape.destinations[0].boundary, 'return');
  assert.deepEqual(p.lifetime.end, []); assert.equal(p.cardinality, 'summary-many');
});
test('same allocation site and every bounded recursive call string remain summary-many', t => {
  const f = source(t, { kind: 'allocation' }), contexts = [createObjectContext(), createObjectContext({ kind: 'call-string', callSites: ['recurse'], receiverPartition: null }),
    createObjectContext({ kind: 'call-string', callSites: ['recurse', 'recurse'], receiverPartition: null })];
  const parts = contexts.map(f.partition);
  assert.ok(parts.every(p => p.kind === 'heap' && p.cardinality === 'summary-many' && p.lifetime.status === 'unknown'));
  assert.equal(new Set(parts.map(p => p.id)).size, 3);
  assert.ok(parts.every(p => strongUpdateEligibility(p, { accessId: 'write' }).eligible === false));
});
test('TLS namespace preserves unknown thread identity instead of treating a static symbol as one instance', t => {
  const p = source(t, { tls: true }).partition(); assert.equal(p.kind, 'tls'); assert.equal(p.cardinality, 'summary-many');
  assert.equal(p.lifetimeEvidence.thread.selectedThread, null); assert.equal(p.lifetime.status, 'unknown');
});
test('missing flow coverage and potential free invalidate local lifetime bounds', t => {
  assert.equal(source(t, { incomplete: true }).partition().lifetime.status, 'unknown');
  const p = source(t, { frees: ['free-site'] }).partition(); assert.equal(p.lifetime.status, 'unknown');
  assert.deepEqual(p.lifetimeEvidence.summaryLifetimeEffects.frees, ['free-site']);
});
test('free/reuse and changed context advance epoch without making address inequality or alias claims', t => {
  const a = source(t, { kind: 'allocation' }).partition(), b = source(t, { kind: 'allocation', frees: ['free-site'] }).partition();
  assert.notEqual(a.lifetime.epoch, b.lifetime.epoch); assert.equal(a.root.rootKey, b.root.rootKey);
  assert.equal(a.lifetimeEvidence.aliasAuthority, false); assert.equal(b.lifetimeEvidence.strongUpdateAuthority, false);
});
test('serialized lifetime owner, foreign root and foreign scope cannot grant source binding', t => {
  const f = source(t);
  assert.throws(() => createObjectPartition(f.target, { ...f, lifetimeOwner: { ...f.owner } }), /owner-unbound/);
  assert.throws(() => createObjectPartition({ ...f.target, rootEntityId: 'another' }, { ...f, lifetimeOwner: f.owner }), /target-not-owned/);
  assert.throws(() => createObjectPartition(f.target, { ...fixture(d => { d.generation = 'other'; }), lifetimeOwner: f.owner }), /owner-unbound/);
});
test('real ARM64 points-to roots gain source-bound stack activation partitions without inventing local allocation', t => {
  const f = scope(), capturedSource = captured(0x1000n, callee), p = capturedSource.owner.pipeline;
  const surface = createAnalysisSurface({ ir: p.semanticIr, cfg: p.cfg, ssa: p.ssa, memorySsa: p.memorySsa, snapshotId: 'snap' });
  const pointsToRun = surface.pointsTo(), escapeResult = surface.escape(), summary = surface.functionSummary().summary;
  const owner = createCanonicalObjectLifetimeOwner({ ir: p.semanticIr, cfg: p.cfg, pointsToRun, escapeResult, summary,
    ...f, binaryId: p.binaryId, snapshotId: 'snap', work: workFor(t) });
  const targets = [...pointsToRun.pointsTo.values()].flatMap(set => set.targets);
  const target = targets.find(row => row.rootIdentity?.variable?.physicalIdentity?.registerId === 'sp');
  assert.ok(target); const partition = createObjectPartition(target, { ...f, lifetimeOwner: owner });
  assert.equal(partition.kind, 'stack'); assert.equal(partition.cardinality, 'summary-many'); assert.equal(partition.lifetime.status, 'unknown');
  assert.equal(partition.lifetimeEvidence.activation.functionId, p.functionId);
  assert.ok(partition.lifetimeEvidence.remaining.includes('incoming-stack-base-not-a-local-allocation-lifetime'));
});
test('native demand publishes the same source-bound lifetime descriptor at value and MemorySSA access consumers', async t => {
  const f = scope(), c = captured(0x1000n, callee);
  const d = await projectScopedDemandOwners(c.owner, c.result, { kind: 'demand', ...f, worldId: f.world.id,
    snapshotId: 'snap', producerArtifactId: 'native-lifetime', precision: { maximumValues: 64 } },
  { limits: { deadlineMs: 10000, residentBytes: 64 * 1024 * 1024 } });
  assert.equal(d.status, 'completed');
  const access = d.memoryObjects.accesses.find(row => row.partitions.some(p => p.kind === 'stack'));
  assert.ok(access); const partition = access.partitions.find(p => p.kind === 'stack');
  const value = d.objects.flatMap(row => row.partitions).find(p => p.root.rootKey === partition.root.rootKey);
  assert.ok(value); assert.equal(value.lifetimeEvidence.sourceDigest, partition.lifetimeEvidence.sourceDigest);
  assert.equal(value.lifetime.epoch, partition.lifetime.epoch);
  assert.equal(access.strongUpdateEligible, false); assert.equal(partition.cardinality, 'summary-many');
});
