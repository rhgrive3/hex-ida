/* Thin conflict-resistant wrapper around the exact main decompiler snapshot.
 * `decompile-base.js` remains the compatibility implementation. Canonical
 * Semantic-v2 function results can attach a presentation-only model carrying
 * the already-produced decompiler snapshot; never re-decompile that snapshot
 * through the legacy architecture path. */
import { decompile as baseDecompile } from './decompile-base.js';
import { lowerArm64RawAssembly } from './decompiler/arm64-extra-semantics.js';
import { sourceOf } from './decompiler/ast/nodes.js';

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

function attachResidualControlSource(result, model) {
  if (!Array.isArray(result?.lines)) return result;
  const instructions = Array.isArray(model?.instructions) ? model.instructions : [];
  for (const line of result.lines) {
    if (!line || line.source || line.row == null || !/^goto\s+loc_[0-9a-f]+;$/i.test(String(line.text || '').trim())) continue;
    const instruction = instructions.find((candidate) => candidate?.row === line.row) ?? null;
    line.source = sourceOf({
      address:instruction?.address ?? line.addr ?? null,
      row:line.row,
      ir:instruction?.id ?? null,
      evidence:[{ reason:'residual control-flow edge preserved by compatibility projection' }],
    });
  }
  return result;
}

export function decompile(model, opts = {}) {
  const canonical = canonicalSnapshot(model);
  if (canonical) return attachResidualControlSource(canonical, model);
  return attachResidualControlSource(lowerArm64RawAssembly(baseDecompile(model, opts)), model);
}
