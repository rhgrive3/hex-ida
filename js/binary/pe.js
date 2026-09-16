import { ByteView } from './reader.js';
import { BinaryImage, functionSeed } from './model.js';
import { parseImports, parseExports, parseExceptionFunctions, parseBaseRelocations, parseCoffSymbols, parseDelayImports, parseTlsDirectory, parseLoadConfig, directory, peMachineName, createPEMetadataBudget, PE_SECTION_MAPPING_SOURCE, PE_LOW_ALIGNMENT_RAW_IDENTITY_SOURCE } from './pe-loader.js';

const IMAGE_DIRECTORY_ENTRY_EXPORT = 0;
const IMAGE_DIRECTORY_ENTRY_IMPORT = 1;
const IMAGE_DIRECTORY_ENTRY_EXCEPTION = 3;
const IMAGE_DIRECTORY_ENTRY_BASERELOC = 5;
const IMAGE_DIRECTORY_ENTRY_TLS = 9;
const IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG = 10;
const IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT = 13;
const WINDOWS_IMAGE_RAW_ALIGNMENT = 0x200;
const WINDOWS_IMAGE_PAGE_SIZE = 0x1000;
const WINDOWS_IMAGE_BASE_ALIGNMENT = 0x10000n;
const WINDOWS_IMAGE_MAX_SECTIONS = 96;

// Width is architectural authority only for machine values whose image class
// this parser understands. Keep UNKNOWN/unsupported machines format-neutral,
// rather than guessing from numeric ranges or IMAGE_FILE_32BIT_MACHINE.
const PE_MACHINE_BITS = new Map([
  [0x014c, 32], // IMAGE_FILE_MACHINE_I386
  [0x01c0, 32], // IMAGE_FILE_MACHINE_ARM
  [0x01c4, 32], // IMAGE_FILE_MACHINE_ARMNT
  [0x5032, 32], // IMAGE_FILE_MACHINE_RISCV32
  [0x8664, 64], // IMAGE_FILE_MACHINE_AMD64
  [0xaa64, 64], // IMAGE_FILE_MACHINE_ARM64
  [0xa641, 64], // IMAGE_FILE_MACHINE_ARM64EC
  [0xa64e, 64], // IMAGE_FILE_MACHINE_ARM64X
  [0x5064, 64], // IMAGE_FILE_MACHINE_RISCV64
]);

function validatePEMachineMagic(machine, bits) {
  const machineBits = PE_MACHINE_BITS.get(machine);
  if (machineBits != null && machineBits !== bits) {
    const format = bits === 64 ? 'PE32+' : 'PE32';
    throw new Error(`PE Machine 0x${machine.toString(16)} is incompatible with ${format}`);
  }
}

function windowsImageSectionRawMapping(pointerToRawData, { sectionAlignment } = {}) {
  if (pointerToRawData === 0) {
    return { effectiveFileOffset: 0, fileBacked: false, roundedDown: false };
  }
  // The Windows loader's 0x200 sector round-down only applies to images
  // mapped at the default page granularity. Low-alignment images
  // (SectionAlignment < 0x1000, e.g. pefile issue #465's resource-only PE
  // with SectionAlignment = FileAlignment = 0x10) are consumed with their
  // declared raw offsets: the loader does not reinterpret PointerToRawData,
  // and rounding it down would redirect the mapping into the MZ/header
  // bytes (#5539).
  if (Number.isSafeInteger(sectionAlignment) && sectionAlignment > 0 && sectionAlignment < WINDOWS_IMAGE_PAGE_SIZE) {
    return {
      effectiveFileOffset: pointerToRawData,
      fileBacked: true,
      roundedDown: false,
      policy: 'low-alignment-declared-raw-offset',
    };
  }
  const effectiveFileOffset = pointerToRawData - (pointerToRawData % WINDOWS_IMAGE_RAW_ALIGNMENT);
  return {
    effectiveFileOffset,
    fileBacked: true,
    roundedDown: effectiveFileOffset !== pointerToRawData,
  };
}

function isPELowAlignmentImage(sectionAlignment) {
  return Number.isSafeInteger(sectionAlignment) && sectionAlignment > 0 && sectionAlignment < WINDOWS_IMAGE_PAGE_SIZE;
}

function peSectionRawIdentityMismatch({ lowAlignment, fileBacked, effectiveFileOffset, virtualAddress }) {
  return lowAlignment && fileBacked && effectiveFileOffset !== virtualAddress;
}

