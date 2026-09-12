import {
  parseMachO as parseMachOCore,
  DICE_KIND_DATA,
  DICE_KIND_JUMP_TABLE8,
  DICE_KIND_JUMP_TABLE16,
  DICE_KIND_JUMP_TABLE32,
  DICE_KIND_ABS_JUMP_TABLE32,
  DICE_KIND_NAMES,
} from './macho-core.js';
import { functionSeed, mergeFunctionSeeds } from './model.js';
import { ByteView } from './reader.js';
import { ensureMachOMetadataBudget, markMachOMetadataPartial } from './macho-budget.js';
import { applyMachOIndirectSymbols } from './macho-indirect-symbols.js';

export {
  DICE_KIND_DATA,
  DICE_KIND_JUMP_TABLE8,
  DICE_KIND_JUMP_TABLE16,
  DICE_KIND_JUMP_TABLE32,
  DICE_KIND_ABS_JUMP_TABLE32,
  DICE_KIND_NAMES,
};

const LC_ROUTINES = 0x11;
const LC_ROUTINES_64 = 0x1a;

const KNOWN_LOAD_COMMAND_MIN_SIZE = new Map([
  [0x80000028, 24], // LC_MAIN
  [0x26, 16],       // LC_FUNCTION_STARTS
  [0x29, 16],       // LC_DATA_IN_CODE
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

function machoInstructionUnit(arch) {
  if (arch === 'arm64' || arch === 'arm64e' || arch === 'arm64_32') return 4n;
  if (arch === 'arm') return 2n;
  return 1n;
}

function isContiguousFileBackedSpan(image, address, size) {
  let previous = null;
  for (let i = 0n; i < size; i++) {
    const offset = image.addressToOffset(address + i);
    if (offset == null || (previous != null && offset !== previous + 1n)) return false;
    previous = offset;
  }
  return true;
}

function firstNonZeroRoutinesReservedField(r, commandOffset, is64) {
  const firstReservedOffset = is64 ? 24 : 16;
  const fieldWidth = is64 ? 8 : 4;
  for (let i = 0; i < 6; i++) {
    const offset = commandOffset + firstReservedOffset + i * fieldWidth;
    const value = is64 ? r.u64(offset) : BigInt(r.u32(offset));
    if (value !== 0n) return i + 1;
  }
  return null;
}

function parseRoutinesCommands(input, image) {
  const bytes = selectedThinBytes(input, image);
  if (!bytes) throw new Error('Mach-O selected slice is outside file');
  const kind = thinMachOKind(bytes);
  if (!kind) return image;
  const r = new ByteView(bytes, { littleEndian:kind.littleEndian });
  const headerSize = kind.bits === 64 ? 32 : 28;
  if (r.length < headerSize) return image;
  const ncmds = r.u32(16);
  const sizeofcmds = r.u32(20);
  if (headerSize + sizeofcmds > r.length) return image;
  const commandEnd = headerSize + sizeofcmds;
  const budget = ensureMachOMetadataBudget(image);
  const instructionUnit = machoInstructionUnit(image.arch);
  const records = [];
  const newSeeds = [];
  let sawRoutines = false;
  let p = headerSize;

  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > commandEnd) break;
    const cmd = r.u32(p), cmdsize = r.u32(p + 4);
    if (cmdsize < 8 || p + cmdsize > commandEnd) break;
    const is32 = cmd === LC_ROUTINES && kind.bits === 32;
    const is64 = cmd === LC_ROUTINES_64 && kind.bits === 64;
    const isRoutinesCommand = cmd === LC_ROUTINES || cmd === LC_ROUTINES_64;
    if (isRoutinesCommand && !is32 && !is64) {
      sawRoutines = true;
      const command = cmd === LC_ROUTINES_64 ? 'LC_ROUTINES_64' : 'LC_ROUTINES';
      budget.partial(
        `load-command-0x${cmd.toString(16)}-parse-error`,
        `${command} is incompatible with a ${kind.bits}-bit Mach-O image`,
      );
      p += cmdsize;
      continue;
    }
    if (is32 || is64) {
      sawRoutines = true;
      const expected = is64 ? 72 : 40;
      const command = is64 ? 'LC_ROUTINES_64' : 'LC_ROUTINES';
      if (cmdsize !== expected) {
        budget.partial(
          `load-command-0x${cmd.toString(16)}-parse-error`,
          `load command 0x${cmd.toString(16)}: invalid ${command} size ${cmdsize}; expected exactly ${expected}`,
        );
        p += cmdsize;
        continue;
      }
      if (!budget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'routines-record')) break;
      const nonZeroReservedField = firstNonZeroRoutinesReservedField(r, p, is64);
      if (nonZeroReservedField != null) {
        budget.partial(
          `load-command-0x${cmd.toString(16)}-parse-error`,
          `${command} reserved${nonZeroReservedField} must be zero`,
        );
        p += cmdsize;
        continue;
      }
      const initAddress = is64 ? r.u64(p + 8) : BigInt(r.u32(p + 8));
      const initModule = is64 ? r.u64(p + 16) : BigInt(r.u32(p + 12));
      const record = {
        command, commandOffset:p, initAddress, initModule,
        validTarget:initAddress === 0n ? null : false,
        promoted:false, reason:null,
      };
      records.push(record);
      if (initAddress === 0n) { p += cmdsize; continue; }

      const mapping = image.resolveVirtualMapping(initAddress);
      if (!mapping) record.reason = 'unmapped';
      else if (!mapping.mapping?.perms?.execute) record.reason = 'non-executable';
      else if (instructionUnit > 1n && initAddress % instructionUnit !== 0n) record.reason = 'misaligned';
      else if (!isContiguousFileBackedSpan(image, initAddress, instructionUnit)) record.reason = 'not-file-backed';

      if (record.reason) {
        budget.partial(
          `routines:initializer-${record.reason}`,
          `${command} initializer 0x${initAddress.toString(16)} is ${record.reason.replaceAll('-', ' ')}`,
        );
        p += cmdsize;
        continue;
      }
      record.validTarget = true;
      if (!budget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'routines-function-output')) {
        record.reason = 'metadata-budget';
        break;
      }
      newSeeds.push(functionSeed(initAddress, {
        source:'routines', confidence:0.999, exactFunctionStart:true,
        functionStartEvidence:`Mach-O ${command} loader initializer in validated executable file-backed instruction span`,
        abiMetadata:{ command, initModule },
      }));
      record.promoted = true;
    }
    p += cmdsize;
  }

  if (sawRoutines && records.length) image.metadata.routines = records;
  if (newSeeds.length) image.functions = mergeFunctionSeeds([...(image.functions || []), ...newSeeds], image);
  image.metadata.machoMetadata = budget.snapshot();
  return image;
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
  if (p !== commandEnd) {
    markMachOMetadataPartial(image, 'load-command-count-size-mismatch');
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
  parseRoutinesCommands(input, image);
  const thin = selectedThinBytes(input, image);
  if (thin) applyMachOIndirectSymbols(thin, image, opts);
  return repairMachOZeroEntrypoint(image);
}
