import { parseELF as parseELFCore } from './elf-core.js';
import { functionSeed, mergeFunctionSeeds } from './model.js';

function executableOwnerForSymbol(image, symbol) {
  const start = BigInt(symbol.address);
  const extent = BigInt(symbol.size || 0n);
  const exactSection = symbol.sectionIndex == null ? null : image.sections?.find((section) => section.index === symbol.sectionIndex) || null;
  if (exactSection?.perms?.execute && start >= exactSection.address && start < exactSection.address + exactSection.size
      && (extent === 0n || extent <= exactSection.address + exactSection.size - start)) return exactSection;
  const section = typeof image.sectionAt === 'function' ? image.sectionAt(start) : null;
  if (section?.perms?.execute && (extent === 0n || extent <= section.address + section.size - start)) return section;
  const segment = typeof image.segmentAt === 'function' ? image.segmentAt(start) : null;
  if (segment?.perms?.execute && (extent === 0n || extent <= segment.address + segment.size - start)) return segment;
  return null;
}

export function repairElfZeroAddressFunctionSeeds(image) {
  if (!image || !Array.isArray(image.symbols)) return image;
  const zeroSeeds = [];
  for (const symbol of image.symbols) {
    if (symbol?.defined !== true || symbol.address !== 0n || !['function','indirect-function'].includes(symbol.kind)) continue;
    if (!executableOwnerForSymbol(image, symbol)) continue;
    const ifunc = symbol.kind === 'indirect-function';
    zeroSeeds.push(functionSeed(0n, {
      size: symbol.size || null,
      name: ifunc ? `${symbol.name}$resolver` : symbol.name,
      source: ifunc ? 'ifunc-resolver' : 'symbol',
      confidence: 0.995,
      exactFunctionStart: true,
      functionStartEvidence: ifunc
        ? 'ELF STT_GNU_IFUNC resolver with validated executable extent'
        : 'ELF STT_FUNC with validated executable extent',
      callingConvention: symbol.callingConvention || null,
      abiMetadata: symbol.riscvVariantCc ? { riscvVariantCc:true, stOther:symbol.stOther } : null,
    }));
  }
  if (zeroSeeds.length) image.functions = mergeFunctionSeeds([...(image.functions || []), ...zeroSeeds], image);
  return image;
}

export function parseELF(input, options = {}) {
  return repairElfZeroAddressFunctionSeeds(parseELFCore(input, options));
}