function isPowerOfTwo(value) {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function validPEFileAlignment(fileAlignment, sectionAlignment) {
  if (!isPowerOfTwo(fileAlignment)) return false;
  if (sectionAlignment > 0 && sectionAlignment < WINDOWS_IMAGE_PAGE_SIZE) return fileAlignment === sectionAlignment;
  return fileAlignment >= 0x200 && fileAlignment <= 0x10000;
}

// Microsoft IMAGE_OPTIONAL_HEADER32/64: SectionAlignment must be at least
// FileAlignment, and when it is below the architecture page size the two must
// be equal. An Optional Header that breaks this contract is not a canonical
// image, so none of its section/entrypoint evidence may be promoted (#4118).
function validatePEImageAlignment(sectionAlignment, fileAlignment) {
  if (sectionAlignment <= 0) {
    throw new Error(`PE SectionAlignment 0x${(sectionAlignment >>> 0).toString(16)} must be positive to map a canonical image`);
  }
  if (fileAlignment <= 0) {
    throw new Error(`PE FileAlignment 0x${(fileAlignment >>> 0).toString(16)} must be positive to map a canonical image`);
  }
  if (sectionAlignment < fileAlignment) {
    throw new Error(`PE SectionAlignment 0x${sectionAlignment.toString(16)} is smaller than FileAlignment 0x${fileAlignment.toString(16)}`);
  }
  if (sectionAlignment < 0x1000 && sectionAlignment !== fileAlignment) {
    throw new Error(`PE SectionAlignment 0x${sectionAlignment.toString(16)} is below the 0x1000 page size, so FileAlignment must equal SectionAlignment (got 0x${fileAlignment.toString(16)})`);
  }
}

function windowsImageSectionRawSize(sizeOfRawData, fileAlignment, sectionAlignment) {
  const alignmentValid = validPEFileAlignment(fileAlignment, sectionAlignment);
  if (sizeOfRawData === 0 || !alignmentValid) {
    return { effectiveRawSize: sizeOfRawData, alignmentValid, roundedUp: false };
  }
  const effectiveRawSize = Math.ceil(sizeOfRawData / fileAlignment) * fileAlignment;
  return { effectiveRawSize, alignmentValid: true, roundedUp: effectiveRawSize !== sizeOfRawData };
}

function validatePESizeOfImage(sizeOfImage, sizeOfHeaders, sectionAlignment) {
  if (sizeOfImage < sizeOfHeaders) {
    throw new Error(`PE SizeOfImage 0x${sizeOfImage.toString(16)} is smaller than SizeOfHeaders 0x${sizeOfHeaders.toString(16)}`);
  }
  // SectionAlignment itself has independent validity rules (#4118). When it
  // is usable, however, SizeOfImage is a loader-level aligned image extent.
  if (sectionAlignment > 0 && sizeOfImage % sectionAlignment !== 0) {
    throw new Error(`PE SizeOfImage 0x${sizeOfImage.toString(16)} is not aligned to SectionAlignment 0x${sectionAlignment.toString(16)}`);
  }
}

function peImageRvaRangeFits(sizeOfImage, startRva, extent = 1n) {
  const limit = BigInt(sizeOfImage);
  const start = BigInt(startRva);
  const size = BigInt(extent);
  return start >= 0n && size >= 0n && start < limit && size <= limit - start;
}

// A loaded PE image occupies [ImageBase, ImageBase + SizeOfImage) inside the
// *target* address domain. Unbounded BigInt arithmetic otherwise invents a
// third address domain that no Windows loader can express (#8757).
function peLoadedAddressDomainLimit(bits) {
  return 1n << BigInt(bits === 64 ? 64 : 32);
}

function peImageAddressRangeInDomain(bits, address, extent = 1n) {
  const limit = peLoadedAddressDomainLimit(bits);
  const start = BigInt(address), size = BigInt(extent);
  return start >= 0n && size >= 0n && start <= limit - size;
}

// One checked RVA -> VA conversion for the whole PE parser. Returns null when
// the sum leaves the target address domain instead of silently extending it.
function peCanonicalVirtualAddress(bits, imageBase, rva) {
  if (typeof rva !== 'number' || !Number.isSafeInteger(rva) || rva < 0) return null;
  const address = BigInt(imageBase) + BigInt(rva);
  return peImageAddressRangeInDomain(bits, address) ? address : null;
}

function validatePELoadedAddressDomain(bits, imageBase, sizeOfImage) {
  if (peImageAddressRangeInDomain(bits, imageBase, BigInt(sizeOfImage))) return;
  throw new Error(`PE ImageBase 0x${BigInt(imageBase).toString(16)} + SizeOfImage 0x${s