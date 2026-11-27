/**
 * Live Memory Budget Tracker & Pressure Controller (§8.1, §16.2, §17.2)
 *
 * Tracks live memory usage across WASM linear memory, JS caches, and HEX-DB
 * shards/page caches. Computes pressure level (`normal` -> `soft` -> `hard` ->
 * `emergency`) against the active RuntimeProfile caps and automatically invokes
 * registered LRU evictors when approaching or exceeding soft/hard/emergency caps.
 */

import { detectRuntimeProfile, getRuntimeProfile } from './runtime-profile.js';

export const PRESSURE_NORMAL = 'normal';
export const PRESSURE_SOFT = 'soft';
export const PRESSURE_HARD = 'hard';
export const PRESSURE_EMERGENCY = 'emergency';

export const MEMORY_CATEGORY_WASM = 'wasmLinear';
export const MEMORY_CATEGORY_JS_CACHE = 'jsCache';
export const MEMORY_CATEGORY_HEXDB = 'hexdbShards';

function assertNonNegativeBytes(bytes, label) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`MEMORY_BUDGET_INVALID_BYTES(${label}): ${bytes}`);
  }
}

export class MemoryBudget {
  constructor(options = {}) {
    const profile = options.profile
      ? (typeof options.profile === 'string' || typeof options.profile === 'number'
        ? getRuntimeProfile(options.profile)
        : options.profile)
      : detectRuntimeProfile(options.detectOptions);

    this._profile = profile;
    this._softCapBytes = options.softCapBytes ?? profile.workerHeap.softCapBytes;
    this._hardCapBytes = options.hardCapBytes ?? profile.workerHeap.hardCapBytes;
    this._emergencyCapBytes = options.emergencyCapBytes ?? profile.workerHeap.emergencyCapBytes;
    this._maxCapBytes = options.maxCapBytes ?? profile.workerHeap.maxCapBytes;
    this._softTargetRatio = options.softTargetRatio ?? 0.85;
    this._hardTargetRatio = options.hardTargetRatio ?? 0.7;

    this._categories = new Map([
      [MEMORY_CATEGORY_WASM, 0],
      [MEMORY_CATEGORY_JS_CACHE, 0],
      [MEMORY_CATEGORY_HEXDB, 0],
    ]);
    this._evictors = new Map(); // name -> { name, category, priority, evict }
    this._listeners = new Set();
    this._level = PRESSURE_NORMAL;
    this._evictionCount = 0;
    this._bytesEvicted = 0;
    this._enforcing = false;
  }

  get profile() {
    return this._profile;
  }

  get tier() {
    return this._profile.tier;
  }

  get level() {
    return this._level;
  }

  get softCapBytes() {
    return this._softCapBytes;
  }

  get hardCapBytes() {
    return this._hardCapBytes;
  }

  get emergencyCapBytes() {
    return this._emergencyCapBytes;
  }

  get maxCapBytes() {
    return this._maxCapBytes;
  }

  get totalBytes() {
    let sum = 0;
    for (const v of this._categories.values()) sum += v;
    return sum;
  }

  getCategoryBytes(category) {
    return this._categories.get(String(category)) ?? 0;
  }

  /**
   * Switch runtime profile dynamically (e.g. user toggles Mobile/Desktop in settings).
   */
  setProfile(profileOrTier) {
    const profile = (typeof profileOrTier === 'string' || typeof profileOrTier === 'number')
      ? getRuntimeProfile(profileOrTier)
      : profileOrTier;
    this._profile = profile;
    this._softCapBytes = profile.workerHeap.softCapBytes;
    this._hardCapBytes = profile.workerHeap.hardCapBytes;
    this._emergencyCapBytes = profile.workerHeap.emergencyCapBytes;
    this._maxCapBytes = profile.workerHeap.maxCapBytes;
    return this.enforce();
  }

