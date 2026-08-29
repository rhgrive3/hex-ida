import { ByteView } from './reader.js';
import { BinaryImage, functionSeed } from './model.js';
import { parseChainedImports, parseChainedBindingSites, parseClassicBindings, parseExportTrie } from './macho-dyld.js';
import { createMachOMetadataBudget, ensureMachOMetadataBudget, markMachOMetadataPartial } from './macho-budget.js';

const LC_SEGMENT = 0x1;
const LC_SYMTAB = 0x2;
const LC_THREAD = 0x4;
const LC_UNIXTHREAD = 0x5;
const LC_DYSYMTAB = 0xb;
const LC_LOAD_DYLIB = 0xc;
const LC_ID_DYLIB = 0xd;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_LOAD_UPWARD_DYLIB = 0x80000023;
const LC_SEGMENT_64 = 0x19;
const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
const LC_FUNCTION_STARTS = 0x26;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_VERSION_MIN_IPHONEOS = 0x25;
const LC_MAIN = 0x80000028;
const LC_VERSION_MIN_TVOS = 0x2f;
const LC_VERSION_MIN_WATCHOS = 0x30;
const LC_BUILD_VERSION = 0x32;
const LC_DYLD_EXPORTS_TRIE = 0x80000033;
const LC_DYLD_CHAINED_FIXUPS = 0x80000034;
const ARM_THREAD_STATE64 = 6;
const ARM_THREAD_STATE64_COUNT = 68;
const ARM_THREAD_STATE64_PC_OFFSET = 256;

const DYLIB_COMMANDS = new Set([
  LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB,
  LC_LAZY_LOAD_DYLIB, LC_LOAD_UPWARD_DYLIB,
]);

export function parseMachO(input, opts = {}) {
  const bytes = new ByteView(input).bytes;
  const kind = machoKind(bytes);
  if (!kind) throw new Error('not a Mach-O file');
  if (kind.fat) {
    const selected = selectFatSlice(bytes, kind, opts.arch);
    if (!selected) throw new Error('Mach-O universal binary has no readable slice');
    const sub = bytes.subarray(Number(selected.offset), Number(selected.offset + selected.size));
    const image = parseThin(sub, { ...opts, containerOffset: selected.offset });
    image.metadata.fat = {
      slices: selected.all.map((s) => ({ arch: sliceArchName(s), cpu: s.cpu, subtype: s.subtype, offset: s.offset, size: s.size })),
      selected: { arch: sliceArchName(selected), cpu: selected.cpu, subtype: selected.subtype, offset: selected.offset, size: selected.size },
    };
    return image;
  }
  return parseThin(bytes, opts);
}

