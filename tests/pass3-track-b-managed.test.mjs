import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { parseDex } from '../js/managed/dex/parser.js';
import { bindCilMetadataTables } from '../js/managed/cil/metadata-definitions-core.js';
import { parseWasm } from '../js/managed/wasm/parser.js';
import { liftWasmFunction } from '../js/managed/wasm/lifter-core.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../js/managed/shared/bridge.js';
import { lowerVMEffectsToSemanticIr as lowerVMEffectsToSemanticIrV2 } from '../js/managed/shared/bridge-lowering-v2.js';
import { parseJvm } from '../js/managed/jvm/parser-core.js';
import { buildDex } from './phase11/fixtures/medium-dex.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adler32(bytes, start = 0) {
  let a = 1;
  let b = 0;
  for (let i = start; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function finalizeDexIntegrity(bytes) {
  const out = bytes.slice();
  const sha1 = crypto.createHash('sha1').update(out.subarray(32)).digest();
  out.set(sha1, 12);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(8, adler32(out, 12), true);
  return out;
}

function buildDexWithInterfaces({ classNames, superclassLinks = [], interfaceLinks = [] }) {
  // Build base DEX in rawOrder so class_defs order matches classNames exactly.
  const built = buildDex({ rawOrder: true, classNames, fields: [], methods: [] });
  const baseBytes = built.bytes;
  const baseView = new DataView(baseBytes.buffer, baseBytes.byteOffset, baseBytes.byteLength);
  const classDefsOff = built.layout.classes;

  // Map class name -> type_idx from the emitted class_defs.
  const typeIdxByName = new Map();
  for (let i = 0; i < classNames.length; i++) {
    const classIdx = baseView.getUint32(classDefsOff + i * 32, true);
    typeIdxByName.set(classNames[i], classIdx);
  }

  // If no interfaceLinks, mutate superclass_idx in place and recompute integrity.
  if (interfaceLinks.length === 0) {
    const bytes = baseBytes.slice();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const [subDefIdx, superName] of superclassLinks) {
      const superIdx = typeIdxByName.get(superName);
      assert.ok(superIdx !== undefined, `unknown superclass ${superName}`);
      view.setUint32(classDefsOff + subDefIdx * 32 + 8, superIdx, true);
    }
    return finalizeDexIntegrity(bytes);
  }

  // Append 4-byte-aligned type_list items before the map_list and rebuild map_list.
  const mapOff = built.layout.mapOff;
  const oldMapCount = baseView.getUint32(mapOff, true);
  const oldMaps = [];
  for (let i = 0; i < oldMapCount; i++) {
    const o = mapOff + 4 + i * 12;
    oldMaps.push([
      baseView.getUint16(o, true),
      baseView.getUint32(o + 4, true),
      baseView.getUint32(o + 8, true),
    ]);
  }

  // Place type_list items starting at mapOff (already 4-byte aligned).
  const typeListOffsets = new Map();
  const typeListChunks = [];
  let cursor = mapOff;
  for (const [defIdx, ifaceNames] of interfaceLinks) {
    while (cursor % 4 !== 0) {
      typeListChunks.push(new Uint8Array([0]));
      cursor += 1;
    }
    typeListOffsets.set(defIdx, cursor);
    const size = 4 + ifaceNames.length * 2;
    const paddedSize = (size + 3) & ~3;
    const chunk = new Uint8Array(paddedSize);
    const cv = new DataView(chunk.buffer);
    cv.setUint32(0, ifaceNames.length, true);
    for (let j = 0; j < ifaceNames.length; j++) {
      const idx = typeIdxByName.get(ifaceNames[j]);
      assert.ok(idx !== undefined, `unknown interface ${ifaceNames[j]}`);
      cv.setUint16(4 + j * 2, idx, true);
    }
    typeListChunks.push(chunk);
    cursor += paddedSize;
  }

  const newMapOff = cursor;
  // Insert TYPE_TYPE_LIST (0x1001) into map_list and update TYPE_MAP_LIST (0x1000).
  const newMaps = oldMaps
    .filter(([type]) => type !== 0x1000)
    .concat([
      [0x1001, interfaceLinks.length, mapOff],
      [0x1000, 1, newMapOff],
    ])
    .sort((a, b) => a[2] - b[2]);
  const mapBytes = new Uint8Array(4 + newMaps.length * 12);
  const mv = new DataView(mapBytes.buffer);
  mv.setUint32(0, newMaps.length, true);
  for (let i = 0; i < newMaps.length; i++) {
    mv.setUint16(4 + i * 12, newMaps[i][0], true);
    mv.setUint16(4 + i * 12 + 2, 0, true);
    mv.setUint32(4 + i * 12 + 4, newMaps[i][1], true);
    mv.setUint32(4 + i * 12 + 8, newMaps[i][2], true);
  }

  const totalSize = newMapOff + mapBytes.length;
  const out = new Uint8Array(totalSize);
  out.set(baseBytes.subarray(0, mapOff), 0);
  let writePos = mapOff;
  for (const chunk of typeListChunks) {
    out.set(chunk, writePos);
    writePos += chunk.length;
  }
  out.set(mapBytes, newMapOff);

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // Update header file_size (32), map_off (52), data_size (104).
  const dataOff = view.getUint32(108, true);
  view.setUint32(32, totalSize, true);
  view.setUint32(52, newMapOff, true);
  view.setUint32(104, totalSize - dataOff, true);

  for (const [subDefIdx, superName] of superclassLinks) {
    const superIdx = typeIdxByName.get(superName);
    view.setUint32(classDefsOff + subDefIdx * 32 + 8, superIdx, true);
  }
  for (const [defIdx, ifaceOff] of typeListOffsets.entries()) {
    view.setUint32(classDefsOff + defIdx * 32 + 12, ifaceOff, true);
  }

  return finalizeDexIntegrity(out);
}

