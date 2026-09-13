import test from 'node:test';
import assert from 'node:assert/strict';
import { queryNativeAppleMetadata, createNativeAppleDispatchResolver } from '../../js/analysis/apple/native-metadata.js';
import { buildSwiftMetadataModel } from '../../js/swift.js';
import { parseSwiftGenericContext, parseSwiftCaptureSection } from '../../js/swift-context.js';
import { readSwiftMangledName } from '../../js/swift.js';
import { projectScopedDemandOwners } from '../../js/analysis/scoped-demand-projection.js';
import { DispatchResolverRegistry, resolveUnifiedDispatch } from '../../js/analysis/dispatch/unified.js';
import { scope } from './native-owner-fixture.mjs';
import { workFor } from './helpers.mjs';
import { appleFixture, contextFor, appleProjection } from './native-apple-fixture.mjs';

const query = (t, f, context, request) => queryNativeAppleMetadata(request,
  { ...f, snapshotId: 'snap', work: workFor(t), getContext: async () => context });

test('actual App parsers automatically expose source-bound ObjC and Swift records', async t => {
  const f = scope(), fixture = await appleFixture(), context = contextFor(fixture, f);
  const queries = [
    [{ kind: 'objc-selector', selector: 'save:' }, 'objc-method', 1],
    [{ kind: 'objc-class', className: 'Widget' }, 'objc-class', 1],
    [{ kind: 'objc-imp', address: '0x6000' }, 'objc-method', 1],
    [{ kind: 'swift-type' }, 'swift-type', 3],
    [{ kind: 'swift-protocol', address: '0x2000' }, 'swift-protocol', 1],
    [{ kind: 'swift-vtable', address: '0x1200', slot: 0 }, 'swift-vtable', 1],
    [{ kind: 'swift-witness', address: '0x1000', protocolAddress: '0x2000', slot: 0 }, 'swift-witness', 1],
    [{ kind: 'swift-generic', address: '0x1300' }, 'swift-generic', 1],
    [{ kind: 'swift-capture', address: '0x5500' }, 'swift-capture', 1],
  ];
  for (const [input, kind, count] of queries) {
    const result = await query(t, f, context, input);
    assert.equal(result.status, 'completed'); assert.equal(result.total, count, input.kind);
    assert.ok(result.records.every(row => row.kind === kind)); assert.equal(result.source.generation, f.world.generation);
    assert.equal(result.worldId, f.world.id); assert.equal(result.exact, false); assert.equal(result.bytesRevalidated, false);
    assert.ok(Object.isFrozen(result.records));
  }
  const witness = await query(t, f, context, { kind: 'swift-witness' });
  assert.equal(BigInt(witness.records[0].entriesAddress), 0x4008n);
  assert.equal(BigInt(witness.records[0].address), 0x6000n);
});

test('generic and capture records come from bytes, with runtime substitutions explicitly unknown', async () => {
  const fixture = await appleFixture(), generic = fixture.swiftModel.genericContexts[0], capture = fixture.swiftModel.captureDescriptors[0];
  assert.equal(generic.complete, true); assert.equal(generic.parameters[0].hasKeyArgument, true);
  assert.equal(generic.requirements[0].kind, 1); assert.equal(generic.requirements[0].parameter.text, 'x');
  assert.equal(generic.requirements[0].type.text, 'Si'); assert.equal(generic.requirements[0].satisfied, 'unknown');
  assert.equal(generic.substitutions, null); assert.equal(capture.captureTypes[0].type.text, 'Si');
  assert.equal(capture.metadataSources[0].source.text, 'B0'); assert.equal(capture.objectLayout, 'unknown');
  assert.equal(capture.substitutions, null); assert.equal(fixture.swiftIndex.genericContextsByType.get('4864')[0], generic);
  assert.equal(fixture.swiftIndex.captureDescriptorsByAddress.get('21760')[0], capture);
});

test('supported generic class vtable follows parsed trailing generic records without guessing resilient layouts', async () => {
  const fixture = await appleFixture();
  fixture.p32(0x1200, 0x80000090);
  fixture.memory.fill(0, 0x122c, 0x1270);
  fixture.p16(0x1234, 1); fixture.p16(0x1238, 1); fixture.memory[0x123c] = 0x80;
  // Generic header + one parameter aligned to four; vtable header starts 0x1240.
  fixture.p32(0x1244, 1); fixture.p32(0x1248, 0x10); fixture.p32(0x124c, 0x6000 - 0x124c);
  const model = await buildSwiftMetadataModel(fixture.read, fixture.sections, { budget: 128, resolvePointer: async raw => raw });
  const table = model.vtables.find(row => row.typeAddress === 0x1200n);
  assert.equal(table.address, 0x1248n); assert.equal(table.methods[0].impl, 0x6000n);
  assert.equal(model.types.find(row => row.address === 0x1200n).genericContext.complete, true);
  fixture.p32(0x1200, 0xa0000090);
  const resilient = await buildSwiftMetadataModel(fixture.read, fixture.sections, { budget: 128, resolvePointer: async raw => raw });
  assert.equal(resilient.vtables.length, 0); assert.equal(resilient.completeness.vtables.complete, false);
});

