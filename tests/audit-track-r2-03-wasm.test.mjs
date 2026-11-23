import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWasm } from '../js/managed/wasm/parser.js';
import { parseWasm as parseWasmCore } from '../js/managed/wasm/parser-core.js';
import { validateWasmFunctionTypes } from '../js/managed/wasm/validator.js';
import { liftWasmFunction } from '../js/managed/wasm/lifter-core.js';

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const section = (id, payload) => [id, payload.length, ...payload];
const wasm = (...sections) => Uint8Array.from([...HEADER, ...sections.flat()]);
const funcBody = (bytecode, locals = []) => {
  const payload = [locals.length, ...locals.flat(), ...bytecode];
  return [payload.length, ...payload];
};
const codeSection = (...bodies) => section(10, [bodies.length, ...bodies.flat()]);
const typeSection = (...sigs) => section(1, [
  sigs.length,
  ...sigs.flatMap(({ params = [], results = [] }) => [0x60, params.length, ...params, results.length, ...results]),
]);
const funcSection = (...typeIndices) => section(3, [typeIndices.length, ...typeIndices]);

test('Bug 1 [P1]: call_indirect validates and lifts table64 selector as i64', () => {
  // Defined table64 (flags=0x04, min=1) + i64.const 0 + call_indirect type 0 table 0
  const validTable64Bytes = wasm(
    typeSection({ params: [0x7f], results: [0x7f] }),
    funcSection(0),
    section(4, [0x01, 0x70, 0x04, 0x01]),
    codeSection(funcBody([
      0x41, 0x07, // i32.const 7 (arg_0)
      0x42, 0x00, // i64.const 0 (table64 selector)
      0x11, 0x00, 0x00, // call_indirect type=0 table=0
      0x0b,
    ])),
  );
  const validTable64Mod = parseWasm(validTable64Bytes);
  const valRes = validateWasmFunctionTypes(0, validTable64Mod);
  assert.equal(valRes.complete, true);

  const lifted = liftWasmFunction(0, validTable64Mod);
  const callBundle = lifted.bundles.find((b) => b.mnemonic === 'call_indirect');
  assert.ok(callBundle, 'expected lifted call_indirect bundle');
  assert.equal(callBundle.consumedValues[0].id, 'func_index');
  assert.equal(callBundle.consumedValues[0].bits, 64);
  assert.equal(callBundle.consumedValues[0].type, 0x7e);
  const oobTrap = callBundle.possibleExceptions.find((e) => e.kind === 'indirect-call-table-oob');
  assert.equal(oobTrap?.condition, 'u64(selector)>=tableSize');

  // Defined table64 with i32 selector must fail type validation
  const badI32SelectorOnTable64 = parseWasm(wasm(
    typeSection({ params: [], results: [] }),
    funcSection(0),
    section(4, [0x01, 0x70, 0x04, 0x01]),
    codeSection(funcBody([
      0x41, 0x00, // i32.const 0 (wrong selector type for table64)
      0x11, 0x00, 0x00,
      0x0b,
    ])),
  ));
  assert.throws(
    () => validateWasmFunctionTypes(0, badI32SelectorOnTable64),
    /wasm-stack-type-mismatch/,
  );
  assert.throws(
    () => liftWasmFunction(0, badI32SelectorOnTable64),
    /wasm-stack-type-mismatch/,
  );

  // Imported table64 (flags=0x04) must also require i64 selector
  const importedTable64Mod = parseWasm(wasm(
    typeSection({ params: [], results: [] }),
    section(2, [0x01, 0x01, 0x6d, 0x01, 0x74, 0x01, 0x70, 0x04, 0x01]),
    funcSection(0),
    codeSection(funcBody([0x42, 0x00, 0x11, 0x00, 0x00, 0x0b])),
  ));
  assert.equal(validateWasmFunctionTypes(0, importedTable64Mod).complete, true);
  const importedCallBundle = liftWasmFunction(0, importedTable64Mod).bundles.find((b) => b.mnemonic === 'call_indirect');
  assert.equal(importedCallBundle.consumedValues[0].bits, 64);
  assert.equal(importedCallBundle.consumedValues[0].type, 0x7e);

  // Synthetic table descriptors using is64 / indexType === 'i64'
  for (const syntheticTable of [
    { elemType: 0x70, min: 1, max: null, is64: true },
    { elemType: 0x70, min: 1, max: null, indexType: 'i64' },
  ]) {
    const syntheticMod = {
      moduleId: 'synthetic-table64',
      vmSpecEdition: 'core-3.0',
      types: [{ params: [], results: [] }],
      imports: [],
      functions: [0],
      tables: [syntheticTable],
      memories: [],
      globals: [],
      codeBodies: [{
        bodyOffset: 0,
        bytecodeOffset: 0,
        locals: [],
        bytecode: Uint8Array.from([0x42, 0x00, 0x11, 0x00, 0x00, 0x0b]),
      }],
    };
    assert.equal(validateWasmFunctionTypes(0, syntheticMod).complete, true);
    const bundle = liftWasmFunction(0, syntheticMod).bundles.find((b) => b.mnemonic === 'call_indirect');
    assert.equal(bundle.consumedValues[0].bits, 64);
    assert.equal(bundle.consumedValues[0].type, 0x7e);
  }

  // Standard table32 still requires i32 and rejects i64
  const validTable32Mod = parseWasm(wasm(
    typeSection({ params: [], results: [] }),
    funcSection(0),
    section(4, [0x01, 0x70, 0x00, 0x01]),
    codeSection(funcBody([0x41, 0x00, 0x11, 0x00, 0x00, 0x0b])),
  ));
  assert.equal(validateWasmFunctionTypes(0, validTable32Mod).complete, true);
  const t32Bundle = liftWasmFunction(0, validTable32Mod).bundles.find((b) => b.mnemonic === 'call_indirect');
  assert.equal(t32Bundle.consumedValues[0].bits, 32);
  assert.equal(t32Bundle.consumedValues[0].type, 0x7f);
  assert.equal(
    t32Bundle.possibleExceptions.find((e) => e.kind === 'indirect-call-table-oob')?.condition,
    'u32(selector)>=tableSize',
  );

  const badI64OnTable32 = parseWasm(wasm(
    typeSection({ params: [], results: [] }),
    funcSection(0),
    section(4, [0x01, 0x70, 0x00, 0x01]),
    codeSection(funcBody([0x42, 0x00, 0x11, 0x00, 0x00, 0x0b])),
  ));
  assert.throws(() => validateWasmFunctionTypes(0, badI64OnTable32), /wasm-stack-type-mismatch/);
});

