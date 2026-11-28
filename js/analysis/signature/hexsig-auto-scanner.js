// Background automatic HEX-SIG signature scanner (v6 Track 2).
// INV-005 compliant: zero architecture or semantics imports.

import {
  AUTO_ANALYSIS_STATUS,
  isStrippedFunctionName,
  normalizeVaHex,
  safeInvokeCallback,
  toSafeByteSize,
} from '../common/v6-auto-contracts.js';
import {
  HEXSIG_ARCH_NONE,
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
  fnv1a64,
  crc16Ccitt,
} from './hex-sig-extractor.js';
import { HEXSIG_VERDICT } from './hex-sig-index.js';
import { selectHexSigPacksForBinary } from './hexsig-hub-loader.js';

export { isStrippedFunctionName };

const DEFAULT_CHUNK_SIZE = 32;
const DEFAULT_MAX_BUDGET_MS = 800;
const DEFAULT_MAX_PACKS = 2;
const DEFAULT_READ_BYTES = 64;
const MAX_READ_BYTES = 256;

function defaultYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Resolve an architecture identifier or name into a numeric HEX-SIG arch ID.
 * Returns HEXSIG_ARCH_NONE (0) for unsupported or unknown architectures.
 * @param {number|string|null|undefined} arch
 * @returns {number}
 */
export function resolveHexSigArchId(arch) {
  if (arch === HEXSIG_ARCH_ARM64) return HEXSIG_ARCH_ARM64;
  if (arch === HEXSIG_ARCH_X86_64) return HEXSIG_ARCH_X86_64;
  if (typeof arch !== 'string') return HEXSIG_ARCH_NONE;
  const norm = arch.trim().toLowerCase();
  if (norm === 'arm64' || norm === 'aarch64' || norm === 'arm64e' || norm === 'arm64_32') {
    return HEXSIG_ARCH_ARM64;
  }
  if (norm === 'x86_64' || norm === 'x86-64' || norm === 'x64' || norm === 'amd64') {
    return HEXSIG_ARCH_X86_64;
  }
  return HEXSIG_ARCH_NONE;
}

function archIdToSelectionArch(archId) {
  if (archId === HEXSIG_ARCH_ARM64) return 'arm64';
  if (archId === HEXSIG_ARCH_X86_64) return 'x64';
  return '';
}

/**
 * Normalize a HexSig library descriptor or string into a displayable library name.
 * @param {string|object|null|undefined} lib
 * @returns {string}
 */
export function normalizeHexSigLibName(lib) {
  if (typeof lib === 'string') return lib.trim();
  if (!lib || typeof lib !== 'object') return '';
  for (const key of ['libName', 'name', 'vendor', 'packId']) {
    const val = lib[key];
    if (typeof val === 'string' && val.trim() !== '') {
      return val.trim();
    }
  }
  return '';
}

/**
 * Return a non-destructive copy of a HexSig hub manifest whose pack `arch` fields
 * are normalized to `'arm64'` or `'x64'` so `selectHexSigPacksForBinary` matches accurately.
 * @param {object|null|undefined} manifest
 * @returns {object}
 */
export function normalizeHexSigManifestForSelection(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { packs: [] };
  }
  const rawPacks = Array.isArray(manifest.packs) ? manifest.packs : [];
  const packs = [];
  for (const p of rawPacks) {
    if (!p || typeof p !== 'object') continue;
    let archId = resolveHexSigArchId(p.arch);
    if (archId === HEXSIG_ARCH_NONE && (p.arch == null || p.arch === '')) {
      archId = resolveHexSigArchId(p.archMask);
    }
    const normalizedArch = archIdToSelectionArch(archId);
    packs.push({
      ...p,
      arch: normalizedArch || (typeof p.arch === 'string' ? p.arch.trim().toLowerCase() : p.arch),
    });
  }
  return {
    ...manifest,
    packs,
  };
}

