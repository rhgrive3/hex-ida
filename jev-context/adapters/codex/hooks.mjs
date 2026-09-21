#!/usr/bin/env node
import { readHookInput, writeHookOutput } from "../hooks/protocol.mjs";
import { handleHookEvent } from "../hooks/handler.mjs";

/**
 * Codex hook command entrypoint (version 0.155.1).
 *
 * What Codex 0.155.1 actually provides, read out of the binary itself:
 *
 *   HookEventsToml = PreToolUse, PermissionRequest, PostToolUse, PreCompact,
 *                    PostCompact, SessionStart, SessionEnd, SubagentStart,
 *                    SubagentStop, Interrupt   (+ user_prompt_submit in TOML)
 *   HookHandlerConfig = Command { command, env, cwd, timeout, async,
 *                                 statusMessage } | McpTool
 *   hook input  = session_id, turn_id, agent_type, transcript_path,
 *                 hook_event_name, model, permission_mode, trigger,
 *                 tool_name, tool_input, tool_use_id, tool_response
 *   hook output = continue, reason, stopReason, suppressOutput, systemMessage,
 *                 decision, hookSpecificOutput
 *   hook-specific outputs =
 *     PreToolUseHookSpecificOutputWire        { hookEventName, permissionDecision,
 *                                               permissionDecisionReason,
 *                                               additionalContext, ... }
 *     PostToolUseHookSpecificOutputWire       { updatedMCPToolOutput, ... }
 *     SessionStart / SubagentStart / UserPromptSubmit /
 *     PermissionRequest HookSpecificOutputWire
 *
 * The decisive detail is the PostToolUse output wire: its only content-bearing
 * field is `updatedMCPToolOutput`, and the binary refuses it for anything else
 * — "PostToolUse hook returned unsupported updatedMCPToolOutput". So a Codex
 * hook can not rewrite the result of a shell, file, or search tool call. Nor
 * does any event receive the assembled message array.
 *
 * Conclusion, and the reason this file is observe-only: **Codex 0.155.1 has no
 * supported hook that prunes context.** What it does have is a supported way to
 * redirect a model request — `model_providers.<id>.base_url` — and that is where
 * Codex pruning is implemented (`proxy/server.mjs`), together with this hook
 * warming the shared decision cache so the proxy's decisions are instant.
 *
 * Contract: always exit 0 with valid JSON. A hook that fails must not fail the
 * tool call, so every error path emits `{}`.
 */
async function main() {
  let payload = {};
  try {
    payload = await readHookInput();
  } catch {
    writeHookOutput({});
    process.exit(0);
  }

  try {
    const { response } = await handleHookEvent(payload, {
      host: "codex",
      // No event is listed here on purpose: 0.155.1 warns "this event cannot
      // emit additionalContext" for events outside its allowlist, and we have
      // no proof PreCompact is inside it. Speculating would produce a silent
      // no-op that looks like a working feature.
      additionalContextEvents: new Set(),
    });
    writeHookOutput(response || {});
  } catch {
    writeHookOutput({});
  }
  process.exit(0);
}

main();
