import fs from "node:fs";
import path from "node:path";

const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

/**
 * Maximum raw hook stdin accepted before JSON parsing. The 1 MiB envelope is
 * intentionally larger than the default 24,000-token classification-state
 * budget, while bounding the host payload before the parser can materialize it.
 */
export const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

function acquireSessionLock(lockPath, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid} ${Date.now()}\n`);
      return fd;
    } catch (error) {
      if (!error || error.code !== "EEXIST") return null;
      if (Date.now() >= deadline) return null;
      // Do not try to reap a "stale" lock here. An unlink-after-stat scheme has
      // an ABA race where one waiter can delete a different process's newly
      // acquired lock. A leftover lock therefore degrades to the safe path
      // below (no persisted observation) until an operator clears it.
      Atomics.wait(LOCK_SLEEP, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseSessionLock(lockPath, fd) {
  try { fs.closeSync(fd); } catch { /* ignore */ }
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

/**
 * Shared hook protocol for hosts whose extension point is an external command
 * that receives JSON on stdin and writes JSON on stdout.
 *
 * Both Codex and Agy use a Claude-compatible hook shape:
 *   input:  { session_id, hook_event_name, tool_name, tool_input, ... }
 *   output: { continue, hookSpecificOutput: { ... } }
 *
 * Both hosts run Claude-compatible lifecycle hooks, but their *capability* is
 * not the same, and the difference is the whole point of this module:
 *
 *   Agy 1.2.7 — `PostToolUse` may return `overwrite_result`, which the host's
 *   own schema describes as "Replaces the result of the tool call that just ran
 *   with this string. The model is told that the result was replaced." That is
 *   a real, supported context rewrite at the moment of production.
 *
 *   Codex 0.155.1 — `PostToolUseHookSpecificOutputWire` offers only
 *   `updatedMCPToolOutput`, and the binary rejects it for anything else
 *   ("PostToolUse hook returned unsupported updatedMCPToolOutput"). So on Codex
 *   a hook can observe, but cannot rewrite a shell/file tool result.
 *
 * Neither host hands a hook the assembled message array, so neither can revise
 * an *older* item on a later call. For Agy the drop is therefore decided at
 * write time; for Codex real removal happens in `proxy/server.mjs`, wired
 * through Codex's own supported `model_providers.<id>.base_url`.
 */

/**
 * Reads a bounded stdin body and parses it as a single JSON object. Invalid JSON
 * remains a no-op; streams over the byte budget are destroyed and rejected so
 * adapters can fail open without observing or recording a partial event.
 */
export async function readHookInput(stream = process.stdin) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const chunkBytes = Buffer.byteLength(chunk);
    const nextTotalBytes = totalBytes + chunkBytes;
    if (nextTotalBytes > MAX_HOOK_INPUT_BYTES) {
      try {
        stream.destroy?.();
      } catch {
        /* rejecting the body is still required if a custom stream cannot close */
      }
      const error = new Error(
        `hook stdin is ${nextTotalBytes} bytes; the maximum supported size is ${MAX_HOOK_INPUT_BYTES} bytes`,
      );
      error.code = "JEV_HOOK_INPUT_TOO_LARGE";
      throw error;
    }

    totalBytes = nextTotalBytes;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks, totalBytes).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Writes a hook response and exits 0. Fail-open: an empty object is acceptable. */
export function writeHookOutput(payload = {}, stream = process.stdout) {
  try {
    stream.write(JSON.stringify(payload));
  } catch {
    /* nothing else we can do; the host treats silence as "no opinion" */
  }
}

/**
 * Per-session store of observed tool results.
 *
 * Hooks are stateless processes, so supersession ("a newer read of this file
 * replaced the older one") has to be reconstructed from a small on-disk record.
 * Only metadata plus a bounded excerpt is stored — never secrets, never a full
 * transcript, and it lives under the tool's own state directory.
 */
export function createSessionStore(options = {}) {
  const filePath = options.path;
  const maxItems = options.maxItems || 400;

  function load() {
    const state = Object.create(null);
    if (!filePath) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          if (Array.isArray(value)) {
            state[key] = value;
          }
        }
      }
      return state;
    } catch {
      return Object.create(null);
    }
  }

  function save(state) {
    if (!filePath) return { saved: false };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      const serialized = Object.create(null);
      if (state && typeof state === "object") {
        for (const [key, value] of Object.entries(state)) {
          if (Array.isArray(value)) {
            serialized[key] = value;
          }
        }
      }
      fs.writeFileSync(tmp, JSON.stringify(serialized), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      return { saved: true };
    } catch {
      return { saved: false };
    }
  }

  function remember(sessionId, entry) {
    const key = sessionId || "default";
    const appended = { ...entry, at: Date.now() };
    if (!filePath) return [appended];

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (cause) {
      const error = new Error(`jev session store directory unavailable: ${path.dirname(filePath)}`);
      error.code = "JEV_SESSION_STORE_DIRECTORY_UNAVAILABLE";
      error.cause = cause;
      throw error;
    }

    const lockPath = `${filePath}.lock`;
    const lock = acquireSessionLock(lockPath, { timeoutMs: options.lockTimeoutMs || 1000 });
    if (lock == null) {
      const error = new Error(`jev session store lock unavailable: ${lockPath}`);
      error.code = "JEV_SESSION_STORE_LOCK_UNAVAILABLE";
      throw error;
    }

    try {
      // Reload only after the lock is held. Every writer therefore extends the
      // latest committed state instead of racing from the same stale snapshot.
      const state = load();
      const existing = Object.prototype.hasOwnProperty.call(state, key) && Array.isArray(state[key])
        ? state[key]
        : [];
      const items = [...existing, appended];
      if (items.length > maxItems) items.splice(0, items.length - maxItems);
      state[key] = items;
      const saved = save(state);
      if (!saved.saved) {
        const error = new Error(`jev session store save failed: ${filePath}`);
        error.code = "JEV_SESSION_STORE_SAVE_FAILED";
        throw error;
      }
      return items;
    } finally {
      releaseSessionLock(lockPath, lock);
    }
  }

  function recent(sessionId) {
    const state = load();
    const key = sessionId || "default";
    return Object.prototype.hasOwnProperty.call(state, key) && Array.isArray(state[key])
      ? state[key]
      : [];
  }

  /**
   * digest -> how many times this exact content already appeared in the session.
   *
   * This is what lets the write-time path recognise a repeat without holding the
   * earlier text: only a 32-hex digest and a size are stored, never content.
   */
  function digestCounts(sessionId) {
    const counts = new Map();
    for (const entry of recent(sessionId)) {
      if (!entry || !entry.digest) continue;
      counts.set(entry.digest, (counts.get(entry.digest) || 0) + 1);
    }
    return counts;
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

  return { load, save, remember, recent, digestCounts, clear };
}

/** Derives the engine's resource grouping from a hook tool name and input. */
export function deriveMetaFromHook(toolName, toolInput) {
  const tool = String(toolName || "").toLowerCase();
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const filePath = input.file_path || input.filePath || input.path || input.filename || null;
  const command = input.command || input.cmd || null;
  const pattern = input.pattern || input.query || null;

  if (tool.includes("read")) return { group: "file", resourceKey: filePath ? `file:${filePath}` : null, filePath };
  if (tool.includes("edit") || tool.includes("write") || tool.includes("replace")) {
    return { group: "diff", resourceKey: filePath ? `edit:${filePath}` : null, filePath };
  }
  if (tool.includes("grep") || tool.includes("glob") || tool.includes("search")) {
    return { group: "search", resourceKey: pattern ? `search:${pattern}` : null, pattern };
  }
  if (tool.includes("bash") || tool.includes("shell") || tool.includes("exec") || tool.includes("terminal")) {
    return { group: "command", resourceKey: command ? `cmd:${command}` : null, command };
  }
  if (tool.includes("todo") || tool.includes("plan")) return { group: "status", resourceKey: "todos" };
  return { group: "other", resourceKey: null };
}

/**
 * Extracts the tool output text from a hook payload. Hosts differ on the field
 * name, so every known spelling is checked rather than assuming one.
 */
export function hookToolOutput(payload) {
  const candidates = [
    payload.tool_response,
    payload.tool_output,
    payload.tool_result,
    payload.output,
    payload.response,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      if (typeof candidate.output === "string") return candidate.output;
      if (typeof candidate.content === "string") return candidate.content;
      if (typeof candidate.stdout === "string") return candidate.stdout;
      try {
        return JSON.stringify(candidate);
      } catch {
        continue;
      }
    }
  }
  return "";
}
