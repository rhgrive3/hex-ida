import { functionSeed } from './model.js';

// SafeSEH is an x86-only IMAGE_LOAD_CONFIG_DIRECTORY32 contract. It predates
// GuardCF, so a valid 72-byte load-config must be useful even when the newer
// GuardCF fields are absent (#8166).
export function parseSafeSEHLoadConfig(
  r,
  off,
  declared,
  image,
  budget,
  mappedFileRangeForRva,
  mappedFileSpanForRva,
) {
  if (image.bits !== 32 || image.metadata?.machine !== 0x014c || declared < 72) return;

  const tableVa = BigInt(r.u32(off + 64));
  const count = BigInt(r.u32(off + 68));
  const handlers = [];
  let valid = true;

  if (count > 0n) {
    const tableDelta = tableVa - image.imageBase;
    const tableRange = tableDelta > 0n && tableDelta <= 0xffffffffn
      ? mappedFileRangeForRva(image, Number(tableDelta))
      : null;
    if (!tableRange) {
      budget.partial('load-config:safeseh-table-span', 'PE SafeSEH handler table is not file-backed');
      valid = false;
    } else {
      const capacity = Math.floor((tableRange.end - tableRange.start) / 4);
      if (count > BigInt(capacity)) {
        budget.partial('load-config:safeseh-count-span', 'PE SafeSEH handler count exceeds its mapped file-backed table');
        valid = false;
      } else {
        const entries = [];
        let previousRva = null;
        for (let i = 0; i < Number(count); i++) {
          if (!budget.take({ inputBytes: 4, records: 1, objects: 1, operations: 1, estimatedHeapBytes: 96 }, 'safeseh-handler')) {
            valid = false;
            break;
          }
          const rva = r.u32(tableRange.start + i * 4);
          if (!rva) {
            budget.partial('load-config:safeseh-target-zero', 'Ignored PE SafeSEH table containing a zero handler RVA');
            valid = false;
            break;
          }
          if (previousRva !== null && rva <= previousRva) {
            budget.partial('load-config:safeseh-order', 'PE SafeSEH handler RVAs are not strictly sorted and unique');
            valid = false;
            break;
          }
          previousRva = rva;
          const address = image.imageBase + BigInt(rva);
          const section = typeof image.sectionAt === 'function' ? image.sectionAt(address) : null;
          if (!section?.perms?.execute) {
            budget.partial('load-config:safeseh-target-non-executable', `Ignored PE SafeSEH handler RVA 0x${rva.toString(16)} outside an executable section`);
            valid = false;
            break;
          }
          if (!mappedFileSpanForRva(image, rva, 1)) {
            budget.partial('load-config:safeseh-target-not-file-backed', `Ignored PE SafeSEH handler RVA 0x${rva.toString(16)} outside a file-backed mapping`);
            valid = false;
            break;
          }
          entries.push({ rva, address });
        }
        if (valid && entries.length === Number(count)) {
          for (const { address } of entries) {
            handlers.push(address);
            image.functions.push(functionSeed(address, {
              source: 'exception',
              confidence: 0.995,
              exactFunctionStart: true,
              functionStartEvidence: 'PE SafeSEH validated handler-table entry',
              abiMetadata: { peSafeSEH: true },
            }));
          }
        }
      }
    }
  }

  image.metadata.loadConfig = {
    ...(image.metadata.loadConfig || {}),
    safeSEHHandlerTable: tableVa || null,
    safeSEHHandlerCount: count,
    safeSEHHandlers: handlers,
  };
}
