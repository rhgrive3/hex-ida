import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { createCilCallSignatureResolver, createCilCallStackEffect } from '../../../js/managed/cil/call-signatures.js';
import { buildCil, cilTables } from '../fixtures/medium-cil.mjs';

// #7601 — MemberRefParent (Class) is identity-bearing: the coded index is
// decoded (raw value + resolved table + rid) and flows into the resolved
// call provenance, and a MemberRef whose owner row does not exist fails
// closed instead of minting an exact resolved signature. Two binaries whose
// MemberRef #1 differs only by owner (TypeDef #1 `N.A` vs TypeDef #2 `N.B`)
// must no longer produce identical `newobj 0x0A000001` call semantics.
//
// Call-target authority is a separate axis (#7601 follow-up): each legal
// MemberRefParent kind resolves to its canonical in-image identity —
// TypeDef/TypeRef name+namespace, TypeSpec raw constructed-type signature,
// MethodDef/ModuleRef name, and a TypeRef owner additionally through its
// ResolutionScope chain to a named assembly/module authority (AssemblyRef
// name+version, ModuleRef name, enclosing TypeRef chain). Targets whose
// scope authority is not decodable (null/Module scope) stay
// `callTargetResolved:false` with a distinct scope-unresolved reason instead
// of laundering an incomplete owner into an exact claim, and `newobj`
// produced values carry the owner's constructed type identity when the
// target authority is exact. A MethodSpec keeps its base MemberRef owner
// identity through the generic instantiation.

const align = (n) => Math.ceil(n / 4) * 4;
const pad = (b) => { const p = new Uint8Array(align(b.length)); p.set(b); return p; };
const utf8 = (s) => [...new TextEncoder().encode(s), 0];

// #Strings: [0]'A'[3]'N'[5]'B'[7]'N'[9]'Caller'[16]'.ctor'[22]'ExtType'[30]'E'[32]'ExtAsm'[39]'ModRef'
const strings = [0, ...utf8('A'), ...utf8('N'), ...utf8('B'), ...utf8('N'), ...utf8('Caller'), ...utf8('.ctor'),
  ...utf8('ExtType'), ...utf8('E'), ...utf8('ExtAsm'), ...utf8('ModRef')];
// #Blob: #1 @1  = instance void() ctor [0x20,0,1];
//        #2 @5  = static void() Caller [0,0,1];
//        #3 @10 = instance generic<1> I4() [0x30,1,0,8];
//        #4 @15 = MethodSpec instantiation(1 arg: I4) [0x0a,1,8]
//        #5 @19 = TypeSpec: CLASS TypeRef#1 [0x12,0x05]
const blob = Uint8Array.from([0, 0x03, 0x20, 0x00, 0x01, 0x03, 0x00, 0x00, 0x01, 0x00, 0x04, 0x30, 0x01, 0x00, 0x08,
  0x03, 0x0a, 0x01, 0x08, 0x02, 0x12, 0x05, 0]);
const TYPE_SPEC_SIG_BLOB = 19;
const STRING_EXT_ASM = 32;
const STRING_MOD_REF = 39;

