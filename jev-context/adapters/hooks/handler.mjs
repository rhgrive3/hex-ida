import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPipeline } from "../../core/pipeline.mjs";
import { loadConfig } from "../../core/config.mjs";
import { createSessionStore, deriveMetaFromHook, hookToolOutput } from "./protocol.mjs";
import { decisionDigest } from "../../core/digest.mjs";
import { POLICY_VERSION, loadConfig as loadEngineConfig } from "../../core/config.mjs";

/**
 * Shared handler for hosts whose extension point is a lifecycle hook.
 *
 * Capability boundary, stated plainly: neither Codex nor Agy exposes a hook that
 * receives (or can rewrite) the assembled message array. Their events are
 * PreToolUse / PostToolUse / PermissionRequest / PreCompact and session
 * boundaries. Therefore this handler cannot, and does not pretend to, remove an
 * item from a model request.
 *
 * What it does instead:
 *   - records each tool result as it is produced, so supersession between two
 *     reads of the same file is reconstructible;
 *   - classifies that output in a *detached* process, keeping OpenJEV entirely
 *     off the host's critical path and keeping the shared decision cache warm;
 *   - answers PreCompact with guidance, the one event where the host is
 *     actively choosing what to drop.
 */

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "prewarm-worker.mjs");

/** What must never be summarised away, stated once for every host that can accept it. */
export const PRESERVE_GUIDANCE =
  "Preserve verbatim: unresolved errors and their exact messages, the current state of files being " +
  "edited, the newest test/build result, explicit user constraints, and path/branch identity. " +
  "Bulk progress output, superseded file snapshots and resolved failures may be summarised or dropped.";

/**
 * Identity for repeated output, computed with the engine's own digest function.
 *
 * This must stay identical to `makeItem()`'s digest — scope and policy version
 * included — or a remembered item would never match the item the pruning
 * pipeline later hashes, and duplicate detection would silently never fire.
 */
export function contentDigest(text, tool, scope, policyVersion) {
  return decisionDigest({
    content: String(text ?? ""),
    tool: tool || null,
    scope: scope || "default",
    policyVersion: policyVersion || POLICY_VERSION,
  });
}

/**
 * Best-effort structured logger for hook processes.
 *
 * Diagnostics only, and deliberately content-free: it records the event, the
 * reason and a token count, never tool output and never a credential. A logging
 * failure is swallowed, because the host must not care whether we could log.
 */
export function createHookLogger(config) {
  return function log(event, detail = {}) {
    try {
      if (!config || !config.logPath) return;
      fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
      fs.appendFileSync(config.logPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`, {
        mode: 0o600,
      });
    } catch {
      /* logging must never be the reason a hook fails */
    }
  };
}

function spawnPrewarm(job) {
  try {
    const child = spawn(process.execPath, [WORKER], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env,
    });
    child.on("error", () => {});
    try {
      child.stdin.end(JSON.stringify(job));
    } catch {
      /* ignore */
    }
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function handleHookEvent(payload, options = {}) {
  const host = options.host || "hook";
  const engine = options.engineConfig || loadEngineConfig();
  const store =
    options.store ||
    createSessionStore({ path: options.storePath || path.join(engine.home, `${host}-sessions.json`) });

  const event = String(payload.hook_event_name || payload.event || "").trim();
  const sessionId = String(payload.session_id || payload.sessionId || "default");

  if (event === "SessionStart") {
    return { response: {}, note: "session-start" };
  }

  if (event === "SessionEnd") {
    return { response: {}, note: "session-end" };
  }

  if (event === "PostToolUse" || event === "AfterTool") {
    const output = hookToolOutput(payload);
    if (!output) return { response: {} };

    const toolName = String(payload.tool_name || payload.toolName || "unknown");
    const meta = deriveMetaFromHook(toolName, payload.tool_input || payload.toolInput);

    const scope = `${host}:${sessionId}`;
    const remembered = store.remember(sessionId, {
      tool: toolName,
      group: meta.group,
      resourceKey: meta.resourceKey,
      chars: output.length,
      digest: contentDigest(output, toolName, scope, engine.policyVersion),
    });
    options.onObserved?.({ sessionId, toolName, meta, output, remembered });

    // Detached: the host answers this tool call immediately while OpenJEV is
    // consulted in the background. Nothing in this branch can block the agent.
    if (options.pipelineAvailable !== false) {
      spawnPrewarm({
        scope,
        items: [
          {
            id: String(payload.tool_use_id || payload.toolUseId || `tool_${Date.now()}`),
            role: "tool",
            tool: toolName,
            text: output,
            position: 0,
            meta,
            flags: {},
          },
        ],
      });
    }
    return { response: {}, note: "post-tool-use" };
  }

  if (event === "PreCompact") {
    // The compaction step is the one place the host is actively choosing what to
    // drop, so guidance here is valuable *where the host accepts it*. Codex
    // 0.155.1 only lists `additionalContext` on PreToolUse / SessionStart /
    // UserPromptSubmit hook-specific outputs, and warns "this event cannot emit
    // additionalContext" elsewhere, so we do not speculate: a host opts in
    // through `additionalContextEvents`.
    if (options.additionalContextEvents && options.additionalContextEvents.has("PreCompact")) {
      return {
        response: {
          hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: PRESERVE_GUIDANCE },
        },
        note: "pre-compact",
      };
    }
    return { response: {}, note: "pre-compact-unsupported" };
  }

  return { response: {} };
}

export { spawnPrewarm };