// ---------------------------------------------------------------------------
// P3-S06-001: DEX class_defs topological ordering
// ---------------------------------------------------------------------------

test('P3-S06-001 DEX accepts unrelated class_defs in non-ascending class_idx order', () => {
  const bytes = buildDexWithInterfaces({ classNames: ['LB;', 'LA;'] });
  const parsed = parseDex(bytes, { binaryId: 'p3-s06-001-unrelated' });
  assert.deepEqual(parsed.classes.map((c) => c.classType), ['LB;', 'LA;']);
});

test('P3-S06-001 DEX accepts subclass after superclass even when superclass has larger type_idx', () => {
  // LZBase; has larger type_idx than LAChild;, but appears first in class_defs (valid topological order).
  const bytes = buildDexWithInterfaces({
    classNames: ['LZBase;', 'LAChild;'],
    superclassLinks: [[1, 'LZBase;']],
  });
  const parsed = parseDex(bytes, { binaryId: 'p3-s06-001-topo-valid' });
  assert.equal(parsed.classes[0].classType, 'LZBase;');
  assert.equal(parsed.classes[1].classType, 'LAChild;');
  assert.equal(parsed.classes[1].superType, 'LZBase;');
});

test('P3-S06-001 DEX rejects subclass defined before its superclass in class_defs', () => {
  const bytes = buildDexWithInterfaces({
    classNames: ['LAChild;', 'LZBase;'],
    superclassLinks: [[0, 'LZBase;']],
  });
  assert.throws(() => parseDex(bytes, { binaryId: 'p3-s06-001-super-after' }), /dex-class-defs-order-invalid/);
});

test('P3-S06-001 DEX rejects self-inheriting class_def', () => {
  const bytes = buildDexWithInterfaces({
    classNames: ['LSelf;'],
    superclassLinks: [[0, 'LSelf;']],
  });
  assert.throws(() => parseDex(bytes, { binaryId: 'p3-s06-001-self' }), /dex-class-defs-order-invalid/);
});

test('P3-S06-001 DEX rejects duplicate class_idx in class_defs', () => {
  const built = buildDex({ rawOrder: true, classNames: ['LDup;', 'LDup;'], fields: [], methods: [] });
  assert.throws(() => parseDex(built.bytes, { binaryId: 'p3-s06-001-dup' }), /dex-class-defs-order-invalid/);
});