function parseThin(bytes, opts) {
  const kind = machoKind(bytes);
  if (!kind || kind.fat) throw new Error('not a thin Mach-O file');
  const r = new ByteView(bytes, { littleEndian: kind.littleEndian });
  const bits = kind.bits;
  const headerSize = bits === 64 ? 32 : 28;
  const cpu = r.i32(4);
  const subtype = r.i32(8);
  const filetype = r.u32(12);
  const ncmds = r.u32(16);
  const sizeofcmds = r.u32(20);
  const flags = r.u32(24);
  if (headerSize + sizeofcmds > r.length) throw new Error('Mach-O load commands exceed file');
  const commandEnd = headerSize + sizeofcmds;

  const arch = cpuArchName(cpu, subtype);
  const image = new BinaryImage(bytes, {
    format: 'macho', arch, bits,
    endian: kind.littleEndian ? 'little' : 'big',
    platform: 'apple', imageBase: 0n,
    fileOffset: opts.containerOffset || 0n,
    metadata: {
      cpu, subtype, cpuName: cpuName(cpu), subtypeBase: subtypeBase(subtype),
      subtypeName: arch === 'arm64e' ? 'arm64e' : String(subtypeBase(subtype)),
      filetype, flags, ncmds, sizeofcmds,
    },
  });
  const metadataBudget = ensureMachOMetadataBudget(image, createMachOMetadataBudget(image, { signal: opts.signal }));

  const commands = [];
  const segmentOrder = [];
  const symtabs = [];
  const linkeditData = {};
  const dyldInfos = [];
  let p = headerSize;
  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > commandEnd) { markMachOMetadataPartial(image, 'load-command-truncated'); image.warnings.push(`truncated load command ${i}`); break; }
    const cmd = r.u32(p);
    const cmdsize = r.u32(p + 4);
    if (cmdsize < 8 || p + cmdsize > commandEnd) {
      markMachOMetadataPartial(image, 'load-command-invalid-size');
      image.warnings.push(`invalid load command ${i} size ${cmdsize}`);
      break;
    }
    if (!metadataBudget.take({ inputBytes:cmdsize, records:1, objects:1, operations:1, estimatedHeapBytes:64 }, 'load-command')) break;
    commands.push({ cmd, offset: p, size: cmdsize });
    try {
      if (cmd === LC_SEGMENT_64 && bits === 64) parseSegment64(r, p, cmdsize, image, segmentOrder);
      else if (cmd === LC_SEGMENT && bits === 32) parseSegment32(r, p, cmdsize, image, segmentOrder);
      else if (cmd === LC_SYMTAB) {
        if (cmdsize < 24) throw new Error(`invalid LC_SYMTAB size ${cmdsize}`);
        symtabs.push({ symoff: r.u32(p + 8), nsyms: r.u32(p + 12), stroff: r.u32(p + 16), strsize: r.u32(p + 20) });
      }
      else if (DYLIB_COMMANDS.has(cmd) || cmd === LC_ID_DYLIB) {
        if (cmdsize < 24) throw new Error(`invalid dylib command size ${cmdsize}`);
        parseDylib(r, p, cmdsize, image, cmd === LC_ID_DYLIB);
      }
      else if (cmd === LC_MAIN && cmdsize >= 24) linkeditData.main = { entryoff: r.u64(p + 8), stacksize: r.u64(p + 16) };
      else if ((cmd === LC_THREAD || cmd === LC_UNIXTHREAD) && cmdsize >= 16) {
        const pc = parseThreadEntrypoint(r, p, cmdsize, cpu, bits);
        if (pc != null && linkeditData.threadEntry == null) linkeditData.threadEntry = pc;
      }
      else if (cmd === LC_VERSION_MIN_MACOSX || cmd === LC_VERSION_MIN_IPHONEOS || cmd === LC_VERSION_MIN_TVOS || cmd === LC_VERSION_MIN_WATCHOS) {
        if (cmdsize < 16) throw new Error(`invalid LC_VERSION_MIN size ${cmdsize}`);
        parseLegacyVersionMin(r, p, cmd, image);
      }
      else if (cmd === LC_FUNCTION_STARTS && cmdsize >= 16) linkeditData.functionStarts = dataCommand(r, p);
      else if (cmd === LC_DYLD_CHAINED_FIXUPS && cmdsize >= 16) linkeditData.chainedFixups = dataCommand(r, p);
      else if (cmd === LC_DYLD_EXPORTS_TRIE && cmdsize >= 16) linkeditData.exportsTrie = dataCommand(r, p);
      else if ((cmd === LC_DYLD_INFO || cmd === LC_DYLD_INFO_ONLY) && cmdsize >= 48) dyldInfos.push(parseDyldInfo(r, p));
      else if (cmd === LC_BUILD_VERSION && cmdsize >= 24) parseBuildVersion(r, p, image);
    } catch (e) {
      if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
      markMachOMetadataPartial(image, `load-command-0x${cmd.toString(16)}-parse-error`);
      image.warnings.push(`load command 0x${cmd.toString(16)}: ${e.message}`);
    }
    p += cmdsize;
  }

  image.metadata.loadCommands = commands.length;
  image.metadata.segmentOrder = segmentOrder.map((s) => s.name);
  const text = image.segments.find((s) => s.name === '__TEXT') || image.segments.find((s) => s.perms.execute) || image.segments[0];
  image.imageBase = text ? text.address : 0n;

  if (linkeditData.main) {
    image.entrypoint = image.offsetToAddress(linkeditData.main.entryoff);
    image.metadata.entrypointSource = 'LC_MAIN';
  } else if (linkeditData.threadEntry != null) {
    image.entrypoint = linkeditData.threadEntry;
    image.metadata.entrypointSource = 'LC_UNIXTHREAD';
  }
  if (image.entrypoint != null && image.entrypoint !== 0n) {
    const entrySegment = image.segmentAt(image.entrypoint);
    const alignment = (arch === 'arm64' || arch === 'arm64e' || arch === 'arm64_32') ? 4n : arch === 'arm' ? 2n : 1n;
    if (entrySegment?.perms?.execute && image.entrypoint % alignment === 0n) {
      image.metadata.entrypointValid = true;
      image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));
    } else {
      image.metadata.entrypointValid = false;
      image.warnings.push(`Ignored ${image.metadata.entrypointSource || 'Mach-O'} entrypoint 0x${image.entrypoint.toString(16)} outside executable/aligned mapping`);
    }
  }

  for (const st of symtabs) parseSymbolTable(r, st, image, bits, metadataBudget);
  const hadFunctionStarts = !!linkeditData.functionStarts;
  if (linkeditData.functionStarts) parseFunctionStarts(r, linkeditData.functionStarts, image, metadataBudget);
  parseCompactUnwind(r, image, metadataBudget);
  let chainedImports = null;
  if (linkeditData.chainedFixups) chainedImports = parseChainedImports(r, linkeditData.chainedFixups, image, metadataBudget);
  if (linkeditData.chainedFixups && chainedImports) parseChainedBindingSites(r, linkeditData.chainedFixups, image, chainedImports, segmentOrder, metadataBudget);
  for (const info of dyldInfos) {
    parseClassicBindings(r, info.bind, image, segmentOrder, 'bind', metadataBudget);
    parseClassicBindings(r, info.weakBind, image, segmentOrder, 'weak-bind', metadataBudget);
    parseClassicBindings(r, info.lazyBind, image, segmentOrder, 'lazy-bind', metadataBudget);
    if (!linkeditData.exportsTrie && info.export.size) parseExportTrie(r, info.export, image, metadataBudget);
  }
  if (linkeditData.exportsTrie) parseExportTrie(r, linkeditData.exportsTrie, image, metadataBudget);

  const namesByAddr = new Map();
  const nameIndexEntries = image.symbols.length + image.exports.length;
  if (metadataBudget.take({ objects:nameIndexEntries, operations:nameIndexEntries, estimatedHeapBytes:nameIndexEntries*48 }, 'name-address-index')) {
    for (const sym of image.symbols) if (sym.defined && sym.address != null) namesByAddr.set(sym.address.toString(), sym.name);
    for (const ex of image.exports) if (ex.address != null) namesByAddr.set(ex.address.toString(), ex.name);
  }
  if (hadFunctionStarts) {
    for (const f of image.functions) if (!f.name) f.name = namesByAddr.get(f.address.toString()) || null;
    const provenStarts = new Set(image.functions.filter((f) => f.source !== 'export').map((f) => f.address.toString()));
    image.functions = image.functions.filter((f) => f.source !== 'export' || provenStarts.has(f.address.toString()));
  } else {
    for (const sym of image.symbols) {
      if (!sym.defined || sym.address == null) continue;
      const sec = image.sectionAt(sym.address);
      if (sec && sec.perms.execute && sym.name !== '__mh_execute_header' && metadataBudget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'symbol-function-fallback')) image.functions.push(functionSeed(sym.address, { name: sym.name, source: 'symbol', confidence: 0.9 }));
    }
  }

  image.metadata.machoMetadata = metadataBudget.snapshot();
  return image.finalize();
}

