import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCilCallMetadataIndex } from '../js/managed/cil/call-signature-metadata.js';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';
import { decodeDexExceptionTable } from '../js/managed/dex/exception-table.js';
import { liftDexMethod as liftDexBase } from '../js/managed/dex/lifter-base.js';
import { liftDexMethod } from '../js/managed/dex/lifter.js';
import { decodeDexControlFlow, buildDexControlFlowIndex } from '../js/managed/dex/control-flow.js';
import { dexMethodDefinitions } from '../js/managed/dex/method-definitions.js';
import { captureDexValidationMetadata } from '../js/managed/dex/validation-base.js';
import { parseWasm } from '../js/managed/wasm/parser-core.js';
import { liftWasmFunction } from '../js/managed/wasm/lifter-core.js';
import { validateWasmFunctionTypes } from '../js/managed/wasm/validator.js';
import { liftJvmMethod } from '../js/managed/jvm/lifter-core.js';
import { validateCilEffectFunction } from '../js/managed/cil/validation.js';
import { bindCilMetadataTables } from '../js/managed/cil/metadata-definitions-core.js';
import { createCilMetadataAdmission } from '../js/managed/cil/metadata-budget.js';
import { liftCilMethod } from '../js/managed/cil/lifter.js';
import { overlayCilMetadata } from '../js/managed/cil/parser-overlay.js';
import { readCilGenericMetadata } from '../js/managed/cil/metadata-generics.js';
import { dexMethod, buildDex } from './phase11/fixtures/medium-dex.mjs';

function uleb(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function sleb(value) {
  const out = [];
  let v = value | 0;
  let more = true;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
      more = false;
    } else {
      b |= 0x80;
    }
    out.push(b);
  }
  return out;
}

