import { validateDexMap } from './map-validation.js';
import { parseDex as parseDexCore, probeDex } from './parser-core.js';

export { probeDex };

export function parseDex(bytes, options = {}) {
  validateDexMap(bytes);
  return parseDexCore(bytes, options);
}