function validateMappedRange(label, address, size, fileOffset, fileSize, image) {
  const inputSize = BigInt(image.bytes?.length ?? image.fileSize ?? 0);
  if (fileSize > size) throw new Error(`${label} file size exceeds VM size`);
  if (fileOffset > inputSize || fileSize > inputSize - fileOffset) throw new Error(`${label} file range exceeds input`);
  return { vmEnd: address + size, fileEnd: fileOffset + fileSize };
}

function validateSectionRange(label, saddr, ssize, fileOffset, fileSize, seg, image, zeroFill) {
  if (saddr < seg.address || saddr > seg.address + seg.size || ssize > seg.address + seg.size - saddr) throw new Error(`${label} VM range escapes parent segment`);
  if (!zeroFill) {
    if (fileOffset < seg.fileOffset || fileOffset > seg.fileOffset + seg.fileSize || fileSize > seg.fileOffset + seg.fileSize - fileOffset) throw new Error(`${label} file range escapes parent segment`);
    validateMappedRange(label, saddr, ssize, fileOffset, fileSize, image);
  }
}

function parseSegment64(r, p, cmdsize, image, order) {
  if (cmdsize < 72) throw new Error(`invalid LC_SEGMENT_64 size ${cmdsize}`);
  const name = r.ascii(p + 8, 16);
  const address = r.u64(p + 24);
  const size = r.u64(p + 32);
  const fileOffset = r.u64(p + 40);
  const fileSize = r.u64(p + 48);
  const initprot = r.i32(p + 60);
  const nsects = r.u32(p + 64);
  if (nsects > Math.floor((cmdsize - 72) / 80)) throw new Error(`invalid section count ${nsects}`);
  const flags = r.u32(p + 68);
  validateMappedRange(`segment ${name}`, address, size, fileOffset, fileSize, image);
  const seg = image.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: 'LC_SEGMENT_64' });
  order.push(seg);
  let q = p + 72;
  for (let i = 0; i < nsects; i++, q += 80) {
    r.check(q, 80);
    const sectname = r.ascii(q, 16);
    const segname = r.ascii(q + 16, 16);
    const saddr = r.u64(q + 32);
    const ssize = r.u64(q + 40);
    const offset = r.u32(q + 48);
    const sflags = r.u32(q + 64);
    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;
    const sectionFileOffset = BigInt(offset), sectionFileSize = zeroFill ? 0n : ssize;
    validateSectionRange(`section ${sectname}`, saddr, ssize, sectionFileOffset, sectionFileSize, seg, image, zeroFill);
    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: sectionFileOffset, fileSize: sectionFileSize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });
  }
}