// MemberRef row (small indexes): parent coded | name | signature
const memberRefsRow = (parentCoded, { nameIndex = 16, signatureIndex = 1 } = {}) => {
  const row = new Uint8Array(6), rv = new DataView(row.buffer);
  rv.setUint16(0, parentCoded, true);
  rv.setUint16(2, nameIndex, true);
  rv.setUint16(4, signatureIndex, true);
  return row;
};
// TypeRef row (small indexes): resolution scope | name | namespace
const typeRefsRow = (scopeEncoded = 0) => typeRefsRows([scopeEncoded]);
const typeRefsRows = (scopeEncodings) => {
  const bytes = new Uint8Array(6 * scopeEncodings.length), rv = new DataView(bytes.buffer);
  scopeEncodings.forEach((scopeEncoded, i) => {
    rv.setUint16(i * 6, scopeEncoded, true);
    rv.setUint16(i * 6 + 2, 22, true); // 'ExtType'
    rv.setUint16(i * 6 + 4, 30, true); // 'E'
  });
  return bytes;
};
// AssemblyRef row (small indexes): version | flags | publicKey | name | culture | hash
const assemblyRefsRow = ([major, minor, build, rev] = [1, 0, 0, 0], {
  flags = 0, publicKeyIndex = 0, cultureIndex = 0, hashIndex = 0,
} = {}) => {
  const row = new Uint8Array(20), rv = new DataView(row.buffer);
  rv.setUint16(0, major, true);
  rv.setUint16(2, minor, true);
  rv.setUint16(4, build, true);
  rv.setUint16(6, rev, true);
  rv.setUint32(8, flags, true);
  rv.setUint16(12, publicKeyIndex, true);
  rv.setUint16(14, STRING_EXT_ASM, true); // 'ExtAsm'
  rv.setUint16(16, cultureIndex, true);
  rv.setUint16(18, hashIndex, true);
  return row;
};
// ModuleRef row (small indexes): name
const moduleRefsRow = () => {
  const row = new Uint8Array(2), rv = new DataView(row.buffer);
  rv.setUint16(0, STRING_MOD_REF, true); // 'ModRef'
  return row;
};
// TypeSpec row (small indexes): signature blob
const typeSpecsRow = () => {
  const row = new Uint8Array(2), rv = new DataView(row.buffer);
  rv.setUint16(0, TYPE_SPEC_SIG_BLOB, true);
  return row;
};
// MethodSpec row (small indexes): Method coded (MemberRef#1 = (1<<1)|1) | instantiation blob
const methodSpecRow = () => {
  const row = new Uint8Array(4), rv = new DataView(row.buffer);
  rv.setUint16(0, 0x0003, true);
  rv.setUint16(2, 15, true); // instantiation blob #4
  return row;
};

const NEWOBJ_CALLER = [0x73, 0x01, 0x00, 0x00, 0x0a, 0x26, 0x2a]; // newobj 0x0A000001; pop; ret
const CALL_METHODSPEC = [0x28, 0x01, 0x00, 0x00, 0x2b, 0x26, 0x2a]; // call 0x2B000001; pop; ret
const CALL_METHODDEF = [0x28, 0x01, 0x00, 0x00, 0x06, 0x26, 0x2a]; // call 0x06000001; pop; ret
const CALL_METHODREF = [0x28, 0x01, 0x00, 0x00, 0x0a, 0x26, 0x2a]; // call 0x0A000001; pop; ret
const CALLVIRT_METHODREF = [0x6f, 0x01, 0x00, 0x00, 0x0a, 0x26, 0x2a]; // callvirt 0x0A000001; pop; ret

function fixture(parentCoded, {
  memberRefsBytes = memberRefsRow(parentCoded),
  methodSpecs = null,
  typeRefs = null,
  assemblyRefs = null,
  moduleRefs = null,
  typeSpecs = null,
  methodBody = NEWOBJ_CALLER,
  blobOverride = null,
} = {}) {
  const types = new Uint8Array(2 * 14), tv = new DataView(types.buffer);
  [[1, 3], [5, 7]].forEach(([name, ns], i) => {
    tv.setUint32(i * 14, 1, true);
    tv.setUint16(i * 14 + 4, name, true);
    tv.setUint16(i * 14 + 6, ns, true);
    tv.setUint16(i * 14 + 8, 0, true);
    tv.setUint16(i * 14 + 10, 1, true);
    tv.setUint16(i * 14 + 12, 1, true);
  });
  const methods = new Uint8Array(14), mvv = new DataView(methods.buffer);
  mvv.setUint32(0, 0x3600, true); // body RVA (file offset 0x1800)
  mvv.setUint16(6, 0x16, true);   // static Caller
  mvv.setUint16(8, 9, true);      // 'Caller'
  mvv.setUint16(10, 5, true);     // sig blob #2 (static void())
  mvv.setUint16(12, 1, true);
  const tables = cilTables(new Map([
    ...(typeRefs ? [[0x01, { count: typeRefs.length / 6, bytes: typeRefs }]] : []),
    ...(assemblyRefs ? [[0x23, { count: 1, bytes: assemblyRefs }]] : []),
    ...(moduleRefs ? [[0x1a, { count: 1, bytes: moduleRefs }]] : []),
    ...(typeSpecs ? [[0x1b, { count: 1, bytes: typeSpecs }]] : []),
    [2, { count: 2, bytes: types }],
    [6, { count: 1, bytes: methods }],
    [0x0a, { count: 1, bytes: memberRefsBytes }],
    ...(methodSpecs ? [[0x2b, { count: 1, bytes: methodSpecs }]] : []),
  ]));
  return buildCil({
    methods: [{ name: 'Caller', owner: 0, body: methodBody }],
    streams: [
      { name: '#~', bytes: tables.bytes },
      { name: '#Strings', bytes: pad(Uint8Array.from(strings)) },
      { name: '#Blob', bytes: pad(blobOverride ?? blob) },
    ],
  }).bytes;
}