test('Bug 2 [P2]: lifter-core respects control frame stackHeight base when consuming values', () => {
  // Push i32 on outer stack, enter empty block, attempt to drop outer value.
  // Pass options.selectTypes to exercise lifter-core's own stack accounting directly.
  const underflowInsideBlock = parseWasm(wasm(
    typeSection({ params: [], results: [] }),
    funcSection(0),
    codeSection(funcBody([
      0x41, 0x01, // i32.const 1 (outer stack height = 1)
      0x02, 0x40, // block () -> () (frame.stackHeight = 1)
      0x1a,       // drop -> must underflow relative to frame.stackHeight!
      0x0b,       // end block
      0x0b,       // end func
    ])),
  ));
  assert.throws(
    () => liftWasmFunction(0, underflowInsideBlock, { selectTypes: new Map() }),
    /wasm-stack-underflow/,
  );

  // Nested block requiring 1 param inside an outer block with 0 local values (outer stack has 1 value)
  const blockParamUnderflow = parseWasm(wasm(
    typeSection(
      { params: [], results: [0x7f] },
      { params: [0x7f], results: [0x7f] },
    ),
    funcSection(0),
    codeSection(funcBody([
      0x41, 0x01, // outer stack height = 1
      0x02, 0x40, // outer block () -> () (frame.stackHeight = 1)
      0x02, 0x01, // inner block (i32) -> (i32): must NOT consume outer stack value
      0x0b,       // end inner block
      0x1a,       // drop
      0x0b,       // end outer block
      0x0b,       // end func
    ])),
  ));
  assert.throws(
    () => liftWasmFunction(0, blockParamUnderflow, { selectTypes: new Map() }),
    /wasm-stack-underflow-block-params/,
  );

  // Valid nested block that preserves outer stack value lifts cleanly
  const validNested = parseWasm(wasm(
    typeSection({ params: [], results: [0x7f] }),
    funcSection(0),
    codeSection(funcBody([
      0x41, 0x2a, // i32.const 42
      0x02, 0x7f, // block (result i32)
      0x41, 0x01, // i32.const 1
      0x0b,       // end block
      0x6a,       // i32.add
      0x0b,       // end func
    ])),
  ));
  const lifted = liftWasmFunction(0, validNested);
  assert.equal(lifted.aggregateCompleteness, 'exact');
});

