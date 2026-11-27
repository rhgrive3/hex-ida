/**
 * Adaptive 2-Tier Runtime Profile Detector & HexRuntimeLimits Parity (§16.1–§16.2)
 *
 * Returns exact HexRuntimeLimits matching both:
 *   1. C++ `cpp/include/hex_runtime_profile.hpp` (32-byte alignas(4) POD struct:
 *      profile_tier, type_arena_max_bytes, slot5a_bytes, slot5b_bytes,
 *      volatile_a_bytes, volatile_b_bytes, max_sig_prop_nodes, max_sig_prop_iters)
 *   2. §16.2 extended 64-byte POD limits (max_func_words, max_func_blocks, etc.)
 * plus JS Worker heap caps, HEX-DB shard/cache caps, and converger budgets.
 */

export const PROFILE_ID_MOBILE_256M = 0;
export const PROFILE_ID_DESKTOP_HIGH = 1;

export const HEX_PROFILE_MOBILE = 0;
export const HEX_PROFILE_DESKTOP = 1;

export const PROFILE_TIER_MOBILE = 'mobile';
export const PROFILE_TIER_DESKTOP = 'desktop';

export const CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH = 32;
export const HEX_RUNTIME_LIMITS_BYTE_LENGTH = 64;

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

export const HEX_FIXED_SLOTS_TOTAL_BYTES = 1024 * KIB; // Slots 0..4 = 1 MiB

/**
 * Exact 32-byte POD matching `cpp/include/hex_runtime_profile.hpp` (`kMobileRuntimeLimits`).
 */
export const MOBILE_CPP_RUNTIME_LIMITS = Object.freeze({
  profile_tier: HEX_PROFILE_MOBILE,
  type_arena_max_bytes: 8 * MIB,
  slot5a_bytes: 512 * KIB,
  slot5b_bytes: 512 * KIB,
  volatile_a_bytes: 4 * MIB,
  volatile_b_bytes: 2 * MIB,
  max_sig_prop_nodes: 8192,
  max_sig_prop_iters: 6,
});

/**
 * Exact 32-byte POD matching `cpp/include/hex_runtime_profile.hpp` (`kDesktopRuntimeLimits`).
 */
export const DESKTOP_CPP_RUNTIME_LIMITS = Object.freeze({
  profile_tier: HEX_PROFILE_DESKTOP,
  type_arena_max_bytes: 48 * MIB,
  slot5a_bytes: 3 * MIB,
  slot5b_bytes: 4 * MIB,
  volatile_a_bytes: 24 * MIB,
  volatile_b_bytes: 16 * MIB,
  max_sig_prop_nodes: 65536,
  max_sig_prop_iters: 16,
});

/**
 * Extended 64-byte POD limits from §16.2 for PROFILE_MOBILE_256M (id=0).
 */
export const MOBILE_HEX_RUNTIME_LIMITS = Object.freeze({
  profile_id: PROFILE_ID_MOBILE_256M,
  type_arena_max_bytes: 8 * MIB,       // 8.0 MiB
  max_func_words: 16384,
  max_func_blocks: 4096,
  single_pass_words: 8192,
  single_pass_blocks: 1024,
  region_max_words: 4096,
  region_max_blocks: 512,
  max_emit_text_bytes: 1 * MIB,        // 1.0 MiB
  max_linemap_entries: 32768,
  max_deobf_steps: 1024,
  max_deobf_vstack: 4096,
  max_field_obs_batch: 65536,
  max_struct_clusters: 8192,
  max_slice_nodes: 256,
  reserved_: 0,
});

/**
 * Extended 64-byte POD limits from §16.2 for PROFILE_DESKTOP_HIGH (id=1).
 */
export const DESKTOP_HEX_RUNTIME_LIMITS = Object.freeze({
  profile_id: PROFILE_ID_DESKTOP_HIGH,
  type_arena_max_bytes: 48 * MIB,      // 48.0 MiB
  max_func_words: 65536,
  max_func_blocks: 8192,
  single_pass_words: 8192,
  single_pass_blocks: 2048,
  region_max_words: 8192,
  region_max_blocks: 1024,
  max_emit_text_bytes: 8 * MIB,        // 8.0 MiB
  max_linemap_entries: 131072,
  max_deobf_steps: 8192,
  max_deobf_vstack: 16384,
  max_field_obs_batch: 262144,
  max_struct_clusters: 32767,
  max_slice_nodes: 1024,
  reserved_: 0,
});

