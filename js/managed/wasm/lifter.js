import { liftWasmFunction as liftWasmFunctionCore } from './lifter-core.js';
import { validateWasmFunctionTypes } from './validator.js';
import { createVMEffectFunction } from '../shared/vm-effects.js';

const NARROW_I32_LOADS = Object.freeze({
  0x2c: Object.freeze({ mnemonic: 'i32.load8_s', sourceBits: 8, extension: 'sign' }),
  0x2d: Object.freeze({ mnemonic: 'i32.load8_u', sourceBits: 8, extension: 'zero' }),
  0x2e: Object.freeze({ mnemonic: 'i32.load16_s', sourceBits: 16, extension: 'sign' }),
  0x2f: Object.freeze({ mnemonic: 'i32.load16_u', sourceBits: 16, extension: 'zero' }),
});

function fail(code) { throw new TypeError(code); }

function preserveNarrowLoadExtensionSemantics(lifted, options) {
  let changed = false;
  const bundles = lifted.bundles.map((bundle) => {
    const rule = NARROW_I32_LOADS[bundle.opcode];
    if (!rule) return bundle;
    const memory = bundle.memoryEffects?.[0];
    const produced = bundle.producedValues?.[0];
    if (bundle.frontendId !== 'wasm'
        || bundle.mnemonic !== 'load'
        || bundle.completeness !== 'exact'
        || bundle.memoryEffects?.length !== 1
        || bundle.producedValues?.length !== 1
        || memory?.space !== 'linear-memory'
        || memory?.isWrite !== false
        || memory?.byteWidth * 8 !== rule.sourceBits
        || produced?.bits !== 32) {
      fail('wasm-narrow-load-extension-source-contract-mismatch');
    }
    changed = true;
    return {
      ...bundle,
      mnemonic: rule.mnemonic,
      producedValues: [{ ...produced, sourceBits: rule.sourceBits, extension: rule.extension }],
      memoryEffects: [{ ...memory, sourceBits: rule.sourceBits, resultBits: 32, extension: rule.extension }],
    };
  });
  if (!changed) return lifted;
  return createVMEffectFunction({ ...lifted, bundles }, options);
}

export function liftWasmFunction(funcIndex, wasmModule, options = {}) {
  const validation = validateWasmFunctionTypes(funcIndex, wasmModule, options);
  const lifted = preserveNarrowLoadExtensionSemantics(liftWasmFunctionCore(funcIndex, wasmModule, options), options);
  return Object.freeze({
    ...lifted,
    metadata: Object.freeze({
      ...lifted.metadata,
      wasmSpecValidation: validation.complete ? 'valid' : 'partial',
    }),
  });
}
