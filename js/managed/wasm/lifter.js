import { liftWasmFunction as liftWasmFunctionCore } from './lifter-core.js';
import { validateWasmFunctionTypes } from './validator.js';

export function liftWasmFunction(funcIndex, wasmModule, options = {}) {
  const validation = validateWasmFunctionTypes(funcIndex, wasmModule, options);
  const lifted = liftWasmFunctionCore(funcIndex, wasmModule, options);
  return Object.freeze({
    ...lifted,
    metadata: Object.freeze({
      ...lifted.metadata,
      wasmSpecValidation: validation.complete ? 'valid' : 'partial',
    }),
  });
}