test('P3-S06-001 DEX validates interface topological ordering in class_defs', () => {
  // Valid: interface LZFace; defined at index 0, implementor LAImpl; defined at index 1.
  const validBytes = buildDexWithInterfaces({
    classNames: ['LZFace;', 'LAImpl;'],
    interfaceLinks: [[1, ['LZFace;']]],
  });
  const parsed = parseDex(validBytes, { binaryId: 'p3-s06-001-iface-valid' });
  assert.deepEqual(parsed.classes[1].interfaceTypes, ['LZFace;']);

  // Invalid: implementor LAImpl; defined at index 0 before its interface LZFace; at index 1.
  const invalidBytes = buildDexWithInterfaces({
    classNames: ['LAImpl;', 'LZFace;'],
    interfaceLinks: [[0, ['LZFace;']]],
  });
  assert.throws(() => parseDex(invalidBytes, { binaryId: 'p3-s06-001-iface-after' }), /dex-class-defs-order-invalid/);
});

// ---------------------------------------------------------------------------
// P3-S06-002: CIL Constant null-reference constants for all reference types
// ---------------------------------------------------------------------------

function buildCilBlobHeap(...blobs) {
  const bytes = [0];
  const indexes = [];
  for (const blob of blobs) {
    indexes.push(bytes.length);
    bytes.push(blob.length, ...blob);
  }
  return { heap: new Uint8Array(bytes), indexes };
}

function buildCilDefs({
  types = null,
  fields = [],
  methods = [],
  params = [],
  properties = [],
  constants = [],
} = {}) {
  return {
    types: types ?? [
      { token: '0x02000001', namespace: 'Test', name: 'TypeA', accessFlags: 0x11 },
      { token: '0x02000002', namespace: 'Test', name: 'TypeB', accessFlags: 0x11 },
    ],
    typeRefs: [],
    typeSpecs: [],
    fields,
    methods,
    params,
    properties,
    constants,
    classLayouts: [],
    fieldLayouts: [],
    nestedClasses: [],
    assemblyRefs: [],
  };
}

test('P3-S06-002 CIL Field accepts ELEMENT_TYPE_CLASS null constant for STRING, SZARRAY, ARRAY, and reference GENERICINST', () => {
  const nullBlob = [0, 0, 0, 0];
  const cases = [
    ['STRING', [0x06, 0x0e]],
    ['SZARRAY', [0x06, 0x1d, 0x08]], // int[]
    ['ARRAY', [0x06, 0x14, 0x08, 0x02, 0x00, 0x00]], // int[,]
    ['GENERICINST(CLASS)', [0x06, 0x15, 0x12, 0x04, 0x01, 0x08]], // GenericClass<int> (TypeDef rid=1 => encoded 0x04)
  ];
  for (const [label, fieldSig] of cases) {
    const { heap, indexes } = buildCilBlobHeap(fieldSig, nullBlob);
    const bound = bindCilMetadataTables(buildCilDefs({
      fields: [{ token: '0x04000001', accessFlags: 0, declaringTypeToken: '0x02000001', signatureBlobIndex: indexes[0] }],
      constants: [{ token: '0x0b000001', type: 0x12, parent: { table: 0x04, rid: 1, token: '0x04000001' }, valueIndex: indexes[1] }],
    }), heap);
    assert.equal(bound.constants.length, 1, label);
    assert.equal(bound.constants[0].type, 'class', label);
    assert.equal(bound.constants[0].value, null, label);
  }
});

test('P3-S06-002 CIL Field rejects ELEMENT_TYPE_CLASS null constant for value-type GENERICINST', () => {
  const { heap, indexes } = buildCilBlobHeap(
    [0x06, 0x15, 0x11, 0x04, 0x01, 0x08], // GENERICINST VALUETYPE TypeDef(1)<int>
    [0, 0, 0, 0],
  );
  assert.throws(
    () => bindCilMetadataTables(buildCilDefs({
      fields: [{ token: '0x04000001', accessFlags: 0, declaringTypeToken: '0x02000001', signatureBlobIndex: indexes[0] }],
      constants: [{ token: '0x0b000001', type: 0x12, parent: { table: 0x04, rid: 1, token: '0x04000001' }, valueIndex: indexes[1] }],
    }), heap),
    /cil-constant-type-mismatch/,
  );
});