function parseSegment32(r, p, cmdsize, image, order) {
  if (cmdsize < 56) throw new Error(`invalid LC_SEGMENT size ${cmdsize}`);
  const name = r.ascii(p + 8, 16);
  const address = BigInt(r.u32(p + 24));
  const size = BigInt(r.u32(p + 28));
  const fileOffset = BigInt(r.u32(p + 32));
  const fileSize = BigInt(r.u32(p + 36));
  const initprot = r.i32(p + 44);
  const nsects = r.u32(p + 48);
  if (nsects > Math.floor((cmdsize - 56) / 68)) throw new Error(`invalid section count ${nsects}`);
  const flags = r.u32(p + 52);
  validateMappedRange(`segment ${name}`, address, size, fileOffset, fileSize, image);
  const seg = image.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: 'LC_SEGMENT' });
  order.push(seg);
  let q = p + 56;
  for (let i = 0; i < nsects; i++, q += 68) {
    r.check(q, 68);
    const sectname = r.ascii(q, 16);
    const segname = r.ascii(q + 16, 16);
    const saddr = BigInt(r.u32(q + 32));
    const ssize = BigInt(r.u32(q + 36));
    const offset = r.u32(q + 40);
    const sflags = r.u32(q + 56);
    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;
    const sectionFileOffset = BigInt(offset), sectionFileSize = zeroFill ? 0n : ssize;
    validateSectionRange(`section ${sectname}`, saddr, ssize, sectionFileOffset, sectionFileSize, seg, image, zeroFill);
    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: sectionFileOffset, fileSize: sectionFileSize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });
  }
}

function parseDylib(r, p, cmdsize, image, isId) {
  const nameoff = r.u32(p + 8);
  if (nameoff < 24 || nameoff >= cmdsize) return;
  const span = r.bytes.subarray(p + nameoff, p + cmdsize);
  if (span.indexOf(0) === -1) return;
  const name = r.cstring(p + nameoff, cmdsize - nameoff);
  if (isId) image.metadata.installName = name;
  else if (name) image.libraries.push(name);
}

function parseBuildVersion(r, p, image) {
  const platform = r.u32(p + 8);
  const minos = r.u32(p + 12);
  const sdk = r.u32(p + 16);
  image.metadata.buildVersion = { platform, platformName: platformName(platform), minos: version32(minos), sdk: version32(sdk), source: 'LC_BUILD_VERSION' };
  image.platform = platformName(platform) || image.platform;
}

function parseLegacyVersionMin(r, p, cmd, image) {
  if (image.metadata.buildVersion?.source === 'LC_BUILD_VERSION') return;
  const platform = cmd === LC_VERSION_MIN_MACOSX ? 1 : cmd === LC_VERSION_MIN_IPHONEOS ? 2 : cmd === LC_VERSION_MIN_TVOS ? 3 : 4;
  image.metadata.buildVersion = { platform, platformName: platformName(platform), minos: version32(r.u32(p + 8)), sdk: version32(r.u32(p + 12)), source: 'LC_VERSION_MIN' };
  image.platform = platformName(platform) || image.platform;
}

function parseThreadEntrypoint(r, p, cmdsize, cpu, bits) {
  const end = p + cmdsize;
  let q = p + 8;
  while (q + 8 <= end) {
    const flavor = r.u32(q);
    const count = r.u32(q + 4);
    const state = q + 8;
    const stateBytes = count * 4;
    if (!Number.isSafeInteger(stateBytes) || stateBytes < 0 || state + stateBytes > end) return null;
    const arch = cpuName(cpu);
    if (arch === 'arm64' && flavor === ARM_THREAD_STATE64 && count === ARM_THREAD_STATE64_COUNT) return r.u64(state + ARM_THREAD_STATE64_PC_OFFSET);
    if (arch === 'x86_64' && flavor === 4 && stateBytes >= 136) return r.u64(state + 128);
    if (arch === 'arm' && bits === 32 && flavor === 1 && stateBytes >= 64) return BigInt(r.u32(state + 60));
    q = state + stateBytes;
  }
  return null;
}

function parseDyldInfo(r, p) {
  return {
    rebase: { offset: r.u32(p + 8), size: r.u32(p + 12) },
    bind: { offset: r.u32(p + 16), size: r.u32(p + 20) },
    weakBind: { offset: r.u32(p + 24), size: r.u32(p + 28) },
    lazyBind: { offset: r.u32(p + 32), size: r.u32(p + 36) },
    export: { offset: r.u32(p + 40), size: r.u32(p + 44) },
  };
}