test('Bug 3 [P2]: validator and lifter reject negative and non-integer funcIndex', () => {
  const modWithImport = parseWasm(wasm(
    typeSection({ params: [], results: [] }),
    section(2, [0x01, 0x01, 0x6d, 0x01, 0x66, 0x00, 0x00]), // 1 imported func
    funcSection(0),
    codeSection(funcBody([0x0b])),
  ));
  const modWithoutImport = parseWasm(wasm(
    typeSection({ params: [], results: [] }),
    funcSection(0),
    codeSection(funcBody([0x0b])),
  ));

  const badIndices = [-1, -42, 0.5, 1.25, NaN, Infinity, -Infinity, '0', null, undefined];
  for (const mod of [modWithImport, modWithoutImport]) {
    for (const badIndex of badIndices) {
      assert.throws(
        () => validateWasmFunctionTypes(badIndex, mod),
        /wasm-invalid-function-index/,
        `validateWasmFunctionTypes should reject funcIndex=${String(badIndex)}`,
      );
      assert.throws(
        () => liftWasmFunction(badIndex, mod),
        /wasm-invalid-function-index/,
        `liftWasmFunction should reject funcIndex=${String(badIndex)}`,
      );
    }
  }

  // Valid indices still succeed
  assert.equal(validateWasmFunctionTypes(0, modWithImport).complete, true);
  assert.equal(validateWasmFunctionTypes(1, modWithImport).complete, true);
  assert.equal(liftWasmFunction(0, modWithImport).aggregateCompleteness, 'partial');
  assert.equal(liftWasmFunction(1, modWithImport).aggregateCompleteness, 'exact');
});

test('Bug 4 [P2]: parser-core validates blocktype type index bounds and negativity', () => {
  // Out-of-bounds positive type index (type index 1 when only type 0 exists)
  const oobBlockType = wasm(
    typeSection({ params: [], results: [] }),
    funcSection(0),
    codeSection(funcBody([0x02, 0x01, 0x0b, 0x0b])),
  );
  assert.throws(() => parseWasmCore(oobBlockType), /wasm-invalid-block-type-index/);
  assert.throws(() => parseWasm(oobBlockType), /wasm-invalid-block-type-index/);

  // Negative single-byte non-valtype blocktype (0x7a = -6 in SLEB128, not a value type)
  const negSingleByteBlockType = wasm(
    typeSection({ params: [], results: [] }),
    funcSection(0),
    codeSection(funcBody([0x03, 0x7a, 0x0b, 0x0b])),
  );
  assert.throws(() => parseWasmCore(negSingleByteBlockType), /wasm-invalid-block-type-index/);

  // Negative multi-byte SLEB128 blocktype (-1 = 0xff, 0x7f)
  const negMultiByteBlockType = wasm(
    typeSection({ params: [], results: [] }),
    funcSection(0),
    codeSection(funcBody([0x04, 0xff, 0x7f, 0x0b, 0x0b])),
  );
  assert.throws(() => parseWasmCore(negMultiByteBlockType), /wasm-invalid-block-type-index/);

  // Valid blocktype index 0 succeeds
  const validBlockType = wasm(
    typeSection({ params: [], results: [] }),
    funcSection(0),
    codeSection(funcBody([0x02, 0x00, 0x0b, 0x0b])),
  );
  assert.doesNotThrow(() => parseWasmCore(validBlockType));
  assert.doesNotThrow(() => parseWasm(validBlockType));
});