test('P3-S06-002 CIL Param and Property accept null constants for STRING, CLASS, SZARRAY, and reference GENERICINST', () => {
  const nullBlob = [0, 0, 0, 0];
  const refTypeBlobs = [
    ['STRING', [0x0e]],
    ['CLASS', [0x12, 0x04]],
    ['SZARRAY', [0x1d, 0x08]],
    ['GENERICINST(CLASS)', [0x15, 0x12, 0x04, 0x01, 0x08]],
  ];

  for (const [label, typeBlob] of refTypeBlobs) {
    // Param (table 0x08): method sig = [0x00, 0x01, 0x01, ...typeBlob] (default, 1 param, void return)
    {
      const { heap, indexes } = buildCilBlobHeap([0x00, 0x01, 0x01, ...typeBlob], nullBlob);
      const bound = bindCilMetadataTables(buildCilDefs({
        methods: [{ token: '0x06000001', signatureBlobIndex: indexes[0] }],
        params: [{ token: '0x08000001', ownerToken: '0x06000001', sequence: 1 }],
        constants: [{ token: '0x0b000001', type: 0x12, parent: { table: 0x08, rid: 1, token: '0x08000001' }, valueIndex: indexes[1] }],
      }), heap);
      assert.equal(bound.constants[0].value, null, `Param ${label}`);
    }

    // Property (table 0x17): property sig = [0x08, 0x00, ...typeBlob]
    {
      const { heap, indexes } = buildCilBlobHeap([0x08, 0x00, ...typeBlob], nullBlob);
      const bound = bindCilMetadataTables(buildCilDefs({
        properties: [{ token: '0x17000001', typeBlobIndex: indexes[0] }],
        constants: [{ token: '0x0b000001', type: 0x12, parent: { table: 0x17, rid: 1, token: '0x17000001' }, valueIndex: indexes[1] }],
      }), heap);
      assert.equal(bound.constants[0].value, null, `Property ${label}`);
    }
  }
});

test('P3-S06-002 CIL Param rejects null constant for value-type GENERICINST', () => {
  const { heap, indexes } = buildCilBlobHeap(
    [0x00, 0x01, 0x01, 0x15, 0x11, 0x04, 0x01, 0x08],
    [0, 0, 0, 0],
  );
  assert.throws(
    () => bindCilMetadataTables(buildCilDefs({
      methods: [{ token: '0x06000001', signatureBlobIndex: indexes[0] }],
      params: [{ token: '0x08000001', ownerToken: '0x06000001', sequence: 1 }],
      constants: [{ token: '0x0b000001', type: 0x12, parent: { table: 0x08, rid: 1, token: '0x08000001' }, valueIndex: indexes[1] }],
    }), heap),
    /cil-constant-parent-type-unprovable/,
  );
});

// ---------------------------------------------------------------------------
// P3-S06-003: WebAssembly if/else polarity across lifter, bridge, and bridge-v2
// ---------------------------------------------------------------------------

function buildWasmSingleFuncModule(params, results, bodyBytes) {
  const section = (id, payload) => [id, payload.length, ...payload];
  const typeSection = section(1, [1, 0x60, params.length, ...params, results.length, ...results]);
  const funcSection = section(3, [1, 0]);
  const body = [0, ...bodyBytes]; // 0 local decls + body
  const codeSection = section(10, [1, body.length, ...body]);
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...typeSection, ...funcSection, ...codeSection]);
}

