import { parseCil as parseCilBase, probeCil as probeCilBase } from './parser-base.js';
import { overlayCilMetadata } from './parser-overlay.js';
function unsupported(reason='malformed-pe-cli'){ return {supported:false,confidence:0,reason}; }
export function probeCil(bytes) {
  const base=probeCilBase(bytes); if(!base.supported)return base;
  try { overlayCilMetadata(bytes,parseCilBase(bytes)); return base; }
  catch { return unsupported(); }
}
export function parseCil(bytes,options={}) {
  const probe=probeCil(bytes); if(!probe.supported)throw new TypeError('cil-unsupported-binary');
  return overlayCilMetadata(bytes,parseCilBase(bytes,options));
}