/**
 * Build a HexSigIndex.match() query object from raw function prologue bytes.
 * Merges optional custom `extractQuery(bytes, archId)` output when provided.
 * @param {Uint8Array|ArrayLike<number>} codeBytes
 * @param {number|string} archId
 * @param {Function|null} [extractQuery=null]
 * @returns {object}
 */
export function buildHexSigMatchQuery(codeBytes, archId, extractQuery = null) {
  const bytes = codeBytes instanceof Uint8Array
    ? codeBytes
    : new Uint8Array(codeBytes || 0);
  const resolvedArch = typeof archId === 'number'
    ? archId
    : resolveHexSigArchId(archId);

  const pattern = bytes.subarray(0, Math.min(32, bytes.length));
  const patternHash64 = fnv1a64(pattern);
  const tailLen = Math.min(32, Math.max(0, bytes.length - pattern.length));
  const crc16 = tailLen > 0
    ? crc16Ccitt(bytes, pattern.length, pattern.length + tailLen)
    : crc16Ccitt(pattern, pattern.length > 16 ? 16 : 0, pattern.length);

  const baseQuery = {
    arch: resolvedArch,
    archId: resolvedArch,
    codeBytes: bytes,
    pattern,
    length: pattern.length,
    patternHash64,
    crc16,
    tailOffset: tailLen > 0 ? pattern.length : 0,
    tailLen,
  };

  if (typeof extractQuery === 'function') {
    const custom = extractQuery(bytes, resolvedArch);
    if (custom && typeof custom === 'object') {
      const mergedArch = custom.arch ?? custom.archId ?? resolvedArch;
      return {
        ...baseQuery,
        ...custom,
        arch: mergedArch,
        archId: custom.archId ?? mergedArch,
        codeBytes: custom.codeBytes ?? bytes,
      };
    }
  }

  return baseQuery;
}

function toUint8ArrayOrNull(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  return null;
}

/**
 * Create a budgeted, abortable background HEX-SIG auto-scanner.
 */
