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

export function parseWasm(bytes, options = {}) {
  const module = parseWasmCore(bytes, options);
  for (const body of module.codeBodies || []) {
    const bytecode = body?.bytecode;
    if (!bytecode || bytecode.length === 0 || bytecode[bytecode.length - 1] !== 0x0b) {
      fail('wasm-function-missing-end');
    }
  }
  return module;
}
