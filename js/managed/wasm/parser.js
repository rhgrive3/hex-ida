// WASM parser public boundary regression guard for #1113.
// The core parser preserves the decoded function body. This wrapper rejects
// any body whose outer function expression is not terminated by `end` (0x0b).
export {
  probeWasm,
  decodeUleb128,
  decodeSleb128,
  decodeSleb128_64,
  decodeName,
} from './parser-core.js';

import { parseWasm as parseWasmCore } from './parser-core.js';

function fail(code) { throw new TypeError(code); }

const CONST_RESULT_TYPES = new Map([
  [0x41, 0x7f], // i32.const -> i32
  [0x42, 0x7e], // i64.const -> i64
  [0x43, 0x7d], // f32.const -> f32
  [0x44, 0x7c], // f64.const -> f64
]);

function validateConstExpr(expr, expectedType, globals, functionCount) {
  const ops = expr?.ops;
  if (!Array.isArray(ops) || ops.length !== 1) fail('wasm-invalid-const-expr-stack');
  const op = ops[0];
  let resultType = CONST_RESULT_TYPES.get(op?.opcode) ?? null;
  if (op?.opcode === 0x23) {
    if (!Number.isSafeInteger(op.index) || op.index < 0 || op.index >= globals.length) {
      fail('wasm-invalid-const-expr-global-index');
    }
    const global = globals[op.index];
    if (global?.mutable !== false) fail('wasm-invalid-const-expr-global-mutability');
    resultType = global.valType;
  } else if (op?.opcode === 0xd2) {
    if (!Number.isSafeInteger(op.index) || op.index < 0 || op.index >= functionCount) {
      fail('wasm-invalid-const-expr-function-index');
    }
    resultType = 0x70;
  } else if (op?.opcode === 0xd0) {
    resultType = op.refType;
  }
  if (resultType == null || resultType !== expectedType) fail('wasm-invalid-const-expr-result-type');
}

export function parseWasm(bytes, options = {}) {
  const module = parseWasmCore(bytes, options);
  for (const body of module.codeBodies || []) {
    const bytecode = body?.bytecode;
    if (!bytecode || bytecode.length === 0 || bytecode[bytecode.length - 1] !== 0x0b) {
      fail('wasm-function-missing-end');
    }
  }

  const importedGlobals = (module.imports || [])
    .filter((entry) => entry?.desc?.kind === 3)
    .map((entry) => entry.desc);
  const importedFunctions = (module.imports || []).filter((entry) => entry?.desc?.kind === 0);
  const functionCount = importedFunctions.length + (module.functions?.length || 0);
  const globalContext = [...importedGlobals];
  for (const global of module.globals || []) {
    validateConstExpr(global?.init, global?.valType, globalContext, functionCount);
    globalContext.push(global);
  }
  for (const element of module.elements || []) {
    if (element?.mode === 'active') validateConstExpr(element.offsetExpr, 0x7f, importedGlobals, functionCount);
  }
  for (const segment of module.dataSegments || []) {
    if (segment?.mode === 'active') validateConstExpr(segment.offsetExpr, 0x7f, importedGlobals, functionCount);
  }
  return module;
}
