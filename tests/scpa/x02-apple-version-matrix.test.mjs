import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openBinary, openBinarySource, MemoryByteSource } from '../../js/binary/index.js';
import { ObjcMetadataProvider } from '../../js/metadata/objc.js';
import { resolveObjcDispatch } from '../../js/objc.js';
import { describeMachOPointerSite } from '../../js/binary/macho-dyld.js';
import { inspectFormatSafeImage, createFormatSafeRebuildTransaction } from '../../js/rebuild/format-safe.js';
import { appleMatrixInput, loadAppleMatrixInput, chainedMatrixInput, sha256 } from './fixtures/x02-apple-version-fixtures.mjs';

const base = await appleMatrixInput();
for (const source of [false, true]) test(`X02-OBJC-${source ? 'SOURCE' : 'BUFFER'}: public loader preserves category/protocol dispatch ambiguity`, async () => {
  const ctx = await loadAppleMatrixInput(base, { source });
  const result = await ctx.objc.probe();
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.completeness.complete, true);
  assert.equal(ctx.objc.cachedModel.categories.length, 1);
  assert.equal(ctx.objc.cachedModel.protocols.length, 1);
  assert.equal(result.counts.categories, 1);
  assert.equal(result.counts.protocols, 1);
  assert.equal(result.counts.methods, 2);
  assert.equal(ctx.objc.types().records.find(r => r.name === 'Widget').address, '0x8000');
  assert.equal(result.completeness.declared, 3);
  assert.equal(result.completeness.parsed, 3);
  const dispatch = resolveObjcDispatch(ctx.objc.cachedIndex, { receiverType: 'Widget', selector: 'save:' });
  assert.equal(dispatch.resolved, null);
  assert.equal(dispatch.candidates.length, 2);
  assert.deepEqual(new Set(dispatch.candidates.map(c => c.imp)), new Set([0x6000n, 0x6004n]));
  assert.equal(dispatch.requirements.length, 1);
  assert.match(dispatch.reason, /multiple plausible/);
  const methods = ctx.objc.methods().records;
  assert.equal(methods.length, 2);
  assert.equal(new Set(methods.map(m => m.entityId)).size, 2);
  assert.equal(methods.find(m => m.descriptor.categoryName === 'Extra').address, '0x6004');
  assert.ok(methods.every(m => m.descriptor.implementationProven));
});

for (const name of ['__objc_catlist', '__objc_protolist']) test(`X02-OBJC-TRUNCATED-${name}: declared unreadable records stay partial`, async () => {
  const input = await appleMatrixInput({ sections: [
    ['__objc_classlist', 0x220, 8], ['__objc_catlist', 0x228, 8], ['__objc_protolist', 0x230, 8], ['__text', 0x6000, 8],
  ].map(([n, a, s]) => [n, a, n === name ? 9 : s]) });
  const ctx = await loadAppleMatrixInput(input), result = await ctx.objc.probe();
  assert.equal(result.completeness.complete, false);
  assert.equal(result.identity.verdict, 'matched-partial');
  assert.ok(result.completeness.reasons.length > 0);
  assert.equal(resolveObjcDispatch(ctx.objc.cachedIndex, { receiverType: 'Widget', selector: 'save:' }).resolved, null);
});

test('X02-OBJC-DEFAULTS: explicit null options cannot suppress discovered metadata', async () => {
  const ctx = await loadAppleMatrixInput(base);
  ctx.objc.options.runtimeSections.categoryList = null;
  ctx.objc.options.runtimeSections.protocolList = null;
  const result = await ctx.objc.probe();
  assert.equal(result.counts.categories, 1);
  assert.equal(result.counts.protocols, 1);
});

test('X02-OBJC-RAW-SECTIONS: provider accepts canonical BinaryImage section addresses', async () => {
  const ctx = await loadAppleMatrixInput(base);
  ctx.objc.sections = ctx.image.sections;
  const result = await ctx.objc.probe();
  assert.equal(result.completeness.complete, true);
  assert.equal(result.counts.categories, 1);
  assert.equal(result.counts.protocols, 1);
});

