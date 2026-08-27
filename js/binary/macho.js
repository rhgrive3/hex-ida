import { parseMachO as parseMachOCore } from './macho-core.js';
import { functionSeed, mergeFunctionSeeds } from './model.js';

export function repairMachOZeroEntrypoint(image) {
  if (!image || image.entrypoint !== 0n || image.metadata?.entrypointSource == null) return image;
  const entrySegment = typeof image.segmentAt === 'function' ? image.segmentAt(0n) : null;
  const alignment = (image.arch === 'arm64' || image.arch === 'arm64e' || image.arch === 'arm64_32') ? 4n : image.arch === 'arm' ? 2n : 1n;
  if (entrySegment?.perms?.execute && 0n % alignment === 0n) {
    image.metadata.entrypointValid = true;
    const seed = functionSeed(0n, { source:'entrypoint', confidence:0.9 });
    image.functions = mergeFunctionSeeds([...(image.functions || []), seed], image);
  } else {
    image.metadata.entrypointValid = false;
    const warning = `Ignored ${image.metadata.entrypointSource || 'Mach-O'} entrypoint 0x0 outside executable/aligned mapping`;
    if (!image.warnings.includes(warning)) image.warnings.push(warning);
  }
  return image;
}

export function parseMachO(input, opts = {}) {
  return repairMachOZeroEntrypoint(parseMachOCore(input, opts));
}
