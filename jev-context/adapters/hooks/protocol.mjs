import fs from "node:fs";
import path from "node:path";

const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

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

/** Reads all of stdin and parses it as a single JSON object. Never throws. */
export async function readHookInput(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8").trim();
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
    if (!filePath) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function save(state) {
    if (!filePath) return { saved: false };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
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
    } catch {
      const current = recent(sessionId);
      return [...current, appended].slice(-maxItems);
    }

    const lockPath = `${filePath}.lock`;
    const lock = acquireSessionLock(lockPath);
    if (lock == null) {
      // Contention must fail closed: return a truthful in-process view so this
      // decision does not misclassify the current item as a duplicate, but do
      // not overwrite another writer's state.
      const current = recent(sessionId);
      return [...current, appended].slice(-maxItems);
    }

    try {
      // Reload only after the lock is held. Every writer therefore extends the
      // latest committed state instead of racing from the same stale snapshot.
      const state = load();
      const items = Array.isArray(state[key]) ? [...state[key]] : [];
      items.push(appended);
      if (items.length > maxItems) items.splice(0, items.length - maxItems);
      state[key] = items;
      save(state);
      return items;
    } finally {
      releaseSessionLock(lockPath, lock);
    }
  }

  function recent(sessionId) {
    const state = load();
    const key = sessionId || "default";
    return Array.isArray(state[key]) ? state[key] : [];
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