function wasmSection(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

function buildWasmModule(sections) {
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

// 1. [P0] cil/call-signature-metadata.js: TypeDef.FieldList offset +4 (not +6)
test('Wave2-B #1 [P0]: TypeDef.FieldList reads at offset +4 instead of +6', () => {
  const image = buildCil({
    methods: [],
    types: [
      { name: 'First', namespace: 'Example', fieldList: 1, methodList: 1 },
      { name: 'Second', namespace: 'Example', fieldList: 2, methodList: 1 },
    ],
    fields: [
      { name: 'f1', flags: 6, signature: [0x06, 0x08] },
      { name: 'f2', flags: 6, signature: [0x06, 0x08] },
    ],
  }).bytes;
  const meta = buildCilCallMetadataIndex(image);
  assert.equal(meta.typeDefs.length, 2);
  assert.equal(meta.typeDefs[0].fieldList, 1);
  assert.equal(meta.typeDefs[1].fieldList, 2);
});

// 2. [P0] dex/exception-table.js: maxExceptionRegions prevents quadratic shared catch_handler OOM
test('Wave2-B #2 [P0]: decodeDexExceptionTable enforces maxExceptionRegions budget', () => {
  // Build 4 tries sharing 1 catch_handler with 4 typed targets => 16 regions.
  const insnsSize = 8; // even => no padding
  const insnsStart = 0;
  const triesSize = 4;
  const handlerBytes = [
    ...uleb(1), // 1 handler in list
    ...sleb(4), // 4 typed catches
    ...uleb(0), ...uleb(0),
    ...uleb(1), ...uleb(1),
    ...uleb(2), ...uleb(2),
    ...uleb(3), ...uleb(3),
  ];
  const listStart = insnsStart + insnsSize * 2 + triesSize * 8;
  const bytes = new Uint8Array(listStart + handlerBytes.length);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < triesSize; i++) {
    const off = insnsStart + insnsSize * 2 + i * 8;
    dv.setUint32(off, i * 2, true);
    dv.setUint16(off + 4, 2, true);
    dv.setUint16(off + 6, 1, true); // handlerOff = 1 (right after list ULEB count)
  }
  bytes.set(handlerBytes, listStart);

  const types = ['Ljava/lang/A;', 'Ljava/lang/B;', 'Ljava/lang/C;', 'Ljava/lang/D;'];
  const boundaries = new Set([0, 2, 4, 6, 8, 10, 12, 14]);

  const ok = decodeDexExceptionTable(bytes, {
    methodId: 'm0', insnsStart, insnsSize, triesSize, types, boundaries, maxExceptionRegions: 16,
  });
  assert.equal(ok.regions.length, 16);

  assert.throws(
    () => decodeDexExceptionTable(bytes, {
      methodId: 'm0', insnsStart, insnsSize, triesSize, types, boundaries, maxExceptionRegions: 15,
    }),
    /dex-exception-region-budget-exceeded/,
  );
});

// 3. [P0] dex/lifter-base.js: invoke-interface shares frozen interfaceTypes and charges budget
test('Wave2-B #3 [P0]: invoke-interface shares frozen interfaceTypes and charges value budget', () => {
  const image = dexMethod(
    [0x2072, 0x0000, 0x0010, 0x2072, 0x0000, 0x0010, 0x000e],
    { registers: 4 },
  );
  const frozenClasses = Object.freeze([
    Object.freeze({ ...image.classes[0], interfaceTypes: Object.freeze(['LI1;', 'LI2;', 'LI3;']) }),
    Object.freeze({ classType: 'LB;', directMethods: Object.freeze([]), virtualMethods: Object.freeze([]), interfaceTypes: Object.freeze(['LI4;', 'LI5;']) }),
  ]);
  const frozenImage = Object.freeze({ ...image, classes: frozenClasses });

  const fn = liftDexBase(0, frozenImage);
  const ifaceCalls = fn.bundles.flatMap((b) => b.callEffects).filter((c) => c.dispatchKind === 'interface');
  assert.equal(ifaceCalls.length, 2);
  assert.deepEqual(ifaceCalls[0].interfaceTypes, ifaceCalls[1].interfaceTypes);
  assert.ok(Object.isFrozen(ifaceCalls[0].interfaceTypes));
  assert.deepEqual(ifaceCalls[0].interfaceTypes, ['LI1;', 'LI2;', 'LI3;', 'LI4;', 'LI5;']);

  assert.throws(
    () => liftDexBase(0, frozenImage, { budget: { maxValues: 6 } }),
    /vm-effect-resource-limit-values/,
  );
});

// 4. [P1] wasm/parser-core.js: readFunctionMemarg supports flags & 0x40 multi-memory index
test('Wave2-B #4 [P1]: parseWasm decodes multi-memory memarg (flags & 0x40)', () => {
  // Type: () -> i32
  const typeSec = wasmSection(1, [1, 0x60, 0, 1, 0x7f]);
  // Function: [0]
  const funcSec = wasmSection(3, [1, 0]);
  // Memory: 2 memories (min 1)
  const memSec = wasmSection(5, [2, 0x00, 1, 0x00, 1]);
  // Code: 1 body: 0 locals, i32.const 0, i32.load align=(0x40|2) memoryIndex=1 offset=8, end
  const body = [0, 0x41, 0x00, 0x28, 0x42, 0x01, 0x08, 0x0b];
  const codeSec = wasmSection(10, [1, ...uleb(body.length), ...body]);

  const mod = parseWasm(buildWasmModule([typeSec, funcSec, memSec, codeSec]));
  assert.equal(mod.codeBodies.length, 1);
  assert.equal(mod.memories.length, 2);

  // flags >= 0x80 must fail closed
  const badBody = [0, 0x41, 0x00, 0x28, 0x80, 0x01, 0x08, 0x0b];
  const badCodeSec = wasmSection(10, [1, ...uleb(badBody.length), ...badBody]);
  assert.throws(
    () => parseWasm(buildWasmModule([typeSec, funcSec, memSec, badCodeSec])),
    /wasm-invalid-memarg-flags/,
  );
});

// 5. [P1] wasm/lifter-core.js: unreachable parameterized block restores currentStackHeight
test('Wave2-B #5 [P1]: liftWasmFunction restores currentStackHeight for parameterized block in unreachable code', () => {
  // Type 0: () -> ()
  // Type 1: (i32) -> (i32)
  const typeSec = wasmSection(1, [2, 0x60, 0, 0, 0x60, 1, 0x7f, 1, 0x7f]);
  const funcSec = wasmSection(3, [1, 0]);
  // Body: unreachable, block (type 1: (i32)->(i32)), end, drop, end
  const body = [0, 0x00, 0x02, 0x01, 0x0b, 0x1a, 0x0b];
  const codeSec = wasmSection(10, [1, ...uleb(body.length), ...body]);
  const mod = parseWasm(buildWasmModule([typeSec, funcSec, codeSec]));

  const lifted = liftWasmFunction(0, mod);
  assert.ok(lifted.bundles.length >= 4);
});

// 6. [P1] wasm/validator.js: return (0x0f) charges budget.chargeValues(funcType.results.length)
test('Wave2-B #6 [P1]: wasm validator return charges funcType.results.length to budget', () => {
  // Type: () -> (i32, i32, i32, i32)
  const typeSec = wasmSection(1, [1, 0x60, 0, 4, 0x7f, 0x7f, 0x7f, 0x7f]);
  const funcSec = wasmSection(3, [1, 0]);
  // Body: 4x i32.const 1, return, end
  const body = [0, 0x41, 1, 0x41, 1, 0x41, 1, 0x41, 1, 0x0f, 0x0b];
  const codeSec = wasmSection(10, [1, ...uleb(body.length), ...body]);
  const mod = parseWasm(buildWasmModule([typeSec, funcSec, codeSec]));

  // return charges funcType.results.length (4 values).
  assert.doesNotThrow(() => validateWasmFunctionTypes(0, mod, { budget: { maxValues: 4 } }));
  assert.throws(
    () => validateWasmFunctionTypes(0, mod, { budget: { maxValues: 3 } }),
    /vm-effect-resource-limit-values/,
  );
});

// 7. [P1] dex/control-flow.js + dex/lifter.js: switch payload budget & deduplication
test('Wave2-B #7 [P1]: shared DEX switch payload enforces budget and avoids unbounded duplication', () => {
  // packed-switch at pc=0 -> payload at pc=4 (byte 8); second packed-switch at pc=10 -> same payload or out of budget
  // Layout:
  // pc=0..2: packed-switch v0, +4 (payload at pc=4)
  // pc=3: return-void (0x000e)
  // pc=4..9: packed-switch payload (0x0100, n=2, first=0, disp0=3, disp1=3) -> length = 4 + 2*2 = 8 units? Wait: 1+1+2+2*2 = 8 units (pc 4..11)
  const words = [0x002b, 4, 0, 0x000e, 0x0100, 2, 0, 0, 3, 0, 3, 0];
  const raw = new Uint8Array(words.length * 2);
  const dv = new DataView(raw.buffer);
  words.forEach((w, i) => dv.setUint16(i * 2, w, true));
  const index = buildDexControlFlowIndex(dv, 0, words.length);

  const flow1 = decodeDexControlFlow({ view: dv, insnsStart: 0, insnsSize: words.length, pc: 0, opcode: 0x2b, formatByte: 0, index });
  assert.equal(flow1.reason, null);
  assert.equal(flow1.controlEffects[0].targetOffsets, flow1.controlEntries);
  assert.ok(Object.isFrozen(flow1.controlEntries));

  // Exceeding maxSwitchEntries returns dex-switch-budget-exceeded
  const flowOver = decodeDexControlFlow({
    view: dv, insnsStart: 0, insnsSize: words.length, pc: 0, opcode: 0x2b, formatByte: 0, index, maxSwitchEntries: 2,
  });
  assert.equal(flowOver.reason, 'dex-switch-budget-exceeded');

  // Via liftDexMethod with tight maxValues budget
  const image = dexMethod(words, { registers: 2 });
  const liftedTight = liftDexMethod(0, image, { budget: { maxValues: 1 } });
  assert.equal(liftedTight.bundles[0].mnemonic, 'unavailable_method');
});

// 8. [P1] dex/method-definitions.js: cache hit checked before isDeepFrozen
test('Wave2-B #8 [P1]: dexMethodDefinitions checks WeakMap cache before isDeepFrozen', () => {
  const N = 2000;
  const methods = [];
  const directMethods = [];
  for (let i = 0; i < N; i++) {
    methods.push(Object.freeze({ classType: 'LTest;', name: `m${i}` }));
    directMethods.push(Object.freeze({ methodIdx: i, accessFlags: 0x0001, codeOff: 16 + i * 4 }));
  }
  const image = Object.freeze({
    methods: Object.freeze(methods),
    classes: Object.freeze([Object.freeze({ classType: 'LTest;', directMethods: Object.freeze(directMethods), virtualMethods: Object.freeze([]) })]),
  });

  const first = dexMethodDefinitions(image);
  assert.equal(first.size, N);
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) {
    const hit = dexMethodDefinitions(image);
    assert.equal(hit, first);
  }
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 100, `Expected O(1) cache hits, took ${elapsed.toFixed(1)}ms`);
});