test('Bug 5 [P2]: parser validates const expr global context and i64 offsets for table64/memory64', () => {
  const i32GlobalDef = (mutable, val = 0) => [0x7f, mutable ? 0x01 : 0x00, 0x41, val, 0x0b];
  const i64GlobalDef = (mutable, val = 0) => [0x7e, mutable ? 0x01 : 0x00, 0x42, val, 0x0b];
  const funcrefGlobalDef = (mutable) => [0x70, mutable ? 0x01 : 0x00, 0xd0, 0x70, 0x0b];

  // Active element offset referencing module-defined immutable global succeeds
  assert.doesNotThrow(() => parseWasm(wasm(
    section(4, [0x01, 0x70, 0x00, 0x01]),
    section(6, [0x01, ...i32GlobalDef(false, 0)]),
    section(9, [0x01, 0x00, 0x23, 0x00, 0x0b, 0x00]),
  )));

  // Active element offset referencing module-defined mutable global fails
  assert.throws(() => parseWasm(wasm(
    section(4, [0x01, 0x70, 0x00, 0x01]),
    section(6, [0x01, ...i32GlobalDef(true, 0)]),
    section(9, [0x01, 0x00, 0x23, 0x00, 0x0b, 0x00]),
  )), /wasm-invalid-const-expr-global-mutability/);

  // Element initializer referencing module-defined immutable funcref global succeeds
  assert.doesNotThrow(() => parseWasm(wasm(
    section(6, [0x01, ...funcrefGlobalDef(false)]),
    section(9, [0x01, 0x05, 0x70, 0x01, 0x23, 0x00, 0x0b]),
  )));

  // Element initializer referencing module-defined mutable funcref global fails
  assert.throws(() => parseWasm(wasm(
    section(6, [0x01, ...funcrefGlobalDef(true)]),
    section(9, [0x01, 0x05, 0x70, 0x01, 0x23, 0x00, 0x0b]),
  )), /wasm-invalid-const-expr-global-mutability/);

  // Active data offset referencing module-defined immutable global succeeds
  assert.doesNotThrow(() => parseWasm(wasm(
    section(5, [0x01, 0x00, 0x01]),
    section(6, [0x01, ...i32GlobalDef(false, 0)]),
    section(11, [0x01, 0x00, 0x23, 0x00, 0x0b, 0x00]),
  )));

  // Active data offset referencing module-defined mutable global fails
  assert.throws(() => parseWasm(wasm(
    section(5, [0x01, 0x00, 0x01]),
    section(6, [0x01, ...i32GlobalDef(true, 0)]),
    section(11, [0x01, 0x00, 0x23, 0x00, 0x0b, 0x00]),
  )), /wasm-invalid-const-expr-global-mutability/);

  // table64 active element offset: i64.const & immutable i64 global accepted, i32.const rejected
  assert.doesNotThrow(() => parseWasm(wasm(
    section(4, [0x01, 0x70, 0x04, 0x01]),
    section(9, [0x01, 0x00, 0x42, 0x00, 0x0b, 0x00]),
  )));
  assert.doesNotThrow(() => parseWasm(wasm(
    section(4, [0x01, 0x70, 0x04, 0x01]),
    section(6, [0x01, ...i64GlobalDef(false, 0)]),
    section(9, [0x01, 0x00, 0x23, 0x00, 0x0b, 0x00]),
  )));
  assert.throws(() => parseWasm(wasm(
    section(4, [0x01, 0x70, 0x04, 0x01]),
    section(9, [0x01, 0x00, 0x41, 0x00, 0x0b, 0x00]),
  )), /wasm-invalid-const-expr-result-type/);

  // Imported table64 active element offset: i64.const accepted, i32.const rejected
  assert.doesNotThrow(() => parseWasm(wasm(
    section(2, [0x01, 0x01, 0x6d, 0x01, 0x74, 0x01, 0x70, 0x04, 0x01]),
    section(9, [0x01, 0x00, 0x42, 0x00, 0x0b, 0x00]),
  )));
  assert.throws(() => parseWasm(wasm(
    section(2, [0x01, 0x01, 0x6d, 0x01, 0x74, 0x01, 0x70, 0x04, 0x01]),
    section(9, [0x01, 0x00, 0x41, 0x00, 0x0b, 0x00]),
  )), /wasm-invalid-const-expr-result-type/);

  // memory64 active data offset: i64.const & immutable i64 global accepted, i32.const rejected
  assert.doesNotThrow(() => parseWasm(wasm(
    section(5, [0x01, 0x04, 0x01]),
    section(11, [0x01, 0x00, 0x42, 0x00, 0x0b, 0x00]),
  )));
  assert.doesNotThrow(() => parseWasm(wasm(
    section(5, [0x01, 0x04, 0x01]),
    section(6, [0x01, ...i64GlobalDef(false, 0)]),
    section(11, [0x01, 0x00, 0x23, 0x00, 0x0b, 0x00]),
  )));
  assert.throws(() => parseWasm(wasm(
    section(5, [0x01, 0x04, 0x01]),
    section(11, [0x01, 0x00, 0x41, 0x00, 0x0b, 0x00]),
  )), /wasm-invalid-const-expr-result-type/);

  // Imported memory64 active data offset: i64.const accepted, i32.const rejected
  assert.doesNotThrow(() => parseWasm(wasm(
    section(2, [0x01, 0x01, 0x6d, 0x01, 0x78, 0x02, 0x04, 0x01]),
    section(11, [0x01, 0x00, 0x42, 0x00, 0x0b, 0x00]),
  )));
  assert.throws(() => parseWasm(wasm(
    section(2, [0x01, 0x01, 0x6d, 0x01, 0x78, 0x02, 0x04, 0x01]),
    section(11, [0x01, 0x00, 0x41, 0x00, 0x0b, 0x00]),
  )), /wasm-invalid-const-expr-result-type/);
});
