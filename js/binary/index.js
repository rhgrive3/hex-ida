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

function defineLazyStrings(image, initialStringOpts) {
  let stringOpts = initialStringOpts;
  let computed = false;
  let cachedValue;
  Object.defineProperty(image, 'strings', {
    enumerable: true,
    configurable: true,
    get() {
      if (!computed) {
        cachedValue = scanStrings(image, stringOpts);
        computed = true;
        stringOpts = null;
      }
      const value = cachedValue;
      const desc = this === image ? Object.getOwnPropertyDescriptor(image, 'strings') : null;
      if (desc?.configurable === true) {
        Object.defineProperty(image, 'strings', {
          value,
          writable: true,
          enumerable: desc.enumerable,
          configurable: true,
        });
      }
      return value;
    },
    set(value) {
      if (Object.isFrozen(image)) {
        throw new TypeError("Cannot assign to read only property 'strings' of object");
      }
      if (this !== image) {
        Object.defineProperty(this, 'strings', {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        return;
      }
      computed = true;
      stringOpts = null;
      cachedValue = value;
      const desc = Object.getOwnPropertyDescriptor(image, 'strings');
      if (desc?.configurable === true) {
        Object.defineProperty(image, 'strings', {
          value,
          writable: true,
          enumerable: desc.enumerable,
          configurable: true,
        });
      }
    },
  });
}

export function openBinary(input, opts = {}) {
  const engineMode = getEngineMode(opts);
  const scopeJs = engineMode === 'js';
  const hadPrevHex = scopeJs && Object.prototype.hasOwnProperty.call(globalThis, 'HEX_ENGINE');
  const prevHex = scopeJs ? globalThis.HEX_ENGINE : undefined;
  const hadPrevMode = scopeJs && Object.prototype.hasOwnProperty.call(globalThis, '__HEX_ENGINE_MODE__');
  const prevMode = scopeJs ? globalThis.__HEX_ENGINE_MODE__ : undefined;
  let setHex = false;
  let setMode = false;
  try {
    if (scopeJs) {
      globalThis.HEX_ENGINE = 'js';
      setHex = true;
      globalThis.__HEX_ENGINE_MODE__ = 'js';
      setMode = true;
    }
  const detected = detectBinary(input);
  let wasmInfo = null;
  if (engineMode !== 'js') {
    const bytes = toUint8View(input);
    if (bytes && (bytes.length <= 1_500_000 || detected.format === 'unknown')) {
      wasmInfo = wasmInspectBinary(bytes);
    }
  }

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
    const resolvedStringEngine = (typeof opts.strings === 'object' && opts.strings !== null && opts.strings._engine != null)
      ? getEngineMode({ _engine: opts.strings._engine })
      : engineMode;
    const stringOpts = (typeof opts.strings === 'object' && opts.strings !== null)
      ? { ...opts.strings, _engine: resolvedStringEngine }
      : { _engine: resolvedStringEngine };
    const eagerStrings = engineMode !== 'auto'
      || getEngineMode(stringOpts) !== 'auto'
      || (typeof opts.strings === 'object' && opts.strings !== null && (opts.strings.onProgress || opts.strings.signal || opts.strings.eager === true))
      || !Object.isExtensible(image);
    if (eagerStrings) {
      image.strings = scanStrings(image, stringOpts);
    } else {
      defineLazyStrings(image, stringOpts);
    }
  }
  return image;
  } finally {
    if (scopeJs) {
      if (setHex) {
        if (hadPrevHex) globalThis.HEX_ENGINE = prevHex;
        else delete globalThis.HEX_ENGINE;
      }
      if (setMode) {
        if (hadPrevMode) globalThis.__HEX_ENGINE_MODE__ = prevMode;
        else delete globalThis.__HEX_ENGINE_MODE__;
      }
    }
  }
}