export const MOBILE_RUNTIME_PROFILE = Object.freeze({
  tier: PROFILE_TIER_MOBILE,
  profileId: PROFILE_ID_MOBILE_256M,
  name: 'PROFILE_MOBILE_256M',
  cppLimits: MOBILE_CPP_RUNTIME_LIMITS,
  limits: MOBILE_HEX_RUNTIME_LIMITS,
  workerHeap: Object.freeze({
    softCapBytes: 192 * MIB,
    hardCapBytes: 224 * MIB,
    emergencyCapBytes: 240 * MIB,
    maxCapBytes: 256 * MIB,
  }),
  hexdb: Object.freeze({
    shardMaxBytes: 4 * MIB,
    totalShardCapBytes: 128 * MIB,
    memoryFallbackCapBytes: 24 * MIB,
    walMaxBytes: 4 * MIB,
    pageCacheNormalBytes: 8 * MIB,
    pageCacheSoftBytes: 4 * MIB,
    pageCacheHardBytes: 1 * MIB,
    pageCacheEmergencyBytes: 0,
  }),
  converger: Object.freeze({
    sliceBudgetMs: 8,
    idleDelayMs: 400,
    checkpointEveryBatches: 16,
    checkpointIntervalMs: 2000,
    dirtyConeMaxDepth: 6,
    dirtyConeMaxFuncs: 256,
    emuMaxSteps: 4096,
    emuMaxCowPages: 64,
  }),
  wasm: Object.freeze({
    initialMemoryBytes: 122 * 64 * KIB, // 7.625 MiB
    maxLinearBytes: 15.625 * MIB,
    typeArenaMaxBytes: 8 * MIB,
  }),
});

export const DESKTOP_RUNTIME_PROFILE = Object.freeze({
  tier: PROFILE_TIER_DESKTOP,
  profileId: PROFILE_ID_DESKTOP_HIGH,
  name: 'PROFILE_DESKTOP_HIGH',
  cppLimits: DESKTOP_CPP_RUNTIME_LIMITS,
  limits: DESKTOP_HEX_RUNTIME_LIMITS,
  workerHeap: Object.freeze({
    softCapBytes: 768 * MIB,
    hardCapBytes: 896 * MIB,
    emergencyCapBytes: 960 * MIB,
    maxCapBytes: 1024 * MIB,
  }),
  hexdb: Object.freeze({
    shardMaxBytes: 4 * MIB,
    totalShardCapBytes: 256 * MIB,
    memoryFallbackCapBytes: 64 * MIB,
    walMaxBytes: 4 * MIB,
    pageCacheNormalBytes: 32 * MIB,
    pageCacheSoftBytes: 16 * MIB,
    pageCacheHardBytes: 4 * MIB,
    pageCacheEmergencyBytes: 0,
  }),
  converger: Object.freeze({
    sliceBudgetMs: 12,
    idleDelayMs: 1200,
    checkpointEveryBatches: 16,
    checkpointIntervalMs: 2000,
    dirtyConeMaxDepth: 16,
    dirtyConeMaxFuncs: 4096,
    emuMaxSteps: 32768,
    emuMaxCowPages: 512,
  }),
  wasm: Object.freeze({
    initialMemoryBytes: 122 * 64 * KIB, // 7.625 MiB
    maxLinearBytes: 55.625 * MIB,
    typeArenaMaxBytes: 48 * MIB,
  }),
});

const CPP_LIMIT_FIELD_ORDER = Object.freeze([
  'profile_tier',
  'type_arena_max_bytes',
  'slot5a_bytes',
  'slot5b_bytes',
  'volatile_a_bytes',
  'volatile_b_bytes',
  'max_sig_prop_nodes',
  'max_sig_prop_iters',
]);

const LIMIT_FIELD_ORDER = Object.freeze([
  'profile_id',
  'type_arena_max_bytes',
  'max_func_words',
  'max_func_blocks',
  'single_pass_words',
  'single_pass_blocks',
  'region_max_words',
  'region_max_blocks',
  'max_emit_text_bytes',
  'max_linemap_entries',
  'max_deobf_steps',
  'max_deobf_vstack',
  'max_field_obs_batch',
  'max_struct_clusters',
  'max_slice_nodes',
  'reserved_',
]);