// 9. [P1] jvm/lifter-core.js: lookupswitch joinOffsets reads branch target (+12), not match key (+8)
test('Wave2-B #9 [P1]: JVM lookupswitch joinOffsets uses branch offset (+12), not match key (+8)', () => {
  // Bytecode:
  // 0: iconst_0 (0x03)
  // 1: lookupswitch (0xab), padding to 4 (2 bytes: 2, 3)
  // 4: default = +24 (target = 1 + 24 = 25)
  // 8: npairs = 1
  // 12: match key = 5 (NOTE: offset 1+5 = 6 is inside lookupswitch padding/table!)
  // 16: target = +20 (target = 1 + 20 = 21)
  // 20: nop (0x00) -- NOT a target (offset 20)
  // 21: iconst_1 (0x04) -- branch target!
  // 22: ireturn (0xac)
  // 23: nop (0x00)
  // 24: nop (0x00)
  // 25: iconst_2 (0x05) -- default target!
  // 26: ireturn (0xac)
  const code = new Uint8Array(27);
  const dv = new DataView(code.buffer);
  code[0] = 0x03; // iconst_0
  code[1] = 0xab; // lookupswitch
  dv.setInt32(4, 24, false);  // default -> 25
  dv.setInt32(8, 1, false);   // npairs = 1
  dv.setInt32(12, 5, false);  // match = 5 (would be 1+5=6 if buggy!)
  dv.setInt32(16, 20, false); // offset -> 21
  code[20] = 0x00;
  code[21] = 0x04;
  code[22] = 0xac;
  code[23] = 0x00;
  code[24] = 0x00;
  code[25] = 0x05;
  code[26] = 0xac;

  const jvmClass = {
    moduleId: 'managed-mod:jvm:test',
    vmSpecEdition: 'jvms-8',
    thisClass: 'Test',
    constantPool: [],
    methods: [{
      name: 'sw',
      descriptor: '()I',
      accessFlags: 0x0009,
      code: { maxStack: 2, maxLocals: 1, bytecode: code, codeOffset: 0, exceptionTable: [] },
    }],
  };

  // Put iconst_1 (0x04), iconst_2 (0x05), iadd (0x60), ireturn (0xac) after lookupswitch
  // Re-build with match=21 (offset 1+21=22 is iadd) and target=23 (offset 1+23=24 is ireturn)
  const code2 = new Uint8Array(26);
  const dv2 = new DataView(code2.buffer);
  code2[0] = 0x03; // iconst_0
  code2[1] = 0xab; // lookupswitch
  dv2.setInt32(4, 23, false);  // default -> 24
  dv2.setInt32(8, 1, false);   // npairs = 1
  dv2.setInt32(12, 21, false); // match = 21 (1+21=22 is iadd!)
  dv2.setInt32(16, 23, false); // target = 23 (1+23=24 is ireturn!)
  code2[20] = 0x04; // iconst_1
  code2[21] = 0x05; // iconst_2
  code2[22] = 0x60; // iadd (must NOT be treated as joinOffset!)
  code2[23] = 0xac; // ireturn
  code2[24] = 0x04; // iconst_1 (branch target = 24!)
  code2[25] = 0xac; // ireturn
  jvmClass.methods[0].code.bytecode = code2;

  const fn = liftJvmMethod(0, jvmClass);
  const iaddBundle = fn.bundles.find((b) => b.bytecodeOffset === 22);
  assert.ok(iaddBundle, 'iadd at offset 22 present');
  assert.equal(iaddBundle.mnemonic, 'iadd');
  // iadd at offset 22 is NOT a join target (match=21 was NOT a branch target), so stackModelTrusted stays true and producedValues[0].bits === 32!
  assert.equal(iaddBundle.producedValues[0]?.bits, 32);
  // Target at offset 24 IS a join target, so ireturn at 25 has stackModelTrusted=false (consumedValues[0] has no proven bits or is partial)
  const targetIreturn = fn.bundles.find((b) => b.bytecodeOffset === 25);
  assert.ok(targetIreturn);
});