function parseSymbolTable(r, st, image, bits, sharedBudget = null) {
  const budget = ensureMachOMetadataBudget(image, sharedBudget);
  const ent = bits === 64 ? 16 : 12;
  if (st.symoff + st.nsyms * ent > r.length || st.stroff + st.strsize > r.length) {
    markMachOMetadataPartial(image, 'symbol-table-truncated');
    image.warnings.push('Mach-O symbol table is truncated'); return;
  }
  for (let i = 0; i < st.nsyms; i++) {
    if (!budget.take({ inputBytes:ent, records:1,objects:1,operations:2,estimatedHeapBytes:224 }, 'symbol-record')) break;
    const p = st.symoff + i * ent;
    const strx = r.u32(p);
    const type = r.u8(p + 4);
    const sect = r.u8(p + 5);
    const desc = r.u16(p + 6);
    const value = bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 8));
    if (type & 0xe0) continue;
    let name = '';
    if (strx < st.strsize) {
      const span = r.bytes.subarray(st.stroff + strx, st.stroff + st.strsize);
      if (span.indexOf(0) !== -1) {
        name = r.cstring(st.stroff + strx, st.strsize - strx);
      }
    }
    if (!name) continue;
    if (!budget.take({ stringBytes:name.length*2, estimatedHeapBytes:name.length*2+32 }, 'symbol-name')) break;
    const ntype = type & 0x0e;
    const external = !!(type & 1);
    const isUndefinedType = ntype === 0;
    // For N_UNDF with non-zero n_value, Mach-O defines a tentative/common
    // symbol: n_value is the requested byte size, never a VM address.
    const commonSymbol = isUndefinedType && value !== 0n;
    const undefinedSymbol = isUndefinedType && !commonSymbol;
    const sym = {
      name,
      address: isUndefinedType ? 0n : value,
      size: commonSymbol ? value : null,
      common: commonSymbol,
      kind: ntype === 0x0e ? 'section' : commonSymbol ? 'common' : undefinedSymbol ? 'undefined' : 'other',
      binding: external ? 'global' : 'local',
      defined: !isUndefinedType,
      sectionIndex: sect, desc, source: 'LC_SYMTAB',
    };
    image.symbols.push(sym);
    if (undefinedSymbol && external) {
      const ordinal = (desc >>> 8) & 0xff;
      image.imports.push({ name, library: dylibForOrdinal(image, ordinal), ordinal, weak: !!(desc & 0x40), source: 'symbol-table', sites: [] });
    } else if (!isUndefinedType && external && value !== 0n) {
      image.exports.push({ name, address: value, kind: 'symbol', source: 'symbol-table' });
    }
    void sect;
  }
}

function parseFunctionStarts(r, dc, image, sharedBudget = null) {
  const budget = ensureMachOMetadataBudget(image, sharedBudget);
  if (!dc.size || dc.offset > r.length || dc.size > r.length - dc.offset) return;
  let p = dc.offset;
  const end = dc.offset + dc.size;
  let addr = image.imageBase;
  const maxAddress = image.bits === 32 ? 0xffffffffn : 0xffffffffffffffffn;
  const alignment = (image.arch === 'arm64' || image.arch === 'arm64e' || image.arch === 'arm64_32') ? 4n : image.arch === 'arm' ? 2n : 1n;
  const status = image.metadata.functionStarts = { complete: true, recovered: 0, partialReason: null };
  let terminated = false;
  while (p < end) {
    if (!budget.take({ records:1, operations:1, estimatedHeapBytes:32 }, 'function-start-record')) { status.complete=false; status.partialReason='metadata-budget'; break; }
    let x;
    try { x = r.uleb(p, 10, end); }
    catch (e) {
      if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
      status.complete = false; status.partialReason = 'truncated-leb';
      image.warnings.push(`LC_FUNCTION_STARTS: ${e.message}`); break;
    }
    p = x.next;
    if (x.value === 0n) { terminated = true; break; }
    if (addr < 0n || addr > maxAddress || x.value > maxAddress - addr) {
      status.complete = false; status.partialReason = 'address-overflow';
      image.warnings.push('LC_FUNCTION_STARTS address overflow'); break;
    }
    const next = addr + x.value;
    addr = next;
    const seg = image.segmentAt(addr);
    if (!seg || !seg.perms.execute || (alignment > 1n && addr % alignment !== 0n)) {
      status.complete = false; status.partialReason = 'invalid-entry';
      image.warnings.push(`invalid LC_FUNCTION_STARTS entry 0x${addr.toString(16)}`);
      break;
    }
    if (!budget.take({ inputBytes:x.bytes, objects:1, estimatedHeapBytes:128 }, 'function-start-output')) { status.complete=false; status.partialReason='metadata-budget'; break; }
    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
    status.recovered++;
  }
  if (!terminated && p >= end && status.complete) {
    status.complete = false; status.partialReason = 'missing-terminator';
    image.warnings.push('LC_FUNCTION_STARTS stream is missing its zero terminator');
  }
}

function dataCommand(r, p) { return { offset: r.u32(p + 8), size: r.u32(p + 12) }; }
function vmPerms(v) { return { read: !!(v & 1), write: !!(v & 2), execute: !!(v & 4) }; }
function dylibForOrdinal(image, ordinal) {
  if (ordinal === 0) return null;
  if (ordinal === -1 || ordinal === 0xff) return '<main-executable>';
  if (ordinal === -2 || ordinal === 0xfe) return '<flat-lookup>';
  if (ordinal === -3 || ordinal === 0xfd) return '<weak-lookup>';
  return ordinal > 0 ? image.libraries[ordinal - 1] || null : null;
}
function cpuName(cpu) {
  const u = cpu >>> 0;
  return ({ 7: 'x86', 12: 'arm', 18: 'ppc', 0x01000007: 'x86_64', 0x0100000c: 'arm64', 0x0200000c: 'arm64_32' })[u] || `cpu-${u}`;
}
function subtypeBase(subtype) { return (subtype >>> 0) & 0x00ffffff; }
function cpuArchName(cpu, subtype) { return cpuName(cpu) === 'arm64' && subtypeBase(subtype) === 2 ? 'arm64e' : cpuName(cpu); }
function sliceArchName(slice) { return cpuArchName(slice.cpu, slice.subtype); }
function platformName(p) { return ({ 1: 'macOS', 2: 'iOS', 3: 'tvOS', 4: 'watchOS', 6: 'macCatalyst', 7: 'iOS-simulator', 8: 'tvOS-simulator', 9: 'watchOS-simulator', 10: 'driverKit', 11: 'visionOS', 12: 'visionOS-simulator' })[p] || `apple-platform-${p}`; }
function version32(v) { return `${(v >>> 16) & 0xffff}.${(v >>> 8) & 0xff}.${v & 0xff}`; }