export function createHexSigAutoScanner({
  hexSigIndex,
  hubLoader = null,
  mountPack = null,
  mountedPackIds = null,
  isPackMounted = null,
  extractQuery = null,
  matchOpts = null,
  chunkSize = DEFAULT_CHUNK_SIZE,
  maxBudgetMs = DEFAULT_MAX_BUDGET_MS,
  maxPacks = DEFAULT_MAX_PACKS,
  yieldFn = null,
  nowFn = () => Date.now(),
} = {}) {
  const safeChunkSize = Number.isFinite(Number(chunkSize)) && Number(chunkSize) >= 1
    ? Math.floor(Number(chunkSize))
    : DEFAULT_CHUNK_SIZE;
  const safeMaxBudgetMs = Number.isFinite(Number(maxBudgetMs)) && Number(maxBudgetMs) >= 0
    ? Number(maxBudgetMs)
    : DEFAULT_MAX_BUDGET_MS;
  const safeMaxPacks = Number.isFinite(Number(maxPacks)) && Number(maxPacks) >= 0
    ? Math.floor(Number(maxPacks))
    : DEFAULT_MAX_PACKS;
  const effectiveYieldFn = typeof yieldFn === 'function' ? yieldFn : defaultYield;
  const effectiveNowFn = typeof nowFn === 'function' ? nowFn : () => Date.now();
  const mountedSet = mountedPackIds instanceof Set ? mountedPackIds : new Set();

  function checkPackMounted(packId) {
    if (typeof isPackMounted === 'function') {
      try {
        if (isPackMounted(packId)) return true;
      } catch {
        // Ignore callback failure and fall back to internal set.
      }
    }
    return mountedSet.has(packId);
  }

  return {
    async run({
      binaryMeta = {},
      functions = [],
      readFunctionBytes,
      signal = null,
      onNamed = null,
      onBatchNamed = null,
      onProgress = null,
    } = {}) {
      const results = [];
      const errors = [];
      let scanned = 0;
      let named = 0;
      let skippedNamed = 0;

      if (signal?.aborted) {
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          completed: 0,
          total: 0,
        });
        return {
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      if (!hexSigIndex || typeof hexSigIndex.match !== 'function') {
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status: AUTO_ANALYSIS_STATUS.SKIPPED,
          completed: 0,
          total: 0,
        });
        return {
          status: AUTO_ANALYSIS_STATUS.SKIPPED,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      const archId = resolveHexSigArchId(binaryMeta?.arch ?? binaryMeta?.archId);
      if (archId === HEXSIG_ARCH_NONE) {
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status: AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH,
          completed: 0,
          total: 0,
        });
        return {
          status: AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      const startMs = effectiveNowFn();
      const isBudgetExceeded = () => (effectiveNowFn() - startMs) >= safeMaxBudgetMs;
      const funcList = Array.isArray(functions) ? functions : [];
      const totalFuncs = funcList.length;

      // Phase 1: Select & load packs via hubLoader (if configured).
      if (
        hubLoader
        && hubLoader.manifest
        && typeof hubLoader.loadPack === 'function'
        && safeMaxPacks > 0
      ) {
        const normalizedManifest = normalizeHexSigManifestForSelection(hubLoader.manifest);
        const selectedPacks = selectHexSigPacksForBinary(normalizedManifest, {
          arch: archIdToSelectionArch(archId),
          format: binaryMeta?.format || '',
          platform: binaryMeta?.platform || '',
        }).slice(0, safeMaxPacks);

        if (selectedPacks.length > 0) {
          safeInvokeCallback(onProgress, {
            phase: 'hexsig',
            status: AUTO_ANALYSIS_STATUS.RUNNING,
            completed: 0,
            total: totalFuncs,
            detail: 'loading_packs',
          });
        }

        for (const pack of selectedPacks) {
          if (signal?.aborted) {
            safeInvokeCallback(onProgress, {
              phase: 'hexsig',
              status: AUTO_ANALYSIS_STATUS.ABORTED,
              completed: 0,
              total: totalFuncs,
            });
            return {
              status: AUTO_ANALYSIS_STATUS.ABORTED,
              scanned,
              named,
              skippedNamed,
              results,
              errors,
            };
          }
          if (isBudgetExceeded()) {
            safeInvokeCallback(onProgress, {
              phase: 'hexsig',
              status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
              completed: 0,
              total: totalFuncs,
            });
            return {
              status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
              scanned,
              named,
              skippedNamed,
              results,
              errors,
            };
          }
          if (checkPackMounted(pack.packId)) continue;

          try {
            const loaded = await hubLoader.loadPack(pack.packId);
            if (signal?.aborted) {
              safeInvokeCallback(onProgress, {
                phase: 'hexsig',
                status: AUTO_ANALYSIS_STATUS.ABORTED,
                completed: 0,
                total: totalFuncs,
              });
              return {
                status: AUTO_ANALYSIS_STATUS.ABORTED,
                scanned,
                named,
                skippedNamed,
                results,
                errors,
              };
            }
            if (isBudgetExceeded()) {
              safeInvokeCallback(onProgress, {
                phase: 'hexsig',
                status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
                completed: 0,
                total: totalFuncs,
              });
              return {
                status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
                scanned,
                named,
                skippedNamed,
                results,
                errors,
              };
            }

            if (typeof mountPack === 'function') {
              const mRes = await mountPack(loaded);
              if (signal?.aborted) {
                safeInvokeCallback(onProgress, {
                  phase: 'hexsig',
                  status: AUTO_ANALYSIS_STATUS.ABORTED,
                  completed: 0,
                  total: totalFuncs,
                });
                return {
                  status: AUTO_ANALYSIS_STATUS.ABORTED,
                  scanned,
                  named,
                  skippedNamed,
                  results,
                  errors,
                };
              }
              if (mRes && mRes.ok === false) {
                errors.push({
                  packId: pack.packId,
                  reason: mRes.reason || 'mount_failed',
                });
              } else {
                mountedSet.add(pack.packId);
              }
            } else {
              const meta = loaded?.meta || pack;
              const decoded = loaded?.decoded;
              if (meta && meta.libId !== undefined && Array.isArray(hexSigIndex.libs)) {
                hexSigIndex.libs[meta.libId] = {
                  libId: meta.libId,
                  packId: meta.packId,
                  vendor: meta.vendor,
                  kind: meta.libKind,
                  libName: meta.libName,
                };
              }
              if (decoded && Array.isArray(decoded.entries) && typeof hexSigIndex.addEntry === 'function') {
                for (const entry of decoded.entries) {
                  hexSigIndex.addEntry(entry);
                }
              }
              mountedSet.add(pack.packId);
            }
          } catch (err) {
            errors.push({
              packId: pack.packId,
              reason: err?.message || String(err),
            });
            if (signal?.aborted) {
              safeInvokeCallback(onProgress, {
                phase: 'hexsig',
                status: AUTO_ANALYSIS_STATUS.ABORTED,
                completed: 0,
                total: totalFuncs,
              });
              return {
                status: AUTO_ANALYSIS_STATUS.ABORTED,
                scanned,
                named,
                skippedNamed,
                results,
                errors,
              };
            }
          }
        }
      }

      // Phase 2: Guard against empty index or missing reader.
      const entryCount = Array.isArray(hexSigIndex.entries) ? hexSigIndex.entries.length : 0;
      if (entryCount === 0) {
        const status = errors.length > 0
          ? AUTO_ANALYSIS_STATUS.OFFLINE
          : AUTO_ANALYSIS_STATUS.SKIPPED;
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status,
          completed: 0,
          total: totalFuncs,
        });
        return {
          status,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      if (typeof readFunctionBytes !== 'function') {
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status: AUTO_ANALYSIS_STATUS.SKIPPED,
          completed: 0,
          total: totalFuncs,
        });
        return {
          status: AUTO_ANALYSIS_STATUS.SKIPPED,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      // Phase 3: Chunked function scanning with WASM auto-demotion and budget enforcement.
      const baseMatchOpts = matchOpts && typeof matchOpts === 'object' ? { ...matchOpts } : {};
      let sessionPreferWasm = baseMatchOpts.preferWasm !== false;
      let chunkBatch = [];

      function flushChunkBatch() {
        if (chunkBatch.length === 0) return;
        const batch = chunkBatch;
        chunkBatch = [];
        safeInvokeCallback(onBatchNamed, batch);
      }

      safeInvokeCallback(onProgress, {
        phase: 'hexsig',
        status: AUTO_ANALYSIS_STATUS.RUNNING,
        completed: 0,
        total: totalFuncs,
      });

      for (let i = 0; i < totalFuncs; i++) {
        if (signal?.aborted) {
          safeInvokeCallback(onProgress, {
            phase: 'hexsig',
            status: AUTO_ANALYSIS_STATUS.ABORTED,
            completed: i,
            total: totalFuncs,
          });
          return {
            status: AUTO_ANALYSIS_STATUS.ABORTED,
            scanned,
            named,
            skippedNamed,
            results,
            errors,
          };
        }

        if (isBudgetExceeded()) {
          flushChunkBatch();
          safeInvokeCallback(onProgress, {
            phase: 'hexsig',
            status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
            completed: i,
            total: totalFuncs,
          });
          return {
            status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
            scanned,
            named,
            skippedNamed,
            results,
            errors,
          };
        }

        const fn = funcList[i];
        if (fn && typeof fn === 'object') {
          const vaHex = normalizeVaHex(fn.vaHex ?? fn.va ?? fn.addr ?? fn.address);
          if (vaHex) {
            const oldName = typeof fn.name === 'string'
              ? fn.name
              : (fn.name == null ? null : String(fn.name));

            if (!isStrippedFunctionName(oldName)) {
              skippedNamed++;
            } else {
              const readLen = fn.size == null
                ? DEFAULT_READ_BYTES
                : Math.min(toSafeByteSize(fn.size, DEFAULT_READ_BYTES), MAX_READ_BYTES);

              if (readLen > 0) {
                let rawBytes = null;
                let readFailed = false;
                try {
                  rawBytes = await readFunctionBytes(vaHex, readLen, { signal });
                } catch (err) {
                  readFailed = true;
                  errors.push({
                    vaHex,
                    reason: err?.message || String(err),
                  });
                }

                if (signal?.aborted) {
                  safeInvokeCallback(onProgress, {
                    phase: 'hexsig',
                    status: AUTO_ANALYSIS_STATUS.ABORTED,
                    completed: i,
                    total: totalFuncs,
                  });
                  return {
                    status: AUTO_ANALYSIS_STATUS.ABORTED,
                    scanned,
                    named,
                    skippedNamed,
                    results,
                    errors,
                  };
                }

                if (!readFailed) {
                  const codeBytes = toUint8ArrayOrNull(rawBytes);
                  if (codeBytes && codeBytes.length >= 4) {
                    scanned++;
                    try {
                      const query = buildHexSigMatchQuery(codeBytes, archId, extractQuery);
                      const res = hexSigIndex.match(query, {
                        ...baseMatchOpts,
                        preferWasm: sessionPreferWasm,
                      });

                      if (
                        sessionPreferWasm === true
                        && codeBytes.length >= 4
                        && hexSigIndex.entries.length > 0
                        && res?.engine === 'js'
                      ) {
                        sessionPreferWasm = false;
                      }

                      if (
                        res
                        && res.matched === true
                        && res.verdict === HEXSIG_VERDICT.AUTO_NAME
                        && Boolean(res.symbolName)
                      ) {
                        const libObj = res.lib
                          ?? (typeof hexSigIndex.getLib === 'function' ? hexSigIndex.getLib(res.libId) : null);
                        const matchRecord = {
                          vaHex,
                          oldName,
                          newName: String(res.symbolName),
                          libId: typeof res.libId === 'number' ? res.libId : 0xffff,
                          libName: normalizeHexSigLibName(libObj),
                          score: typeof res.score1 === 'number'
                            ? res.score1
                            : (typeof res.confidence === 'number' ? res.confidence : 0),
                          margin: typeof res.margin === 'number' ? res.margin : 0,
                          engine: res.engine === 'wasm' ? 'wasm' : 'js',
                          verdict: res.verdict,
                        };
                        named++;
                        results.push(matchRecord);
                        chunkBatch.push(matchRecord);
                        safeInvokeCallback(onNamed, matchRecord);
                      }
                    } catch (err) {
                      errors.push({
                        vaHex,
                        reason: err?.message || String(err),
                      });
                    }
                  }
                }
              }
            }
          }
        }

        if ((i + 1) % safeChunkSize === 0 && (i + 1) < totalFuncs) {
          flushChunkBatch();
          safeInvokeCallback(onProgress, {
            phase: 'hexsig',
            status: AUTO_ANALYSIS_STATUS.RUNNING,
            completed: i + 1,
            total: totalFuncs,
          });
          if (isBudgetExceeded()) {
            safeInvokeCallback(onProgress, {
              phase: 'hexsig',
              status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
              completed: i + 1,
              total: totalFuncs,
            });
            return {
              status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
              scanned,
              named,
              skippedNamed,
              results,
              errors,
            };
          }
          await effectiveYieldFn();
          if (signal?.aborted) {
            safeInvokeCallback(onProgress, {
              phase: 'hexsig',
              status: AUTO_ANALYSIS_STATUS.ABORTED,
              completed: i + 1,
              total: totalFuncs,
            });
            return {
              status: AUTO_ANALYSIS_STATUS.ABORTED,
              scanned,
              named,
              skippedNamed,
              results,
              errors,
            };
          }
        }
      }

      flushChunkBatch();
      safeInvokeCallback(onProgress, {
        phase: 'hexsig',
        status: AUTO_ANALYSIS_STATUS.DONE,
        completed: totalFuncs,
        total: totalFuncs,
      });
      return {
        status: AUTO_ANALYSIS_STATUS.DONE,
        scanned,
        named,
        skippedNamed,
        results,
        errors,
      };
    },
  };
}
