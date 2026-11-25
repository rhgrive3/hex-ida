import { detectBinary } from './detect.js';
import { parseMachO } from './macho.js';
import { parseELF } from './elf-loader.js';
import { parsePE } from './pe.js';
import { scanStrings } from './strings.js';
import { parseDyldSharedCache } from './dyld-shared-cache.js';
import { getEngineMode, wasmInspectBinary } from '../core/hex-engine-bridge.js';

export { BinaryImage, functionSeed, mergeFunctionSeeds } from './model.js';
export { ByteView, BinaryReadError, hex } from './reader.js';
export {
  ByteSource, ByteSourceError, ByteSourceRangeError, ByteSourceLimitError,
  MemoryByteSource, BlobByteSource, SubrangeByteSource,
  asByteSource, readExactly, safeNumber,
} from './source.js';
export { openBinarySource, parseELFSource, parsePESource } from './source-loaders.js';
export { parseMachOSource, clearMachOSourceCache } from './macho-source-cache.js';
export { detectBinary } from './detect.js';
export { parseMachO } from './macho.js';
export { parseELF, parseAarch64GnuProperty, attachAarch64GnuPropertyEvidence } from './elf-loader.js';
export { parsePE } from './pe.js';
export { scanStrings } from './strings.js';
export { parseDyldSharedCache, parseDyldSharedCacheSource } from './dyld-shared-cache.js';
export { auditBinary, capabilitiesOf } from './audit.js';
export { fnv1a64, fingerprintBytes, fingerprintFunction, fingerprintImage } from './fingerprint.js';

const WASM_FORMAT_BY_ID = Object.freeze({
  1: 'elf',
  2: 'macho',
  3: 'pe',
});

function toUint8View(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

export function openBinary(input, opts = {}) {
  const engineMode = getEngineMode(opts);
  let wasmInfo = null;
  if (engineMode !== 'js') {
    const bytes = toUint8View(input);
    if (bytes) {
      wasmInfo = wasmInspectBinary(bytes);
    }
  }

  const detected = detectBinary(input);
  const format = detected.format !== 'unknown'
    ? detected.format
    : (wasmInfo ? (WASM_FORMAT_BY_ID[wasmInfo.format] || 'unknown') : 'unknown');

  let image;
  if (format === 'dyld-shared-cache') image = parseDyldSharedCache(input, opts);
  else if (format === 'macho') image = parseMachO(input, opts);
  else if (format === 'elf') image = parseELF(input, opts);
  else if (format === 'pe') image = parsePE(input, opts);
  else throw new Error('対応していない実行ファイル形式です（Mach-O / ELF / PE を判定できませんでした）。');

  if (opts.strings) {
    const stringOpts = typeof opts.strings === 'object'
      ? (opts._engine != null && opts.strings._engine == null
        ? { ...opts.strings, _engine: opts._engine }
        : opts.strings)
      : (opts._engine != null ? { _engine: opts._engine } : {});
    image.strings = scanStrings(image, stringOpts);
  }
  return image;
}