// 10. [P1] cil/validation.js: processed set avoids JSON.stringify and charges stateBudget.chargeWork
test('Wave2-B #10 [P1]: CIL validation charges stateBudget.chargeWork for processed state keys', () => {
  const bundles = [
    {
      bytecodeOffset: 0,
      operationId: 'op:0',
      consumedValues: [],
      producedValues: [{ bits: 32 }, { bits: 32 }],
      controlEffects: [],
      callEffects: [],
      completeness: 'exact',
    },
    {
      bytecodeOffset: 1,
      operationId: 'op:1',
      consumedValues: [{ bits: 32 }, { bits: 32 }],
      producedValues: [],
      controlEffects: [{ kind: 'return' }],
      callEffects: [],
      completeness: 'exact',
    },
  ];
  // With maxVerifierStateCells = 3, retained cells = 2 (at offset 1) + work "0:0" (3) => exceeds budget 3!
  const tight = validateCilEffectFunction({
    methodId: 'managed-method:test:0x06000001',
    profileId: 'ecma-335',
    bundles,
    entryState: { maxStack: 4 },
    exceptionRegions: [],
  }, { returnStackSlots: 0, maxVerifierStateCells: 3 });
  assert.equal(tight.status, 'partial');
  assert.ok(tight.warnings.some((w) => w.code === 'cil-verifier-state-budget-exceeded'));
});

