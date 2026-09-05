import { detectBinary } from './detect.js';
import { parseELF } from './elf-loader.js';
import { parseMachO } from './macho.js';
import { parsePE } from './pe.js';
import { ByteView } from './reader.js';
import { asByteSource } from './source.js';
import { parseSourceRanges } from './source-reader.js';
import { scanSourceStrings } from '../bytesource/strings.js';
import { sliceArchName, validateFatSlice, validateFatContainer, probePastEndArm64SliceAsync, parseInnerMachOHeader } from './macho-fat.js';

const FAT_KINDS = new Map([
  ['cafebabe', { bits: 32, littleEndian: false }],
  ['cafebabf', { bits: 64, littleEndian: false }],
  ['bebafeca', { bits: 32, littleEndian: true }],
  ['bfbafeca', { bits: 64, littleEndian: true }],
]);

export async function openBinarySource(input, opts = {}) {
  const sourceOptions = opts.source || {};
  const source = asByteSource(input, sourceOptions);
  const prefixLength = Number(source.size < 16n ? source.size : 16n);
  const prefix = await readChunked(source, 0n, prefixLength, { signal: opts.signal });
  const detected = detectBinary(prefix);
  const rangeOptions = withSignal(opts.ranges || {}, opts.signal);

  if (detected.format === 'elf') return parseELFSourceWithPrefix(source, opts, prefix, rangeOptions);
  // The source probe is intentionally small; parsePE performs bounded range reads for e_lfanew and PE\0\0.
  if (detected.format === 'pe' || (prefix.byteLength >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a)) {
    return parsePESourceWithPrefix(source, opts, prefix, rangeOptions);
  }
  if (detected.format === 'macho') return parseMachOSourceWithPrefix(source, opts, prefix, rangeOptions);
  throw new Error('対応していない実行ファイル形式です（Mach-O / ELF / PE を判定できませんでした）。');
}

export async function parseELFSource(input, opts = {}, _prefix = null, rangeOptions = opts.ranges || {}) {
  const source = asByteSource(input, opts.source || {});
  const prefix = await readPrefix(source, opts.signal);
  return parseELFSourceWithPrefix(source, opts, prefix, rangeOptions);
}

async function parseELFSourceWithPrefix(source, opts, prefix, rangeOptions) {
  const ranges = withSignal(rangeOptions, opts.signal);
  const image = await parseSourceRanges(source, parseELF, opts, withInitial(prefix, ranges));
  return withStrings(image, source, opts);
}

export async function parsePESource(input, opts = {}, _prefix = null, rangeOptions = opts.ranges || {}) {
  const source = asByteSource(input, opts.source || {});
  const prefix = await readPrefix(source, opts.signal);
  return parsePESourceWithPrefix(source, opts, prefix, rangeOptions);
}

async function parsePESourceWithPrefix(source, opts, prefix, rangeOptions) {
  const ranges = withSignal(rangeOptions, opts.signal);
  const image = await parseSourceRanges(source, parsePE, opts, withInitial(prefix, ranges));
  return withStrings(image, source, opts);
}

export async function parseMachOSource(input, opts = {}, _prefix = null, rangeOptions = opts.ranges || {}) {
  const source = asByteSource(input, opts.source || {});
  const prefix = await readPrefix(source, opts.signal);
  return parseMachOSourceWithPrefix(source, opts, prefix, rangeOptions);
}

