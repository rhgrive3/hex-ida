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
import {
  canonicalizeLegacyRootedFieldBases,
  restoreLegacyPrivateStackForwarding,
} from './legacy-stack-compat-repair.js';
import { hasDefUseIndex } from './semantics/def-use.js';

// The canonical def-use reader travels with the public facade. The IR no longer
// carries a `defUse` closure, so consumers ask for the index explicitly.
export { defUseFor } from './semantics/def-use.js';

// A canonical v2 -> v1 projection is identified by the producer-owned compat
// record it publishes plus the semantic indexes it carries — never by a runtime
// method. The historical probe was `typeof model.defUse === 'function'`; the
// equivalent semantic fact is that the projection published its SSA value
// (def-use) index. Keeping the probe on a method would either resurrect the
// closure or make every projection look like a raw legacy model and be
// re-lifted by the legacy ARM64 decoder.
function isCanonicalV2CompatibilityProjection(model) {
  return model?.compat?.projection === 'semantic-ir-v2-to-v1'
    && typeof model?.semanticIrVersion === 'string'
    && Array.isArray(model?.instructions)
    && Array.isArray(model?.blocks)
    && hasDefUseIndex(model);
}

export function buildIR(model, options = {}) {
  const projected = baseBuildIR(model, options);
  canonicalizeLegacyRootedFieldBases(projected);
  const mode = options?.semanticMigrationMode ?? getSemanticMigrationMode();
  if (mode === 'legacy-v1') restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf);
  return projected;
}

export function irFor(model, options = {}) {
  const mode = options?.semanticMigrationMode ?? getSemanticMigrationMode();
  if (isCanonicalV2CompatibilityProjection(model)) {
    canonicalizeLegacyRootedFieldBases(model);
    if (mode === 'legacy-v1') restoreLegacyPrivateStackForwarding(model, stackPointerProvenanceOf);
    return model;
  }
  const projected = baseIrFor(model, options);
  canonicalizeLegacyRootedFieldBases(projected);
  if (mode === 'legacy-v1') restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf);
  return projected;
}