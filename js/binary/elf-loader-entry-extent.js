import '../words.js';
import { ByteView } from './reader.js';
import { elfLoaderEntrySectionAnalysisWindow, mappedELFFileSpanForVa } from './elf-mapping.js';

const W = globalThis.Words;

// A loader entry proves the start, not the end. Only a fully file-backed,
// straight-line section ending in RET supplies the missing extent evidence.
// Reuse the production word classifier; unknown/control/system instructions
// keep the original start-only seed. This deliberately does not solve CFGs.
export function retainElfLoaderEntryExtents(image) {
  if (image.format !== 'elf' || image.arch !== 'arm64' || image.endian !== 'little') return image;
  const reader = new ByteView(image.bytes);
  const starts = new Set(image.functions.map((fn) => fn.address));
  const exactStarts = new Set(image.functions.filter((fn) => fn.exactFunctionStart === true).map((fn) => fn.address));
  image.functions = image.functions.map((fn) => {
    if (fn.end != null || fn.size != null || fn.exactFunctionStart !== true) return fn;
    const contracts = fn.loaderEntryContracts || [];
    const sources = new Set([fn.source, ...(fn.sources || [])]);
    if (!contracts.some((tag) => (tag === 'DT_INIT' && sources.has('dt-init') && image.metadata.dtInit?.address === fn.address)
      || (tag === 'DT_FINI' && sources.has('dt-fini') && image.metadata.dtFini?.address === fn.address))) return fn;
    const window = elfLoaderEntrySectionAnalysisWindow(image, fn.address);
    if (!window) return fn;
    const size = window.end - window.start;
    // Bound optional proof work independently of attacker-controlled section size.
    if (size > 4096n || size % 4n !== 0n || window.start % 4n !== 0n) return fn;
    const span = mappedELFFileSpanForVa(image, window.start, size);
    if (!span) return fn;
    for (let offset = 0; offset < Number(size); offset += 4) {
      const pc = window.start + BigInt(offset);
      if ((offset && starts.has(pc)) || image.isDataInCode(pc)) return fn;
      const word = reader.u32(span.start + offset, true);
      const kind = W.classifyWord(word);
      if (offset === Number(size) - 4) {
        // RET through LR, not an arbitrary register-indirect transfer.
        if (word !== 0xd65f03c0) return fn;
      } else if (kind === W.KIND.CALL) {
        const target = W.branchImm26(word, pc);
        // A call into this same window would create another local entry.
        if (target == null || (target >= window.start && target < window.end)
          || !exactStarts.has(target)) return fn;
      } else if (kind === W.KIND.OTHER || kind === W.KIND.RET
        || kind === W.KIND.BRANCH || kind === W.KIND.CONDBR
        || kind === W.KIND.INDCALL || kind === W.KIND.SYS || kind === W.KIND.TRAP) {
        return fn;
      }
    }
    return { ...fn, size, end:window.end,
      extentSource:'elf-loader-linear-return', extentConfidence:0.9, extentInherited:false };
  });
  return image;
}