async function parseMachOSourceWithPrefix(source, opts, prefix, rangeOptions) {
  const ranges = withSignal(rangeOptions, opts.signal);
  const magic = prefix;
  const fat = fatKind(magic);
  if (!fat) {
    const image = await parseSourceRanges(source, parseMachO, opts, withInitial(magic, ranges));
    return withStrings(image, source, opts);
  }

  if (source.size < 8n) throw new Error('Mach-O universal header is truncated');
  const head = magic.byteLength >= 8 ? magic.subarray(0, 8) : await readChunked(source, 0n, 8, { signal: opts.signal });
  const hr = new ByteView(head, { littleEndian: fat.littleEndian });
  const count = hr.u32(4);
  if (count > 128) throw new Error(`unreasonable Mach-O slice count ${count}`);
  const entrySize = fat.bits === 64 ? 32 : 20;
  const tableSize = count * entrySize;
  const extraSize = (fat.bits === 32 && source.size >= 8n + BigInt(tableSize + 20)) ? 20 : 0;
  if (8n + BigInt(tableSize) > source.size) throw new Error('Mach-O universal slice table is truncated');
  const table = await readChunked(source, 8n, tableSize + extraSize, { signal: opts.signal });
  const r = new ByteView(table, { littleEndian: fat.littleEndian, base: 8 });
  const all = [];
  for (let i = 0, p = 0; i < count; i++, p += entrySize) {
    const cpu = r.i32(p), subtype = r.i32(p + 4);
    const offset = fat.bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 8));
    const size = fat.bits === 64 ? r.u64(p + 16) : BigInt(r.u32(p + 12));
    const align = r.u32(p + (fat.bits === 64 ? 24 : 16));
    all.push({ cpu, subtype, offset, size, align });
  }

  // #6317: probe past-end arm64 compatibility slice for FAT32
  if (fat.bits === 32 && extraSize === 20) {
    const compat = await probePastEndArm64SliceAsync(r, count, source.size, async (off, len) => {
      return readChunked(source, off, len, { signal: opts.signal });
    }, all);
    if (compat) all.push(compat);
  }

  // #6316: validate each slice
  for (const slice of all) {
    if (slice.offset < 0n || slice.size <= 0n || slice.offset + slice.size > source.size) {
      throw new Error('Mach-O universal binary slice is outside file bounds');
    }
    const headerBytes = await readChunked(source, slice.offset, Math.min(32, Number(slice.size)), { signal: opts.signal });
    const inner = parseInnerMachOHeader(headerBytes);
    validateFatSlice(slice, inner, source.size, opts);
  }

  // #6314: validate container (duplicate architectures and slice range overlap)
  validateFatContainer(all);

  const sliceIndex = opts.sliceIndex;
  const requestedIndex = sliceIndex == null ? null : ((typeof sliceIndex === 'number' || (typeof sliceIndex === 'string' && sliceIndex.trim() !== '')) ? Number(sliceIndex) : NaN);
  if (requestedIndex != null && (!Number.isSafeInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= all.length)) {
    throw new Error(`requested Mach-O slice index ${opts.sliceIndex} is not present in the universal binary`);
  }
  const indexed = requestedIndex == null ? null : all[requestedIndex];
  const requested = indexed || (opts.arch ? all.find((slice) => sliceArchName(slice) === opts.arch) : null);
  if (requestedIndex == null && opts.arch && !requested) throw new Error(`requested Mach-O architecture ${opts.arch} is not present in the universal binary`);
  const selected = requested || all.find((slice) => sliceArchName(slice) === 'arm64e') || all.find((slice) => sliceArchName(slice) === 'arm64') || all.find((slice) => sliceArchName(slice) === 'x86_64') || all[0];
  if (!selected) throw new Error('Mach-O universal binary has no readable slice');
  const sliceSource = source.subrange(selected.offset, selected.size);
  const slicePrefix = await readPrefix(sliceSource, opts.signal);
  const image = await parseSourceRanges(sliceSource, parseMachO, { ...opts, containerOffset: selected.offset }, withInitial(slicePrefix, ranges));
  image.metadata.fat = {
    slices: all.map((slice) => ({ arch: sliceArchName(slice), cpu: slice.cpu, subtype: slice.subtype, offset: slice.offset, size: slice.size })),
    selected: { arch: sliceArchName(selected), cpu: selected.cpu, subtype: selected.subtype, offset: selected.offset, size: selected.size },
  };
  return withStrings(image, sliceSource, opts);
}

async function withStrings(image, source, opts) {
  if (!opts.strings) return image;
  const scanOpts = typeof opts.strings === 'object' ? opts.strings : {};
  const result = await scanSourceStrings(image, source, { ...scanOpts, signal: scanOpts.signal ?? opts.signal });
  image.strings = result.results;
  image.metadata.sourceStrings = { cancelled: result.cancelled, capped: result.capped, count: result.results.length };
  return image;
}

function withSignal(options, signal) {
  if (!signal || options.signal) return options;
  return { ...options, signal };
}

function withInitial(prefix, options) {
  const ranges = { ...(options || {}) };
  delete ranges.initial;
  if (!prefix?.byteLength) return ranges;
  return { ...ranges, initial: [{ offset: 0n, bytes: prefix }] };
}

async function readPrefix(source, signal) {
  const length = Number(source.size < 16n ? source.size : 16n);
  return readChunked(source, 0n, length, { signal });
}

async function readChunked(source, offset, length, { signal } = {}) {
  const total = Number(length);
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('chunked read length is invalid');
  if (total === 0) return new Uint8Array(0);
  const ceiling = Number(source?.maxReadLength ?? total);
  const limit = Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : total;
  const out = new Uint8Array(total);
  let pos = 0;
  const base = BigInt(offset);
  while (pos < total) {
    const chunk = Math.min(limit, total - pos);
    const bytes = await source.readExactly(base + BigInt(pos), chunk, { signal });
    out.set(bytes, pos);
    pos += chunk;
  }
  return out;
}

function fatKind(bytes) {
  if (bytes.byteLength < 4) return null;
  let magic = '';
  for (let i = 0; i < 4; i++) magic += bytes[i].toString(16).padStart(2, '0');
  return FAT_KINDS.get(magic) || null;
}