for (const name of ['__objc_classlist', '__objc_catlist', '__objc_protolist']) test(`X02-OBJC-DUPLICATE-${name}: multiple uncombined tables never claim a complete scan`, async () => {
  const ctx = await loadAppleMatrixInput(base);
  ctx.objc.sections.push({ ...ctx.sections.find(s => s.name === name) });
  const result = await ctx.objc.probe();
  assert.notEqual(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.completeness.complete, false);
  if (ctx.objc.cachedIndex) assert.equal(resolveObjcDispatch(ctx.objc.cachedIndex, { receiverType: 'Widget', selector: 'save:' }).resolved, null);
});

test('X02-OBJC-CACHE: a later absent or cancelled probe does not retain the old model', async () => {
  const ctx = await loadAppleMatrixInput(base);
  await ctx.objc.probe();
  assert.ok(ctx.objc.methods().records.length);
  ctx.objc.sections = [];
  await ctx.objc.probe();
  assert.equal(ctx.objc.cachedModel, null);
  assert.equal(ctx.objc.cachedIndex, null);
  assert.equal(ctx.objc.methods().records.length, 0);
  ctx.objc.sections = ctx.sections;
  await ctx.objc.probe();
  ctx.objc.options.signal = AbortSignal.abort();
  const result = await ctx.objc.probe();
  assert.equal(result.completeness.complete, false);
  assert.equal(ctx.objc.cachedModel, null);
});

test('X02-OBJC-MALFORMED-SECTION: invalid declaration addresses are not absent metadata', async () => {
  const ctx = await loadAppleMatrixInput(base);
  ctx.objc.sections = ctx.sections.map(s => s.name === '__objc_catlist' ? { ...s, vmAddr: 'bogus' } : s);
  const result = await ctx.objc.probe();
  assert.equal(result.completeness.complete, false);
  assert.notEqual(result.identity.verdict, 'matched-authoritative');
});

test('X02-OBJC-SUPERSEDED: a late scan cannot overwrite a newer publication', async () => {
  const ctx = await loadAppleMatrixInput(base);
  const originalRead = ctx.objc.readAt;
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  let first = true;
  ctx.objc.readAt = async (...args) => {
    if (first) { first = false; enter(); await paused; }
    return originalRead(...args);
  };
  const oldProbe = ctx.objc.probe();
  await entered;
  ctx.objc.readAt = originalRead;
  const fresh = await ctx.objc.probe();
  assert.equal(fresh.completeness.complete, true);
  const current = ctx.objc.cachedModel;
  resume();
  assert.equal((await oldProbe).completeness.complete, false);
  assert.equal(ctx.objc.cachedModel, current);
  assert.equal(ctx.objc.methods().records.length, 2);
});

test('X02-SWIFT: public input retains nominal, generic, witness and capture descriptors', async () => {
  const ctx = await loadAppleMatrixInput(base), result = await ctx.swift.probe();
  assert.equal(result.counts.types, 3);
  assert.equal(result.counts.protocols, 1);
  assert.equal(result.counts.conformances, 1);
  assert.equal(result.counts.vtables, 1);
  const model = ctx.swift.cachedModel;
  assert.ok(model.types.some(t => t.name === 'Box'));
  assert.equal(model.genericContexts.length, 1);
  assert.equal(model.genericContexts[0].parameters.length, 1);
  assert.equal(model.genericContexts[0].requirements.length, 1);
  assert.equal(model.genericContexts[0].requirements[0].type.text, 'Si');
  assert.equal(model.genericContexts[0].instantiation, 'unknown');
  assert.equal(model.genericContexts[0].substitutions, null);
  assert.equal(model.witnessTables.length, 1);
  assert.equal(model.witnessTables[0].entries[0].rawTarget, 0x6000n);
  assert.equal(model.witnessTables[0].entries[0].target, 0x6000n);
  assert.equal(model.captureDescriptors.length, 1);
  assert.equal(model.captureDescriptors[0].captureTypes[0].type.text, 'Si');
  assert.equal(model.captureDescriptors[0].metadataSources[0].source.text, 'B0');
  assert.equal(model.captureDescriptors[0].objectLayout, 'unknown');
  assert.equal(model.captureDescriptors[0].metadataSources[0].interpretation, 'unresolved');
  // swift-5.0 / objc-2.0 are layout labels, not observed OS or producer versions.
  assert.equal(base.osVersion, null);
  assert.equal(base.compilerVersion, null);
  assert.equal(base.runtimeVersion, null);
  assert.equal(base.provenance, 'owned-synthetic-layout');
});

