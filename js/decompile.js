/* Thin conflict-resistant wrapper around the exact main decompiler snapshot.
 * `decompile-base.js` remains the compatibility implementation. Canonical
 * Semantic-v2 function results can attach a presentation-only model carrying
 * the already-produced decompiler snapshot; never re-decompile that snapshot
 * through the legacy architecture path. */
import { decompile as baseDecompile } from './decompile-base.js';
import { lowerArm64RawAssembly } from './decompiler/arm64-extra-semantics.js';
import { optimizeSemanticDecompilation } from './decompiler/pipeline.js';
export { optimizeSemanticDecompilation } from './decompiler/pipeline.js';

export * from './decompile-base.js';

function canonicalSnapshot(model) {
  const snapshot = model?.__canonicalDecompiler ?? null;
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    ...snapshot,
    lines: Array.isArray(snapshot.lines) ? snapshot.lines.map((line) => ({ ...line })) : [],
    warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.slice() : [],
    evidence: Array.isArray(snapshot.evidence) ? snapshot.evidence.slice() : [],
  };
}

export function decompile(model, opts = {}) {
  const canonical = canonicalSnapshot(model);
  if (canonical) return canonical;
  return lowerArm64RawAssembly(baseDecompile(model, opts));
}

/** Explicit asynchronous optimization; the default decompile stays synchronous. */
export async function decompileWithProof(model, options = {}, proofOptions = {}) {
  const result = decompile(model,{...options,phase8Optimize:false,phase8PrepareProof:true});
  return optimizeSemanticDecompilation(result,proofOptions);
}
