import * as original from './elf-dynamic-original.js';

export * from './elf-dynamic-original.js';

const PT_DYNAMIC = 2;
const MAX_PT_DYNAMIC_ENTRIES = 100_000;

export function parseProgramDynamic(r, programHeaders, image, bits, opts = {}) {
  const entrySize = BigInt(bits === 64 ? 16 : 8);
  const maxBytes = entrySize * BigInt(MAX_PT_DYNAMIC_ENTRIES);
  let capped = false;
  const boundedHeaders = (programHeaders || []).map((ph) => {
    if (ph?.type !== PT_DYNAMIC || ph.filesz == null) return ph;
    const filesz = BigInt(ph.filesz);
    if (filesz <= maxBytes) return ph;
    capped = true;
    return { ...ph, filesz: maxBytes };
  });
  if (capped) {
    image.metadata.programDynamicPartial = true;
    const diagnostics = image.metadata.programDynamicDiagnostics ||= [];
    const message = `PT_DYNAMIC entry span exceeds bootstrap materialization limit ${MAX_PT_DYNAMIC_ENTRIES}; entry records truncated before budgeted decode`;
    if (!diagnostics.includes(message)) diagnostics.push(message);
    const warning = `PT_DYNAMIC: ${message}`;
    if (!image.warnings.includes(warning)) image.warnings.push(warning);
  }
  return original.parseProgramDynamic(r, boundedHeaders, image, bits, opts);
}
