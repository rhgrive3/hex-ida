import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { validateCilEffectFunction } from '../../../js/managed/cil/validation.js';
import { parseCilLocalVarSignature } from '../../../js/managed/cil/call-signature-types.js';

async function methodsOf(image) {
  const frontend = new CilFrontend();
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  return { frontend, methods };
}

// ===========================================================================
// #5353 — ldarg*/ldloc*/stloc* derive slot type/width from metadata authority
// ===========================================================================

test('#5353 int64 argument lifts as a 64-bit exact access, not a fabricated 32-bit one', async () => {
  const built = buildCil({
    methods: [{ name: 'F', body: [0x02, 0x26, 0x2a], signature: [0x00, 0x01, 0x0a, 0x0a] }], // static void F(int64); ldarg.0; pop; ret
  });
  const image = parseCil(built.bytes);
  const { frontend, methods } = await methodsOf(image);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const ldarg = decoded.bundles.find((bundle) => bundle.mnemonic === 'ldarg.0');
  assert.equal(ldarg.completeness, 'exact');
  assert.deepEqual(ldarg.locationReads, [{ kind: 'argument', index: 0, bits: 64 }]);
  assert.equal(ldarg.producedValues[0].bits, 64);
  assert.equal(ldarg.producedValues[0].stackType, 'int64');
  assert.equal(decoded.aggregateCompleteness, 'exact');
});

test('#5353 int32 argument keeps the existing 32-bit behavior', async () => {
  const built = buildCil({
    methods: [{ name: 'F', body: [0x02, 0x26, 0x2a], signature: [0x00, 0x01, 0x08, 0x08] }], // static void F(int32)
  });
  const image = parseCil(built.bytes);
  const { frontend, methods } = await methodsOf(image);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const ldarg = decoded.bundles.find((bundle) => bundle.mnemonic === 'ldarg.0');
  assert.equal(ldarg.completeness, 'exact');
  assert.deepEqual(ldarg.locationReads, [{ kind: 'argument', index: 0, bits: 32 }]);
  assert.equal(ldarg.producedValues[0].bits, 32);
  assert.equal(ldarg.producedValues[0].stackType, 'int32');
});

test('#5353 int64 local lifts as 64-bit through the LocalVarSigTok authority', () => {
  const built = buildCil({
    methods: [{
      name: 'G',
      body: [0x06, 0x13, 0x00, 0x2a], // ldloc.0; stloc.s 0; ret
      fat: true,
      localVarSigTok: 0x11000001,
      signature: [0x00, 0x00, 0x01], // static void()
    }],
    standAloneSigs: [[0x07, 0x01, 0x0a]], // LOCAL_SIG, 1 local, I8
  });
  const image = parseCil(built.bytes);
  const lifted = liftCilMethod(0, image);
  const ldloc = lifted.bundles.find((bundle) => bundle.mnemonic === 'ldloc.0');
  const stloc = lifted.bundles.find((bundle) => bundle.mnemonic === 'stloc.s');
  assert.equal(ldloc.completeness, 'exact');
  assert.deepEqual(ldloc.locationReads, [{ kind: 'local', index: 0, bits: 64 }]);
  assert.equal(ldloc.producedValues[0].bits, 64);
  assert.equal(stloc.completeness, 'exact');
  assert.deepEqual(stloc.locationWrites, [{ kind: 'local', index: 0, bits: 64 }]);
  assert.equal(validateCilEffectFunction(lifted).status, 'valid');
});

test('#5353 long-form ldarg/ldloc/stloc use the same slot-type authority', () => {
  const built = buildCil({
    methods: [{
      name: 'G',
      body: [0xfe, 0x09, 0x00, 0x00, 0x26, 0x2a], // ldarg 0; pop; ret
      fat: true,
      localVarSigTok: 0,
      signature: [0x00, 0x01, 0x0a, 0x0a], // static void F(int64)
    }],
  });
  const image = parseCil(built.bytes);
  const lifted = liftCilMethod(0, image);
  const ldarg = lifted.bundles.find((bundle) => bundle.mnemonic === 'ldarg');
  assert.equal(ldarg.completeness, 'exact');
  assert.deepEqual(ldarg.locationReads, [{ kind: 'argument', index: 0, bits: 64 }]);
  assert.equal(ldarg.producedValues[0].bits, 64);
});