const callBundle = (bytes, mnemonic) => liftCilMethod(0, parseCil(bytes, { binaryId: 'same' }))
  .bundles.find((b) => b.mnemonic === mnemonic);

test('#7601 MemberRef owner identity flows into resolved call provenance', () => {
  const a = callBundle(fixture(0x0008), 'newobj'); // TypeDef #1 (N.A)
  const b = callBundle(fixture(0x0010), 'newobj'); // TypeDef #2 (N.B)
  assert.equal(a.callEffects[0].signatureResolved, true);
  assert.equal(b.callEffects[0].signatureResolved, true);
  assert.equal(a.callEffects[0].signatureProvenance.ownerTable, 2);
  assert.equal(a.callEffects[0].signatureProvenance.ownerRid, 1);
  assert.equal(b.callEffects[0].signatureProvenance.ownerTable, 2);
  assert.equal(b.callEffects[0].signatureProvenance.ownerRid, 2);
  // The two binaries differ only by owner — the decoded call semantics must
  // reflect that instead of collapsing.
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a.callEffects[0].signatureProvenance, b.callEffects[0].signatureProvenance);
});

test('#7601 owner rows are resolved to canonical identity at the resolver boundary', () => {
  const imageA = parseCil(fixture(0x0008), { binaryId: 'a' });
  const imageB = parseCil(fixture(0x0010), { binaryId: 'b' });
  const resolutionA = createCilCallSignatureResolver(imageA)(0x0a000001);
  const resolutionB = createCilCallSignatureResolver(imageB)(0x0a000001);
  assert.equal(resolutionA.complete, true);
  assert.equal(resolutionB.complete, true);
  assert.deepEqual(resolutionA.provenance.owner, { table: 'TypeDef', rid: 1, name: 'A', namespace: 'N' });
  assert.deepEqual(resolutionB.provenance.owner, { table: 'TypeDef', rid: 2, name: 'B', namespace: 'N' });
});

test('#7601 a MemberRef whose owner row does not exist fails closed', () => {
  const bytes = fixture((3 << 3) | 0); // TypeDef #3 — table has only 2 rows
  const image = parseCil(bytes, { binaryId: 'ghost' });
  const resolution = createCilCallSignatureResolver(image)(0x0a000001);
  assert.equal(resolution.complete, false);
  assert.equal(resolution.reason, 'cil-call-signature-memberref-parent-row-missing');
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, false);
  assert.equal(call.callEffects[0].signatureReason, 'cil-call-signature-memberref-parent-row-missing');
});

test('#7601 a TypeRef owner without a decodable scope authority stays target-unresolved', () => {
  // MemberRefParent tag 1 = TypeRef, rid 1; TypeRef row exists, scope null.
  const bytes = fixture(0x0009, { typeRefs: typeRefsRow(0) });
  const image = parseCil(bytes, { binaryId: 'external' });
  const resolution = createCilCallSignatureResolver(image)(0x0a000001);
  assert.equal(resolution.complete, true); // signature contract is exact
  assert.deepEqual(resolution.provenance.owner,
    { table: 'TypeRef', rid: 1, name: 'ExtType', namespace: 'E', scope: null });
  const stackEffect = createCilCallStackEffect('newobj', resolution);
  assert.equal(stackEffect.complete, true);
  assert.equal(stackEffect.callTargetResolved, false);
  assert.equal(stackEffect.callTargetReason, 'cil-call-target-owner-scope-unresolved');
  // The production bundle must not launder the unresolved scope into an
  // exact resolved-target claim either.
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, false);
  assert.equal(call.callEffects[0].callTargetReason, 'cil-call-target-owner-scope-unresolved');
  // The produced object carries the unresolved TypeRef owner identity but
  // must not claim a resolved constructed type authority.
  assert.deepEqual(call.producedValues[0].constructedType,
    { table: 'TypeRef', rid: 1, name: 'ExtType', namespace: 'E', scope: null });
});

