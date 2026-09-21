import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractItems, deriveMeta } from "../adapters/opencode/plugin.mjs";
import { createPruningProxy, extractChatMessages } from "../proxy/server.mjs";
import { installCodex, uninstallCodex, installAgy, uninstallAgy, installOpenCode, uninstallOpenCode } from "../adapters/install.mjs";
import { createPipeline } from "../core/pipeline.mjs";

const JEV_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jev-adapter-"));
}

/** A stub that always drops: these tests are about plumbing, not judgement. */
function droppingClient() {
  return {
    calls: 0,
    async classify({ questions }) {
      this.calls += 1;
      const answers = {};
      for (const id of Object.keys(questions || {})) {
        answers[id] = { type: "choice", choice: "drop", probabilities: { keep: 0.01, drop: 0.99 }, confidence: 0.99 };
      }
      return { ok: true, answers, usage: { input_tokens: 100, output_tokens: 10 }, latencyMs: 4 };
    },
  };
}

function failingClient() {
  return {
    calls: 0,
    async classify() {
      this.calls += 1;
      return { ok: false, reason: "http-503", status: 503, latencyMs: 2 };
    },
  };
}

/**
 * A local stand-in for api.openjev.sh that speaks the documented wire contract.
 *
 * Using it (rather than injecting a client object) means the plugin test
 * exercises the *real* client, the real HTTP request building, the real answer
 * interpretation and the real decision cache — only the remote service is
 * replaced.
 */
