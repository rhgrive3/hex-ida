import { parseCil as parseCilBase, probeCil as probeCilBase } from './parser-base.js';
import { overlayCilMetadata } from './parser-overlay.js';
export { readCompressedInt } from './parser-base.js';
function unsupported(reason='malformed-pe-cli'){ return {supported:false,confidence:0,reason}; }
export function probeCil(bytes) {
  const base=probeCilBase(bytes); if(!base.supported)return base;
  try { overlayCilMetadata(bytes,parseCilBase(bytes)); return base; }
  catch { return unsupported(); }
}
export function parseCil(bytes,options={}) {
  // The public probe intentionally collapses overlay/body validation failures
  // to an unsupported result. Parsing must retain the typed validation error so
  // callers can distinguish malformed method bodies from unsupported binaries.
  const probe=probeCilBase(bytes); if(!probe.supported)throw new TypeError('cil-unsupported-binary');
  const parsed=parseCilBase(bytes,options);
  try { return overlayCilMetadata(bytes,parsed); }
  catch { throw new TypeError('cil-unsupported-binary'); }
}
