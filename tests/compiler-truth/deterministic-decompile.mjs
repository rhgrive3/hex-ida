import { decompile as productDecompile } from '../../js/decompile.js';

export function assertDeterministicDecompilerOptions(options) {
  if (!options || typeof options !== 'object' || options.deterministicTransforms !== true) {
    throw new Error('compiler-truth decompile calls require deterministicTransforms:true');
  }
  return options;
}

/*
 * Compiler-truth output is proof evidence, so every call must be independent
 * of the host's wall-clock speed. Enforce the evaluated option at the actual
 * call boundary instead of trying to infer JavaScript semantics with a source
 * regex (nested calls, spreads, duplicate keys and regular-expression literals
 * all make that inference unsound without a full parser).
 */
export function decompile(model, options) {
  return productDecompile(model, assertDeterministicDecompilerOptions(options));
}