// 11. [P1] cil/metadata-definitions-core.js: assertUniqueSignatureRows memoizes by blobIndex & charges admission
test('Wave2-B #11 [P1]: assertUniqueSignatureRows memoizes blob hashes and charges admission operations', () => {
  const blobHeap = Uint8Array.from([0x00, 0x02, 0x06, 0x08]); // 1-based offset 1 -> [0x06, 0x08]
  const types = [
    { rid: 1, token: '0x02000001', name: 'T', namespace: '', accessFlags: 0x001, fieldRange: { start: 1, end: 51 }, methodRange: { start: 1, end: 1 } },
  ];
  const fields = Array.from({ length: 50 }, (_, i) => ({
    rid: i + 1,
    token: `0x040000${(i + 1).toString(16).padStart(2, '0')}`,
    accessFlags: 0x0001,
    name: `f${i}`,
    signatureBlobIndex: 1,
    declaringTypeToken: '0x02000001',
  }));
  const defs = {
    module: { name: 'M' },
    types,
    fields,
    methods: [],
    params: [],
    properties: [],
    events: [],
    methodSemantics: [],
    constants: [],
    classLayouts: [],
    fieldLayouts: [],
    nestedClasses: [],
    interfaceImpls: [],
    methodImpls: [],
    implMaps: [],
    fieldRvas: [],
    declSecurities: [],
    files: [],
    exportedTypes: [],
    manifestResources: [],
    typeSpecs: [],
    typeRefs: [],
    memberRefs: [],
    assemblyRefs: [],
    fieldMarshals: [],
    customAttributes: [],
  };

  // Tight maxOperations should fail with CilMetadataResourceLimitError
  const tightAdmission = createCilMetadataAdmission({ maxOperations: 10 });
  assert.throws(
    () => bindCilMetadataTables(structuredClone(defs), blobHeap, tightAdmission),
    (err) => err.code === 'cil-metadata-resource-limit-operations',
  );

  // Sufficient budget succeeds
  const okAdmission = createCilMetadataAdmission({ maxOperations: 1000 });
  const bound = bindCilMetadataTables(structuredClone(defs), blobHeap, okAdmission);
  assert.equal(bound.fields.length, 50);
});