test('#7601 a TypeRef owner scoped to a named AssemblyRef resolves its target exactly', () => {
  // MemberRefParent tag 1 = TypeRef rid 1; ResolutionScope tag 2 = AssemblyRef rid 1.
  const bytes = fixture(0x0009, { typeRefs: typeRefsRow((1 << 2) | 2), assemblyRefs: assemblyRefsRow([2, 5, 7, 9]) });
  const image = parseCil(bytes, { binaryId: 'scoped' });
  const resolution = createCilCallSignatureResolver(image)(0x0a000001);
  assert.equal(resolution.complete, true);
  assert.deepEqual(resolution.provenance.owner.scope,
    { table: 'AssemblyRef', rid: 1, name: 'ExtAsm', majorVersion: 2, minorVersion: 5, buildNumber: 7, revisionNumber: 9,
      flags: 0, publicKeyOrToken: null, culture: null, hashValue: null });
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, true);
  assert.equal('callTargetReason' in call.callEffects[0], false);
  assert.deepEqual(call.producedValues[0].constructedType,
    { table: 'TypeRef', rid: 1, name: 'ExtType', namespace: 'E',
      scope: { table: 'AssemblyRef', rid: 1, name: 'ExtAsm', majorVersion: 2, minorVersion: 5, buildNumber: 7, revisionNumber: 9,
        flags: 0, publicKeyOrToken: null, culture: null, hashValue: null } });
});

test('#7601 a TypeRef owner scoped to a ModuleRef resolves its target exactly', () => {
  // ResolutionScope tag 1 = ModuleRef rid 1.
  const bytes = fixture(0x0009, { typeRefs: typeRefsRow((1 << 2) | 1), moduleRefs: moduleRefsRow() });
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, true);
  assert.deepEqual(call.producedValues[0].constructedType.scope,
    { table: 'ModuleRef', rid: 1, name: 'ModRef' });
});

test('#7601 a TypeRef owner scoped to a nested TypeRef chain resolves through the enclosing identities', () => {
  // ResolutionScope tag 3 = nested TypeRef rid 2, whose own scope is
  // AssemblyRef #1 — the chain must resolve through the enclosing identity.
  const bytes = fixture(0x0009, {
    typeRefs: typeRefsRows([(2 << 2) | 3, (1 << 2) | 2]),
    assemblyRefs: assemblyRefsRow([3, 1, 4, 1]),
  });
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, true);
  assert.deepEqual(call.producedValues[0].constructedType.scope,
    { table: 'TypeRef', rid: 2, name: 'ExtType', namespace: 'E',
      scope: { table: 'AssemblyRef', rid: 1, name: 'ExtAsm', majorVersion: 3, minorVersion: 1, buildNumber: 4, revisionNumber: 1,
        flags: 0, publicKeyOrToken: null, culture: null, hashValue: null } });
});

test('#7601 a TypeRef owner whose scope row is missing fails closed', () => {
  // Scope claims AssemblyRef #1 but no AssemblyRef table is present.
  const bytes = fixture(0x0009, { typeRefs: typeRefsRow((1 << 2) | 2) });
  const image = parseCil(bytes, { binaryId: 'missing-scope' });
  const resolution = createCilCallSignatureResolver(image)(0x0a000001);
  assert.equal(resolution.complete, false);
  assert.equal(resolution.reason, 'cil-call-signature-memberref-owner-scope-row-missing');
});

test('#7601 a TypeRef owner with a Module-tagged scope fails closed', () => {
  // ResolutionScope tag 0 = Module; no Module table is present in the image.
  const bytes = fixture(0x0009, { typeRefs: typeRefsRow(1 << 2) });
  const image = parseCil(bytes, { binaryId: 'module-scope' });
  const resolution = createCilCallSignatureResolver(image)(0x0a000001);
  assert.equal(resolution.complete, false);
  assert.equal(resolution.reason, 'cil-call-signature-memberref-owner-scope-row-missing');
});