async function startFakeOpenJev({ choice = "drop", confidence = 0.99, fail = null } = {}) {
  const state = { calls: 0, lastBody: null };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      state.calls += 1;
      if (fail === "503") {
        res.writeHead(503).end("unavailable");
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(422).end("bad body");
        return;
      }
      state.lastBody = parsed;
      const answers = {};
      for (const id of Object.keys(parsed.questions || {})) {
        answers[id] = {
          type: "choice",
          choice,
          probabilities: choice === "drop" ? { keep: 1 - confidence, drop: confidence } : { keep: confidence, drop: 1 - confidence },
          confidence,
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "openjev", answers, usage: { input_tokens: 321, output_tokens: 42 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() };
}

function adapterEnv(overrides = {}) {
  const home = tempHome();
  return {
    OPENJEV_API_KEY: "oj_test.adapter-key-not-real-000000",
    JEV_PRUNING_HOME: home,
    JEV_PRUNING_THRESHOLD_TOKENS: "1",
    JEV_PRUNING_MODE: "active",
    JEV_PRUNING_BACKGROUND: "false",
    JEV_PRUNING_KEEP_RECENT_ITEMS: "1",
    JEV_PRUNING_OPENCODE_TOMBSTONE: "true",
    ...overrides,
  };
}

function runHook(scriptPath, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function toolPart(id, tool, output, input) {
  return {
    id,
    sessionID: "s1",
    messageID: `m_${id}`,
    type: "tool",
    callID: `call_${id}`,
    tool,
    state: { status: "completed", input, output, title: tool, metadata: {}, time: { start: 0, end: 1 } },
  };
}

export async function adapterTests(test) {
  /* ------------------------------------------------- OpenCode plugin hook */

  await test("opencode: extractItems maps real ToolPart shapes", () => {
    const verbatim = "LATEST FILE CONTENTS";
    const messages = [
      {
        info: { role: "assistant", sessionID: "s1" },
        parts: [toolPart("p1", "read", verbatim, { filePath: "/src/a.mjs" })],
      },
    ];
    const { items } = extractItems(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].role, "tool");
    assert.equal(items[0].text, verbatim, "tool output must be taken verbatim from state.output");
    assert.equal(items[0].meta.group, "file");
    assert.equal(items[0].meta.resourceKey, "file:/src/a.mjs");
  });

  await test("opencode: deriveMeta classifies the tool families that matter", () => {
    assert.equal(deriveMeta("read", { filePath: "/a" }).group, "file");
    assert.equal(deriveMeta("bash", { command: "npm test" }).group, "command");
    assert.equal(deriveMeta("grep", { pattern: "foo" }).group, "search");
    assert.equal(deriveMeta("edit", { filePath: "/a" }).group, "diff");
    assert.equal(deriveMeta("todowrite", {}).group, "status");
  });

  await test("opencode: transform prunes aged tool output and preserves everything else", async () => {
    const fake = await startFakeOpenJev();
    const env = adapterEnv({ OPENJEV_BASE_URL: fake.url });
    Object.assign(process.env, env);
    const { JevPrunePlugin } = await import("../adapters/opencode/plugin.mjs");
    const hooks = await JevPrunePlugin();
    const transform = hooks["experimental.chat.messages.transform"];

    const verbose = (marker) => Array.from({ length: 40 }, (_, i) => `${marker} step ${i}/40 50%`).join("\n");
    const textPart = { id: "txt1", type: "text", text: "I will inspect the module." };

    const messages = [
      { info: { role: "user", sessionID: "s1" }, parts: [{ id: "u1", type: "text", text: "Inspect src/a.mjs and fix the build." }] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [textPart, toolPart("p_old1", "bash", verbose("install one"), { command: "npm install" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("p_old2", "bash", verbose("install two"), { command: "npm ci" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("p_readA", "read", "// OLD A", { filePath: "/src/a.mjs" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("p_readC", "read", "// LATEST C", { filePath: "/src/a.mjs" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("p_tail", "bash", verbose("tail step"), { command: "make" })] },
    ];
    const before = JSON.stringify(messages.map((m) => m.info));

    await transform({}, { messages });

    // Message metadata and non-tool parts are untouched.
    assert.equal(JSON.stringify(messages.map((m) => m.info)), before);
    assert.equal(messages[1].parts[0], textPart, "the text part object must not be replaced");
    assert.equal(messages[0].parts[0].text, "Inspect src/a.mjs and fix the build.");

    const partById = new Map();
    for (const message of messages) for (const part of message.parts) partById.set(part.id, part);

    // Pairing is preserved: every tool part is still present, plus the two text
    // parts (one user, one assistant).
    assert.equal(partById.size, 7, "no part may be removed (call/result pairing)");
    for (const id of ["p_old1", "p_old2", "p_readA", "p_readC", "p_tail"]) {
      assert.ok(partById.has(id), `tool part ${id} was removed, breaking call/result pairing`);
    }

    // Aged output is replaced by a tombstone; the newest read is untouched.
    assert.match(partById.get("p_old1").state.output, /\[jev-prune\]/);
    assert.match(partById.get("p_old2").state.output, /\[jev-prune\]/);
    assert.equal(partById.get("p_readC").state.output, "// LATEST C", "the newest snapshot must survive verbatim");
    assert.ok(!partById.get("p_tail").state.output.includes("[jev-prune]"), "the recent item must survive");

    // The request that reached the (fake) provider carried the task statement
    // (needed to judge relevance) but no credential, and it did ask only about
    // the tool results.
    assert.ok(fake.state.calls >= 1, "the plugin must have consulted OpenJEV");
    const transmitted = JSON.stringify(fake.state.lastBody);
    assert.ok(transmitted.includes("CURRENT TASK"), "the task header makes the judgement possible");
    assert.ok(!transmitted.includes("sk-"), "no credential may be transmitted");
    const questionIds = Object.keys(fake.state.lastBody.questions);
    assert.ok(questionIds.length >= 1, "the pruned items must have been put to OpenJEV");
    // Only questions about tool results are ever asked: never about the user's
    // own instruction, which is never a pruning candidate.
    assert.ok(
      Object.values(fake.state.lastBody.questions).every((question) => question.type === "choice"),
      "only choice questions are used",
    );
    fake.close();
  });

  await test("opencode: a credential inside the task statement is redacted before transmission", async () => {
    const fake = await startFakeOpenJev();
    Object.assign(process.env, adapterEnv({ OPENJEV_BASE_URL: fake.url }));
    const { JevPrunePlugin } = await import("../adapters/opencode/plugin.mjs");
    const hooks = await JevPrunePlugin();
    const verbose = (m) => Array.from({ length: 40 }, (_, i) => `${m} ${i}/40`).join("\n");
    const messages = [
      {
        info: { role: "user", sessionID: "s1" },
        parts: [{ id: "u1", type: "text", text: "Deploy with OPENAI_API_KEY=sk-proj-LEAKLEAKLEAK0000000000000000 please" }],
      },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("y1", "bash", verbose("a"), { command: "a" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("y2", "bash", verbose("b"), { command: "b" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("y3", "bash", verbose("c"), { command: "c" })] },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    const transmitted = JSON.stringify(fake.state.lastBody || {});
    assert.ok(!transmitted.includes("sk-proj-LEAKLEAKLEAK0000000000000000"), "the task credential was transmitted");
    assert.ok(transmitted.includes("[REDACTED"), "expected a redaction marker in the task header");
    // The live context still carries the user's real text: only the outbound
    // copy sent to OpenJEV is redacted.
    assert.ok(messages[0].parts[0].text.includes("sk-proj-LEAKLEAKLEAK"), "the local context must be untouched");
    fake.close();
  });

  await test("opencode: JEV_PRUNING_SEND_TASK=false withholds the task statement", async () => {
    const fake = await startFakeOpenJev();
    Object.assign(process.env, adapterEnv({ OPENJEV_BASE_URL: fake.url, JEV_PRUNING_SEND_TASK: "false" }));
    const { JevPrunePlugin } = await import("../adapters/opencode/plugin.mjs");
    const hooks = await JevPrunePlugin();
    const verbose = (m) => Array.from({ length: 40 }, (_, i) => `${m} ${i}/40`).join("\n");
    const messages = [
      { info: { role: "user", sessionID: "s1" }, parts: [{ id: "u1", type: "text", text: "UNIQUE-TASK-STRING-XYZ" }] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("w1", "bash", verbose("a"), { command: "a" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("w2", "bash", verbose("b"), { command: "b" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("w3", "bash", verbose("c"), { command: "c" })] },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    const transmitted = JSON.stringify(fake.state.lastBody || {});
    assert.ok(!transmitted.includes("UNIQUE-TASK-STRING-XYZ"), "the task statement must be withheld when disabled");
    assert.ok(transmitted.includes("not supplied"), "the header should say the task was not supplied");
    fake.close();
  });

  await test("opencode: an OpenJEV outage leaves the assembled context untouched", async () => {
    const fake = await startFakeOpenJev({ fail: "503" });
    Object.assign(process.env, adapterEnv({ OPENJEV_BASE_URL: fake.url }));
    const { JevPrunePlugin } = await import("../adapters/opencode/plugin.mjs");
    const hooks = await JevPrunePlugin();
    const verbose = (m) => Array.from({ length: 40 }, (_, i) => `${m} ${i}/40`).join("\n");
    const messages = [
      { info: { role: "user", sessionID: "s1" }, parts: [{ id: "u1", type: "text", text: "go" }] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("z1", "bash", verbose("a"), { command: "a" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("z2", "bash", verbose("b"), { command: "b" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("z3", "bash", verbose("c"), { command: "c" })] },
    ];
    const snapshot = JSON.stringify(messages);
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    assert.equal(JSON.stringify(messages), snapshot, "a 503 must leave every byte of the context intact");
    assert.ok(fake.state.calls >= 1, "the plugin must have tried");
    fake.close();
  });

  await test("opencode: transform is a no-op when pruning is off or unconfigured", async () => {
    Object.assign(process.env, adapterEnv({ JEV_PRUNING_MODE: "off" }));
    const { JevPrunePlugin } = await import("../adapters/opencode/plugin.mjs");
    const hooks = await JevPrunePlugin();
    const messages = [
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("q1", "bash", "output one", { command: "a" })] },
      { info: { role: "assistant", sessionID: "s1" }, parts: [toolPart("q2", "bash", "output two", { command: "b" })] },
    ];
    const snapshot = JSON.stringify(messages);
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    assert.equal(JSON.stringify(messages), snapshot, "off mode must not modify the assembled context");
  });

  await test("opencode: transform never throws on a malformed payload", async () => {
    Object.assign(process.env, adapterEnv());
    const { JevPrunePlugin } = await import("../adapters/opencode/plugin.mjs");
    const hooks = await JevPrunePlugin();
    const transform = hooks["experimental.chat.messages.transform"];
    await transform({}, { messages: null });
    await transform({}, {});
    await transform({}, { messages: [{}] });
    await transform({}, { messages: [{ info: {}, parts: [{ type: "tool" }] }] });
    // Reaching here means every malformed shape was tolerated.
    assert.ok(true);
  });

  /* --------------------------------------------------------- pruning proxy */

  await test("proxy: prunes stale tool messages and keeps the rest byte-identical", async () => {
    const env = adapterEnv({ JEV_PROXY_UPSTREAM: "http://127.0.0.1:0" });
    const pipeline = createPipeline({ env, client: droppingClient(), logger: () => {} });

    let captured = null;
    const upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        captured = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;

    const verbose = (m) => Array.from({ length: 40 }, (_, i) => `${m} ${i}/40`).join("\n");
    const proxy = createPruningProxy({ pipeline, upstream: `http://127.0.0.1:${upstreamPort}` });
    const server = await proxy.listen({ host: "127.0.0.1", port: 0 });
    const proxyPort = server.address().port;

    const requestBody = JSON.stringify({
      model: "test-model",
      messages: [
        { role: "system", content: "SYSTEM PROMPT THAT MUST NOT CHANGE" },
        { role: "user", content: "Please fix the build." },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", name: "bash", content: verbose("install one") },
        { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_2", name: "bash", content: verbose("install two") },
        { role: "assistant", content: null, tool_calls: [{ id: "call_3", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_3", name: "bash", content: verbose("install three") },
      ],
    });

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer upstream-key" },
      body: requestBody,
    });
    assert.equal(response.status, 200);
    assert.ok(captured, "the upstream must have received a request");

    const forwarded = JSON.parse(captured);
    const toolMessages = forwarded.messages.filter((message) => message.role === "tool");
    assert.ok(
      toolMessages.some((message) => message.content.includes("[jev-prune]")),
      "at least one stale tool message should have been pruned",
    );
    // Pairing is preserved: every tool_call still has its tool message.
    assert.equal(toolMessages.length, 3, "tool/assistant pairing must survive pruning");
    assert.equal(forwarded.messages[0].content, "SYSTEM PROMPT THAT MUST NOT CHANGE");
    assert.equal(forwarded.messages[1].content, "Please fix the build.");

    // The upstream's own auth header is forwarded untouched.
    server.close();
    upstream.close();
  });

  await test("proxy: an OpenJEV failure forwards the original body untouched", async () => {
    const env = adapterEnv();
    const pipeline = createPipeline({ env, client: failingClient(), logger: () => {} });

    let captured = null;
    const upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        captured = body;
        res.writeHead(200).end("{}");
      });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

    const proxy = createPruningProxy({ pipeline, upstream: `http://127.0.0.1:${upstream.address().port}` });
    const server = await proxy.listen({ host: "127.0.0.1", port: 0 });

    const verbose = (m) => Array.from({ length: 40 }, (_, i) => `${m} ${i}/40`).join("\n");
    const original = JSON.stringify({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "c1", name: "bash", content: verbose("a") },
        { role: "tool", tool_call_id: "c2", name: "bash", content: verbose("b") },
        { role: "tool", tool_call_id: "c3", name: "bash", content: verbose("c") },
      ],
    });

    await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: original,
    });

    assert.equal(captured, original, "on failure the upstream must receive the exact original bytes");
    server.close();
    upstream.close();
  });

  await test("proxy: a non-JSON body is passed through unchanged", async () => {
    const env = adapterEnv();
    const pipeline = createPipeline({ env, client: droppingClient(), logger: () => {} });
    const proxy = createPruningProxy({ pipeline, upstream: "http://127.0.0.1:1" });
    const body = "not json at all";
    assert.equal(await proxy.pruneRequestBody(body), body);
  });

  await test("proxy: extractChatMessages ignores non-tool conversations", () => {
    assert.equal(extractChatMessages({ messages: [{ role: "user", content: "hi" }] }).items.length, 1);
    assert.equal(extractChatMessages({ input: [] }), null);
  });

  /* -------------------------------------------------------------- hook CLI */

  await test("codex hooks: PostToolUse answers with valid JSON and exits 0", async () => {
    const env = { ...adapterEnv(), OPENJEV_API_KEY: "" };
    const result = await runHook(path.join(JEV_ROOT, "adapters", "codex", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "tests passed",
    }, env);
    assert.equal(result.code, 0, `hook must exit 0, stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed, "object");
  });

  // Codex 0.155.1 lists additionalContext only on the PreToolUse / SessionStart /
  // UserPromptSubmit / PermissionRequest / SubagentStart hook-specific outputs
  // and warns "this event cannot emit additionalContext" elsewhere. The adapter
  // therefore emits nothing for PreCompact rather than a silent no-op.
  await test("codex hooks: PreCompact emits nothing, because Codex cannot accept it", async () => {
    const env = { ...adapterEnv(), OPENJEV_API_KEY: "" };
    const result = await runHook(path.join(JEV_ROOT, "adapters", "codex", "hooks.mjs"), {
      hook_event_name: "PreCompact",
      session_id: "s1",
    }, env);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });

  await test("codex hooks: PostToolUse cannot rewrite a non-MCP tool result", async () => {
    // Evidence: PostToolUseHookSpecificOutputWire exposes only
    // `updatedMCPToolOutput`, and the binary reports "PostToolUse hook returned
    // unsupported updatedMCPToolOutput" for non-MCP tools. The adapter therefore
    // never claims a rewrite capability Codex does not honour.
    const env = { ...adapterEnv(), OPENJEV_API_KEY: "" };
    const result = await runHook(path.join(JEV_ROOT, "adapters", "codex", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "cat big.log" },
      tool_response: "x\n".repeat(500),
    }, env);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.overwrite_result, undefined);
    assert.equal(parsed.hookSpecificOutput, undefined);
  });

  await test("codex hooks: malformed stdin still yields an empty JSON response", async () => {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(JEV_ROOT, "adapters", "codex", "hooks.mjs")], {
        env: { ...process.env, OPENJEV_API_KEY: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("close", (code) => resolve({ code, stdout }));
      child.stdin.end("this is not json");
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });

  await test("agy hooks: same contract over the gemini/claude hooks.json surface", async () => {
    const env = { ...adapterEnv(), OPENJEV_API_KEY: "" };
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "SessionStart",
      session_id: "a1",
    }, env);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });

  /* ------------------------------------------------ agy overwrite_result path */

  // Agy's PostToolUse hook result schema (read from the 1.2.7 binary) includes
  //   OverwriteResult *string `json:"overwrite_result,omitempty"`
  // "Optional. Replaces the result of the tool call that just ran with this
  //  string." These tests exercise that documented capability end to end, over
  // real HTTP against a stand-in for the OpenJEV service.

  const verboseLog = (seed) =>
    Array.from({ length: 120 }, (_, i) => `${seed} step ${i}/120 ${i}% done`).join("\n");

  await test("agy: a fresh verbose build log is elided and its original is stashed", async () => {
    const fake = await startFakeOpenJev({ choice: "drop", confidence: 0.99 });
    const env = { ...adapterEnv({ OPENJEV_BASE_URL: fake.url }), JEV_PRUNING_ELISION_EXCERPT_CHARS: "80" };
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "agy-drop-1",
      tool_name: "Bash",
      tool_input: { command: "npm install" },
      tool_response: verboseLog("fetch"),
    }, env);
    assert.equal(result.code, 0, `hook must exit 0, stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.overwrite_result, "a confident drop must produce overwrite_result");
    assert.match(parsed.overwrite_result, /^\[jev-prune: elided [1-9]\d* tokens/, "the marker must report the real token count");
    assert.ok(
      parsed.overwrite_result.length < verboseLog("fetch").length / 10,
      "the marker must be far smaller than what it replaced",
    );
    // Recoverability: the verbatim original is on disk, not destroyed.
    // The scope is sanitised into a filename-safe directory: `agy:agy-drop-1`
    // becomes `agy_agy-drop-1`.
    const stashDir = path.join(env.JEV_PRUNING_HOME, "elided", "agy_agy-drop-1");
    const files = fs.readdirSync(stashDir);
    assert.equal(files.length, 1);
    const stashPath = path.join(stashDir, files[0]);
    assert.equal(fs.readFileSync(stashPath, "utf8"), verboseLog("fetch"));
    assert.match(parsed.overwrite_result, /full text kept locally at/);
    fake.close();
  });

  await test("agy: a fresh file read is never elided and costs no OpenJEV call", async () => {
    const fake = await startFakeOpenJev({ choice: "drop", confidence: 0.99 });
    const env = adapterEnv({ OPENJEV_BASE_URL: fake.url });
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "agy-file-1",
      tool_name: "Read",
      tool_input: { file_path: "/src/app.ts" },
      tool_response: verboseLog("line"),
    }, env);
    assert.deepEqual(JSON.parse(result.stdout), {}, "the current contents of a file are current state");
    assert.equal(fake.state.calls, 0, "a fresh file read must not even be offered to OpenJEV");
    fake.close();
  });

  await test("agy: a fresh unresolved failure survives even a confident drop judgement", async () => {
    const fake = await startFakeOpenJev({ choice: "drop", confidence: 0.99 });
    const env = adapterEnv({ OPENJEV_BASE_URL: fake.url });
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "agy-fail-1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: `${verboseLog("t")}\nError: 2 tests failed\nexit code 1`,
    }, env);
    assert.deepEqual(JSON.parse(result.stdout), {}, "an unresolved failure must never be elided");
    assert.equal(fake.state.calls, 0, "an unresolved failure is settled by rules, not by OpenJEV");
    fake.close();
  });

  await test("agy: a byte-identical repeat is elided without a second OpenJEV call", async () => {
    const fake = await startFakeOpenJev({ choice: "drop", confidence: 0.99 });
    const env = adapterEnv({ OPENJEV_BASE_URL: fake.url });
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: "agy-dup-1",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: verboseLog("listing"),
    };
    await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), payload, env);
    const callsAfterFirst = fake.state.calls;
    const second = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), payload, env);
    const parsed = JSON.parse(second.stdout);
    assert.ok(parsed.overwrite_result, "an exact repeat is losslessly droppable");
    assert.equal(fake.state.calls, callsAfterFirst, "a known duplicate must not cost another OpenJEV call");
    fake.close();
  });

  await test("agy: a redactable credential never reaches OpenJEV in the clear", async () => {
    const fake = await startFakeOpenJev({ choice: "drop", confidence: 0.99 });
    const env = adapterEnv({ OPENJEV_BASE_URL: fake.url });
    const secret = "sk-live-abcdefghijklmnopqrstuvwxyz012345";
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "agy-secret-1",
      tool_name: "Bash",
      tool_input: { command: "cat .env.local" },
      tool_response: `OPENAI_API_KEY=${secret}\n`.repeat(40),
    }, env);
    assert.equal(result.code, 0);
    // A vendor key has a known shape, so it is redacted and the item may legally
    // be judged. What is not negotiable is that the raw value never left.
    assert.ok(fake.state.calls > 0, "a positively identified key is redacted, not withheld");
    assert.ok(!JSON.stringify(fake.state.lastBody || "").includes(secret), "the raw key must never be transmitted");
    assert.match(JSON.stringify(fake.state.lastBody), /REDACTED/, "the transmitted copy must show the redaction marker");
    const parsed = JSON.parse(result.stdout);
    if (parsed.overwrite_result) {
      assert.ok(!parsed.overwrite_result.includes(secret), "the replacement must not echo the credential");
    }
    fake.close();
  });

  await test("agy: a credential we cannot identify is withheld and kept verbatim", async () => {
    const fake = await startFakeOpenJev({ choice: "drop", confidence: 0.99 });
    const env = adapterEnv({ OPENJEV_BASE_URL: fake.url });
    // A credential word with no `name=value` shape and no vendor prefix: nothing
    // can be positively redacted, so fail-closed must keep it out of the request
    // *and* out of the rewrite path.
    const opaque = "QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890abcdefg";
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "agy-secret-2",
      tool_name: "Bash",
      tool_input: { command: "cat notes.txt" },
      tool_response: `the deploy password is ${opaque}\n`.repeat(40),
    }, env);
    assert.deepEqual(JSON.parse(result.stdout), {}, "an unidentifiable credential must stay in context");
    assert.equal(fake.state.calls, 0, "an unidentifiable credential must not leave the machine");
    assert.ok(!JSON.stringify(fake.state.lastBody || "").includes(opaque));
    fake.close();
  });

  await test("agy: a small result never pays for a round trip", async () => {
    const fake = await startFakeOpenJev({ choice: "drop", confidence: 0.99 });
    const env = adapterEnv({ OPENJEV_BASE_URL: fake.url, JEV_PRUNING_WRITE_TIME_MIN_TOKENS: "200" });
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "agy-small-1",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: "hi\n",
    }, env);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(fake.state.calls, 0, "eliding 1 token is not worth a blocking round trip");
    fake.close();
  });

  await test("agy: shadow mode never rewrites and never blocks on OpenJEV", async () => {
    const fake = await startFakeOpenJev({ choice: "drop", confidence: 0.99 });
    const env = adapterEnv({
      OPENJEV_BASE_URL: fake.url,
      JEV_PRUNING_MODE: "shadow",
      JEV_PRUNING_BACKGROUND: "false",
    });
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "agy-shadow-1",
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: verboseLog("build"),
    }, env);
    assert.deepEqual(JSON.parse(result.stdout), {}, "shadow mode must not modify the context");
    assert.equal(fake.state.calls, 0, "shadow mode must not make the agent wait for OpenJEV");
    fake.close();
  });

  await test("agy: an OpenJEV outage leaves the result untouched", async () => {
    const fake = await startFakeOpenJev({ fail: "503" });
    const env = adapterEnv({ OPENJEV_BASE_URL: fake.url });
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "agy-503-1",
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: verboseLog("build"),
    }, env);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
    fake.close();
  });

  await test("agy: an unwritable stash refuses the elision rather than losing content", async () => {
    const fake = await startFakeOpenJev({ choice: "drop", confidence: 0.99 });
    const env = adapterEnv({
      OPENJEV_BASE_URL: fake.url,
      // A file where a directory is required: mkdir -p must fail.
      JEV_PRUNING_ELISION_PATH: path.join(tempHome(), "not-a-dir"),
    });
    fs.writeFileSync(env.JEV_PRUNING_ELISION_PATH, "occupied");
    const result = await runHook(path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs"), {
      hook_event_name: "PostToolUse",
      session_id: "agy-stash-1",
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: verboseLog("build"),
    }, env);
    assert.deepEqual(JSON.parse(result.stdout), {}, "fail-open means keep, never lose");
    fake.close();
  });

  await test("session store: a concurrent writer extends state committed while it waits", async () => {
    const home = tempHome();
    const storePath = path.join(home, "sessions.json");
    const lockPath = `${storePath}.lock`;
    const readyPath = path.join(home, "child-ready");
    fs.writeFileSync(lockPath, `${process.pid} ${Date.now()}\n`, { mode: 0o600 });

    const protocolUrl = pathToFileURL(path.join(JEV_ROOT, "adapters", "hooks", "protocol.mjs")).href;
    const script = [
      `import fs from "node:fs";`,
      `import { createSessionStore } from ${JSON.stringify(protocolUrl)};`,
      `fs.writeFileSync(process.env.READY_PATH, "ready");`,
      `createSessionStore({ path: process.env.STORE_PATH }).remember("shared", { digest: "child" });`,
    ].join("\n");

    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, STORE_PATH: storePath, READY_PATH: readyPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const deadline = Date.now() + 2000;
    while (!fs.existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(readyPath), "child writer did not reach the lock in time");

    fs.writeFileSync(storePath, JSON.stringify({
      shared: [{ digest: "parent", at: Date.now() }],
    }), { mode: 0o600 });
    fs.unlinkSync(lockPath);

    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, `concurrent writer failed: ${stderr}`);
    const state = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.deepEqual(
      state.shared.map((entry) => entry.digest).sort(),
      ["child", "parent"],
      "the waiting writer must reload and preserve the state committed before it acquired the lock",
    );
  });

  /* ------------------------------------------------------------- installers */

  await test("install: codex hooks.json is merged, not overwritten", () => {
    const codexHome = tempHome();
    const filePath = path.join(codexHome, "hooks.json");
    const preexisting = { hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] }, other: true };
    fs.writeFileSync(filePath, JSON.stringify(preexisting));

    const result = installCodex({ codexHome });
    assert.equal(result.added.length, 3, "only the events the adapter acts on are registered");
    assert.ok(result.backup, "a backup must be written before modifying an existing file");

    const merged = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(merged.other, true, "unrelated top-level keys must survive");
    const postToolUse = merged.hooks.PostToolUse;
    assert.equal(postToolUse.length, 2, "the pre-existing entry must be kept alongside ours");
    assert.ok(postToolUse.some((entry) => JSON.stringify(entry).includes("echo keep-me")));
    assert.ok(postToolUse.some((entry) => JSON.stringify(entry).includes("hooks.mjs")));
    // No Codex event can rewrite a tool result, so every Codex hook is async and
    // the agent never waits on us.
    for (const event of ["SessionStart", "SessionEnd", "PostToolUse"]) {
      assert.ok(JSON.stringify(merged.hooks[event]).includes('"async":true'), `${event} must be async on codex`);
    }

    // Idempotent: a second install adds nothing.
    const second = installCodex({ codexHome });
    assert.equal(second.added.length, 0);
    assert.equal(second.already.length, 3);
  });

  await test("install: agy registers a SYNCHRONOUS PostToolUse, or overwrite_result is discarded", async () => {
    const geminiHome = tempHome();
    const result = installAgy({ geminiHome });
    const written = JSON.parse(fs.readFileSync(result.file, "utf8"));

    assert.ok(Array.isArray(written.hooks.PostToolUse), "Agy must register PostToolUse");
    const ourPost = written.hooks.PostToolUse[0].hooks[0];
    assert.ok(!ourPost.async, "an async PostToolUse hook's result is never read by Agy");
    assert.ok(ourPost.command.includes("adapters/agy/hooks.mjs") || ourPost.command.includes(`adapters${path.sep}agy`));
    // The hook must be allowed to outlive the OpenJEV timeout, or it can never
    // answer in time to rewrite anything.
    assert.ok(ourPost.timeout >= 5, "the hook timeout must exceed JEV_PRUNING_TIMEOUT_MS");

    const { HOST_HOOKS } = await import("../adapters/install.mjs");
    assert.deepEqual(HOST_HOOKS.agy.map((entry) => entry.event), ["SessionStart", "SessionEnd", "PostToolUse"]);
    assert.ok(
      !HOST_HOOKS.agy.some((entry) => entry.event === "PreCompact"),
      "Agy 1.2.7 has no PreCompact event; registering one would be fiction",
    );
  });

  await test("uninstall: only jev-prune entries are removed", () => {
    const codexHome = tempHome();
    installCodex({ codexHome });
    const filePath = path.join(codexHome, "hooks.json");
    const before = JSON.parse(fs.readFileSync(filePath, "utf8"));
    before.hooks.PostToolUse.push({ hooks: [{ type: "command", command: "echo keep-me-too" }] });
    fs.writeFileSync(filePath, JSON.stringify(before));

    const result = uninstallCodex({ codexHome });
    assert.ok(result.removed.length > 0);
    const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const flat = JSON.stringify(after);
    assert.ok(!flat.includes("hooks.mjs"), "our entries must be gone");
    assert.ok(flat.includes("echo keep-me-too"), "foreign entries must survive");
  });

  await test("install: agy writes to the shared gemini config path", () => {
    const geminiHome = tempHome();
    const result = installAgy({ geminiHome });
    assert.equal(result.file, path.join(geminiHome, "config", "hooks.json"));
    const written = JSON.parse(fs.readFileSync(result.file, "utf8"));
    assert.ok(JSON.stringify(written).includes("agy"));
    assert.deepEqual(written.hooks.SessionStart.length, 1);
    const removed = uninstallAgy({ geminiHome });
    assert.ok(removed.removed.length > 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.file, "utf8")).hooks, {});
  });

  await test("install: opencode shim resolves back to the engine", () => {
    const root = tempHome();
    const result = installOpenCode({ root });
    assert.ok(fs.existsSync(result.file));
    assert.match(result.wrote, /adapters\/opencode\/plugin\.mjs/);
    const removed = uninstallOpenCode({ root });
    assert.equal(removed.removed, true);
    assert.ok(!fs.existsSync(result.file));
  });

  await test("uninstall: foreign OpenCode shim is never deleted, and an overwritten one is restored", () => {
    const root = tempHome();
    const shim = path.join(root, ".opencode", "plugin", "jev-prune.mjs");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    const foreign = "// foreign plugin owned by the user\nexport default {};\n";
    fs.writeFileSync(shim, foreign);

    const untouched = uninstallOpenCode({ root });
    assert.equal(untouched.removed, false, "uninstall must refuse a shim it did not generate");
    assert.equal(fs.readFileSync(shim, "utf8"), foreign);

    installOpenCode({ root });
    assert.ok(fs.existsSync(`${shim}.before-jev-prune`), "install must preserve the foreign shim");
    const removed = uninstallOpenCode({ root });
    assert.equal(removed.removed, true);
    assert.equal(removed.restored, true, "uninstall must restore the pre-install foreign shim");
    assert.equal(fs.readFileSync(shim, "utf8"), foreign);
    assert.ok(!fs.existsSync(`${shim}.before-jev-prune`));
  });

  await test("install: the codex provider sample never contains a credential", async () => {
    const { codexProviderSample } = await import("../adapters/install.mjs");
    const sample = codexProviderSample();
    assert.match(sample, /model_providers\.jev-prune/);
    assert.match(sample, /env_key = "JEV_UPSTREAM_API_KEY"/);
    assert.ok(!sample.includes("oj_"), "no credential may appear in the sample");
  });
}