/**
 * Pack 32-byte HexRuntimeLimits matching C++ `cpp/include/hex_runtime_profile.hpp`.
 */
export function packCppHexRuntimeLimits(cppLimits) {
  const buf = new Uint8Array(CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  const view = new DataView(buf.buffer, buf.byteOffset, CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  for (let i = 0; i < CPP_LIMIT_FIELD_ORDER.length; i++) {
    const key = CPP_LIMIT_FIELD_ORDER[i];
    view.setUint32(i * 4, (cppLimits[key] ?? 0) >>> 0, true);
  }
  return buf;
}

/**
 * Unpack 32-byte little-endian buffer into C++ `hex_runtime_profile.hpp` HexRuntimeLimits.
 */
export function unpackCppHexRuntimeLimits(bytes) {
  if (!bytes || bytes.byteLength < CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH) {
    throw new RangeError(`CPP_HEX_RUNTIME_LIMITS_SHORT_BUFFER: expected ${CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH} bytes`);
  }
  const buf = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  const view = new DataView(buf.buffer, buf.byteOffset, CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  const out = {};
  for (let i = 0; i < CPP_LIMIT_FIELD_ORDER.length; i++) {
    out[CPP_LIMIT_FIELD_ORDER[i]] = view.getUint32(i * 4, true);
  }
  return Object.freeze(out);
}

/**
 * Pack extended 64-byte HexRuntimeLimits (§16.2) into a little-endian Uint8Array.
 */
export function packHexRuntimeLimits(limits) {
  const buf = new Uint8Array(HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  const view = new DataView(buf.buffer, buf.byteOffset, HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  for (let i = 0; i < LIMIT_FIELD_ORDER.length; i++) {
    const key = LIMIT_FIELD_ORDER[i];
    view.setUint32(i * 4, (limits[key] ?? 0) >>> 0, true);
  }
  return buf;
}

/**
 * Unpack a 64-byte little-endian buffer into an extended §16.2 HexRuntimeLimits object.
 */
export function unpackHexRuntimeLimits(bytes) {
  if (!bytes || bytes.byteLength < HEX_RUNTIME_LIMITS_BYTE_LENGTH) {
    throw new RangeError(`HEX_RUNTIME_LIMITS_SHORT_BUFFER: expected ${HEX_RUNTIME_LIMITS_BYTE_LENGTH} bytes`);
  }
  const buf = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  const view = new DataView(buf.buffer, buf.byteOffset, HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  const out = {};
  for (let i = 0; i < LIMIT_FIELD_ORDER.length; i++) {
    out[LIMIT_FIELD_ORDER[i]] = view.getUint32(i * 4, true);
  }
  return Object.freeze(out);
}

function normalizeTier(value) {
  if (value === PROFILE_ID_MOBILE_256M || value === '0') return PROFILE_TIER_MOBILE;
  if (value === PROFILE_ID_DESKTOP_HIGH || value === '1') return PROFILE_TIER_DESKTOP;
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (s === 'mobile' || s === 'profile_mobile_256m' || s === 'mobile_256m') return PROFILE_TIER_MOBILE;
  if (s === 'desktop' || s === 'profile_desktop_high' || s === 'desktop_high') return PROFILE_TIER_DESKTOP;
  return null;
}

/**
 * Return the full immutable runtime profile object for a given tier ('mobile' | 'desktop' | 0 | 1).
 */
export function getRuntimeProfile(tierOrId) {
  const tier = normalizeTier(tierOrId);
  if (tier === PROFILE_TIER_MOBILE) return MOBILE_RUNTIME_PROFILE;
  if (tier === PROFILE_TIER_DESKTOP) return DESKTOP_RUNTIME_PROFILE;
  throw new TypeError(`HEX_RUNTIME_PROFILE_INVALID: ${tierOrId}`);
}

function isSafariWebKit(ua) {
  if (typeof ua !== 'string' || !ua) return false;
  return /Safari\//i.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|OPR\/|Firefox\//i.test(ua);
}

/**
 * Detect device runtime tier following §16.1 priority order:
 *   1. Explicit override (`options.override`, `env.HEX_RUNTIME_PROFILE`, `localStorage['hex.runtimeProfile']`)
 *   2. Safari / iPadOS / iOS WebKit forced protection -> 'mobile'
 *   3. `navigator.deviceMemory` (`<= 4` -> 'mobile', `>= 8` -> 'desktop')
 *   4. `performance.memory.jsHeapSizeLimit` (`< 1 GiB` -> 'mobile', `>= 1 GiB && hardwareConcurrency >= 4` -> 'desktop')
 *   5. Viewport / mobile UA hints -> 'mobile'
 *   6. Node/CLI/CI default -> 'desktop'
 */
export function detectRuntimeProfile(options = {}) {
  const env = options.env ?? globalThis;
  const nav = options.navigator ?? env?.navigator ?? null;
  const perf = options.performance ?? env?.performance ?? null;
  const storage = options.localStorage ?? (() => {
    try {
      return env?.localStorage ?? null;
    } catch {
      return null;
    }
  })();

  // 1. Explicit override
  let storedOverride = null;
  try {
    storedOverride = storage?.getItem?.('hex.runtimeProfile') ?? null;
  } catch {
    storedOverride = null;
  }
  const explicit = normalizeTier(options.override)
    ?? normalizeTier(env?.HEX_RUNTIME_PROFILE)
    ?? normalizeTier(storedOverride);
  if (explicit) {
    return {
      ...getRuntimeProfile(explicit),
      reason: 'explicit-override',
    };
  }

  const ua = typeof options.userAgent === 'string'
    ? options.userAgent
    : (typeof nav?.userAgent === 'string' ? nav.userAgent : '');
  const platform = typeof options.platform === 'string'
    ? options.platform
    : (typeof nav?.platform === 'string' ? nav.platform : '');
  const maxTouchPoints = options.maxTouchPoints ?? nav?.maxTouchPoints ?? 0;
  const deviceMemory = options.deviceMemory !== undefined ? options.deviceMemory : nav?.deviceMemory;
  const hardwareConcurrency = options.hardwareConcurrency !== undefined
    ? options.hardwareConcurrency
    : nav?.hardwareConcurrency;
  const innerWidth = options.innerWidth !== undefined ? options.innerWidth : env?.innerWidth;

  // 2. Safari / iPadOS / iOS WebKit forced protection
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return { ...MOBILE_RUNTIME_PROFILE, reason: 'ios-webkit' };
  }
  if (platform === 'MacIntel' && maxTouchPoints > 1) {
    return { ...MOBILE_RUNTIME_PROFILE, reason: 'ipados-touch' };
  }
  if (isSafariWebKit(ua) && deviceMemory === undefined) {
    return { ...MOBILE_RUNTIME_PROFILE, reason: 'safari-no-device-memory' };
  }

  // 3. navigator.deviceMemory
  if (typeof deviceMemory === 'number' && Number.isFinite(deviceMemory)) {
    if (deviceMemory <= 4) {
      return { ...MOBILE_RUNTIME_PROFILE, reason: 'device-memory-low' };
    }
    if (deviceMemory >= 8) {
      return { ...DESKTOP_RUNTIME_PROFILE, reason: 'device-memory-high' };
    }
  }

  // 4. performance.memory.jsHeapSizeLimit
  const jsHeapLimit = options.jsHeapSizeLimit ?? perf?.memory?.jsHeapSizeLimit;
  if (typeof jsHeapLimit === 'number' && Number.isFinite(jsHeapLimit)) {
    if (jsHeapLimit < GIB) {
      return { ...MOBILE_RUNTIME_PROFILE, reason: 'js-heap-limit-low' };
    }
    if (jsHeapLimit >= GIB && (hardwareConcurrency == null || hardwareConcurrency >= 4)) {
      return { ...DESKTOP_RUNTIME_PROFILE, reason: 'js-heap-limit-high' };
    }
  }

  // 5. Viewport / mobile UA hints
  if (/Android|Mobile|Tablet/i.test(ua)) {
    return { ...MOBILE_RUNTIME_PROFILE, reason: 'mobile-ua' };
  }
  if (typeof innerWidth === 'number' && innerWidth > 0 && innerWidth < 768) {
    return { ...MOBILE_RUNTIME_PROFILE, reason: 'narrow-viewport' };
  }
  if (typeof hardwareConcurrency === 'number' && hardwareConcurrency > 0 && hardwareConcurrency <= 2) {
    return { ...MOBILE_RUNTIME_PROFILE, reason: 'low-concurrency' };
  }

  // 6. Node/CLI/CI or unclassified desktop default
  return { ...DESKTOP_RUNTIME_PROFILE, reason: 'default-desktop' };
}
