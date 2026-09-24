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

export function createDecisionCache(options = {}) {
  const filePath = options.path;
  const policyVersion = options.policyVersion || "";
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : MAX_ENTRIES;

  let entries = new Map();
  let loaded = false;
  let recovered = false;
  let corrupt = false;
  let hits = 0;
  let misses = 0;
  let dirty = false;

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
    entries.set(digest, {
      a: decision.action,
      c: decision.confidence ?? 0,
      p: decision.dropProbability ?? 0,
      r: decision.reason || "",
      v: policyVersion,
      t: decision.timestamp || Date.now(),
    });
    dirty = true;
    // Bounded growth: drop the oldest insertion order entries.
    if (entries.size > maxEntries) {
      const overflow = entries.size - maxEntries;
      let index = 0;
      for (const key of entries.keys()) {
        if (index >= overflow) break;
        entries.delete(key);
        index += 1;
      }
    }
  }

  function save() {
    if (!filePath || !dirty) return { saved: false };
    // The temp name must be unique per writer: several sessions (and several
    // engine instances inside one process) can save concurrently, and a shared
    // temp path would let one rename rob another of its file.
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = { policyVersion, savedAt: new Date().toISOString(), entries: Object.fromEntries(entries) };
      // Write-then-rename so a crash can never leave a half-written cache that
      // later reads as a valid-but-truncated decision set.
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      dirty = false;
      return { saved: true, entries: entries.size };
    } catch (error) {
      // A cache write failure is not a task failure.
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return { saved: false, error: String(error && error.message ? error.message : error).slice(0, 200) };
    }
  }

  function clear() {
    load();
    const removed = entries.size;
    entries = new Map();
    dirty = false;
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
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
