import * as original from './elf-core-original.js';
import { applyAarch64MappingSymbols } from './elf-aarch64-mapping.js';
export * from './elf-core-original.js';
export function parseELF(input, options = {}) {
  return applyAarch64MappingSymbols(original.parseELF(input, options));
}