test('#7601 same-name TypeRefs in separate assemblies never alias', () => {
  // Two binaries identical except the AssemblyRef version authority behind
  // the same-name TypeRef owner must produce distinct newobj semantics.
  const v1 = callBundle(fixture(0x0009, { typeRefs: typeRefsRow((1 << 2) | 2), assemblyRefs: assemblyRefsRow([1, 0, 0, 0]) }), 'newobj');
  const v2 = callBundle(fixture(0x0009, { typeRefs: typeRefsRow((1 << 2) | 2), assemblyRefs: assemblyRefsRow([2, 0, 0, 0]) }), 'newobj');
  assert.equal(v1.callEffects[0].signatureResolved, true);
  assert.equal(v2.callEffects[0].signatureResolved, true);
  assert.deepEqual(v1.producedValues[0].constructedType.scope,
    { table: 'AssemblyRef', rid: 1, name: 'ExtAsm', majorVersion: 1, minorVersion: 0, buildNumber: 0, revisionNumber: 0,
      flags: 0, publicKeyOrToken: null, culture: null, hashValue: null });
  assert.notDeepEqual(v1, v2);
  assert.notDeepEqual(v1.callEffects[0].signatureProvenance.owner, v2.callEffects[0].signatureProvenance.owner);
});

test('#7601 AssemblyRef identity is lossless across PublicKeyOrToken / Culture / HashValue / Flags', () => {
  // #Blob: [9]=len4 [de ad be ef] (public key), [14]=len2 [be ef] (hash)
  const blobWithKey = Uint8Array.from([0, 0x03, 0x20, 0x00, 0x01, 0x03, 0x00, 0x00, 0x01,
    0x04, 0xde, 0xad, 0xbe, 0xef, 0x02, 0xbe, 0xef, 0]);
  const base = { typeRefs: typeRefsRow((1 << 2) | 2), assemblyRefs: assemblyRefsRow([1, 0, 0, 0]) };
  const keyA = callBundle(fixture(0x0009, { ...base, blobOverride: blobWithKey }), 'newobj');
  const keyB = callBundle(fixture(0x0009, {
    ...base, blobOverride: blobWithKey, assemblyRefs: assemblyRefsRow([1, 0, 0, 0], { publicKeyIndex: 9 }),
  }), 'newobj');
  // PublicKeyOrToken-only difference: same name/version, distinct call-target authority.
  assert.equal(keyA.callEffects[0].signatureResolved, true);
  assert.equal(keyB.callEffects[0].signatureResolved, true);
  assert.equal(keyA.producedValues[0].constructedType.scope.publicKeyOrToken, null);
  assert.deepEqual(keyB.producedValues[0].constructedType.scope.publicKeyOrToken, [0xde, 0xad, 0xbe, 0xef]);
  assert.notDeepEqual(keyA.producedValues[0].constructedType, keyB.producedValues[0].constructedType);
  assert.notDeepEqual(keyA, keyB);
  // Culture-only difference.
  const cultureB = callBundle(fixture(0x0009, {
    ...base, blobOverride: blobWithKey, assemblyRefs: assemblyRefsRow([1, 0, 0, 0], { cultureIndex: 39 }),
  }), 'newobj');
  assert.equal(cultureB.producedValues[0].constructedType.scope.culture, 'ModRef');
  assert.notDeepEqual(keyA.callEffects[0].signatureProvenance.owner, cultureB.callEffects[0].signatureProvenance.owner);
  // Flags/HashValue are carried raw as authority.
  const flagsB = callBundle(fixture(0x0009, {
    ...base, blobOverride: blobWithKey, assemblyRefs: assemblyRefsRow([1, 0, 0, 0], { flags: 1, hashIndex: 14 }),
  }), 'newobj');
  assert.equal(flagsB.producedValues[0].constructedType.scope.flags, 1);
  assert.deepEqual(flagsB.producedValues[0].constructedType.scope.hashValue, [0xbe, 0xef]);
});

test('#7601 a malformed AssemblyRef public-key reference fails closed', () => {
  // PublicKeyOrToken points past the end of the blob heap.
  const bytes = fixture(0x0009, {
    typeRefs: typeRefsRow((1 << 2) | 2), assemblyRefs: assemblyRefsRow([1, 0, 0, 0], { publicKeyIndex: 999 }),
  });
  const image = parseCil(bytes, { binaryId: 'bad-key' });
  const resolution = createCilCallSignatureResolver(image)(0x0a000001);
  assert.equal(resolution.complete, false);
  assert.equal(resolution.reason, 'cil-call-signature-memberref-owner-scope-public-key-invalid');
});

