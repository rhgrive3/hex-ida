import { parseCil as parseCilBase, probeCil as probeCilBase } from './parser-base.js';
import { overlayCilMetadata } from './parser-overlay.js';
import { overlayCilManifestSecurity } from './metadata-manifest-security.js';
import { readCilMetadataContext } from './metadata-context.js';
import { isCilMetadataResourceLimit, isCilMetadataBudgetConfigError } from './metadata-budget.js';
function unsupported(reason='malformed-pe-cli'){ return {supported:false,confidence:0,reason}; }
// One validated metadata context feeds both overlays and the base parse, so a
// probe or a parse decodes the definition graph exactly once instead of once per
// overlay per entry point (#8704).
function cilValidatedPipeline(bytes,options={}){
  const base=probeCilBase(bytes); if(!base.supported)return {supported:false,probe:base};
  try {
    const context=readCilMetadataContext(bytes,options);
    return {supported:true,base,image:overlayCilManifestSecurity(bytes,overlayCilMetadata(bytes,parseCilBase(bytes,options),context),context)};
  } catch (error) {
    if(isCilMetadataResourceLimit(error))return {supported:false,error};
    // An invalid budget describes the caller, not the image, so it is never
    // collapsed into a malformed-metadata verdict.
    if(isCilMetadataBudgetConfigError(error))throw error;
    return {supported:false,probe:unsupported()};
  }
}
export function probeCil(bytes,options={}) {
  const outcome=cilValidatedPipeline(bytes,options);
  if(outcome.supported)return outcome.base;
  if(outcome.error)return {supported:false,confidence:0,reason:outcome.error.code,status:'resource-limited',resourceLimited:true};
  return outcome.probe;
}
export function parseCil(bytes,options={}) {
  const outcome=cilValidatedPipeline(bytes,options);
  if(outcome.supported)return outcome.image;
  // Budget exhaustion is an explicit bounded stop, never a malformed-image verdict.
  if(outcome.error)throw outcome.error;
  throw new TypeError('cil-unsupported-binary');
}