for (const format of [1, 7, 9, 10, 12]) for (const bind of [false, true]) for (const key of [0, 1, 2, 3]) {
  test(`X02-PAC-${format}-${bind ? 'BIND' : 'REBASE'}-${key}: public Mach-O load preserves metadata, not authentication`, () => {
    const input = chainedMatrixInput({ format, bind, key, addressDiversity: key % 2 === 1 });
    const image = openBinary(input.bytes), view = describeMachOPointerSite(image, input.raw, input.storageAddress);
    assert.equal(image.arch, 'arm64e');
    assert.equal(view.status, 'recorded-site');
    assert.equal(view.decoded.authenticationKey, key);
    assert.equal(view.decoded.discriminator, 0xa55a);
    assert.equal(view.decoded.addressDiversity, key % 2 === 1);
    assert.equal(view.decoded.bind, bind);
    assert.equal(view.decoded.target, bind ? null : 0x1234n);
    assert.equal(view.authenticationVerified, false);
    assert.equal(view.executionTargetExact, false);
    assert.equal(describeMachOPointerSite(image, input.raw ^ 1n, input.storageAddress).decoded, null);
    if (bind) assert.equal(image.metadata.chainedFixups.complete, false, 'missing import target must remain partial');
  });
}

test('X02-PAC-UNSUPPORTED: a different pointer format never borrows an authenticated layout', () => {
  const input = chainedMatrixInput({ format: 14 });
  const image = openBinary(input.bytes), view = describeMachOPointerSite(image, input.raw, input.storageAddress);
  assert.equal(view.decoded, null);
  assert.equal(view.authenticationVerified, false);
  assert.equal(view.executionTargetExact, false);
});

test('X02-CHAINED-UNKNOWN-VERSION: future fixups payloads cannot borrow current layouts', async () => {
  const input = chainedMatrixInput({ version: 1 });
  for (const source of [false, true]) {
    const { image } = await loadAppleMatrixInput(input, { source });
    assert.equal(image.metadata.chainedFixups.version, 1);
    assert.equal(image.metadata.chainedFixups.complete, false);
    assert.equal(image.metadata.chainedFixups.importsPartialReason, 'unsupported-version');
    const pointer = describeMachOPointerSite(image, input.raw, input.storageAddress);
    assert.equal(pointer.decoded, null);
    assert.equal(pointer.executionTargetExact, false);
  }
});

test('X02-SWIFT-UNKNOWN-KIND: an unsupported descriptor does not become a valid type', async () => {
  const input = await appleMatrixInput({ mutateMemory: (_bytes, view) => view.setUint32(0x1300, 31, true) });
  const ctx = await loadAppleMatrixInput(input), result = await ctx.swift.probe();
  assert.equal(result.identity.verdict, 'matched-partial');
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.invalidEntries, 1);
  assert.equal(result.counts.types, 2);
  assert.ok(!ctx.swift.types().records.some(row => row.name === 'Box'));
});

test('X02-SHARED-CACHE-GAP: direct dyld cache input is explicitly unsupported by both public loaders', async () => {
  const bytes = new Uint8Array(512);
  bytes.set(new TextEncoder().encode('dyld_v1  arm64e\0'));
  assert.throws(() => openBinary(bytes));
  await assert.rejects(() => openBinarySource(new MemoryByteSource(bytes)));
  // This is a negative boundary test, NOT shared-cache/slide acceptance.
});