test('#7601 a locally-owned MemberRef (TypeDef) keeps callTargetResolved true', () => {
  const bytes = fixture(0x0008); // TypeDef #1 owner, no TypeRef table
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, true);
  assert.equal('callTargetReason' in call.callEffects[0], false);
  assert.deepEqual(call.producedValues[0].constructedType, { table: 'TypeDef', rid: 1, name: 'A', namespace: 'N' });
});

test('#7601 a MethodDef call target stays fully resolved', () => {
  const bytes = fixture(0x0008, { methodBody: CALL_METHODDEF });
  const call = callBundle(bytes, 'call');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].signatureProvenance.table, 'MethodDef');
  assert.equal(call.callEffects[0].callTargetResolved, true);
});

test('#7601 call and callvirt separate owner identity on the public bundle', () => {
  const a = callBundle(fixture(0x0008, { methodBody: CALL_METHODREF }), 'call');
  const b = callBundle(fixture(0x0010, { methodBody: CALL_METHODREF }), 'call');
  const v = callBundle(fixture(0x0008, { methodBody: CALLVIRT_METHODREF }), 'callvirt');
  assert.equal(a.callEffects[0].signatureResolved, true);
  assert.equal(a.callEffects[0].signatureProvenance.ownerTable, 2);
  assert.equal(a.callEffects[0].signatureProvenance.ownerRid, 1);
  assert.notDeepEqual(a, b);
  assert.deepEqual(b.callEffects[0].signatureProvenance.owner,
    { table: 'TypeDef', rid: 2, name: 'B', namespace: 'N' });
  assert.equal(v.callEffects[0].signatureProvenance.ownerRid, 1);
  assert.equal(v.callEffects[0].callTargetResolved, true);
});

test('#7601 direct ModuleRef MemberRefParent is fixed as canonical call-target identity', () => {
  // MemberRefParent tag 2 = ModuleRef rid 1.
  const bytes = fixture(0x000a, {
    moduleRefs: moduleRefsRow(),
    memberRefsBytes: memberRefsRow(0x000a, { nameIndex: 9, signatureIndex: 5 }),
    methodBody: CALL_METHODREF,
  });
  const resolution = createCilCallSignatureResolver(parseCil(bytes, { binaryId: 'direct-module' }))(0x0a000001);
  assert.equal(resolution.complete, true);
  assert.equal(resolution.provenance.ownerTable, 0x1a);
  assert.deepEqual(resolution.provenance.owner, { table: 'ModuleRef', rid: 1, name: 'ModRef' });
  const call = callBundle(bytes, 'call');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, true);
});

test('#7601 direct MethodDef MemberRefParent is fixed as canonical call-target identity', () => {
  // MemberRefParent tag 3 = MethodDef rid 1.
  const bytes = fixture(0x000b, {
    memberRefsBytes: memberRefsRow(0x000b, { nameIndex: 9, signatureIndex: 5 }),
    methodBody: CALL_METHODREF,
  });
  const resolution = createCilCallSignatureResolver(parseCil(bytes, { binaryId: 'direct-method' }))(0x0a000001);
  assert.equal(resolution.complete, true);
  assert.equal(resolution.provenance.ownerTable, 0x06);
  assert.deepEqual(resolution.provenance.owner, { table: 'MethodDef', rid: 1, name: 'Caller' });
  const call = callBundle(bytes, 'call');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, true);
});

test('#7601 a TypeSpec owner carries validated exact signature bytes as constructed-type authority', () => {
  // MemberRefParent tag 4 = TypeSpec rid 1; TypeSpec sig = CLASS TypeRef#1.
  const bytes = fixture(0x000c, { typeSpecs: typeSpecsRow(), typeRefs: typeRefsRow(0) });
  const image = parseCil(bytes, { binaryId: 'spec-owner' });
  const resolution = createCilCallSignatureResolver(image)(0x0a000001);
  assert.equal(resolution.complete, true);
  assert.deepEqual(resolution.provenance.owner,
    { table: 'TypeSpec', rid: 1, signatureBlobIndex: TYPE_SPEC_SIG_BLOB, signatureBytes: [0x12, 0x05] });
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, true);
  assert.deepEqual(call.producedValues[0].constructedType,
    { table: 'TypeSpec', rid: 1, signatureBlobIndex: TYPE_SPEC_SIG_BLOB, signatureBytes: [0x12, 0x05] });
});

