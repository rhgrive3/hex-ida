import test from 'node:test';
import assert from 'node:assert/strict';
import { captured, callee, scope } from './native-owner-fixture.mjs';
import { workFor } from './helpers.mjs';
import { buildCanonicalQueryProjection } from '../../js/analysis/query/semantic/projection.js';
import { projectScopedDemandOwners } from '../../js/analysis/scoped-demand-projection.js';
import { specializeDemandSummary, demandContextRangeRequest, attachDemandContextRanges } from '../../js/analysis/summary/specialization.js';

async function setup(t) {
  const f = scope(), work = workFor(t, { residentBytes: 128 * 1024 * 1024 });
  const make = async c => {
    const projection = await buildCanonicalQueryProjection(c.result.pipeline, { ...f, snapshotId: 'snap', work,
      producerArtifactId: `artifact-${c.base}`, sourceLocation: { start: c.base, end: c.base + BigInt(c.rows.length * 4), snapshotId: 'snap' } });
    t.after(() => projection.release());
    const demand = await projectScopedDemandOwners(c.owner, c.result, { kind: 'demand', ...f, worldId: f.world.id,
      snapshotId: 'snap', producerArtifactId: `artifact-${c.base}`, precision: { maximumValues: 64 } },
    { limits: { deadlineMs: 10000, residentBytes: 128 * 1024 * 1024 } });
    assert.equal(demand.status, 'completed'); return { projection, demand };
  };
  const caller = await make(captured()), calleeOwner = await make(captured(0x2000n, callee));
  const callSiteId = caller.demand.nativeFlowInputs.calls[0].callSiteId;
  const args = { caller, callee: calleeOwner, callSiteId, summary: calleeOwner.demand.summary, sccRevision: 'scc-a',
    targetBinding: { callerFunctionId: caller.projection.functionId, callSiteId, targetFunctionId: calleeOwner.projection.functionId, inSelectedScope: true },
    ...f, snapshotId: 'snap', work };
  const create = changes => specializeDemandSummary({ ...args, ...changes });
  return { ...f, args, create, view: await create() };
}
test('conditional summary identity records every source and precision boundary before worker evaluation', async t => {
  const { view } = await setup(t), deps = view.contextDependencies;
  assert.equal(deps.worldId, view.worldId); assert.equal(deps.assumptionsId, view.assumptionsId);
  assert.equal(deps.abi.id, 'aapcs64'); assert.equal(deps.abi.revision, '2');
  assert.ok(deps.abi.callerPrototype.length); assert.ok(deps.abi.calleePrototype.length);
  assert.ok(deps.memory.callerMssa); assert.ok(deps.memory.calleeMssa);
  assert.equal(deps.dispatch.exhaustive, false); assert.equal(view.exact, false);
  const request = demandContextRangeRequest(view);
  if (request) assert.equal(request.contextDependencyKey, deps.key);
  else assert.ok(view.inputs.every(input => input.range?.fact?.constant == null));
});
for (const [name, mutate] of [
  ['prototype declaration', demand => { demand.abiPlacements.views[0].results[0].declaration.bits = 32; }],
  ['ABI registry version', demand => { demand.abiPlacements.views[0].canonicalOwner.registryDigest = 'new-registry'; }],
  ['object lifetime generation', demand => { demand.objects.find(row => row.partitions.length).partitions[0].lifetimeGeneration = 'new-lifetime'; }],
  ['object cardinality', demand => { const p = demand.objects.find(row => row.partitions.length).partitions[0]; p.cardinality = p.cardinality === 'summary-many' ? 'unknown' : 'summary-many'; }],
  ['memory offset', demand => { demand.objects.find(row => row.partitions.length).partitions[0].subobject.offset = '48'; }],
  ['points-to offset interval', demand => { const target = demand.objects.find(row => row.pointsTo.targets.length).pointsTo.targets[0]; target.offsetRange = { min: 16n, max: 24n }; }],
  ['lifetime source escape evidence', demand => { const p = demand.objects.find(row => row.partitions.length).partitions[0]; p.lifetimeEvidence.escape.destinations.push({ boundary: 'global', reason: 'changed-source-escape', siteId: 'escape-site', evidenceIds: [] }); }],
]) test(`changed ${name} cannot reuse a conditional summary context`, async t => {
  const f = await setup(t), demand = structuredClone(f.args.caller.demand); mutate(demand);
  const next = await f.create({ caller: { ...f.args.caller, demand } });
  assert.notEqual(next.contextDependencyKey, f.view.contextDependencyKey); assert.notEqual(next.id, f.view.id);
});
test('selected dispatch membership and unfinished SCC revisions are distinct context dependencies', async t => {
  const f = await setup(t);
  const changed = await f.create({ targetBinding: { ...f.args.targetBinding, reason: 'multiple-selected-functions-share-entry' } });
  assert.notEqual(changed.contextDependencyKey, f.view.contextDependencyKey);
  assert.notEqual((await f.create({ sccRevision: 'scc-b' })).contextDependencyKey, f.view.contextDependencyKey);
  assert.equal(f.view.returns.every(row => row.upper === 'TOP'), true);
});
test('stale target-source identity cannot be rehashed into a valid call context', async t => {
  const f = await setup(t);
  await assert.rejects(f.create({ targetBinding: { ...f.args.targetBinding,
    sourceBinding: { callerInput: { ...f.args.caller.projection.inputIdentity, snapshotId: 'later' } } } }), /target-source-stale/);
});
test('backward-expanded source facts cannot obscure or replace the live SSA input at the call', async t => {
  const f = await setup(t), input = f.view.inputs.find(row => row.range?.fact?.constant != null);
  assert.ok(input); assert.notEqual(input.actual.valueId, input.actual.compatibilityValueId);
  const demand = structuredClone(f.args.caller.demand);
  const earlier = demand.ranges.bindings.find(row => row.semanticSsaValueId === input.actual.compatibilityValueId);
  const atCall = demand.ranges.bindings.find(row => row.semanticSsaValueId === input.actual.valueId);
  assert.ok(earlier && atCall && earlier.localId !== atCall.localId);
  demand.ranges.values.find(row => row.localId === earlier.localId).fact.constant.value = 77n;
  const next = await f.create({ caller: { ...f.args.caller, demand } });
  const current = next.inputs.find(row => row.parameter.valueId === input.parameter.valueId).range;
  assert.equal(String(current.fact.constant.value), '1');
  assert.equal(current.sourceFactId, demand.ranges.values.find(row => row.localId === atCall.localId).entityId);
});
test('conditional result attachment checks parent assumptions, dependency key, and canonical callee digest', async t => {
  const f = await setup(t), view = f.view;
  const projected = { artifactId: 'refined-artifact', ownerIdentity: f.args.callee.projection.inputIdentity,
    conditionalRanges: { contextId: view.id, worldId: view.worldId, snapshotId: view.snapshotId,
      parentAssumptionsId: view.assumptionsId, contextDependencyKey: view.contextDependencyKey, exact: false, values: [] } };
  assert.ok(attachDemandContextRanges(view, projected).valueProjection);
  for (const field of ['parentAssumptionsId', 'contextDependencyKey']) {
    const altered = structuredClone(projected); altered.conditionalRanges[field] = 'foreign';
    assert.throws(() => attachDemandContextRanges(view, altered), /summary-context-ranges-binding/);
  }
  const altered = structuredClone(projected); altered.ownerIdentity.ownerDigests.ir = 'changed';
  assert.throws(() => attachDemandContextRanges(view, altered), /summary-context-ranges-binding/);
});
