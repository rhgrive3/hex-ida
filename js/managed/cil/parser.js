import { parseCil as parseCilBase, probeCil as probeCilBase } from './parser-base.js';
import { overlayCilMetadata } from './parser-overlay.js';
import { readCilMetadataContext } from './metadata-context.js';
import { isCilMetadataResourceLimit, isCilMetadataBudgetConfigError } from './metadata-budget.js';
export { readCompressedInt } from './parser-base.js';
function unsupported(reason='malformed-pe-cli'){ return {supported:false,confidence:0,reason}; }
function validateCilMetadata(bytes, options = {}) {
  try { return readCilMetadataContext(bytes, options); }
  catch (error) {
    if (isCilMetadataResourceLimit(error) || isCilMetadataBudgetConfigError(error)) throw error;
    throw new TypeError('cil-unsupported-binary');
  }
}
export function probeCil(bytes, options = {}) {
  const base = probeCilBase(bytes); if (!base.supported) return base;
  try { validateCilMetadata(bytes, options); overlayCilMetadata(bytes, parseCilBase(bytes, options)); return base; }
  catch (error) {
    if (isCilMetadataResourceLimit(error)) return { supported:false, confidence:0, reason:error.code, status:'resource-limited', resourceLimited:true };
    if (isCilMetadataBudgetConfigError(error)) throw error;
    return unsupported();
  }
}
export function parseCil(bytes, options = {}) {
  // Admit the complete metadata graph before any overlay materialization. This
  // preserves the PR's typed malformed-image behavior while preventing a
  // physically valid but attacker-sized metadata graph from becoming an
  // unbounded object factory (#8704/#8785/#8791/#8944).
  const probe = probeCilBase(bytes); if (!probe.supported) throw new TypeError('cil-unsupported-binary');
  const context = validateCilMetadata(bytes, options);
  const parsed = parseCilBase(bytes, options);
  try { return overlayCilMetadata(bytes, parsed, context, options); }
  catch (error) {
    if (isCilMetadataResourceLimit(error)) throw error;
    if (isCilMetadataBudgetConfigError(error)) throw error;
    throw new TypeError('cil-unsupported-binary');
  }
}