// 12. [P1] cil/lifter.js: liftCilMethodWithManagedFamily preserves prefix modifiers, byte range, and completeness
test('Wave2-B #12 [P1]: CIL managed-family lift preserves preceding prefix modifiers and completeness', () => {
  // readonly. (0xfe 0x1e) + ldelema TypeRef/TypeDef (0x8f 0x01 0x00 0x00 0x02) + ret (0x2a)
  const bytecode = Uint8Array.from([0xfe, 0x1e, 0x8f, 0x01, 0x00, 0x00, 0x02, 0x2a]);
  const cilImage = {
    moduleId: 'managed-mod:cil:prefix-test',
    vmSpecEdition: 'ecma-335',
    types: [{ token: '0x02000001', name: 'Elem', namespace: 'Test' }],
    methodBodies: [{
      bytecode,
      codeOffset: 100,
      headerOffset: 100,
      exceptionClauses: [],
    }],
  };

  const fn = liftCilMethod(0, cilImage);
  const ldelema = fn.bundles.find((b) => b.mnemonic === 'ldelema');
  assert.ok(ldelema, 'ldelema bundle present');
  assert.equal(ldelema.bytecodeOffset, 2);
  assert.ok(ldelema.metadata?.readonly, 'readonly prefix metadata preserved');
  assert.equal(ldelema.metadata.readonly.mnemonic, 'readonly.');
  assert.equal(ldelema.completeness, 'partial', 'completeness must reflect unmodeled prefix modifier');
  assert.ok(ldelema.unknownEffects.some((e) => e.reason === 'cil-prefix-modifier-unmodeled:readonly'));
  assert.equal(Number(ldelema.origin.byteRanges[0].start), 100);
  assert.equal(Number(ldelema.origin.byteRanges[0].end), 107);
});

// 13. [P2] cil/parser-overlay.js: embedded ManifestResource with pe.resources == null throws typed error
test('Wave2-B #13 [P2]: overlayCilMetadata throws typed error when pe.resources is null for embedded ManifestResource', () => {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  const ctx = {
    bytes,
    view,
    pe: {
      resources: null,
      metadataOffset: 0,
      metadataSize: 0,
      mapRva: () => 0,
    },
    meta: { runtimeVersion: 'v4.0.30319' },
    layout: {
      rowCounts: new Array(64).fill(0),
      tableOffsets: new Array(64).fill(0),
      rowSizes: new Array(64).fill(0),
      heapSizes: 0,
    },
    defs: {
      module: { name: 'Test.dll' },
      types: [],
      fields: [],
      params: [],
      events: [],
      methodSemantics: [],
      constants: [],
      methods: [],
      manifestResources: [{ rid: 1, offset: 0, flags: 1, name: 'res', implementation: null }],
      typeSpecs: [],
      typeRefs: [],
      memberRefs: [],
      assemblyRefs: [],
      fieldMarshals: [],
      customAttributes: [],
      properties: [],
    },
    usStream: null,
    blobStream: null,
    blobHeap: null,
    stringsStream: null,
    admission: null,
  };

  assert.throws(
    () => overlayCilMetadata(bytes, { imageId: 'img:1', methodBodies: [] }, ctx),
    /cil-manifest-resource-directory-missing/,
  );
});

