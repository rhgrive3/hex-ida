import fs from "node:fs";
import path from "node:path";

/**
 * Persisted runtime settings.
 *
 * Environment variables are the deployment-time contract; this file is the
 * *runtime* override so `jev-prune active` / `jev-prune off` persist across the
 * short-lived processes each host agent spawns for hooks and plugins. It stores
 * a mode and a timestamp — never a key, never conversation content.
 */

const ALLOWED_MODES = new Set(["off", "shadow", "active"]);

export function createSettingsStore(options = {}) {
  const filePath = options.path;

  function load() {
    if (!filePath) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return {};
      const result = {};
      if (typeof parsed.mode === "string" && ALLOWED_MODES.has(parsed.mode)) result.mode = parsed.mode;
      if (typeof parsed.updatedAt === "string") result.updatedAt = parsed.updatedAt;
      return result;
    } catch {
      // Missing or corrupt settings mean "use the environment defaults".
      return {};
    }
  }

  function save(patch) {
    if (!filePath) return { saved: false };
    const current = load();
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if (next.mode && !ALLOWED_MODES.has(next.mode)) delete next.mode;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      return { saved: true, settings: next };
    } catch (error) {
      return { saved: false, error: String(error && error.message ? error.message : error).slice(0, 200) };
    }
  }

  function clear() {
    if (!filePath) return { cleared: false };
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { cleared: true };
    } catch {
      return { cleared: false };
    }
  }

  return { load, save, clear };
}