test('#7601 same TypeSpec RID/blob index with different blob bytes never aliases newobj semantics', () => {
  const valueTypeBlob = Uint8Array.from(blob);
  valueTypeBlob[20] = 0x11; // VALUETYPE TypeRef#1 instead of CLASS TypeRef#1 at the same heap offset.
  const classCall = callBundle(fixture(0x000c, { typeSpecs: typeSpecsRow(), typeRefs: typeRefsRow(0) }), 'newobj');
  const valueCall = callBundle(fixture(0x000c, {
    typeSpecs: typeSpecsRow(), typeRefs: typeRefsRow(0), blobOverride: valueTypeBlob,
  }), 'newobj');
  assert.equal(classCall.callEffects[0].callTargetResolved, true);
  assert.equal(valueCall.callEffects[0].callTargetResolved, true);
  assert.deepEqual(classCall.producedValues[0].constructedType.signatureBytes, [0x12, 0x05]);
  assert.deepEqual(valueCall.producedValues[0].constructedType.signatureBytes, [0x11, 0x05]);
  assert.notDeepEqual(classCall.producedValues[0].constructedType, valueCall.producedValues[0].constructedType);
  assert.notDeepEqual(classCall, valueCall);
});

test('#7601 malformed TypeSpec signature fails closed before exact call-target authority', () => {
  const malformed = Uint8Array.from(blob);
  malformed[20] = 0xff; // invalid ELEMENT_TYPE at the same TypeSpec heap offset.
  const bytes = fixture(0x000c, { typeSpecs: typeSpecsRow(), typeRefs: typeRefsRow(0), blobOverride: malformed });
  const image = parseCil(bytes, { binaryId: 'bad-spec' });
  const resolution = createCilCallSignatureResolver(image)(0x0a000001);
  assert.equal(resolution.complete, false);
  assert.equal(resolution.reason, 'cil-call-signature-memberref-owner-typespec-signature-invalid');
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, false);
});

test('#7601 a MethodSpec keeps its base MemberRef owner identity through the instantiation', () => {
  // MethodSpec #1 -> MemberRef #1 (TypeDed #2 owner), generic instance sig
  // (1 method generic), instantiation [I4]; arity matches, owner propagates.
  const bytes = fixture(0x0010, {
    methodSpecs: methodSpecRow(),
    memberRefsBytes: memberRefsRow(0x0010, { signatureIndex: 10 }),
    methodBody: CALL_METHODSPEC,
  });
  const image = parseCil(bytes, { binaryId: 'spec' });
  const resolution = createCilCallSignatureResolver(image)(0x2b000001);
  assert.equal(resolution.complete, true);
  assert.equal(resolution.provenance.table, 'MethodSpec');
  assert.equal(resolution.provenance.resolvedTable, 'MemberRef');
  assert.deepEqual(resolution.provenance.owner, { table: 'TypeDef', rid: 2, name: 'B', namespace: 'N' });
  const stackEffect = createCilCallStackEffect('call', resolution);
  assert.equal(stackEffect.complete, true);
  assert.equal(stackEffect.callTargetResolved, true);
  const call = callBundle(bytes, 'call');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].signatureProvenance.table, 'MethodSpec');
  assert.equal(call.callEffects[0].signatureProvenance.ownerRid, 2);
  assert.equal(call.callEffects[0].callTargetResolved, true);
});