// 14. [P2] cil/metadata-generics.js: readCilGenericMetadata passes admission to readInternedCilHeapString
test('Wave2-B #14 [P2]: readCilGenericMetadata forwards admission to readInternedCilHeapString', () => {
  // #Strings: \0 + "TLongParamName"\0
  const strings = Buffer.from('\0TLongParamName\0', 'utf8');
  // GenericParam row (table 0x2a): Number(2)=0, Flags(2)=0, Owner(2)=0x0002 (TypeDef RID 1: (1<<1)|0), Name(2)=1
  const row = new Uint8Array(8);
  const rv = new DataView(row.buffer);
  rv.setUint16(0, 0, true);
  rv.setUint16(2, 0, true);
  rv.setUint16(4, 2, true); // Owner TypeDef #1
  rv.setUint16(6, 1, true); // Name offset 1

  const bytes = new Uint8Array(strings.length + row.length);
  bytes.set(strings, 0);
  bytes.set(row, strings.length);
  const view = new DataView(bytes.buffer);

  const rowCounts = new Array(64).fill(0);
  rowCounts[0x02] = 1;
  rowCounts[0x2a] = 1;
  const tableOffsets = new Array(64).fill(0);
  tableOffsets[0x2a] = strings.length;
  const rowSizes = new Array(64).fill(0);
  rowSizes[0x2a] = 8;

  const layout = { rowCounts, tableOffsets, rowSizes, heapSizes: 0 };
  const stringsStream = { offset: 0, size: strings.length };
  const defs = {
    types: [{ rid: 1, token: '0x02000001' }],
    methods: [],
  };

  const tight = createCilMetadataAdmission({ maxStringBytes: 4 });
  assert.throws(
    () => readCilGenericMetadata(bytes, view, layout, stringsStream, defs, tight),
    (err) => err.code === 'cil-metadata-resource-limit-string-bytes',
  );

  const ok = createCilMetadataAdmission({ maxStringBytes: 1024 });
  const res = readCilGenericMetadata(bytes, view, layout, stringsStream, defs, ok);
  assert.equal(res.genericParams[0].name, 'TLongParamName');
});

// 15. [P2] dex/validation-base.js: handlers.push loop avoids call stack overflow on large targets
test('Wave2-B #15 [P2]: captureDexValidationMetadata handles >100k catch targets without stack overflow', () => {
  // Build a DEX method with codeOff=0x20, insnsSize=2 (4 bytes), triesSize=1,
  // 1 catch_handler with 150,000 typed targets (would overflow call stack with push(...targets)).
  const targetCount = 150_000;
  const headerSize = 16;
  const insnsBytes = 4;
  const triesBytes = 8;
  const listHeader = uleb(1);
  const handlerHeader = sleb(targetCount);
  const pairBytes = [0x00, 0x00]; // typeIdx=0, addr=0 (2 bytes per pair)
  const totalSize = 0x20 + headerSize + insnsBytes + triesBytes + listHeader.length + handlerHeader.length + targetCount * 2;
  const raw = new Uint8Array(totalSize);
  const dv = new DataView(raw.buffer);

  // code_item at 0x20
  dv.setUint16(0x20 + 0, 2, true); // registersSize
  dv.setUint16(0x20 + 2, 0, true); // insSize
  dv.setUint16(0x20 + 4, 0, true); // outsSize
  dv.setUint16(0x20 + 6, 1, true); // triesSize
  dv.setUint32(0x20 + 8, 0, true); // debugInfoOff
  dv.setUint32(0x20 + 12, 2, true); // insnsSize = 2
  // insns: nop (0x0000), return-void (0x000e)
  dv.setUint16(0x20 + 16, 0x0000, true);
  dv.setUint16(0x20 + 18, 0x000e, true);
  // try_item at 0x20 + 20
  dv.setUint32(0x20 + 20, 0, true);
  dv.setUint16(0x20 + 24, 2, true);
  dv.setUint16(0x20 + 26, listHeader.length, true);

  let p = 0x20 + 28;
  raw.set(listHeader, p); p += listHeader.length;
  raw.set(handlerHeader, p); p += handlerHeader.length;
  // Remaining bytes are all 0x00, which encodes typeIdx=0, addr=0 for all 150,000 pairs!

  const image = {
    rawBytes: raw,
    strings: [],
    types: ['Ljava/lang/Throwable;'],
    fields: [],
    methods: [{ classType: 'LTest;', name: 'big', proto: { returnType: 'V', params: [] } }],
    classes: [{ classType: 'LTest;', directMethods: [{ methodIdx: 0, accessFlags: 0x0009, codeOff: 0x20 }], virtualMethods: [] }],
  };

  const meta = captureDexValidationMetadata(0, image);
  assert.equal(meta.exceptionComplete, true);
  assert.equal(meta.handlers.length, targetCount);
});
