import fs from "node:fs";
import path from "node:path";

/**
 * Decision cache — the reason OpenJEV usage does not grow with session length.
 *
 * Keyed by content digest (content + tool + scope + policy version), so:
 *   - the same tool result is never classified twice;
 *   - a changed file/command output produces a new digest and therefore a fresh
 *     judgement instead of a stale one.
 *
 * This is deliberately NOT a provider prompt cache. It stores only the local
 * verdict (`keep`/`drop` plus scores), never conversation content, and lives
 * entirely on disk here. `jev-prune cache clear` removes it.
 *
 * The cache is a performance device, never a correctness device: a corrupt,
 * truncated or unreadable file degrades to "no cached decisions" and the run
 * continues.
 */

const MAX_ENTRIES = 20000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function acquireLock(lockPath, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid} ${Date.now()}\n`);
      return fd;
    } catch (error) {
      if (!error || error.code !== "EEXIST") return null;
      if (Date.now() >= deadline) return null;
      // Fail-open backoff: wait up to 10ms or remaining time.
      Atomics.wait(LOCK_SLEEP, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseLock(lockPath, fd) {
  try {
    if (fd != null) fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

export function createDecisionCache(options = {}) {
  const filePath = options.path;
  const policyVersion = options.policyVersion || "";
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : MAX_ENTRIES;
  const lockTimeoutMs = Number.isInteger(options.lockTimeoutMs) && options.lockTimeoutMs > 0
    ? options.lockTimeoutMs
    : 3000;

  let entries = new Map();
  const dirtyKeys = new Set();
  let loaded = false;
  let recovered = false;
  let corrupt = false;
  let hits = 0;
  let misses = 0;

  function load() {
    if (loaded) return summary();
    loaded = true;
    if (!filePath) return summary();
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const source = parsed && typeof parsed === "object" && parsed.entries ? parsed.entries : parsed;
      if (source && typeof source === "object") {
        for (const [key, value] of Object.entries(source)) {
          if (value && typeof value === "object" && value.v === policyVersion) {
            entries.set(key, value);
          }
        }
      }
      // A file that parsed but carried a different policy version is not
      // "corrupt", it is simply superseded; entries were filtered above.
      recovered = loaded !== 0 && entries.size === 0 && raw.trim().length > 0;
    } catch (error) {
      // Missing file is normal; anything else is recorded and discarded.
      if (error && error.code !== "ENOENT") {
        corrupt = true;
        recovered = true;
      }
      entries = new Map();
    }
    return summary();
  }

  function get(digest) {
    load();
    const entry = entries.get(digest);
    if (!entry || entry.v !== policyVersion) {
      misses += 1;
      return null;
    }
    hits += 1;
    return entry;
  }

  function set(digest, decision) {
    load();
    if (!digest) return;
    const entry = {
      a: decision.action,
      c: decision.confidence ?? 0,
      p: decision.dropProbability ?? 0,
      r: decision.reason || "",
      v: policyVersion,
      t: decision.timestamp || Date.now(),
    };
    entries.set(digest, entry);
    dirtyKeys.add(digest);

    // Bounded growth: drop the oldest insertion order entries.
    if (entries.size > maxEntries) {
      const overflow = entries.size - maxEntries;
      let index = 0;
      for (const key of entries.keys()) {
        if (index >= overflow) break;
        entries.delete(key);
        dirtyKeys.delete(key);
        index += 1;
      }
    }
  }

  function save() {
    if (!filePath || dirtyKeys.size === 0) return { saved: false };
    const lockPath = `${filePath}.lock`;
    const tmp = `${filePath}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (error) {
      return { saved: false, error: String(error && error.message ? error.message : error).slice(0, 200) };
    }

    const lock = acquireLock(lockPath, { timeoutMs: lockTimeoutMs });
    if (lock == null) {
      return { saved: false, error: "could not acquire cache lock" };
    }

    try {
      let diskEntries = new Map();
      try {
        if (fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, "utf8");
          const parsed = JSON.parse(raw);
          const source = parsed && typeof parsed === "object" && parsed.entries ? parsed.entries : parsed;
          if (source && typeof source === "object") {
            for (const [key, value] of Object.entries(source)) {
              if (value && typeof value === "object" && value.v === policyVersion) {
                diskEntries.set(key, value);
              }
            }
          }
        }
      } catch (error) {
        if (error && error.code !== "ENOENT") {
          corrupt = true;
          recovered = true;
        }
        diskEntries = new Map();
      }

      // Merge this writer's dirty decisions into the latest on-disk entries
      for (const key of dirtyKeys) {
        const entry = entries.get(key);
        if (entry) {
          diskEntries.delete(key);
          diskEntries.set(key, entry);
        }
      }

      if (diskEntries.size > maxEntries) {
        const overflow = diskEntries.size - maxEntries;
        let index = 0;
        for (const key of diskEntries.keys()) {
          if (index >= overflow) break;
          diskEntries.delete(key);
          index += 1;
        }
      }

      const payload = {
        policyVersion,
        savedAt: new Date().toISOString(),
        entries: Object.fromEntries(diskEntries),
      };
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      entries = diskEntries;
      dirtyKeys.clear();
      loaded = true;
      return { saved: true, entries: entries.size };
    } catch (error) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return { saved: false, error: String(error && error.message ? error.message : error).slice(0, 200) };
    } finally {
      releaseLock(lockPath, lock);
    }
  }

  function clear() {
    load();
    const removed = entries.size;
    entries = new Map();
    dirtyKeys.clear();
    const lockPath = filePath ? `${filePath}.lock` : null;
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
    try {
      if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    return { removed };
  }

  function summary() {
    return { size: entries.size, hits, misses, corrupt, recovered, policyVersion };
  }

  return {
    load,
    get,
    set,
    save,
    clear,
    summary,
    get hitCount() {
      return hits;
    },
    get missCount() {
      return misses;
    },
  };
}
