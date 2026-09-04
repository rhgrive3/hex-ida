import { decodeSleb128, decodeSleb128_64, decodeUleb128 } from './parser.js';

function fail(code) { throw new TypeError(code); }

const I32 = 0x7f;
const I64 = 0x7e;
const F32 = 0x7d;
const F64 = 0x7c;
const UNKNOWN = Symbol('wasm-unknown-stack-type');
const VALUE_TYPES = new Set([I32, I64, F32, F64, 0x7b, 0x70, 0x6f]);

function checkpoint(options) {
  if (options?.signal?.aborted) {
    const error = new Error('wasm-validation-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

function sameTypes(a, b) {
  return a.length === b.length && a.every((type, index) => type === b[index]);
}

function decodeBlockType(bytecode, pos, wasmModule) {
  if (pos >= bytecode.length) fail('wasm-truncated-blocktype');
  const first = bytecode[pos];
  if (first === 0x40) return { params: [], results: [], nextOffset: pos + 1 };
  if (VALUE_TYPES.has(first)) return { params: [], results: [first], nextOffset: pos + 1 };
  const result = decodeSleb128(bytecode, pos);
  if (result.value < 0 || result.value >= wasmModule.types.length) fail('wasm-invalid-block-type-index');
  const type = wasmModule.types[result.value];
  return { params: type.params.slice(), results: type.results.slice(), nextOffset: result.nextOffset };
}

function functionTypeForIndex(wasmModule, funcIndex) {
  const imported = wasmModule.imports.filter((entry) => entry.desc.kind === 0);
  const typeIndex = funcIndex < imported.length
    ? imported[funcIndex].desc.typeIndex
    : wasmModule.functions[funcIndex - imported.length];
  const type = wasmModule.types[typeIndex];
  if (!type) fail('wasm-invalid-callee-type-index');
  return type;
}

export function validateWasmFunctionTypes(funcIndex, wasmModule, options = {}) {
  const imported = wasmModule.imports.filter((entry) => entry.desc.kind === 0);
  if (funcIndex < imported.length) return Object.freeze({ complete: true });

  const internalIndex = funcIndex - imported.length;
  if (internalIndex < 0 || internalIndex >= wasmModule.functions.length || internalIndex >= wasmModule.codeBodies.length) {
    fail('wasm-invalid-function-index');
  }
  const funcType = wasmModule.types[wasmModule.functions[internalIndex]];
  if (!funcType) fail('wasm-invalid-function-type-index');
  const codeBody = wasmModule.codeBodies[internalIndex];
  const bytecode = codeBody.bytecode;
  const locals = [...funcType.params, ...codeBody.locals];
  const globals = [
    ...wasmModule.imports.filter((entry) => entry.desc.kind === 3).map((entry) => entry.desc),
    ...wasmModule.globals,
  ];
  const stack = [];
  const frames = [{ kind: 'function', height: 0, params: [], results: funcType.results.slice(), polymorphic: false, elseSeen: false }];
  let pos = 0;
  let complete = true;

  const currentFrame = () => frames[frames.length - 1];
  const matches = (actual, expected) => actual === UNKNOWN || expected === UNKNOWN || actual === expected;
  const pop = (expected = UNKNOWN, underflowCode = 'wasm-stack-underflow', mismatchCode = 'wasm-stack-type-mismatch') => {
    const frame = currentFrame();
    if (!frame) fail('wasm-invalid-control-stack');
    if (stack.length === frame.height && frame.polymorphic) return expected;
    if (stack.length <= frame.height) fail(underflowCode);
    const actual = stack.pop();
    if (!matches(actual, expected)) fail(mismatchCode);
    return actual;
  };
  const popTypes = (types, underflowCode = 'wasm-stack-underflow', mismatchCode = 'wasm-stack-type-mismatch') => {
    const actual = new Array(types.length);
    for (let i = types.length - 1; i >= 0; i--) actual[i] = pop(types[i], underflowCode, mismatchCode);
    return actual;
  };
  const pushTypes = (types) => { for (const type of types) stack.push(type); };
  const assertSuffix = (types, underflowCode = 'wasm-stack-underflow', mismatchCode = 'wasm-stack-type-mismatch') => {
    const frame = currentFrame();
    let index = stack.length - 1;
    for (let i = types.length - 1; i >= 0; i--, index--) {
      if (index < frame.height) {
        if (frame.polymorphic) continue;
        fail(underflowCode);
      }
      if (!matches(stack[index], types[i])) fail(mismatchCode);
    }
  };
  const markUnreachable = () => {
    const frame = currentFrame();
    stack.length = frame.height;
    frame.polymorphic = true;
  };
  const finishFrame = (frame, code) => {
    popTypes(frame.results, code, 'wasm-stack-type-mismatch');
    if (stack.length !== frame.height) fail(code);
    stack.length = frame.height;
  };
  const labelTypes = (frame) => frame.kind === 'loop' ? frame.params : frame.results;

  while (pos < bytecode.length) {
    checkpoint(options);
    const opcode = bytecode[pos++];
    switch (opcode) {
      case 0x00:
        markUnreachable();
        break;
      case 0x01:
        break;
      case 0x02: case 0x03: case 0x04: {
        const blockType = decodeBlockType(bytecode, pos, wasmModule);
        pos = blockType.nextOffset;
        const kind = opcode === 0x02 ? 'block' : opcode === 0x03 ? 'loop' : 'if';
        if (kind === 'if') pop(I32, 'wasm-stack-underflow-if-condition');
        const inheritedPolymorphic = currentFrame().polymorphic && stack.length === currentFrame().height;
        popTypes(blockType.params, 'wasm-stack-underflow-block-params');
        const height = stack.length;
        pushTypes(blockType.params);
        frames.push({ kind, height, params: blockType.params, results: blockType.results, polymorphic: inheritedPolymorphic, entryPolymorphic: inheritedPolymorphic, elseSeen: false });
        break;
      }
      case 0x05: {
        const frame = currentFrame();
        if (!frame || frame.kind !== 'if' || frame.elseSeen) fail('wasm-invalid-else');
        finishFrame(frame, 'wasm-invalid-if-then-stack');
        frame.elseSeen = true;
        frame.polymorphic = frame.entryPolymorphic;
        pushTypes(frame.params);
        break;
      }
      case 0x0b: {
        const frame = currentFrame();
        if (!frame) fail('wasm-unmatched-end');
        if (frame.kind === 'if' && !frame.elseSeen && !sameTypes(frame.params, frame.results)) {
          fail('wasm-invalid-if-without-else-type');
        }
        finishFrame(frame, 'wasm-invalid-block-result-stack');
        frames.pop();
        if (frame.kind === 'function') {
          if (pos !== bytecode.length) fail('wasm-trailing-bytes-after-function-end');
        } else {
          pushTypes(frame.results);
        }
        break;
      }
      case 0x0c: case 0x0d: {
        const depth = decodeUleb128(bytecode, pos); pos = depth.nextOffset;
        if (depth.value >= frames.length) fail('wasm-invalid-branch-depth');
        if (opcode === 0x0d) pop(I32, 'wasm-stack-underflow-branch-condition');
        const target = frames[frames.length - 1 - depth.value];
        assertSuffix(labelTypes(target), 'wasm-stack-underflow-branch-values');
        if (opcode === 0x0c) markUnreachable();
        break;
      }
      case 0x0e: {
        const count = decodeUleb128(bytecode, pos); pos = count.nextOffset;
        const depths = [];
        for (let i = 0; i < count.value; i++) { const depth = decodeUleb128(bytecode, pos); pos = depth.nextOffset; depths.push(depth.value); }
        const fallback = decodeUleb128(bytecode, pos); pos = fallback.nextOffset; depths.push(fallback.value);
        if (depths.some((depth) => depth >= frames.length)) fail('wasm-invalid-branch-depth');
        pop(I32, 'wasm-stack-underflow-branch-table-index');
        const expected = labelTypes(frames[frames.length - 1 - depths[0]]);
        for (const depth of depths) {
          const actual = labelTypes(frames[frames.length - 1 - depth]);
          if (!sameTypes(actual, expected)) fail('wasm-branch-table-type-mismatch');
        }
        assertSuffix(expected, 'wasm-stack-underflow-branch-values');
        markUnreachable();
        break;
      }
      case 0x0f:
        assertSuffix(funcType.results, 'wasm-stack-underflow-return');
        markUnreachable();
        break;
      case 0x10: {
        const callee = decodeUleb128(bytecode, pos); pos = callee.nextOffset;
        const type = functionTypeForIndex(wasmModule, callee.value);
        popTypes(type.params, 'wasm-stack-underflow-call');
        pushTypes(type.results);
        break;
      }
      case 0x11: {
        const typeIndex = decodeUleb128(bytecode, pos); pos = typeIndex.nextOffset;
        const type = wasmModule.types[typeIndex.value];
        if (!type) fail('wasm-invalid-call-indirect-type-index');
        const table = decodeUleb128(bytecode, pos); pos = table.nextOffset;
        const importedTables = wasmModule.imports.filter((entry) => entry.desc.kind === 1).length;
        if (table.value >= importedTables + wasmModule.tables.length) fail('wasm-invalid-call-indirect-table-index');
        pop(I32, 'wasm-stack-underflow-call-indirect');
        popTypes(type.params, 'wasm-stack-underflow-call-indirect');
        pushTypes(type.results);
        break;
      }
      case 0x1a:
        pop(UNKNOWN);
        break;
      case 0x1b: {
        pop(I32, 'wasm-stack-underflow-select');
        const rhs = pop(UNKNOWN, 'wasm-stack-underflow-select');
        const lhs = pop(UNKNOWN, 'wasm-stack-underflow-select');
        if (!matches(lhs, rhs)) fail('wasm-stack-type-mismatch');
        stack.push(lhs === UNKNOWN ? rhs : lhs);
        break;
      }
      case 0x20: {
        const local = decodeUleb128(bytecode, pos); pos = local.nextOffset;
        if (local.value >= locals.length) fail('wasm-invalid-local-index');
        stack.push(locals[local.value]);
        break;
      }
      case 0x21: case 0x22: {
        const local = decodeUleb128(bytecode, pos); pos = local.nextOffset;
        if (local.value >= locals.length) fail('wasm-invalid-local-index');
        pop(locals[local.value]);
        if (opcode === 0x22) stack.push(locals[local.value]);
        break;
      }
      case 0x23: case 0x24: {
        const global = decodeUleb128(bytecode, pos); pos = global.nextOffset;
        if (global.value >= globals.length) fail('wasm-invalid-global-index');
        if (opcode === 0x23) stack.push(globals[global.value].valType);
        else pop(globals[global.value].valType);
        break;
      }
      case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d: case 0x2e: case 0x2f: {
        const align = decodeUleb128(bytecode, pos); pos = align.nextOffset;
        const offset = decodeUleb128(bytecode, pos); pos = offset.nextOffset;
        void align; void offset;
        pop(I32, 'wasm-stack-underflow-load');
        const resultType = opcode === 0x29 ? I64 : opcode === 0x2a ? F32 : opcode === 0x2b ? F64 : I32;
        stack.push(resultType);
        break;
      }
      case 0x36: case 0x37: case 0x38: case 0x39: case 0x3a: case 0x3b: {
        const align = decodeUleb128(bytecode, pos); pos = align.nextOffset;
        const offset = decodeUleb128(bytecode, pos); pos = offset.nextOffset;
        void align; void offset;
        const valueType = opcode === 0x37 ? I64 : opcode === 0x38 ? F32 : opcode === 0x39 ? F64 : I32;
        pop(valueType, 'wasm-stack-underflow-store');
        pop(I32, 'wasm-stack-underflow-store');
        break;
      }
      case 0x41: {
        const value = decodeSleb128(bytecode, pos); pos = value.nextOffset; stack.push(I32); break;
      }
      case 0x42: {
        const value = decodeSleb128_64(bytecode, pos); pos = value.nextOffset; stack.push(I64); break;
      }
      case 0x45:
        pop(I32); stack.push(I32); break;
      case 0x46: case 0x47: case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d:
        pop(I32); pop(I32); stack.push(I32); break;
      case 0x6a: case 0x6b: case 0x6c: case 0x6d: case 0x6e: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76:
        pop(I32); pop(I32); stack.push(I32); break;
      case 0x7c: case 0x7d: case 0x7e:
        pop(I64); pop(I64); stack.push(I64); break;
      default:
        return Object.freeze({ complete: false });
    }
  }

  if (frames.length !== 0) fail('wasm-missing-function-end');
  return Object.freeze({ complete });
}
