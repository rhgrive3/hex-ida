import { createPipeline } from "../../core/pipeline.mjs";

/**
 * OpenCode adapter — the primary integration.
 *
 * Extension point (verified against @opencode-ai/plugin 1.18.29's Hooks
 * interface, which ships inside this repository at
 * `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`):
 *
 *   "experimental.chat.messages.transform"?: (
 *     input: {},
 *     output: { messages: { info: Message; parts: Part[] }[] },
 *   ) => Promise<void>
 *
 * This hook receives the *assembled* messages for one model call. Mutating
 * `output.messages` changes only what the provider is sent. The session store —
 * the persisted conversation — is written earlier and is not touched here, so a
 * "drop" can never destroy user history. That is exactly the contract the
 * pruning engine needs.
 *
 * Pairing safety: an assistant tool call without its result is rejected by most
 * providers, so a dropped tool part is replaced by a non-generative tombstone
 * (call id, tool name, token count) rather than removed. The bulky output is
 * gone; the call/result invariant survives. Set
 * JEV_PRUNING_OPENCODE_TOMBSTONE=false to omit parts outright.
 */

const ROLE_BY_INFO = { user: "user", assistant: "assistant", system: "system", developer: "developer" };
const TOOL_ALLOWLIST = new Set(["bash", "shell", "exec", "read", "write", "edit", "patch", "multiedit", "grep", "glob", "search", "list", "find", "webfetch", "fetch", "task", "todowrite", "todoread"]);

function firstString(...values) {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/** Maps an OpenCode tool + input onto the engine's resource grouping. */
export function deriveMeta(tool, input) {
  const args = input && typeof input === "object" ? input : {};
  const filePath = firstString(args.filePath, args.file_path, args.path, args.filename);
  const command = firstString(args.command, args.cmd, args.script);
  const pattern = firstString(args.pattern, args.query, args.regex);

  switch (tool) {
    case "read":
      return { group: "file", resourceKey: filePath ? `file:${filePath}` : null, filePath };
    case "write":
    case "edit":
    case "patch":
    case "multiedit":
      return { group: "diff", resourceKey: filePath ? `edit:${filePath}` : null, filePath };
    case "bash":
    case "shell":
    case "exec":
      return { group: "command", resourceKey: command ? `cmd:${command}` : null, command };
    case "grep":
    case "glob":
    case "search":
    case "list":
    case "find":
      return {
        group: "search",
        resourceKey: pattern || filePath ? `search:${pattern || ""}:${filePath || ""}` : null,
        pattern,
      };
    case "todowrite":
    case "todoread":
      return { group: "status", resourceKey: "todos" };
    default:
      return { group: "other", resourceKey: null };
  }
}

/**
 * Flattens OpenCode's assembled messages into engine items while remembering
 * where each item lives so a decision can be applied back to the exact part.
 */
export function extractItems(messages) {
  const items = [];
  const refs = new Map();
  let position = 0;

  for (const message of messages || []) {
    const info = message && message.info ? message.info : {};
    const role = ROLE_BY_INFO[info.role] || (info.role === "tool" ? "tool" : "assistant");
    for (const part of (message && message.parts) || []) {
      if (!part || typeof part !== "object") continue;

      if (part.type === "tool") {
        const state = part.state || {};
        const completed = state.status === "completed";
        const failed = state.status === "error";
        const text = completed ? String(state.output ?? "") : failed ? String(state.error ?? "") : "";
        items.push({
          id: String(part.id || part.callID || `part_${position}`),
          role: "tool",
          tool: String(part.tool || "unknown"),
          text,
          position,
          meta: deriveMeta(part.tool, state.input),
          flags: {},
        });
        refs.set(items[items.length - 1].id, { part, kind: "tool", message });
        position += 1;
        continue;
      }

      // Everything else is context we never prune, but it must still occupy a
      // position so the prefix/recency boundaries are computed correctly.
      const text =
        typeof part.text === "string" ? part.text : typeof part.content === "string" ? part.content : "";
      items.push({
        id: String(part.id || `part_${position}`),
        role,
        tool: null,
        text,
        position,
        meta: {},
        flags: {},
      });
      refs.set(items[items.length - 1].id, { part, kind: "other", message });
      position += 1;
    }
  }

  return { items, refs };
}

function tombstone(item, plan) {
  const stats = plan.stats || {};
  return `[jev-prune] ${stats.dropped || 0} stale tool output(s) omitted from this request; ` +
    `this call's output (${item.tokens} tokens, tool=${item.tool || "unknown"}) was pruned as ` +
    `superseded, duplicated or verbose. Ask again if you need it.`;
}

export const id = "jev-prune";

/**
 * The plugin factory. OpenCode calls this once per session.
 *
 * Every failure path returns silently: if the engine, the network or the
 * configuration is broken, the host still receives the unmodified context.
 */
export const JevPrunePlugin = async () => {
  let pipeline = null;
  let bootstrapError = null;
  try {
    pipeline = createPipeline();
  } catch (error) {
    bootstrapError = error;
  }

  const tombstoneEnabled = String(process.env.JEV_PRUNING_OPENCODE_TOMBSTONE ?? "true").toLowerCase() !== "false";

  return {
    event: async () => {},

    "experimental.chat.messages.transform": async (_hookInput, output) => {
      if (bootstrapError) return; // fail-open
      if (!pipeline || !pipeline.config.usable) return; // disabled / no key / off
      if (!output || !Array.isArray(output.messages) || output.messages.length === 0) return;

      try {
        const { items, refs } = extractItems(output.messages);
        if (items.length === 0) return;

        // Only tool results are ever candidates, so a context with none is free.
        if (!items.some((item) => item.role === "tool")) return;

        const scope = (output.messages[0] && output.messages[0].info && output.messages[0].info.sessionID) || "opencode";
        const taskText = lastUserText(output.messages);

        const { plan } = await pipeline.run(items, {
          scope: String(scope),
          taskText,
          mode: pipeline.config.mode,
        });

        // Background classification of items that were kept only because their
        // judgement was not ready. Deliberately not awaited on this path.
        if (pipeline.config.background && plan.stats.cacheMisses > 0) {
          void pipeline.prewarm(items, { scope: String(scope), taskText });
        }

        const dropped = plan.decisions.filter((decision) => decision.action === "drop");
        if (dropped.length === 0) {
          pipeline.saveState();
          return;
        }

        if (tombstoneEnabled) {
          for (const decision of dropped) {
            const ref = refs.get(decision.id);
            if (!ref || ref.kind !== "tool") continue;
            const item = items.find((candidate) => candidate.id === decision.id);
            if (!item || !ref.part.state) continue;
            ref.part.state.output = tombstone(item, plan);
          }
        } else {
          const dropIds = new Set(dropped.map((decision) => decision.id));
          for (const message of output.messages) {
            if (!Array.isArray(message.parts)) continue;
            message.parts = message.parts.filter((part) => !(part && part.type === "tool" && dropIds.has(String(part.id))));
          }
        }

        pipeline.saveState();
      } catch (error) {
        // Never let pruning break a model call.
        return;
      }
    },
  };
};

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = message && message.info ? message.info.role : null;
    if (role !== "user") continue;
    const text = (message.parts || [])
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text) return text;
  }
  return "";
}

export default JevPrunePlugin;
export { TOOL_ALLOWLIST };
