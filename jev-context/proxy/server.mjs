import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createPipeline } from "../core/pipeline.mjs";

/**
 * Pruning proxy.
 *
 * Why this exists: not every host exposes a hook that can rewrite an assembled
 * model request. Codex is the clearest case — its hook system is stable and
 * enabled, but its events (PreToolUse, PermissionRequest, PostToolUse,
 * PreCompact, PostCompact, SessionStart, SessionEnd, SubagentStart/Stop,
 * Interrupt) describe tool and session lifecycle, not the message array. The
 * supported way to influence what Codex sends to a model is to point a
 * `model_provider` at a different `base_url`.
 *
 * This server is that `base_url`. It accepts an OpenAI-shaped request (Responses
 * or Chat Completions), prunes stale tool output, and forwards a byte-identical
 * stream back. Anything unexpected — a body it cannot parse, a host it cannot
 * reach, an internal error — results in the *original* request being forwarded
 * unchanged.
 *
 * Latency policy: by default (`JEV_PRUNING_BACKGROUND=true`) the proxy applies
 * only decisions that are already cached, so a model request never waits on
 * OpenJEV. New tool output is classified in the background and takes effect on
 * the following request.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function groupForToolName(name) {
  const tool = String(name || "").toLowerCase();
  if (tool.includes("read") || tool === "cat") return { group: "file" };
  if (tool.includes("edit") || tool.includes("write") || tool.includes("patch")) return { group: "diff" };
  if (tool.includes("grep") || tool.includes("search") || tool.includes("glob") || tool.includes("find")) {
    return { group: "search" };
  }
  if (tool.includes("shell") || tool.includes("bash") || tool.includes("exec") || tool.includes("command")) {
    return { group: "command" };
  }
  return { group: "other" };
}

/** Extracts prunable items from an OpenAI Responses API request body. */
export function extractResponsesInput(body) {
  const input = Array.isArray(body.input) ? body.input : null;
  if (!input) return null;
  const items = [];
  const refs = [];
  let position = 0;
  for (let i = 0; i < input.length; i += 1) {
    const entry = input[i];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const isToolResult = entry.type === "function_call_output" || entry.type === "local_shell_call_output" || entry.role === "tool";
    if (isToolResult) {
      const text = typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output ?? entry.content ?? "");
      const callId = entry.call_id || entry.id || `out_${i}`;
      items.push({
        id: String(callId),
        role: "tool",
        tool: entry.name || entry.tool || "tool",
        text,
        position,
        meta: groupForToolName(entry.name || entry.tool),
        flags: {},
      });
      refs.push({ index: i, kind: "responses" });
      position += 1;
      continue;
    }
    const isMessage = entry.type === "message" || typeof entry.role === "string";
    const role = entry.role === "user" ? "user" : entry.role === "system" || entry.role === "developer" ? entry.role : "assistant";
    // Reasoning/function-call entries are assistant-side and never pruned, but
    // they still occupy a position so boundaries are correct.
    items.push({
      id: String(entry.id || `entry_${i}`),
      role: isMessage ? role : "assistant",
      tool: null,
      text: "",
      position,
      meta: {},
      flags: {},
    });
    refs.push({ index: i, kind: isMessage ? "other" : "asis" });
    position += 1;
  }
  return { items, refs };
}

/** Extracts prunable items from an OpenAI Chat Completions request body. */
export function extractChatMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return null;
  const items = [];
  const refs = [];
  let position = 0;

  // Chat Completions requires every tool_call to be answered by a tool message,
  // so a pruned tool message is rewritten rather than removed.
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    if (message.role === "tool") {
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      items.push({
        id: String(message.tool_call_id || `tool_${i}`),
        role: "tool",
        tool: message.name || "tool",
        text,
        position,
        meta: groupForToolName(message.name),
        flags: {},
      });
      refs.push({ index: i, kind: "chat" });
      position += 1;
      continue;
    }
    const role = message.role === "user" ? "user" : message.role === "system" || message.role === "developer" ? message.role : "assistant";
    items.push({
      id: `msg_${i}`,
      role,
      tool: null,
      text: typeof message.content === "string" ? message.content : "",
      position,
      meta: {},
      flags: {},
    });
    refs.push({ index: i, kind: "asis" });
    position += 1;
  }
  return { items, refs };
}

function applyToResponses(body, extracted, plan) {
  const dropped = new Set(plan.decisions.filter((decision) => decision.action === "drop").map((decision) => decision.id));
  if (dropped.size === 0) return { changed: false };
  let changed = false;
  extracted.refs.forEach((ref, index) => {
    if (ref.kind !== "responses") return;
    const item = extracted.items[index];
    if (!dropped.has(item.id)) return;
    const entry = body.input[ref.index];
    if (!entry) return;
    entry.output = `[jev-prune] this tool output (${item.tokens} tokens) was omitted: superseded, duplicated or verbose.`;
    changed = true;
  });
  return { changed };
}