test('#5353 instance method ldarg.0 addresses this without stealing a parameter type', async () => {
  // HASTHIS lives in the calling-convention byte: instance void F(int64) => 20 01 0a 0a.
  const built = buildCil({
    methods: [{ name: 'F', body: [0x02, 0x03, 0x26, 0x26, 0x2a], signature: [0x20, 0x01, 0x0a, 0x0a], flags: 0x0006 }],
  });
  const image = parseCil(built.bytes);
  const { frontend, methods } = await methodsOf(image);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const thisLoad = decoded.bundles.find((bundle) => bundle.mnemonic === 'ldarg.0');
  const paramLoad = decoded.bundles.find((bundle) => bundle.mnemonic === 'ldarg.1');
  assert.equal(thisLoad.completeness, 'exact');
  assert.deepEqual(thisLoad.locationReads, [{ kind: 'argument', index: 0 }]);
  assert.equal(thisLoad.producedValues[0].stackType, 'object-ref');
  assert.equal(paramLoad.producedValues[0].bits, 64);
  assert.equal(paramLoad.producedValues[0].stackType, 'int64');
});

test('#5353 slot access beyond the resolved signature fails closed to partial', () => {
  // The minimal fixture resolves its method to static void(); ldarg.0 is
  // out of frame for a zero-parameter signature and must not borrow a width.
  const built = buildCil({ methods: [{ name: 'F', body: [0x02, 0x26, 0x2a] }] });
  const image = parseCil(built.bytes);
  const lifted = liftCilMethod(0, image);
  const ldarg = lifted.bundles.find((bundle) => bundle.mnemonic === 'ldarg.0');
  assert.equal(ldarg.completeness, 'partial');
  assert.ok(['cil-argument-index-out-of-frame', 'cil-argument-signature-unresolved']
    .includes(ldarg.unknownEffects[0].reason));
  assert.ok(!ldarg.locationReads[0].bits);
});

test('#5353 missing StandAloneSig row fails closed at the lifter boundary', () => {
  // parser-base already rejects this token at parse time; the direct image
  // proves the lifter's own boundary also fails closed (defense in depth).
  const image = {
    moduleId: 'managed-module:test:locals-missing-row',
    vmSpecEdition: 'v4.0.30319',
    methodBodies: [{
      headerOffset: 0,
      codeOffset: 0,
      isTiny: false,
      maxStack: 8,
      codeSize: 3,
      localVarSigTok: 0x11000009,
      bytecode: Uint8Array.from([0x06, 0x26, 0x2a]),
      exceptionClauses: [],
    }],
  };
  const lifted = liftCilMethod(0, image);
  const ldloc = lifted.bundles.find((bundle) => bundle.mnemonic === 'ldloc.0');
  assert.equal(ldloc.completeness, 'partial');
  assert.ok(ldloc.unknownEffects[0].reason.startsWith('cil-'), JSON.stringify(ldloc.unknownEffects));
  assert.ok(!ldloc.locationReads[0].bits);
  assert.equal(lifted.aggregateCompleteness, 'partial');
});

test('#5353 out-of-frame slot access fails closed to partial instead of exact 32-bit', () => {
  const built = buildCil({
    methods: [{
      name: 'G',
      body: [0x06, 0x26, 0x2a], // ldloc.0 (no locals signature => out of frame); pop; ret
      fat: true,
      localVarSigTok: 0,
      signature: [0x00, 0x00, 0x01],
    }],
  });
  const image = parseCil(built.bytes);
  const lifted = liftCilMethod(0, image);
  const ldloc = lifted.bundles.find((bundle) => bundle.mnemonic === 'ldloc.0');
  assert.equal(ldloc.completeness, 'partial');
  assert.ok(ldloc.unknownEffects.some((effect) => effect.reason === 'cil-local-index-out-of-frame'));
  assert.ok(!ldloc.locationReads[0].bits, 'unresolved slot must not claim a width');
  assert.equal(lifted.aggregateCompleteness, 'partial');
});

test('#5353 unresolved signature downgrades ldarg instead of fabricating width', () => {
  // A bare methodBodies image carries no MethodDef rows at all: the argument
  // signature is unresolvable, so no width may be claimed.
  const image = {
    moduleId: 'managed-module:test:args-unresolved',
    vmSpecEdition: 'v4.0.30319',
    methodBodies: [{
      headerOffset: 0,
      codeOffset: 0,
      isTiny: false,
      maxStack: 8,
      codeSize: 3,
      localVarSigTok: 0,
      bytecode: Uint8Array.from([0x02, 0x26, 0x2a]),
      exceptionClauses: [],
    }],
  };
  const lifted = liftCilMethod(0, image);
  const ldarg = lifted.bundles.find((bundle) => bundle.mnemonic === 'ldarg.0');
  assert.equal(ldarg.completeness, 'partial');
  assert.ok(ldarg.unknownEffects.some((effect) => effect.reason === 'cil-argument-signature-unresolved'));
  assert.ok(!ldarg.locationReads[0].bits);
});

