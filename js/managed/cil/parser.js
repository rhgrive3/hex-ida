import { parseCil as parseCilBase, probeCil as probeCilBase } from './parser-base.js';
import { overlayCilMetadata } from './parser-overlay.js';
import { overlayCilManifestSecurity } from './metadata-manifest-security.js';
import { createCilMetadataBudget } from './metadata-layout.js';
function unsupported(reason='malformed-pe-cli'){ return {supported:false,confidence:0,reason}; }
function parseCilValidated(bytes, options = {}) {
  const budget = createCilMetadataBudget(options);
  return overlayCilManifestSecurity(
    bytes,
    overlayCilMetadata(bytes, parseCilBase(bytes, options), options, budget),
    options,
    budget,
  );
}
export function probeCil(bytes) {
  const base=probeCilBase(bytes); if(!base.supported)return base;
  try { parseCilValidated(bytes); return base; }
  catch { return unsupported(); }
}
export function parseCil(bytes,options={}) {
  const base=probeCilBase(bytes); if(!base.supported)throw new TypeError('cil-unsupported-binary');
  try { return parseCilValidated(bytes, options); }
  catch (error) {
    if (error?.message?.startsWith('cil-metadata-resource-limit-')) throw error;
    throw new TypeError('cil-unsupported-binary');
  }
}
