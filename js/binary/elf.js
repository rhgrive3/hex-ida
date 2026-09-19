import { parseELF as parseELFCore } from './elf-core.js';
import { elfExactFunctionStartRejection, elfFunctionExtentRejection, executableELFRange } from './elf-mapping.js';
import { markELFMetadataPartial } from './elf-budget.js';
import { functionSeed, mergeFunctionSeeds } from './model.js';
import { ByteView } from './reader.js';
import { retainElfLoaderEntryExtents } from './elf-loader-entry-extent.js';

function executableOwnerForSymbol(image, symbol) {
  return executableELFRange(image, symbol.address, symbol.size || 0n, symbol.sectionIndex ?? null);
}

export function repairElfZeroAddressFunctionSeeds(image) {
  if (!image || !Array.isArray(image.symbols)) return image;
  // Production BinaryImage instances always carry a warnings array, but this
  // exported repair helper is also exercised with minimal sectionless images.
  // #8803 may now emit authority diagnostics from this path, so normalize the
  // diagnostic sink before calling the shared metadata-partial helper.
  if (!Array.isArray(image.warnings)) image.warnings = [];
  const zeroSeeds = [];
  for (const symbol of image.symbols) {
    if (symbol?.defined !== true || symbol.address !== 0n || !['function','indirect-function'].includes(symbol.kind)) continue;
    if (!executableOwnerForSymbol(image, symbol)) continue;
    // The VA-0 repair must not grant a stronger claim than the shared exact
    // function-start policy: the entrypoint validator already proved this address
    // is not decodable static code, so zero-fill-only starts stay metadata (#8803).
    const startRejection = elfExactFunctionStartRejection(image, 0n, { sectionIndex: symbol.sectionIndex ?? null });
    if (startRejection) {
      markELFMetadataPartial(image, 'function-authority:va0-repair',
        `Ignored ELF zero-address ${symbol.kind === 'indirect-function' ? 'STT_GNU_IFUNC resolver' : 'STT_FUNC'} ${symbol.name}: ${startRejection}`);
      continue;
    }
    const extentRejection = elfFunctionExtentRejection(image, 0n, symbol.size);
    if (extentRejection) markELFMetadataPartial(image, 'function-authority:va0-repair-extent',
      `ELF zero-address ${symbol.kind === 'indirect-function' ? 'STT_GNU_IFUNC resolver' : 'STT_FUNC'} ${symbol.name}: ${extentRejection}`);
    const ifunc = symbol.kind === 'indirect-function';
    zeroSeeds.push(functionSeed(0n, {
      size: extentRejection ? null : (symbol.size || null),
      name: ifunc ? `${symbol.name}$resolver` : symbol.name,
      source: ifunc ? 'ifunc-resolver' : 'symbol',
      confidence: 0.995,
      exactFunctionStart: true,
      functionStartEvidence: (ifunc
        ? 'ELF STT_GNU_IFUNC resolver with validated executable extent'
        : 'ELF STT_FUNC with validated executable extent')
        + (extentRejection ? '; published st_size is not file-backed and is not retained as extent authority' : ''),
      callingConvention: symbol.callingConvention || null,
      abiMetadata: symbol.riscvVariantCc ? { riscvVariantCc:true, stOther:symbol.stOther } : null,
    }));
  }
  if (zeroSeeds.length) image.functions = mergeFunctionSeeds([...(image.functions || []), ...zeroSeeds], image);
  return image;
}

function validateElfVersion(input) {
  const initial = new ByteView(input, { littleEndian:true });
  if (initial.length < 24 || initial.u8(0) !== 0x7f || initial.u8(1) !== 0x45 || initial.u8(2) !== 0x4c || initial.u8(3) !== 0x46) return;
  if (initial.u8(6) !== 1) throw new Error(`unsupported ELF identification version ${initial.u8(6)}`);
  const data = initial.u8(5);
  if (data !== 1 && data !== 2) return;
  const header = new ByteView(initial.bytes, { littleEndian:data === 1 });
  const headerVersion = header.u32(20);
  if (headerVersion !== 1) throw new Error(`unsupported ELF header version ${headerVersion}`);
}

export function parseELF(input, options = {}) {
  validateElfVersion(input);
  return retainElfLoaderEntryExtents(repairElfZeroAddressFunctionSeeds(parseELFCore(input, options)));
}