test('#5353 typed local parse is stricter than the parse-time shape check', () => {
  // The locals blob survives parse-time validation (raw TypeDefOrRef shape is
  // tag-valid) but names TypeDef row 99 in a 1-row image. The typed decoder
  // enforces row bounds, so the lifter fails closed instead of guessing.
  const built = buildCil({
    methods: [{
      name: 'G',
      body: [0x06, 0x26, 0x2a],
      fat: true,
      localVarSigTok: 0x11000001,
      signature: [0x00, 0x00, 0x01],
    }],
    standAloneSigs: [[0x07, 0x01, 0x11, 0x81, 0x8c]], // LOCAL_SIG, 1 local, VALUETYPE TypeDef#99
  });
  const image = parseCil(built.bytes);
  const lifted = liftCilMethod(0, image);
  const ldloc = lifted.bundles.find((bundle) => bundle.mnemonic === 'ldloc.0');
  assert.equal(ldloc.completeness, 'partial');
  assert.equal(ldloc.unknownEffects[0].reason, 'cil-local-var-signature-invalid');
  assert.ok(!ldloc.locationReads[0].bits);
  assert.equal(lifted.aggregateCompleteness, 'partial');
});

test('#5353 parseCilLocalVarSignature preserves BYREF and pinned locals', () => {
  // LOCAL_SIG: 1 local: pinned byref int64
  const locals = parseCilLocalVarSignature(Uint8Array.from([0x07, 0x01, 0x45, 0x10, 0x0a]));
  assert.equal(locals.length, 1);
  assert.equal(locals[0].stackType, 'managed-pointer');
  assert.equal(locals[0].pointee.stackType, 'int64');
  // 1 local: int32
  const plain = parseCilLocalVarSignature(Uint8Array.from([0x07, 0x01, 0x08]));
  assert.equal(plain[0].stackType, 'int32');
});

// ===========================================================================
// #7735 — CLI header entrypoint authority
// ===========================================================================

function entryFixture(entryPointToken, cliFlags = 0x00000001) {
  return buildCil({
    methods: [
      { name: 'MainA', body: [0x2a], signature: [0x00, 0x00, 0x01] },
      { name: 'MainB', body: [0x2a], signature: [0x00, 0x00, 0x01] },
    ],
    cliFlags,
    entryPointToken,
  });
}

test('#7735 EntryPointToken distinguishes images and resolves to the entry method', () => {
  const a = parseCil(entryFixture((0x06 << 24) | 1).bytes);
  const b = parseCil(entryFixture((0x06 << 24) | 2).bytes);
  assert.equal(a.cliFlags, 0x00000001);
  assert.equal(a.entryPointToken, 0x06000001);
  assert.equal(a.entryTargetKind, 'method-def');
  assert.equal(a.entryMethodToken, '0x06000001');
  assert.equal(b.entryPointToken, 0x06000002);
  assert.equal(b.entryMethodToken, '0x06000002');
  const project = (image) => JSON.stringify({ ...image, rawBytes: undefined, imageId: undefined });
  assert.notEqual(project(a), project(b), 'entry-only difference must be semantically visible');
});

test('#7735 zero EntryPointToken (library) publishes no entry authority', () => {
  const image = parseCil(entryFixture(0).bytes);
  assert.equal(image.entryPointToken, 0);
  assert.equal(image.entryTargetKind, undefined);
  assert.equal(image.entryMethodToken, undefined);
});

test('#7735 out-of-range managed entry MethodDef RID fails closed', () => {
  assert.throws(() => parseCil(entryFixture((0x06 << 24) | 3).bytes), /cil-entrypoint-methoddef-row-missing|cil-unsupported-binary|malformed/);
  assert.equal(probeCil(entryFixture((0x06 << 24) | 3).bytes).supported, false);
});

test('#7735 non-MethodDef/non-File managed token kind fails closed', () => {
  assert.throws(() => parseCil(entryFixture((0x01 << 24) | 1).bytes), /cil-entrypoint-token-kind-invalid|cil-unsupported-binary|malformed/);
});