function applyToChat(body, extracted, plan) {
  const dropped = new Set(plan.decisions.filter((decision) => decision.action === "drop").map((decision) => decision.id));
  if (dropped.size === 0) return { changed: false };
  let changed = false;
  extracted.refs.forEach((ref, index) => {
    if (ref.kind !== "chat") return;
    const item = extracted.items[index];
    if (!dropped.has(item.id)) return;
    const message = body.messages[ref.index];
    if (!message) return;
    message.content = `[jev-prune] this tool output (${item.tokens} tokens) was omitted: superseded, duplicated or verbose.`;
    changed = true;
  });
  return { changed };
}

export function createPruningProxy(options = {}) {
  const pipeline = options.pipeline || createPipeline();
  const config = pipeline.config;
  const upstream = options.upstream || process.env.JEV_PROXY_UPSTREAM || "https://api.openai.com";
  const upstreamUrl = new URL(upstream);

  async function pruneRequestBody(rawBody) {
    // Returns the body to forward. Any failure returns the original bytes.
    if (!config.usable) return rawBody;
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return rawBody;
    }
    if (!parsed || typeof parsed !== "object") return rawBody;

    const extracted = extractChatMessages(parsed) || extractResponsesInput(parsed);
    if (!extracted || extracted.items.length === 0) return rawBody;
    if (!extracted.items.some((item) => item.role === "tool")) return rawBody;

    try {
      const { plan } = await pipeline.run(extracted.items, {
        scope: `proxy:${upstreamUrl.host}`,
        taskText: lastUserText(parsed),
        mode: config.mode,
        // Background mode: never make the model request wait for OpenJEV.
        allowBlockingRequests: !config.background,
      });

      if (config.background && plan.stats.cacheMisses > 0) {
        void pipeline.prewarm(extracted.items, { scope: `proxy:${upstreamUrl.host}`, taskText: lastUserText(parsed) });
      }

      if (config.mode !== "active") {
        pipeline.saveState();
        return rawBody;
      }

      const applied = extractChatMessages(parsed)
        ? applyToChat(parsed, extracted, plan)
        : applyToResponses(parsed, extracted, plan);
      pipeline.saveState();
      if (!applied.changed) return rawBody;
      return JSON.stringify(parsed);
    } catch {
      return rawBody;
    }
  }

  async function handle(req, res) {
    let rawBody = "";
    try {
      for await (const chunk of req) rawBody += chunk;
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }

    const forwardedHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      forwardedHeaders[key] = value;
    }

    let outgoingBody = rawBody;
    if (req.method === "POST" && rawBody) {
      try {
        outgoingBody = await pruneRequestBody(rawBody);
      } catch {
        outgoingBody = rawBody;
      }
    }

    const target = new URL(req.url, upstreamUrl);
    const transport = target.protocol === "http:" ? http : https;

    const upstreamRequest = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...forwardedHeaders, "content-length": Buffer.byteLength(outgoingBody) },
      },
      (upstreamResponse) => {
        const responseHeaders = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) continue;
          responseHeaders[key] = value;
        }
        res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.pipe(res);
      },
    );

    upstreamRequest.on("error", (error) => {
      // An unreachable upstream is reported as a normal upstream error; the
      // request itself was never blocked by pruning.
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `jev-prune proxy upstream error: ${String(error.message).slice(0, 200)}` } }));
    });

    req.on("aborted", () => upstreamRequest.destroy());
    upstreamRequest.end(outgoingBody);
  }

  function listen({ host = process.env.JEV_PROXY_HOST || "127.0.0.1", port = Number(process.env.JEV_PROXY_PORT || 8787) } = {}) {
    const server = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "jev-prune proxy internal error" } }));
      });
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }

  return { listen, handle, pruneRequestBody, pipeline };
}

function lastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i] && messages[i].role === "user" && typeof messages[i].content === "string") return messages[i].content;
    }
  }
  const input = Array.isArray(body.input) ? body.input : null;
  if (input) {
    for (let i = input.length - 1; i >= 0; i -= 1) {
      const entry = input[i];
      if (entry && (entry.role === "user" || entry.type === "message")) {
        const content = entry.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const text = content.filter((part) => part && typeof part.text === "string").map((part) => part.text).join("\n");
          if (text) return text;
        }
      }
    }
  }
  return "";
}

/** Entry point when executed directly: `node jev-context/proxy/server.mjs`. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { listen } = createPruningProxy();
  listen().then((server) => {
    const address = server.address();
    process.stdout.write(
      `jev-prune proxy listening on http://${address.address}:${address.port} (mode=${
        createPipeline().config.mode
      })\n`,
    );
  });
}

export { HOP_BY_HOP, Readable };
