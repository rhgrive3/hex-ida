import { validateDexMap } from './map-validation.js';
import { parseDex as parseDexCore, probeDex } from './parser-core.js';

export { probeDex };

function headerReadyForMapValidation(bytes) {
  const probe = probeDex(bytes);
  if (!probe.supported) return false;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 0x70) return false;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return view.getUint32(32, true) === u8.length
    && view.getUint32(36, true) === 0x70
    && view.getUint32(40, true) === 0x12345678;
}

export function parseDex(bytes, options = {}) {
  if (!headerReadyForMapValidation(bytes)) return parseDexCore(bytes, options);
  validateDexMap(bytes);
  return parseDexCore(bytes, options);
}