test('P3-S06-003 Wasm if/else preserves true->then and false->else polarity in lifter, bridge, and bridge-v2', () => {
  // (func (param i32) (result i32)
  //   local.get 0          ; offset 0 (2 bytes)
  //   if (result i32)      ; offset 2 (2 bytes: 0x04, 0x7f)
  //     i32.const 10       ; offset 4 (2 bytes: 0x41, 0x0a)  <-- TRUE (then) target
  //   else                 ; offset 6 (1 byte: 0x05)
  //     i32.const 20       ; offset 7 (2 bytes: 0x41, 0x14)  <-- FALSE (else) target
  //   end                  ; offset 9 (1 byte: 0x0b)
  // end)                   ; offset 10 (1 byte: 0x0b)
  const wasmBytes = buildWasmSingleFuncModule(
    [0x7f],
    [0x7f],
    [0x20, 0x00, 0x04, 0x7f, 0x41, 0x0a, 0x05, 0x41, 0x14, 0x0b, 0x0b],
  );
  const wasmImage = parseWasm(wasmBytes, { binaryId: 'p3-s06-003-if-else' });
  const lifted = liftWasmFunction(0, wasmImage);

  const ifBundle = lifted.bundles.find((b) => b.mnemonic === 'if');
  assert.ok(ifBundle);
  const condEff = ifBundle.controlEffects.find((c) => c.kind === 'conditional-branch');
  assert.ok(condEff);
  assert.equal(condEff.structured, 'if');
  assert.equal(condEff.targetOffset, 4, 'true branch must target then-body (offset 4)');
  assert.equal(condEff.falseTargetOffset, 7, 'false branch must target else-body (offset 7)');

  // Verify bridge-lowering-v2.js CFG and IR targets for value-producing if/else
  const loweredV2 = lowerVMEffectsToSemanticIrV2(lifted);
  const entryV2 = loweredV2.cfg.blocks.find((b) => b.id === 'bb_0x0');
  assert.ok(entryV2);
  assert.equal(entryV2.successors.find((s) => s.kind === 'conditional-true')?.to, 'bb_0x4');
  assert.equal(entryV2.successors.find((s) => s.kind === 'conditional-false')?.to, 'bb_0x7');
  const condNodeV2 = loweredV2.semanticIr.nodes.find((n) => n.kind === 'conditional-branch');
  assert.deepEqual(condNodeV2.targets, ['bb_0x4', 'bb_0x7']);

  // Verify bridge.js (v1) CFG and pseudocode on void if/else with early returns:
  //   0: local.get 0 (2B)
  //   2: if void (2B: 0x04, 0x40)
  //   4: i32.const 10 (2B); 6: return (1B)   <-- TRUE (then) target
  //   7: else (1B)
  //   8: i32.const 20 (2B); 10: return (1B)  <-- FALSE (else) target
  //   11: end (1B)
  //   12: i32.const 0 (2B); 14: end (1B)
  const wasmVoidIfElse = buildWasmSingleFuncModule(
    [0x7f],
    [0x7f],
    [0x20, 0x00, 0x04, 0x40, 0x41, 0x0a, 0x0f, 0x05, 0x41, 0x14, 0x0f, 0x0b, 0x41, 0x00, 0x0b],
  );
  const liftedV1 = liftWasmFunction(0, parseWasm(wasmVoidIfElse, { binaryId: 'p3-s06-003-if-else-v1' }));
  const loweredV1 = lowerVMEffectsToSemanticIr(liftedV1);
  const entryV1 = loweredV1.cfg.blocks.find((b) => b.id === 'bb_0x0');
  assert.ok(entryV1);
  assert.equal(entryV1.successors.find((s) => s.kind === 'conditional-true')?.to, 'bb_0x4');
  assert.equal(entryV1.successors.find((s) => s.kind === 'conditional-false')?.to, 'bb_0x8');

  const decomp = decompileManagedMethod(liftedV1);
  const pseudoText = decomp.pseudocode;
  assert.match(pseudoText, /if \([^)]+\) \{\s*goto bb_0x4;\s*\} else \{\s*goto bb_0x8;\s*\}/);
  assert.match(pseudoText, /^\s*bb_0x4:/m);
  assert.match(pseudoText, /^\s*bb_0x8:/m);
});