function machoKind(bytes) {
  if (bytes.length < 4) return null;
  const r = new ByteView(bytes);
  const s = [r.u8(0), r.u8(1), r.u8(2), r.u8(3)].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (s === 'cefaedfe') return { fat: false, bits: 32, littleEndian: true };
  if (s === 'cffaedfe') return { fat: false, bits: 64, littleEndian: true };
  if (s === 'feedface') return { fat: false, bits: 32, littleEndian: false };
  if (s === 'feedfacf') return { fat: false, bits: 64, littleEndian: false };
  if (s === 'cafebabe') return { fat: true, bits: 32, littleEndian: false };
  if (s === 'cafebabf') return { fat: true, bits: 64, littleEndian: false };
  if (s === 'bebafeca') return { fat: true, bits: 32, littleEndian: true };
  if (s === 'bfbafeca') return { fat: true, bits: 64, littleEndian: true };
  return null;
}

function selectFatSlice(bytes, kind, preferredArch) {
  const r = new ByteView(bytes, { littleEndian: kind.littleEndian });
  const n = r.u32(4);
  if (n > 128) throw new Error(`unreasonable Mach-O slice count ${n}`);
  const all = [];
  let p = 8;
  for (let i = 0; i < n; i++) {
    if (kind.bits === 64) {
      const cpu = r.i32(p), subtype = r.i32(p + 4), offset = r.u64(p + 8), size = r.u64(p + 16);
      all.push({ cpu, subtype, offset, size }); p += 32;
    } else {
      const cpu = r.i32(p), subtype = r.i32(p + 4), offset = BigInt(r.u32(p + 8)), size = BigInt(r.u32(p + 12));
      all.push({ cpu, subtype, offset, size }); p += 20;
    }
  }
  const valid = all.filter((s) => s.offset >= 0n && s.size > 0n && s.offset + s.size <= BigInt(bytes.length));
  const want = preferredArch ? valid.find((s) => sliceArchName(s) === preferredArch) : null;
  if (preferredArch && !want) throw new Error(`requested Mach-O architecture ${preferredArch} is not present in the universal binary`);
  const chosen = want || valid.find((s) => sliceArchName(s) === 'arm64e') || valid.find((s) => sliceArchName(s) === 'arm64') || valid.find((s) => sliceArchName(s) === 'x86_64') || valid[0];
  return chosen ? { ...chosen, all } : null;
}

