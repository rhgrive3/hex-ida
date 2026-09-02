/* Public Semantic IR facade.
 *
 * Canonical Semantic IR v2 -> legacy-v1 compatibility projections are already
 * semantic IR. Re-running them through the legacy ARM64 decoder/lifter would
 * reinterpret x86-64/RISC-V facts as ARM64. Keep the historical implementation
 * in ir-public-base.js and short-circuit only the explicit canonical projection.
 */
export * from './ir-public-base.js';

import {
  irFor as baseIrFor,
  buildIR as baseBuildIR,
  getSemanticMigrationMode,
  stackPointerProvenanceOf,
} from './ir-public-base.js';
import { restoreLegacyPrivateStackForwarding } from './legacy-stack-compat-repair.js';

function isCanonicalV2CompatibilityProjection(model) {
  return model?.compat?.projection === 'semantic-ir-v2-to-v1'
    && typeof model?.semanticIrVersion === 'string'
    && Array.isArray(model?.instructions)
    && Array.isArray(model?.blocks)
    && typeof model?.defUse === 'function';
}

export function buildIR(model, options = {}) {
  const projected = baseBuildIR(model, options);
  const mode = options?.semanticMigrationMode ?? getSemanticMigrationMode();
  if (mode === 'legacy-v1') restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf);
  return projected;
}

export function irFor(model, options = {}) {
  if (isCanonicalV2CompatibilityProjection(model)) return model;
  const projected = baseIrFor(model, options);
  const mode = options?.semanticMigrationMode ?? getSemanticMigrationMode();
  if (mode === 'legacy-v1') restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf);
  return projected;
}