test('#7601 a MethodSpec over an external MemberRef owner propagates identity but stays target-unresolved', () => {
  const bytes = fixture(0x0009, {
    typeRefs: typeRefsRow(0),
    methodSpecs: methodSpecRow(),
    memberRefsBytes: memberRefsRow(0x0009, { signatureIndex: 10 }),
    methodBody: CALL_METHODSPEC,
  });
  const image = parseCil(bytes, { binaryId: 'spec-external' });
  const resolution = createCilCallSignatureResolver(image)(0x2b000001);
  assert.equal(resolution.complete, true);
  assert.deepEqual(resolution.provenance.owner,
    { table: 'TypeRef', rid: 1, name: 'ExtType', namespace: 'E', scope: null });
  const call = callBundle(bytes, 'call');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].signatureProvenance.ownerTable, 1);
  assert.equal(call.callEffects[0].callTargetResolved, false);
  assert.equal(call.callEffects[0].callTargetReason, 'cil-call-target-owner-scope-unresolved');
});

// R0 (#7601): call-target incompleteness must not launder into the overall
// bundle authority. An unresolved target degrades the public bundle to
// partial (with the target reason), and `newobj` only accepts type-bearing
// owners as exact targets — MethodDef/ModuleRef MemberRefParents carry no
// constructed-type identity.

test('#7601 newobj through a MethodDef owner fails closed without constructed-type authority', () => {
  // MemberRefParent tag 3 = MethodDef rid 1; MemberRef name '.ctor', instance void().
  const bytes = fixture(0x000b, { methodBody: NEWOBJ_CALLER });
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, false);
  assert.equal(call.callEffects[0].callTargetReason, 'cil-newobj-owner-not-type-authority');
  assert.equal(call.completeness, 'partial');
  assert.deepEqual(call.unknownEffects.map((u) => u.reason), ['cil-newobj-owner-not-type-authority']);
  assert.deepEqual(call.producedValues[0], { id: 'constructed-object', stackType: 'object-ref' });
});

test('#7601 newobj through a ModuleRef owner fails closed without constructed-type authority', () => {
  // MemberRefParent tag 2 = ModuleRef rid 1.
  const bytes = fixture(0x000a, {
    moduleRefs: moduleRefsRow(),
    memberRefsBytes: memberRefsRow(0x000a),
    methodBody: NEWOBJ_CALLER,
  });
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].callTargetResolved, false);
  assert.equal(call.callEffects[0].callTargetReason, 'cil-newobj-owner-not-type-authority');
  assert.equal(call.completeness, 'partial');
  assert.deepEqual(call.producedValues[0], { id: 'constructed-object', stackType: 'object-ref' });
});

test('#7601 newobj with an unresolved-scope TypeRef owner degrades the bundle to partial', () => {
  const bytes = fixture(0x0009, { typeRefs: typeRefsRow(0) });
  const call = callBundle(bytes, 'newobj');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, false);
  assert.equal(call.callEffects[0].callTargetReason, 'cil-call-target-owner-scope-unresolved');
  assert.equal(call.completeness, 'partial');
  assert.deepEqual(call.unknownEffects.map((u) => u.reason), ['cil-call-target-owner-scope-unresolved']);
  // The owner identity itself stays lossless on the produced value.
  assert.deepEqual(call.producedValues[0].constructedType,
    { table: 'TypeRef', rid: 1, name: 'ExtType', namespace: 'E', scope: null });
});

test('#7601 call with an unresolved-scope TypeRef owner also degrades the bundle to partial', () => {
  const bytes = fixture(0x0009, {
    typeRefs: typeRefsRow(0),
    memberRefsBytes: memberRefsRow(0x0009, { nameIndex: 9, signatureIndex: 5 }),
    methodBody: CALL_METHODREF,
  });
  const call = callBundle(bytes, 'call');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, false);
  assert.equal(call.completeness, 'partial');
  assert.deepEqual(call.unknownEffects.map((u) => u.reason), ['cil-call-target-owner-scope-unresolved']);
});

test('#7601 call with a resolved owner keeps the exact bundle authority', () => {
  // AssemblyRef-scoped TypeRef owner resolves; the bundle must stay exact.
  const bytes = fixture(0x0009, {
    typeRefs: typeRefsRow((1 << 2) | 2),
    assemblyRefs: assemblyRefsRow([2, 5, 7, 9]),
    memberRefsBytes: memberRefsRow(0x0009, { nameIndex: 9, signatureIndex: 5 }),
    methodBody: CALL_METHODREF,
  });
  const call = callBundle(bytes, 'call');
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].callTargetResolved, true);
  assert.equal(call.completeness, 'exact');
  assert.deepEqual(call.unknownEffects, []);
});