export function parseCompactUnwind(r, image, metadataBudget = null) {
  const sec = image.sections.find((s) => s.name === '__unwind_info' || s.name === '__TEXT,__unwind_info');
  if (!sec) return;

  const budget = ensureMachOMetadataBudget(image, metadataBudget);
  const status = image.metadata.compactUnwind = {
    present: true,
    complete: true,
    recovered: 0,
    invalidEntries: 0,
    partialReason: null,
  };
  const fail = (reason, warning = null, invalidEntry = false) => {
    status.complete = false;
    if (status.partialReason == null) status.partialReason = reason;
    if (invalidEntry) status.invalidEntries++;
    markMachOMetadataPartial(image, `compact-unwind:${reason}`);
    if (warning && !budget.signal?.aborted) budget.warn(`compact unwind: ${warning}`);
    return false;
  };
  const take = (cost, reason) => {
    if (budget.take(cost, `compact-unwind-${reason}`)) return true;
    fail('metadata-budget');
    return false;
  };
  const notFunctionStartMask = 0x80000000;

  if (sec.fileOffset == null || sec.fileSize == null || sec.fileSize < 28n) {
    fail('section-truncated', 'section is too small for the compact-unwind header');
    return;
  }
  const fileOff = Number(sec.fileOffset);
  const fileSize = Number(sec.fileSize);
  if (!Number.isSafeInteger(fileOff) || !Number.isSafeInteger(fileSize)
      || fileOff < 0 || fileSize < 28 || fileOff > r.length || fileSize > r.length - fileOff) {
    fail('section-range-invalid', 'section file range is outside the input');
    return;
  }
  if (!take({ inputBytes:28, records:1, operations:1, estimatedHeapBytes:64 }, 'header')) return;

  const version = r.u32(fileOff);
  if (version !== 1) {
    fail('unsupported-version', `unsupported version ${version}`);
    return;
  }
  const commonOff = r.u32(fileOff + 4);
  const commonCount = r.u32(fileOff + 8);
  const personalityOff = r.u32(fileOff + 12);
  const personalityCount = r.u32(fileOff + 16);
  const indexOff = r.u32(fileOff + 20);
  const indexCount = r.u32(fileOff + 24);
  const arrayFits = (offset, count, stride) => {
    if (!count) return offset === 0 || offset <= fileSize;
    const bytes = count * stride;
    return Number.isSafeInteger(bytes) && offset >= 28 && offset <= fileSize && bytes <= fileSize - offset;
  };
  if (!arrayFits(commonOff, commonCount, 4)) {
    fail('common-encodings-range-invalid', 'common encoding array escapes the section');
    return;
  }
  if (!arrayFits(personalityOff, personalityCount, 4)) {
    fail('personality-range-invalid', 'personality array escapes the section');
    return;
  }
  if (indexCount < 2) {
    fail('index-missing-sentinel', 'first-level index requires at least one page plus a sentinel');
    return;
  }
  const indexBytes = indexCount * 12;
  if (!Number.isSafeInteger(indexBytes) || indexOff < 28 || indexOff > fileSize || indexBytes > fileSize - indexOff) {
    fail('index-range-invalid', 'first-level index escapes the section');
    return;
  }
  const indexEnd = indexOff + indexBytes;
  const ancillaryBytes = commonCount * 4 + personalityCount * 4;
  if (!take({ inputBytes:indexBytes + ancillaryBytes, records:indexCount, operations:indexCount, estimatedHeapBytes:indexCount*40 }, 'index')) return;

  const indexes = [];
  const pageOffsets = new Set();
  for (let i = 0; i < indexCount; i++) {
    const e = fileOff + indexOff + i * 12;
    const functionOffset = r.u32(e);
    const pageOff = r.u32(e + 4);
    const lsdaOff = r.u32(e + 8);
    if (i > 0 && functionOffset <= indexes[i - 1].functionOffset) {
      fail('index-order-invalid', 'first-level function offsets must be strictly increasing');
      return;
    }
    if (lsdaOff > fileSize) {
      fail('lsda-range-invalid', 'LSDA index offset escapes the section');
      return;
    }
    const sentinel = i === indexCount - 1;
    if (sentinel) {
      if (pageOff !== 0) {
        fail('sentinel-page-invalid', 'sentinel must not own a second-level page');
        return;
      }
    } else {
      if (!pageOff || pageOff < indexEnd || pageOff > fileSize - 8) {
        fail('page-range-invalid', `page ${i} header escapes or overlaps the first-level index`);
        return;
      }
      if (pageOffsets.has(pageOff)) {
        fail('page-offset-duplicate', `page ${i} reuses a second-level page offset`);
        return;
      }
      pageOffsets.add(pageOff);
    }
    indexes.push({ functionOffset, pageOff, lsdaOff });
  }

  const physicalPageOffsets = [...pageOffsets].sort((a, b) => a - b);
  const pageEndByOffset = new Map();
  for (let i = 0; i < physicalPageOffsets.length; i++) {
    const pageOff = physicalPageOffsets[i];
    const nextPhysical = physicalPageOffsets[i + 1] ?? fileSize;
    pageEndByOffset.set(pageOff, Math.min(fileSize, pageOff + 4096, nextPhysical));
  }

  const candidateRanges = [];
  for (let i = 0; i < indexCount - 1; i++) {
    const lower = indexes[i].functionOffset;
    const upper = indexes[i + 1].functionOffset;
    const pageOff = indexes[i].pageOff;
    const pageEnd = pageEndByOffset.get(pageOff) ?? pageOff;
    const pageSpan = pageEnd - pageOff;
    if (pageSpan < 8 || !take({ inputBytes:8, records:1, operations:1, estimatedHeapBytes:32 }, 'page-header')) return;

    const pageAbs = fileOff + pageOff;
    const kind = r.u32(pageAbs);
    const entries = [];
    if (kind === 2) {
      const entryOff = r.u16(pageAbs + 4);
      const count = r.u16(pageAbs + 6);
      const entryBytes = count * 8;
      if (!count || entryOff < 8 || !Number.isSafeInteger(entryBytes) || entryOff > pageSpan || entryBytes > pageSpan - entryOff) {
        fail('regular-page-range-invalid', `regular page ${i} entry array escapes its page`);
        return;
      }
      if (!take({ inputBytes:entryBytes, records:count, operations:count, estimatedHeapBytes:count*24 }, 'regular-entry')) return;
      for (let k = 0; k < count; k++) {
        const at = pageAbs + entryOff + k * 8;
        entries.push({ functionOffset:r.u32(at), encoding:r.u32(at + 4) });
      }
    } else if (kind === 3) {
      if (pageSpan < 12) {
        fail('compressed-page-header-truncated', `compressed page ${i} header is truncated`);
        return;
      }
      const entryOff = r.u16(pageAbs + 4);
      const count = r.u16(pageAbs + 6);
      const encodingsOff = r.u16(pageAbs + 8);
      const encodingsCount = r.u16(pageAbs + 10);
      const entryBytes = count * 4;
      const encodingBytes = encodingsCount * 4;
      if (!count || entryOff < 12 || !Number.isSafeInteger(entryBytes) || entryOff > pageSpan || entryBytes > pageSpan - entryOff) {
        fail('compressed-page-range-invalid', `compressed page ${i} entry array escapes its page`);
        return;
      }
      if (encodingsCount && (encodingsOff < 12 || encodingsOff > pageSpan || encodingBytes > pageSpan - encodingsOff)) {
        fail('compressed-encodings-range-invalid', `compressed page ${i} encoding array escapes its page`);
        return;
      }
      if (encodingsCount && encodingsOff < entryOff + entryBytes) {
        fail('compressed-page-layout-invalid', `compressed page ${i} encoding array overlaps its entry array`);
        return;
      }
      if (!take({ inputBytes:entryBytes + encodingBytes, records:count, operations:count, estimatedHeapBytes:count*24 }, 'compressed-entry')) return;
      const encodingDomain = commonCount + encodingsCount;
      for (let k = 0; k < count; k++) {
        const entry = r.u32(pageAbs + entryOff + k * 4);
        const encodingIndex = entry >>> 24;
        if (encodingIndex >= encodingDomain) {
          fail('compressed-encoding-index-invalid', `compressed page ${i} uses encoding index ${encodingIndex} outside ${encodingDomain}`, true);
          return;
        }
        const encoding = encodingIndex < commonCount
          ? r.u32(fileOff + commonOff + encodingIndex * 4)
          : r.u32(pageAbs + encodingsOff + (encodingIndex - commonCount) * 4);
        entries.push({ functionOffset:lower + (entry & 0x00ffffff), encoding });
      }
    } else {
      fail('page-kind-unsupported', `second-level page ${i} has unsupported kind ${kind}`);
      return;
    }

    if (entries[0].functionOffset !== lower) {
      fail('page-first-entry-mismatch', `page ${i} first function offset does not match its first-level owner`, true);
      return;
    }
    for (let k = 0; k < entries.length; k++) {
      const { functionOffset, encoding } = entries[k];
      if (functionOffset < lower || functionOffset >= upper) {
        fail('entry-out-of-range', `function offset 0x${functionOffset.toString(16)} escapes [0x${lower.toString(16)},0x${upper.toString(16)})`, true);
        return;
      }
      if (k > 0 && functionOffset <= entries[k - 1].functionOffset) {
        fail('entry-order-invalid', `page ${i} function offsets must be strictly increasing`, true);
        return;
      }
      const endOffset = entries[k + 1]?.functionOffset ?? upper;
      if (endOffset <= functionOffset) {
        fail('entry-extent-invalid', `page ${i} produced a non-positive function extent`, true);
        return;
      }
      candidateRanges.push({ startOffset:functionOffset, endOffset, encoding });
    }
  }

  const textSeg = image.segments.find((s) => s.name === '__TEXT');
  const imageBase = textSeg ? textSeg.address : (image.segments[0] ? image.segments[0].address : 0n);
  const alignment = (image.arch === 'arm64' || image.arch === 'arm64e' || image.arch === 'arm64_32') ? 4n : image.arch === 'arm' ? 2n : 1n;
  const ranges = [];
  let currentOwnerStart = null;
  for (const candidate of candidateRanges) {
    const start = imageBase + BigInt(candidate.startOffset);
    const end = imageBase + BigInt(candidate.endOffset);
    const seg = image.segmentAt(start);
    if (!seg || seg.perms?.execute !== true || (alignment > 1n && start % alignment !== 0n)) {
      fail('entry-mapping-invalid', `function offset 0x${candidate.startOffset.toString(16)} is not executable/aligned`, true);
      return;
    }
    if (end <= start) {
      fail('entry-extent-invalid', `function offset 0x${candidate.startOffset.toString(16)} has an invalid end`, true);
      return;
    }
    if (end > seg.address + seg.size || image.segmentAt(end - 1n) !== seg) {
      fail('entry-extent-mapping-invalid', `function range 0x${candidate.startOffset.toString(16)}..0x${candidate.endOffset.toString(16)} escapes its executable mapping`, true);
      return;
    }
    const continuation = (candidate.encoding & notFunctionStartMask) !== 0;
    if (continuation) {
      if (currentOwnerStart == null) {
        fail('continuation-owner-missing', `continuation range at 0x${candidate.startOffset.toString(16)} has no preceding primary function`, true);
        return;
      }
      ranges.push({ start, end, primary:false, ownerStart:currentOwnerStart });
    } else {
      currentOwnerStart = start;
      ranges.push({ start, end, primary:true, ownerStart:null });
    }
  }

  if (!take({ objects:ranges.length*2, operations:ranges.length, estimatedHeapBytes:ranges.length*256 }, 'output')) return;
  for (const range of ranges) {
    const sizeBytes = Number(range.end - range.start);
    image.unwindEntries.push({
      start:range.start,
      end:range.end,
      sizeBytes,
      primary:range.primary,
      ...(range.primary ? {} : { ownerStart:range.ownerStart }),
      source:'compact-unwind',
    });
    if (range.primary) image.functions.push(functionSeed(range.start, { source:'unwind', confidence:0.95 }));
  }
  status.recovered = ranges.length;
}
