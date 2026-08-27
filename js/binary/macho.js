import { parseMachO as parseMachOCore } from './macho-core.js';
import { functionSeed, mergeFunctionSeeds } from './model.js';
import { ByteView } from './reader.js';

const KNOWN_LOAD_COMMAND_MIN_SIZE = new Map([
  [0x80000028, 24], // LC_MAIN
  [0x26, 16],       // LC_FUNCTION_STARTS
  [0x80000034, 16], // LC_DYLD_CHAINED_FIXUPS
  [0x80000033, 16], // LC_DYLD_EXPORTS_TRIE
  [0x22, 48],       // LC_DYLD_INFO
  [0x80000022, 48], // LC_DYLD_INFO_ONLY
  [0x32, 24],       // LC_BUILD_VERSION
]);

function thinMachOKind(bytes) {
  const r = new ByteView(bytes);
  if (r.length < 4) return null;
  const a = r.u8(0), b = r.u8(1), c = r.u8(2), d = r.u8(3);
  if (a === 0xce && b === 0xfa && c === 0xed && d === 0xfe) return { bits:32, littleEndian:true };
  if (a === 0xcf && b === 0xfa && c === 0xed && d === 0xfe) return { bits:64, littleEndian:true };
  if (a === 0xfe && b === 0xed && c === 0xfa && d === 0xce) return { bits:32, littleEndian:false };
  if (a === 0xfe && b === 0xed && c === 0xfa && d === 0xcf) return { bits:64, littleEndian:false };
  return null;
}

function selectedThinBytes(input, image) {
  const bytes = new ByteView(input).bytes;
  const selected = image?.metadata?.fat?.selected;
  if (!selected) return bytes;
  const offset = Number(selected.offset), size = Number(selected.size);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > bytes.length || size > bytes.length - offset) return null;
  return bytes.subarray(offset, offset + size);
}

function validateKnownLoadCommandSizes(input, image) {
  const bytes = selectedThinBytes(input, image);
  if (!bytes) throw new Error('Mach-O selected slice is outside file');
  const kind = thinMachOKind(bytes);
  if (!kind) return;
  const r = new ByteView(bytes, { littleEndian:kind.littleEndian });
  const headerSize = kind.bits === 64 ? 32 : 28;
  if (r.length < headerSize) return;
  const ncmds = r.u32(16);
  const sizeofcmds = r.u32(20);
  if (headerSize + sizeofcmds > r.length) return;
  const commandEnd = headerSize + sizeofcmds;
  let p = headerSize;
  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > commandEnd) return;
    const cmd = r.u32(p), cmdsize = r.u32(p + 4);
    if (cmdsize < 8 || p + cmdsize > commandEnd) return;
    const minimum = KNOWN_LOAD_COMMAND_MIN_SIZE.get(cmd);
    if (minimum != null && cmdsize < minimum) {
      throw new Error(`invalid Mach-O load command 0x${cmd.toString(16)} size ${cmdsize}; expected at least ${minimum}`);
    }
    p += cmdsize;
  }
}

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
  const image = parseMachOCore(input, opts);
  validateKnownLoadCommandSizes(input, image);
  return repairMachOZeroEntrypoint(image);
}