test('P3-S06-003 Wasm if-without-else preserves true->then and false->continuation polarity', () => {
  // (func (param i32) (result i32)
  //   local.get 0          ; offset 0 (2 bytes)
  //   if                   ; offset 2 (2 bytes: 0x04, 0x40)
  //     nop                ; offset 4 (1 byte: 0x01)   <-- TRUE (then) target
  //   end                  ; offset 5 (1 byte: 0x0b)
  //   i32.const 42         ; offset 6 (2 bytes: 0x41, 0x2a) <-- FALSE (continuation) target
  // end)                   ; offset 8 (1 byte: 0x0b)
  const wasmBytes = buildWasmSingleFuncModule(
    [0x7f],
    [0x7f],
    [0x20, 0x00, 0x04, 0x40, 0x01, 0x0b, 0x41, 0x2a, 0x0b],
  );
  const wasmImage = parseWasm(wasmBytes, { binaryId: 'p3-s06-003-if-only' });
  const lifted = liftWasmFunction(0, wasmImage);

  const ifBundle = lifted.bundles.find((b) => b.mnemonic === 'if');
  const condEff = ifBundle.controlEffects.find((c) => c.kind === 'conditional-branch');
  assert.equal(condEff.targetOffset, 4);
  assert.equal(condEff.falseTargetOffset, 6);

  const loweredV1 = lowerVMEffectsToSemanticIr(lifted);
  const entryV1 = loweredV1.cfg.blocks.find((b) => b.id === 'bb_0x0');
  assert.equal(entryV1.successors.find((s) => s.kind === 'conditional-true')?.to, 'bb_0x4');
  assert.equal(entryV1.successors.find((s) => s.kind === 'conditional-false')?.to, 'bb_0x6');

  const loweredV2 = lowerVMEffectsToSemanticIrV2(lifted);
  const entryV2 = loweredV2.cfg.blocks.find((b) => b.id === 'bb_0x0');
  assert.equal(entryV2.successors.find((s) => s.kind === 'conditional-true')?.to, 'bb_0x4');
  assert.equal(entryV2.successors.find((s) => s.kind === 'conditional-false')?.to, 'bb_0x6');
});

// ---------------------------------------------------------------------------
// P3-S06-005: JVM ACC_MODULE super_class === 0 per JVMS §4.1
// ---------------------------------------------------------------------------

function buildJvmClass({ thisName, superName = null, accessFlags = 0x0021, major = 53 }) {
  const bytes = [];
  const u1 = (v) => bytes.push(v & 0xff);
  const u2 = (v) => bytes.push((v >>> 8) & 0xff, v & 0xff);
  const u4 = (v) => bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const utf8 = (s) => {
    const raw = Buffer.from(s, 'utf8');
    u1(1);
    u2(raw.length);
    for (const b of raw) u1(b);
  };

  u4(0xcafebabe);
  u2(0);
  u2(major);
  const cpCount = superName === null ? 3 : 5;
  u2(cpCount);
  utf8(thisName); // #1
  u1(7); u2(1);   // #2 Class(thisName)
  if (superName !== null) {
    utf8(superName); // #3
    u1(7); u2(3);    // #4 Class(superName)
  }
  u2(accessFlags);
  u2(2); // this_class
  u2(superName === null ? 0 : 4); // super_class
  u2(0); // interfaces
  u2(0); // fields
  u2(0); // methods
  u2(0); // attributes
  return new Uint8Array(bytes);
}

test('P3-S06-005 JVM ACC_MODULE accepts super_class=0 and rejects nonzero super_class', () => {
  const ACC_MODULE = 0x8000;
  const parsed = parseJvm(
    buildJvmClass({ thisName: 'module-info', superName: null, accessFlags: ACC_MODULE }),
    { binaryId: 'p3-s06-005-module-valid' },
  );
  assert.equal(parsed.thisClassName, 'module-info');
  assert.equal(parsed.superClassName, null);

  assert.throws(
    () => parseJvm(
      buildJvmClass({ thisName: 'module-info', superName: 'java/lang/Object', accessFlags: ACC_MODULE }),
      { binaryId: 'p3-s06-005-module-object' },
    ),
    /jvm-invalid-module-super-class/,
  );

  assert.throws(
    () => parseJvm(
      buildJvmClass({ thisName: 'module-info', superName: 'com/example/Base', accessFlags: ACC_MODULE }),
      { binaryId: 'p3-s06-005-module-other' },
    ),
    /jvm-invalid-module-super-class/,
  );
});