test('X02-SIGNATURE-BOUNDARY: a code-signature marker blocks unsigned-only mutation', async () => {
  const input = await appleMatrixInput({ signed: true });
  const snapshot = inspectFormatSafeImage(input.bytes);
  assert.equal(snapshot.snapshot.signatureState, 'code-signature-present');
  assert.throws(() => createFormatSafeRebuildTransaction({
    source: input.bytes, format: 'macho', architecture: 'arm64', mutation: { kind: 'macho-section-layout', size: 8 },
  }), /signed-or-build-identified-input-unsupported/);
  // The fixture is not a valid signed Apple executable or a signing oracle.
});

test('X02-TRACKED-COMPILER-INPUT: checked-in Mach-O matches its compiler manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../phase12/rebuild/fixtures/manifest.json', import.meta.url)));
  const row = manifest.fixtures.find(f => f.format === 'macho');
  const bytes = new Uint8Array(fs.readFileSync(new URL(`../../${row.path}`, import.meta.url)));
  assert.equal(sha256(bytes), row.sha256);
  const image = openBinary(bytes);
  assert.equal(image.format, 'macho');
  assert.equal(image.arch, 'x86_64');
});

const matrix = JSON.parse(fs.readFileSync(new URL('./fixtures/x02-apple-version-matrix.json', import.meta.url)));
test('X02-MANIFEST-DENOMINATOR: original requirements and evidence gaps cannot disappear', () => {
  assert.deepEqual(matrix.denominator, { requirementRows: 12, functionalCases: 59, inputArtifacts: 49, manifestIntegrityTests: 2 });
  assert.equal(matrix.requirements.length, 12);
  assert.deepEqual(matrix.requirements.map(r => r.id), Array.from({ length: 12 }, (_, i) => `X02-R${String(i + 1).padStart(2, '0')}`));
  assert.equal(matrix.cases.length, 59);
  assert.equal(matrix.inputs.length, 49);
  assert.equal(new Set(matrix.inputs.map(r => r.id)).size, 49);
  assert.equal(new Set(matrix.cases.map(r => r.id)).size, 59);
  assert.equal(matrix.overallStatus, 'CHECKPOINT-LOCKED');
  assert.equal(matrix.transformAuthorization, false);
  assert.equal(matrix.acceptanceComplete, false);
  for (const requirement of matrix.requirements) {
    assert.equal(requirement.fullAcceptanceComplete, false);
    assert.ok(['pass', 'product-gap', 'evidence-gap', 'environment-excluded'].includes(requirement.status));
    assert.ok(requirement.caseIds.length > 0);
    assert.deepEqual(requirement.caseIds, matrix.cases.filter(c => c.requirementIds.includes(requirement.id)).map(c => c.id));
  }
  for (const row of matrix.cases) {
    assert.equal(row.originalRequirementCompletion, false);
    assert.ok(row.requirementIds.every(id => matrix.requirements.some(r => r.id === id)));
    assert.ok(row.inputIds.every(id => matrix.inputs.some(r => r.id === id)));
  }
  assert.equal(matrix.requirements.find(r => r.id === 'X02-R02').status, 'product-gap');
  assert.equal(matrix.requirements.find(r => r.id === 'X02-R12').status, 'environment-excluded');
});

test('X02-MANIFEST-INPUT-HASHES: all declared inputs reproduce without promoting version claims', async () => {
  const { regenerateMatrixInput } = await import('./fixtures/x02-apple-version-fixtures.mjs');
  for (const row of matrix.inputs) {
    const bytes = row.sourceKind === 'checked-in-compiler-artifact'
      ? fs.readFileSync(new URL(`../../${row.path}`, import.meta.url))
      : await regenerateMatrixInput(row);
    assert.equal(sha256(bytes), row.inputSha256, row.id);
    assert.equal(bytes.length, row.size, row.id);
    assert.deepEqual(row.observedVersions, { os: null, compiler: null, runtime: null });
    assert.equal(row.externalIndependentOracle, false);
  }
  await assert.rejects(() => regenerateMatrixInput({ id: 'unknown-input' }), /unsupported/);
});
