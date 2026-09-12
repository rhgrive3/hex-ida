import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor } from './helpers.mjs';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';
import { queryScopedAbiPlacement } from '../../js/analysis/types/scoped-abi.js';
import { fixture as irFixture } from '../phase8/helpers/ir-fixtures.mjs';
import { seedAnalysisState } from '../../js/decompiler/phase8/transaction.js';
import { requestDemandRanges } from '../../js/decompiler/phase8/demand-range.js';
import { configureScopedAnalysisHost, disableScopedAnalysisHost, scopedAnalysisHost } from '../../js/analysis/query/scoped-host.js';
import { dispatchScopedAppQuery } from '../../js/analysis/query/scoped-app.js';

function abiFixture(t, kind, prototype) {
  const f = fixture(data => { data.profile.abiRevision = AAPCS64_ABI.semanticVersion; });
  const snapshotId = 'abi-snapshot', functionId = 'abi-function';
  const adapter = semanticAbiAdapter(AAPCS64_ABI, { architecture: 'arm64', platform: 'linux',
    binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', functionId, snapshotId });
  const result = kind === 'arguments' ? adapter.classifyArguments({ functionPrototype: prototype })
    : adapter.classifyFunctionReturn({ functionPrototype: prototype });
  const context = { binding: { worldId: f.world.id, assumptionsId: f.assumptions.id, snapshotId,
    binaryId: 'binary-scpa-test', functionId, kind, callSiteId: null,
    producerArtifactId: 'abi-classification', ownerRevision: 'owner-v1' }, result, isCurrent: () => true };
  const run = () => queryScopedAbiPlacement({ functionId, kind }, { ...f, snapshotId, work: workFor(t), getContext: () => context });
  return { context, run };
}
const scalar = { type: 'uint64', bits: 64 };
const pair = { type: 'struct Pair', aggregate: true, bits: 128,
  members: [0, 8].map(byteOffset => ({ type: 'uint64', bits: 64, byteOffset })) };
test('real ABI owner scalar and stack placements retain physical evidence without prototype authority', async t => {
  const { run } = abiFixture(t, 'arguments', { parameters: Array.from({ length: 10 }, () => ({ ...scalar })) });
  const r = await run(); assert.equal(r.status, 'completed'); assert.equal(r.results.length, 10);
  // The current scalar register owner omits its physical byte span; do not guess it.
  assert.equal(r.results[0].status, 'unresolved');
  assert.equal(r.results[0].reason, 'canonical-width-and-span-required');
  assert.equal(r.results[8].pieces[0].destination.kind, 'stack');
  assert.equal(r.conflicts.rows.length, 0); assert.equal(r.exact, false);
  assert.ok(r.remaining.includes('prototype-authority-not-established'));
});
test('real ABI aggregate classifier preserves every logical piece and physical register', async t => {
  const { run } = abiFixture(t, 'arguments', { parameters: [pair] }), r = await run();
  assert.equal(r.status, 'completed'); assert.equal(r.results[0].pieces.length, 2);
  assert.deepEqual(r.results[0].pieces.map(p => p.logicalBitOffset), [0, 64]);
  assert.deepEqual(r.results[0].pieces.map(p => p.destination.register), ['x0', 'x1']);
});
test('canonical indirect return projects x8 as the result pointer, never an exact scalar return', async t => {
  const { run } = abiFixture(t, 'return', { returnType: 'struct Big', aggregate: true, bits: 256, returnsValue: true,
    members: [0, 8, 16, 24].map(byteOffset => ({ type: 'uint64', bits: 64, byteOffset })) });
  const r = await run(); assert.equal(r.status, 'completed'); assert.equal(r.hiddenResult.input, 'x8');
  assert.deepEqual(r.results, []); assert.equal(r.hiddenResult.exact, false);
});
test('changed canonical ABI result snapshots cannot be published under a current binding', async t => {
  const { run, context } = abiFixture(t, 'arguments', { parameters: [scalar] });
  context.result = { ...context.result, invalidation: { ...context.result.invalidation, snapshotId: 'old' } };
  const r = await run(); assert.equal(r.status, 'unsupported'); assert.equal(r.exact, false);
});
test('ABI scope and owner liveness are checked independently of classifier output', async t => {
  const { run, context } = abiFixture(t, 'arguments', { parameters: [scalar] });
  context.binding.functionId = 'foreign'; await assert.rejects(run(), /scope-mismatch/);
  context.binding.functionId = 'abi-function'; context.isCurrent = () => false;
  await assert.rejects(run(), /current-owner-required/);
});

function rangeFixture(t) {
  const f = fixture(), builder = irFixture('scpa-wrapping-add'); builder.block(0);
  const lhs = builder.constant(255n, 8), rhs = builder.constant(2n, 8), value = builder.binary('add', lhs, rhs, 8);
  builder.ret(); const ir = { ...builder.build(), binaryId: 'binary-scpa-test', functionId: 'range-function', snapshotId: 'range-snapshot' };
  const context = { ir, analysis: seedAnalysisState(ir) };
  const run = (request = {}, options = {}) => requestDemandRanges(context, { valueIds: [value.id], ...request },
    { ...f, work: workFor(t), ...options });
  return { context, value, run };
}
test('demand ranges invoke real SCCP with wraparound and do not publish by default', async t => {
  const { run, context, value } = rangeFixture(t), before = context.analysis.snapshot();
  const r = await run(); assert.equal(r.status, 'completed'); assert.equal(r.refreshed, true); assert.equal(r.published, false);
  assert.equal(r.values[0].localId, value.id); assert.equal(r.values[0].authority, 'canonical-owner-projection');
  assert.equal(r.values[0].fact.bits, 8); assert.equal(r.values[0].fact.constant.value, 1n); assert.deepEqual(context.analysis.snapshot(), before);
  assert.equal(context.analysis.get('ranges'), null);
});
test('range publication uses the canonical transaction and reuse retains the exact artifact', async t => {
  const { run, context } = rangeFixture(t), first = await run({}, { publish: true });
  assert.equal(first.status, 'completed'); assert.equal(first.published, true);
  const artifact = context.analysis.get('ranges'), second = await run({ mode: 'reuse-only' });
  assert.equal(second.status, 'completed'); assert.equal(second.refreshed, false);
  assert.equal(context.analysis.get('ranges'), artifact); assert.equal(second.publicationDigest, first.publicationDigest);
});
test('reuse-only does not manufacture a range artifact when no current artifact exists', async t => {
  const { run } = rangeFixture(t), r = await run({ mode: 'reuse-only' });
  assert.equal(r.status, 'unsupported'); assert.equal(r.reason, 'range-artifact-not-current');
});
test('range function budget and absent SSA values remain explicit unknowns', async t => {
  const { run } = rangeFixture(t);
  assert.equal((await run({ maximumFunctionValues: 1 })).reason, 'phase8-function-work-budget');
  const r = await run({ valueIds: [2147483647] });
  assert.equal(r.values[0].status, 'unknown'); assert.equal(r.values[0].reason, 'canonical-value-fact-unavailable');
});

function appFixture(t) {
  const metadata = { endian: 'little' }, file = new Blob([new Uint8Array(32)]);
  const app = { backend: { file, gen: 1, transportEpoch: 1 }, symbols: { revision: 1, functionCount: 1 } };
  const snapshot = { snapshotId: 'app-snapshot', binaryId: 'binary-scpa-test', analysisEpoch: 1, projectRevision: 1 };
  const bindings = { file: () => file, architecture: () => 'arm64', format: () => 'elf', sliceIndex: () => 0,
    artifactVersions: () => ({}), projectRevision: () => 1, metadata: () => metadata, capability: () => ({}),
    rangeFor: () => { throw Error('capability discovery must not request code'); } };
  configureScopedAnalysisHost(app, { enabled: true }); t.after(() => disableScopedAnalysisHost(app));
  const run = () => dispatchScopedAppQuery(app, snapshot, 'scopedCapabilities', {}, {}, bindings);
  return { app, snapshot, bindings, run };
}
test('opt-in app capability route lazily creates and reuses a source-bound service', async t => {
  const { app, run } = appFixture(t);
  const r = await run(); assert.equal(r.value.status, 'available-experimental'); assert.equal(r.value.releaseQualified, false);
  const service = scopedAnalysisHost(app).service; await run(); assert.equal(scopedAnalysisHost(app).service, service);
  app.symbols.revision++; await run(); assert.equal(service.closed, true); assert.notEqual(scopedAnalysisHost(app).service, service);
});
for (const [name, change, reason] of [
  ['stale snapshot', f => f.snapshot.analysisEpoch++, 'scoped-snapshot-stale'],
  ['missing slice', f => f.bindings.sliceIndex = () => null, 'scoped-slice-unbound'],
  ['foreign architecture', f => f.bindings.architecture = () => 'x86', 'scoped-native-arm64-only'],
  ['unbound endian', f => f.bindings.metadata = () => ({}), 'scoped-data-endianness-unbound'],
  ['unbound format ABI', f => f.bindings.format = () => 'pe', 'scoped-arm64-format-abi-unavailable'],
]) test(`app capability route fails closed for ${name}`, async t => {
  const f = appFixture(t); change(f); const r = await f.run();
  assert.equal(r.value.status, 'unsupported'); assert.equal(r.value.reason, reason);
});

for (const hidden of ['canonicalStackMirror', 'unrelatedHiddenField']) test(`ABI snapshot rejects injected ${hidden} accessors without invoking them`, async t => {
  const { run, context } = abiFixture(t, 'arguments', { parameters: [scalar] });
  let invoked = 0; const entry = { ...context.result.arguments[0] };
  Object.defineProperty(entry, hidden, { get() { invoked++; return true; }, enumerable: false });
  context.result = { ...context.result, arguments: [entry] };
  await assert.rejects(run()); assert.equal(invoked, 0);
});
test('serialized stack mirror clones cannot acquire the canonical same-object exception', async t => {
  const { run, context } = abiFixture(t, 'arguments', { parameters: Array.from({ length: 9 }, () => ({ ...scalar })) });
  context.result = JSON.parse(JSON.stringify(context.result));
  const r = await run(); assert.equal(r.status, 'inconsistent'); assert.equal(r.exact, false);
});
