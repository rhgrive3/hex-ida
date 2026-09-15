export * from './elf-dynamic-impl.js';
import { parseProgramDynamic as parseProgramDynamicImpl } from './elf-dynamic-impl.js';

// Bound PT_DYNAMIC entry materialization before the implementation allocates
// `tags`/`ordered`. A hostile declared table can otherwise create up to the
// parser's 1,000,000-entry guard worth of JS objects before the string/output
// budgets exist (#8688). The cap is intentionally conservative and fail-closed:
// smaller conforming tables are unchanged; larger tables expose only a bounded
// prefix and the resulting missing-DT_NULL partiality.
const MAX_PT_DYNAMIC_ENTRIES = 100_000;
const PT_DYNAMIC = 2;

export function parseProgramDynamic(r, programHeaders, image, bits, opts = {}) {
  const entSize = BigInt(bits === 64 ? 16 : 8);
  const maxBytes = entSize * BigInt(MAX_PT_DYNAMIC_ENTRIES);
  let bounded = programHeaders;
  let boundedEntryTable = false;

  if (Array.isArray(programHeaders)) {
    for (const header of programHeaders) {
      if (header?.type !== PT_DYNAMIC || typeof header.filesz !== 'bigint' || header.filesz <= maxBytes) continue;
      if (bounded === programHeaders) bounded = programHeaders.slice();
      const index = bounded.indexOf(header);
      if (index >= 0) bounded[index] = { ...header, filesz: maxBytes };
      boundedEntryTable = true;
      break;
    }
  }

  if (boundedEntryTable) {
    if (image?.metadata && typeof image.metadata === 'object') image.metadata.programDynamicPreBudgetPartial = true;
    if (Array.isArray(image?.warnings)) {
      image.warnings.push(`PT_DYNAMIC entry materialization bounded to ${MAX_PT_DYNAMIC_ENTRIES} records before metadata budgets`);
    }
  }

  return parseProgramDynamicImpl(r, bounded, image, bits, opts);
}
