# hex-ida WASM Engine Rollback Guide

The unified C++/WASM engine (`js/core/hex-engine-wasm.js` via `js/core/hex-engine-bridge.js`) can be rolled back to the pure JavaScript engine instantaneously with a single flag, without rebuilding or modifying code.

## 1. Engine Mode Resolution Priority (`getEngineMode(opts)`)
1. **Per-call option**: `{ _engine: 'js' | 'wasm' | 'auto' }`
2. **Browser / Userscript global**: `globalThis.HEX_ENGINE = 'js'` (or `globalThis.__HEX_ENGINE_MODE__ = 'js'`)
3. **Node.js / CLI environment variable**: `HEX_ENGINE=js`
4. **Default**: `'auto'` (uses WASM when `isWasmBulkMemorySupported()` is true and all capability gates pass; automatically falls back per-function to JS with structured telemetry otherwise)

## 2. Instant Rollback Procedures
- **Node.js / CLI**:
  ```bash
  HEX_ENGINE=js node your-script.mjs
  ```
- **Browser / iPad Safari / Userscript Console**:
  ```js
  globalThis.HEX_ENGINE = 'js';
  ```
- **Per-function call**:
  ```js
  decompile(model, { ...opts, _engine: 'js' });
  ```

## 3. Rollback Verification One-Liner
```bash
HEX_ENGINE=js node --input-type=module -e '
import { getEngineMode, isWasmEngineAvailable, wasmDecompileArm64Function } from "./js/core/hex-engine-bridge.js";
import { getWasmCallCounts, getFallbackCounts, resetAllTelemetry } from "./js/core/wasm-telemetry.js";
resetAllTelemetry();
const res = wasmDecompileArm64Function({ words: new Uint32Array([0x0b010000, 0xd65f03c0]), baseAddr: 0x1000n, funcName: "add" });
console.log({ mode: getEngineMode(), wasmAvailable: isWasmEngineAvailable(), res, wasmCalls: getWasmCallCounts(), fallbackCounts: getFallbackCounts() });
'
```
Expected output: `mode: 'js'`, `wasmAvailable: false`, `res: null`, `wasmCalls: {}`, `fallbackCounts: { 'decompile:wasm_disabled': 1 }`.

## 4. Telemetry Inspection
- `getWasmCallCounts()` (`js/core/wasm-telemetry.js`): counts accepted WASM executions (`decompile`, `cfg`, `loops`, `identity`, `binary`, `arm64_decode`, `x86_64_decode`).
- `getFallbackCounts()` (`js/core/wasm-telemetry.js`): counts every fallback with structured reason codes (`decompile:wasm_disabled`, `decompile:wasm_unavailable`, `decompile:non_arm64_arch:<arch>`, `decompile:unsupported_insn:<mn>`, `decompile:unsupported_objc_name`, `decompile:wasm_status_<code>`, `cfg:wasm_disabled`, etc.).