  /**
   * Register an LRU evictor callback invoked under memory pressure.
   * Lower `priority` number runs first (e.g. priority 0 = HEX-DB page cache, 10 = JS cache).
   * `evict(bytesToFree, level)` should return the actual number of bytes freed (synchronously).
   */
  registerEvictor(name, { category = null, priority = 10, evict }) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('MEMORY_BUDGET_EVICTOR_NAME_INVALID');
    }
    if (typeof evict !== 'function') {
      throw new TypeError('MEMORY_BUDGET_EVICTOR_FN_INVALID');
    }
    this._evictors.set(name, { name, category, priority, evict });
    return () => {
      this._evictors.delete(name);
    };
  }

  /**
   * Subscribe to pressure level transitions and eviction reports.
   */
  onPressureChange(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('MEMORY_BUDGET_LISTENER_INVALID');
    }
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  _computeLevel(total) {
    if (total >= this._emergencyCapBytes) return PRESSURE_EMERGENCY;
    if (total >= this._hardCapBytes) return PRESSURE_HARD;
    if (total >= this._softCapBytes) return PRESSURE_SOFT;
    return PRESSURE_NORMAL;
  }

  _emitPressure(prevLevel, nextLevel, evictedBytes, triggeredBy) {
    const event = {
      prevLevel,
      level: nextLevel,
      totalBytes: this.totalBytes,
      evictedBytes,
      triggeredBy,
      tier: this.tier,
      pauseBackground: nextLevel === PRESSURE_HARD || nextLevel === PRESSURE_EMERGENCY,
    };
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must never break budget enforcement.
      }
    }
  }

  /**
   * Set exact byte usage for a category and trigger pressure evaluation / LRU eviction.
   */
  setUsage(category, bytes) {
    const key = String(category);
    assertNonNegativeBytes(bytes, key);
    this._categories.set(key, bytes);
    return this.enforce(key);
  }

  /**
   * Add `bytes` to a category (e.g. WASM memory.grow or new shard allocation).
   */
  recordAllocation(category, bytes) {
    const key = String(category);
    assertNonNegativeBytes(bytes, key);
    const next = (this._categories.get(key) ?? 0) + bytes;
    this._categories.set(key, next);
    return this.enforce(key);
  }

  /**
   * Subtract `bytes` from a category (clamped at 0).
   */
  recordRelease(category, bytes) {
    const key = String(category);
    assertNonNegativeBytes(bytes, key);
    const prev = this._categories.get(key) ?? 0;
    this._categories.set(key, Math.max(0, prev - bytes));
    const prevLevel = this._level;
    const nextLevel = this._computeLevel(this.totalBytes);
    this._level = nextLevel;
    if (prevLevel !== nextLevel) {
      this._emitPressure(prevLevel, nextLevel, 0, key);
    }
    return this.getSnapshot();
  }

  /**
   * Evaluate current pressure and run registered LRU evictors if at/above softCapBytes.
   */
  enforce(triggeredBy = 'manual') {
    if (this._enforcing) return this.getSnapshot();
    this._enforcing = true;
    try {
      const prevLevel = this._level;
      let total = this.totalBytes;
      const initialLevel = this._computeLevel(total);
      let evictedThisPass = 0;

      if (initialLevel !== PRESSURE_NORMAL && this._evictors.size > 0) {
        let targetBytes;
        if (initialLevel === PRESSURE_EMERGENCY) {
          targetBytes = 0; // Purge all evictable caches
        } else if (initialLevel === PRESSURE_HARD) {
          targetBytes = Math.floor(this._softCapBytes * this._hardTargetRatio);
        } else {
          targetBytes = Math.floor(this._softCapBytes * this._softTargetRatio);
        }

        const sortedEvictors = [...this._evictors.values()]
          .sort((a, b) => (a.priority - b.priority) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        for (let i = 0; i < sortedEvictors.length; i++) {
          if (initialLevel !== PRESSURE_EMERGENCY && total <= targetBytes) break;
          const evictor = sortedEvictors[i];
          const needed = initialLevel === PRESSURE_EMERGENCY
            ? Math.max(1, total)
            : Math.max(0, total - targetBytes);
          if (needed <= 0) break;

          let freed = 0;
          try {
            const res = evictor.evict(needed, initialLevel);
            if (typeof res === 'number' && Number.isFinite(res) && res > 0) {
              freed = res;
            }
          } catch {
            freed = 0;
          }

          if (freed > 0) {
            if (evictor.category) {
              const cur = this._categories.get(evictor.category) ?? 0;
              this._categories.set(evictor.category, Math.max(0, cur - freed));
            }
            evictedThisPass += freed;
            this._bytesEvicted += freed;
            this._evictionCount += 1;
            total = this.totalBytes;
          }
        }
      }

      const finalLevel = this._computeLevel(this.totalBytes);
      this._level = finalLevel;

      if (finalLevel !== prevLevel || initialLevel !== prevLevel || evictedThisPass > 0) {
        this._emitPressure(prevLevel, finalLevel, evictedThisPass, triggeredBy);
      }

      return this.getSnapshot();
    } finally {
      this._enforcing = false;
    }
  }

  /**
   * Return the recommended HEX-DB page cache cap (bytes) for the current pressure level (§17.2).
   */
  recommendedHexDbCacheBytes() {
    const h = this._profile.hexdb;
    if (this._level === PRESSURE_EMERGENCY) return h.pageCacheEmergencyBytes;
    if (this._level === PRESSURE_HARD) return h.pageCacheHardBytes;
    if (this._level === PRESSURE_SOFT) return h.pageCacheSoftBytes;
    return h.pageCacheNormalBytes;
  }

  getSnapshot() {
    const categories = {};
    for (const [k, v] of this._categories) {
      categories[k] = v;
    }
    return Object.freeze({
      tier: this.tier,
      profileName: this._profile.name,
      level: this._level,
      totalBytes: this.totalBytes,
      softCapBytes: this._softCapBytes,
      hardCapBytes: this._hardCapBytes,
      emergencyCapBytes: this._emergencyCapBytes,
      maxCapBytes: this._maxCapBytes,
      recommendedHexDbCacheBytes: this.recommendedHexDbCacheBytes(),
      pauseBackground: this._level === PRESSURE_HARD || this._level === PRESSURE_EMERGENCY,
      evictionCount: this._evictionCount,
      bytesEvicted: this._bytesEvicted,
      categories: Object.freeze(categories),
    });
  }
}

export function createMemoryBudget(options) {
  return new MemoryBudget(options);
}