test('bounded pagination keeps owner collisions and never closes the image universe', async t => {
  const f = scope(), fixture = await appleFixture(), context = contextFor(fixture, f);
  fixture.swiftModel.witnessTables.push(structuredClone(fixture.swiftModel.witnessTables[0]));
  const first = await query(t, f, context, { kind: 'swift-witness', limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
  const second = await query(t, f, context, { kind: 'swift-witness', limit: 1, offset: 1 });
  assert.equal(second.records.length, 1); assert.equal(second.nextOffset, null);
  assert.ok(second.remaining.includes('runtime-image-set-open'));
});

test('actual canonical direct calls gain metadata identities without private selector or slot declarations', async t => {
  const f = scope(), fixture = await appleFixture(), context = contextFor(fixture, f), native = await appleProjection(t, f);
  const resolver = createNativeAppleDispatchResolver({ snapshotId: 'snap', getContext: async () => context,
    resolveFunctionIdentity: native.resolveFunctionIdentity });
  const result = await resolver.resolve({ callSiteId: native.callSiteId, maxTargets: 16, maxHops: 4 }, { ...f, projection: native.projection, work: workFor(t) });
  assert.deepEqual(new Set(result.candidates.map(row => row.family)), new Set(['objc-msgsend', 'swift-witness', 'swift-metadata']));
  assert.ok(result.candidates.every(row => row.targetEntityId === native.calleeProjection.functionId));
  assert.ok(result.requirements.includes('metadata-candidate-not-call-proof'));
});

test('unified dispatch accepts actual native Apple provenance while its exact envelope remains open', async t => {
  const f = scope(), fixture = await appleFixture(), context = contextFor(fixture, f), native = await appleProjection(t, f);
  const registry = new DispatchResolverRegistry();
  registry.register(createNativeAppleDispatchResolver({ snapshotId: 'snap', getContext: async () => context,
    resolveFunctionIdentity: native.resolveFunctionIdentity }));
  const result = await resolveUnifiedDispatch(native.projection,
    { functionId: native.projection.functionId, callSiteId: native.callSiteId, families: ['swift-witness'], maxTargets: 8 },
    { ...f, registry, work: workFor(t) });
  const witness = result.candidates.find(row => row.family === 'swift-witness');
  assert.ok(witness); assert.equal(witness.item.value.targetEntityId, native.calleeProjection.functionId);
  assert.equal(witness.provenance.authority, 'unqualified-owner-reference-not-proof');
  assert.equal(result.exact, false);
});

test('selector stub names come from the symbol owner, and unbound metadata cannot invent a function', async t => {
  const f = scope(), fixture = await appleFixture(), context = contextFor(fixture, f), native = await appleProjection(t, f, 0x6200n);
  context.symbolFor = at => at === 0x6200n ? '_objc_msgSend$save:' : null;
  for (const callback of [null, native.resolveFunctionIdentity]) {
    const resolver = createNativeAppleDispatchResolver({ snapshotId: 'snap', getContext: async () => context, resolveFunctionIdentity: callback });
    const result = await resolver.resolve({ callSiteId: native.callSiteId, maxTargets: 16, maxHops: 4 }, { ...f, projection: native.projection, work: workFor(t) });
    assert.equal(result.candidates.length, callback ? 1 : 0);
    if (callback) assert.equal(result.candidates[0].provenance.declaration.selectorFromOwnerSymbol, 'save:');
    else assert.ok(result.requirements.includes('native-apple-canonical-function-unavailable'));
  }
});

test('metadata mutation during canonical identity lookup invalidates publication', async t => {
  const f = scope(), fixture = await appleFixture(), context = contextFor(fixture, f), native = await appleProjection(t, f);
  const resolver = createNativeAppleDispatchResolver({ snapshotId: 'snap', getContext: async () => context,
    resolveFunctionIdentity: async request => { fixture.swiftModel.witnessTables[0].entries[0].target = 0x6004n; return native.resolveFunctionIdentity(request); } });
  await assert.rejects(resolver.resolve({ callSiteId: native.callSiteId, maxTargets: 16, maxHops: 4 }, { ...f, projection: native.projection, work: workFor(t) }), /native-apple-owner-changed/);
});

test('canonical MemorySSA and points-to load join the real witness slot, excluding its conformance header', async t => {
  const f = scope(), fixture = await appleFixture(), context = contextFor(fixture, f);
  for (const storage of [0x4008, 0x4000]) {
    const rows = [['mov', `x0, #0x${storage.toString(16)}`, (0xd2800000 | storage << 5) >>> 0],
      ['ldr', 'x1, [x0]', 0xf9400001], ['blr', 'x1', 0xd63f0020], ['ret', '', 0xd65f03c0]];
    const native = await appleProjection(t, f, 0x6000n, rows);
    const demand = await projectScopedDemandOwners(native.input.owner, native.input.result,
      { kind: 'demand', ...f, worldId: f.world.id, snapshotId: 'snap', precision: { maximumValues: 64 } },
      { limits: { deadlineMs: 10000, residentBytes: 64 * 1024 * 1024 } });
    assert.equal(demand.status, 'completed');
    const member = { projection: native.projection, demand };
    const resolver = createNativeAppleDispatchResolver({ snapshotId: 'snap', getContext: async () => context });
    const result = await resolver.resolve({ callSiteId: native.callSiteId, families: ['swift-witness'], maxTargets: 16, maxHops: 8 },
      { ...f, projection: native.projection, nativeContext: { member, members: [member, { projection: native.calleeProjection }] }, work: workFor(t) });
    assert.equal(result.candidates.length, storage === 0x4008 ? 1 : 0);
    if (storage === 0x4008) {
      assert.equal(result.candidates[0].targetEntityId, native.calleeProjection.functionId);
      assert.equal(result.candidates[0].provenance.declaration.targetReference.dependency, 'possible');
      assert.ok(result.requirements.includes('witness-pointer-content-stability-and-authentication-unproven'));
    }
  }
});

test('source generation, slice, currentness, request types and record bounds fail closed', async t => {
  const f = scope(), fixture = await appleFixture();
  for (const mutation of [c => { c.sourceIdentity.generation = 'later'; }, c => { c.sourceIdentity.sliceId = 'foreign'; }, c => { c.isCurrent = () => false; }]) {
    const context = contextFor(fixture, f); mutation(context);
    await assert.rejects(query(t, f, context, { kind: 'swift-type' }), /native-apple-/);
  }
  for (const request of [{ kind: 'swift-type', address: [] }, { kind: 'swift-type', limit: '1' },
    { kind: 'swift-type', slot: 0 }, { kind: 'swift-witness', slot: -1 }, { kind: 'swift-capture', offset: 4097 }]) {
    await assert.rejects(query(t, f, contextFor(fixture, f), request));
  }
  let touched = false;
  await assert.rejects(query(t, f, contextFor(fixture, f), { kind: 'swift-type', get address() { touched = true; return 0; } }));
  assert.equal(touched, false);
  fixture.swiftModel.types = new Array(4097).fill({});
  await assert.rejects(query(t, f, contextFor(fixture, f), { kind: 'swift-type' }), /native-apple-owner-record-budget/);
});

test('unsupported generic flags, kinds and truncated capture records remain partial', async () => {
  const fixture = await appleFixture();
  for (const [at, value] of [[0x132a, 1], [0x1324, 257]]) {
    const saved = new DataView(fixture.memory.buffer).getUint16(at, true); fixture.p16(at, value);
    const model = await buildSwiftMetadataModel(fixture.read, fixture.sections, { budget: 128, resolvePointer: async raw => raw });
    assert.equal(model.completeness.genericContexts.complete, false); assert.equal(model.complete, false);
    fixture.p16(at, saved);
  }
  fixture.memory[0x132c] = 0x81;
  const generic = await parseSwiftGenericContext(fixture.read, fixture.swiftModel.types[2], { readMangledName: readSwiftMangledName });
  assert.equal(generic.complete, false); assert.match(generic.reason, /parameter-kind/);
  const captures = await parseSwiftCaptureSection(fixture.read, { addr: 0x5500n, size: 20n }, { readMangledName: readSwiftMangledName });
  assert.equal(captures.completeness.complete, false); assert.equal(captures.descriptors.length, 0);
  const signal = AbortSignal.abort(new Error('stop-apple-parser'));
  await assert.rejects(parseSwiftCaptureSection(fixture.read, { addr: 0x5500n, size: 24n }, { signal, readMangledName: readSwiftMangledName }), /stop-apple-parser/);
});

test('capture and generic count budgets bound the combined record fanout before payload reads', async () => {
  const fixture = await appleFixture();
  const captures = await parseSwiftCaptureSection(fixture.read, { addr: 0x5500n, size: 24n }, { budget: 2, readMangledName: readSwiftMangledName });
  assert.equal(captures.completeness.reason, 'capture-total-record-budget');
  assert.equal(captures.descriptors.length, 0);
  const generic = await parseSwiftGenericContext(fixture.read, fixture.swiftModel.types[2], { budget: 2, readMangledName: readSwiftMangledName });
  assert.equal(generic.reason, 'generic-context-count-budget');
  assert.equal(generic.parameters.length, 0); assert.equal(generic.requirements.length, 0);
});