test('#7735 native entrypoint flag treats the union field as an RVA, not a token', () => {
  const image = parseCil(entryFixture(0x00001234, 0x00000010).bytes); // NATIVE_ENTRYPOINT
  assert.equal(image.cliFlags, 0x00000010);
  assert.equal(image.entryTargetKind, 'native-rva');
  assert.equal(image.nativeEntryPointRva, 0x00001234);
  assert.equal(image.entryMethodToken, undefined, 'a native RVA is not a metadata token');
});

// ===========================================================================
// #7750 — BYREF pointee type identity
// ===========================================================================

test('#7750 int32& and int64& call results stay distinct exact types', async () => {
  const make = (inner) => buildCil({
    methods: [
      { name: 'Target', body: [0x2a], signature: [0x00, 0x00, 0x10, inner] }, // static byref-return
      { name: 'Caller', body: [0x28, 0x01, 0x00, 0x00, 0x06, 0x2a], signature: [0x00, 0x00, 0x01] }, // call Target; ret
    ],
  });
  const a = parseCil(make(0x08).bytes, { binaryId: 'same' }); // int32&
  const b = parseCil(make(0x0a).bytes, { binaryId: 'same' }); // int64&
  const fa = await methodsOf(a);
  const fb = await methodsOf(b);
  const da = await fa.frontend.decodeMethod(fa.methods[1], { image: a });
  const db = await fb.frontend.decodeMethod(fb.methods[1], { image: b });
  const callA = da.bundles.find((bundle) => bundle.mnemonic === 'call');
  const callB = db.bundles.find((bundle) => bundle.mnemonic === 'call');
  assert.equal(callA.completeness, 'exact');
  assert.equal(callB.completeness, 'exact');
  assert.equal(callA.producedValues[0].stackType, 'managed-pointer');
  assert.equal(callA.producedValues[0].pointee.stackType, 'int32');
  assert.equal(callB.producedValues[0].pointee.stackType, 'int64');
  assert.notDeepEqual(callA.producedValues, callB.producedValues);
  // Target's own ret consumes the byref return with its pointee.
  const daTarget = await fa.frontend.decodeMethod(fa.methods[0], { image: a });
  const retA = daTarget.bundles.find((bundle) => bundle.mnemonic === 'ret');
  assert.equal(retA.consumedValues[0].pointee.stackType, 'int32');
});

test('#7750 BYREF parameters distinguish ref int32 from ref int64', async () => {
  const make = (inner) => buildCil({
    methods: [{ name: 'F', body: [0x02, 0x26, 0x2a], signature: [0x00, 0x01, 0x01, 0x10, inner] }], // static void F(byref T)
  });
  const a = parseCil(make(0x08).bytes, { binaryId: 'same' });
  const b = parseCil(make(0x0a).bytes, { binaryId: 'same' });
  const fa = await methodsOf(a);
  const fb = await methodsOf(b);
  const da = await fa.frontend.decodeMethod(fa.methods[0], { image: a });
  const db = await fb.frontend.decodeMethod(fb.methods[0], { image: b });
  const ldargA = da.bundles.find((bundle) => bundle.mnemonic === 'ldarg.0');
  const ldargB = db.bundles.find((bundle) => bundle.mnemonic === 'ldarg.0');
  assert.equal(ldargA.completeness, 'exact');
  assert.equal(ldargA.producedValues[0].pointee.stackType, 'int32');
  assert.equal(ldargB.producedValues[0].pointee.stackType, 'int64');
  assert.notDeepEqual(ldargA.producedValues, ldargB.producedValues);
});

// ===========================================================================
// #7753 — ManifestResource + CLI Resources authority
// ===========================================================================

const manifestRow = (offset, flags, nameIdx, impl) => {
  const row = new Uint8Array(12);
  const view = new DataView(row.buffer);
  view.setUint32(0, offset, true);
  view.setUint32(4, flags, true);
  view.setUint16(8, nameIdx, true);
  view.setUint16(10, impl, true);
  return row;
};

function resourceFixture(payload, rowOffset = 0, flags = 1, impl = 0) {
  return buildCil({
    leadingStrings: ['Run'],
    methods: [{ name: 'Main', body: [0x2a], signature: [0x00, 0x00, 0x01] }],
    types: [{ name: 'Program', namespace: 'N', methodList: 1, fieldList: 1 }],
    extraRows: [[0x28, { count: 1, bytes: manifestRow(rowOffset, flags, 1, impl) }]],
    resourcesRva: 0x2c00,
    resourcesSize: 12,
    resources: [{ rva: 0x2c00, payload }],
  });
}

test('#7753 embedded ManifestResource publishes name, visibility, and payload', () => {
  const image = parseCil(resourceFixture(Uint8Array.from([0x41, 0x41, 0x41, 0x41])).bytes);
  const [resource] = image.manifestResources;
  assert.equal(resource.token, '0x28000001');
  assert.equal(resource.name, 'Run');
  assert.equal(resource.visibility, 1); // Public
  assert.equal(resource.location, 'embedded');
  assert.deepEqual(Array.from(resource.payload), [0x41, 0x41, 0x41, 0x41]);
});

test('#7753 payload-only differences are semantically visible in the canonical image', () => {
  const a = parseCil(resourceFixture(Uint8Array.from([0x41, 0x41, 0x41, 0x41])).bytes, { binaryId: 'same' });
  const b = parseCil(resourceFixture(Uint8Array.from([0x42, 0x42, 0x42, 0x42])).bytes, { binaryId: 'same' });
  const project = (image) => JSON.stringify({ ...image, rawBytes: undefined, imageId: undefined });
  assert.notEqual(project(a), project(b));
  assert.deepEqual(Array.from(b.manifestResources[0].payload), [0x42, 0x42, 0x42, 0x42]);
});

test('#7753 resource offset beyond the CLI Resources directory fails closed', () => {
  assert.throws(() => parseCil(resourceFixture(Uint8Array.from([0x41, 0x41, 0x41, 0x41]), 0xffff).bytes), /cil-manifest-resource-offset-invalid|cil-unsupported-binary|malformed/);
});

test('#7753 oversized embedded payload fails closed', () => {
  // 8-byte payload in a 12-byte directory leaves only 8 bytes for the length
  // prefix + payload; a length prefix claiming 0xffff cannot fit.
  const built = buildCil({
    leadingStrings: ['Run'],
    methods: [{ name: 'Main', body: [0x2a], signature: [0x00, 0x00, 0x01] }],
    types: [{ name: 'Program', namespace: 'N', methodList: 1, fieldList: 1 }],
    extraRows: [[0x28, { count: 1, bytes: manifestRow(4, 1, 1, 0) }]],
    resourcesRva: 0x2c00,
    resourcesSize: 12,
    resources: [{ rva: 0x2c00, payload: Uint8Array.from([0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41]) }],
  });
  // Rewrite the length prefix at dir.offset+4 (file offset 0xc04) to 0xffff.
  const view = new DataView(built.bytes.buffer);
  view.setUint32(0x200 + (0x2c00 - 0x2000) + 4, 0xffff, true);
  assert.throws(() => parseCil(built.bytes), /cil-manifest-resource-payload-out-of-bounds|cil-unsupported-binary|malformed/);
});

test('#7753 reserved/invalid visibility flags fail closed', () => {
  assert.throws(() => parseCil(resourceFixture(Uint8Array.from([0x41, 0x41, 0x41, 0x41]), 0, 0).bytes), /cil-manifest-resource-flags-invalid|cil-unsupported-binary|malformed/);
  assert.throws(() => parseCil(resourceFixture(Uint8Array.from([0x41, 0x41, 0x41, 0x41]), 0, 3).bytes), /cil-manifest-resource-flags-invalid|cil-unsupported-binary|malformed/);
});

test('#7753 duplicate resource names fail closed', () => {
  const built = buildCil({
    leadingStrings: ['Run'],
    methods: [{ name: 'Main', body: [0x2a], signature: [0x00, 0x00, 0x01] }],
    types: [{ name: 'Program', namespace: 'N', methodList: 1, fieldList: 1 }],
    extraRows: [[0x28, {
      count: 2,
      bytes: Uint8Array.from([...manifestRow(0, 1, 1, 0), ...manifestRow(0, 1, 1, 0)]),
    }]],
    resourcesRva: 0x2c00,
    resourcesSize: 12,
    resources: [{ rva: 0x2c00, payload: Uint8Array.from([0x41, 0x41, 0x41, 0x41]) }],
  });
  assert.throws(() => parseCil(built.bytes), /cil-manifest-resource-name-duplicate|cil-unsupported-binary|malformed/);
});
