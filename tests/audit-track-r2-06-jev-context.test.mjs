import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createPipeline } from "../jev-context/core/pipeline.mjs";
import { createMetrics } from "../jev-context/core/metrics.mjs";
import { redact } from "../jev-context/core/redact.mjs";
import { elideItem } from "../jev-context/core/elision.mjs";
import { classifyAll } from "../jev-context/core/classifier.mjs";
import { createPruningProxy } from "../jev-context/proxy/server.mjs";
import { handleHookEvent } from "../jev-context/adapters/hooks/handler.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JEV_ROOT = path.join(REPO_ROOT, "jev-context");

function tempDir(prefix = "jev-audit-r2-06-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function verboseLines(label, count = 40) {
  return Array.from({ length: count }, (_, i) => `${label}: step ${i + 1}/${count} 50% complete`).join("\n");
}

function makeEnv(home, overrides = {}) {
  return {
    OPENJEV_API_KEY: "oj_test.audit-key-000000000000",
    JEV_PRUNING_HOME: home,
    JEV_PRUNING_THRESHOLD_TOKENS: "1",
    JEV_PRUNING_MODE: "active",
    JEV_PRUNING_BACKGROUND: "false",
    JEV_PRUNING_KEEP_RECENT_ITEMS: "1",
    JEV_PRUNING_WRITE_TIME_MIN_TOKENS: "10",
    ...overrides,
  };
}

function droppingClient(onClassify) {
  return {
    calls: 0,
    lastPayload: null,
    async classify(payload) {
      this.calls += 1;
      this.lastPayload = payload;
      if (onClassify) await onClassify(payload);
      const answers = {};
      for (const id of Object.keys(payload.questions || {})) {
        answers[id] = {
          type: "choice",
          choice: "drop",
          probabilities: { keep: 0.01, drop: 0.99 },
          confidence: 0.99,
        };
      }
      return { ok: true, answers, usage: { input_tokens: 80, output_tokens: 12 }, latencyMs: 3 };
    },
  };
}

async function startFakeOpenJev({ delayMs = 0, choice = "drop", confidence = 0.99 } = {}) {
  const state = { calls: 0, lastBody: null };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      state.calls += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(422).end("bad json");
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
      res.end(JSON.stringify({ model: "openjev", answers, usage: { input_tokens: 120, output_tokens: 15 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runNodeScript(scriptPath, stdinText, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdinText);
  });
}

// ============================================================================
// P1 #1: pipeline.mjs item.meta.command redaction & mustNotTransmit
// ============================================================================
test("P1 #1: pipeline redacts item.meta.command and withholds suspicious command fail-closed", async () => {
  const home = tempDir();
  const client = droppingClient();
  const pipeline = createPipeline({ env: makeEnv(home), client, logger: () => {} });

  const suspiciousHex = "deadbeef0123456789abcdef0123456789abcdef01234567";
  const items = [
    { id: "u1", role: "user", text: "Deploy service" },
    {
      id: "t_redactable",
      role: "tool",
      tool: "bash",
      text: verboseLines("curl output"),
      meta: { group: "command", command: "curl -u admin:TopSecretPass99 https://api.example.com" },
    },
    {
      id: "t_suspicious",
      role: "tool",
      tool: "bash",
      text: verboseLines("deploy output"),
      meta: { group: "command", command: `deploy --password ${suspiciousHex}` },
    },
    { id: "t_tail", role: "tool", tool: "bash", text: "recent tail" },
  ];

  const { plan } = await pipeline.run(items, { scope: "p1-cmd", taskText: "Deploy service" });

  assert.equal(client.calls, 1);
  const sentState = client.lastPayload.state;
  assert.ok(!sentState.includes("TopSecretPass99"), "redactable password in command must not be transmitted");
  assert.ok(sentState.includes("[REDACTED:curl-userpass]"), "redaction marker should appear for redacted command");
  assert.ok(!sentState.includes(suspiciousHex), "unredactable suspicious credential in command must not be transmitted");

  assert.ok(plan.stats.skippedUnsafe >= 1, "suspicious command item must be counted as skippedUnsafe");
  const suspiciousDecision = plan.decisions.find((d) => d.id === "t_suspicious");
  assert.equal(suspiciousDecision.action, "keep", "suspicious command item must be kept fail-closed");
});

// ============================================================================
// P1 #2: pipeline.mjs safeTaskText() mustNotTransmit fail-closed check
// ============================================================================
test("P1 #2: safeTaskText withholds task statement when mustNotTransmit triggers", async () => {
  const home = tempDir();
  const client = droppingClient();
  const pipeline = createPipeline({ env: makeEnv(home), client, logger: () => {} });

  const suspiciousToken = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const items = [
    { id: "u1", role: "user", text: "task" },
    { id: "t1", role: "tool", tool: "bash", text: verboseLines("build log"), meta: { group: "command" } },
    { id: "t2", role: "tool", tool: "bash", text: "recent tail" },
  ];

  await pipeline.run(items, {
    scope: "p1-task",
    taskText: `Use secret ${suspiciousToken} to finish deploy`,
  });

  assert.equal(client.calls, 1);
  assert.ok(!client.lastPayload.state.includes(suspiciousToken), "suspicious task credential must not be transmitted");
  assert.ok(client.lastPayload.state.includes("not supplied"), "withheld task text should fall back to not supplied");
});

// ============================================================================
// P1 #3: opencode/plugin.mjs shadow mode must not drop/mutate context
// ============================================================================
test("P1 #3: OpenCode plugin in shadow mode never mutates or drops tool parts", async () => {
  const fake = await startFakeOpenJev();
  const prevEnv = { ...process.env };
  try {
    const home = tempDir();
    Object.assign(
      process.env,
      makeEnv(home, {
        OPENJEV_BASE_URL: fake.url,
        JEV_PRUNING_MODE: "shadow",
        JEV_PRUNING_BACKGROUND: "false",
        JEV_PRUNING_OPENCODE_TOMBSTONE: "true",
      }),
    );

    const { JevPrunePlugin } = await import("../jev-context/adapters/opencode/plugin.mjs");
    const hooks = await JevPrunePlugin();
    const transform = hooks["experimental.chat.messages.transform"];

    const messages = [
      { info: { role: "user", sessionID: "shadow-s1" }, parts: [{ id: "u1", type: "text", text: "Check build" }] },
      {
        info: { role: "assistant", sessionID: "shadow-s1" },
        parts: [{ id: "p1", type: "tool", tool: "bash", state: { status: "completed", output: verboseLines("install 1"), input: { command: "npm install" } } }],
      },
      {
        info: { role: "assistant", sessionID: "shadow-s1" },
        parts: [{ id: "p2", type: "tool", tool: "bash", state: { status: "completed", output: "recent", input: { command: "echo ok" } } }],
      },
    ];
    const snapshot = JSON.stringify(messages);

    await transform({}, { messages });

    assert.equal(JSON.stringify(messages), snapshot, "shadow mode must leave output.messages byte-identical");
    assert.ok(fake.state.calls >= 1, "shadow mode still evaluates via OpenJEV");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
    await fake.close();
  }
});

// ============================================================================
// P1 #4: proxy/server.mjs preserves raw Buffer for gzip / binary / multipart
// ============================================================================
test("P1 #4: proxy preserves raw Buffer for gzip and binary multipart payloads without UTF-8 corruption", async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      received.push({ headers: req.headers, body: buf });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(buf);
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const home = tempDir();
  const pipeline = createPipeline({ env: makeEnv(home), client: droppingClient(), logger: () => {} });
  const proxy = createPruningProxy({ pipeline, upstream: `http://127.0.0.1:${upstream.address().port}` });
  const proxyServer = await proxy.listen({ host: "127.0.0.1", port: 0 });
  const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;

  try {
    // 4a: gzip-encoded JSON body
    const jsonPayload = JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "c1", name: "bash", content: verboseLines("gz") },
        { role: "tool", tool_call_id: "c2", name: "bash", content: "tail" },
      ],
    });
    const gzipped = zlib.gzipSync(Buffer.from(jsonPayload, "utf8"));
    const gzRes = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipped,
    });
    const gzEcho = Buffer.from(await gzRes.arrayBuffer());
    assert.ok(gzEcho.equals(gzipped), "gzip request bytes must be forwarded untouched");
    assert.equal(zlib.gunzipSync(gzEcho).toString("utf8"), jsonPayload);

    // 4b: binary multipart body with invalid UTF-8 sequences
    const binaryMultipart = Buffer.concat([
      Buffer.from("------boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n\r\n", "utf8"),
      Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xa0, 0xa1]),
      Buffer.from("\r\n------boundary--\r\n", "utf8"),
    ]);
    const mpRes = await fetch(`${proxyUrl}/v1/files`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----boundary" },
      body: binaryMultipart,
    });
    const mpEcho = Buffer.from(await mpRes.arrayBuffer());
    assert.ok(mpEcho.equals(binaryMultipart), "binary multipart payload must not be corrupted by UTF-8 decoding");
  } finally {
    await new Promise((r) => proxyServer.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

// ============================================================================
// P1 #5: proxy/server.mjs upstreamResponse error, headersSent guard, res close cancel
// ============================================================================
test("P1 #5: proxy handles mid-stream upstream reset safely and cancels upstream on client close", async () => {
  let upstreamAborted = false;
  let resolveAbort;
  const abortPromise = new Promise((resolve) => {
    resolveAbort = resolve;
  });

  const upstream = http.createServer((req, res) => {
    if (req.url === "/reset-mid-stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.socket.destroy();
      }, 20);
      return;
    }
    if (req.url === "/hang") {
      req.on("close", () => {
        if (!res.writableEnded) {
          upstreamAborted = true;
          resolveAbort();
        }
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: open\n\n");
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const home = tempDir();
  const pipeline = createPipeline({ env: makeEnv(home), client: droppingClient(), logger: () => {} });
  const proxy = createPruningProxy({ pipeline, upstream: `http://127.0.0.1:${upstream.address().port}` });
  const proxyServer = await proxy.listen({ host: "127.0.0.1", port: 0 });
  const proxyPort = proxyServer.address().port;

  try {
    // 5a: mid-stream upstream reset must not crash process or inject error JSON after headersSent
    const receivedChunks = await new Promise((resolve) => {
      const chunks = [];
      const req = http.get({ host: "127.0.0.1", port: proxyPort, path: "/reset-mid-stream" }, (res) => {
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    assert.ok(receivedChunks.includes("data: first"), "initial stream chunk should arrive");
    assert.ok(!receivedChunks.includes("jev-prune proxy upstream error"), "error JSON must never be injected after headersSent");

    // 5b: client disconnect cancels upstream request via res.on('close')
    await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: proxyPort, path: "/hang" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
    });

    await Promise.race([
      abortPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream was not cancelled on client close")), 2000)),
    ]);
    assert.equal(upstreamAborted, true, "upstream request must be cancelled when client closes response");
  } finally {
    await new Promise((r) => proxyServer.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

// ============================================================================
// P1 #6: metrics.mjs & pipeline.mjs preserve cumulative metrics across restarts
// ============================================================================
test("P1 #6: createPipeline loads and accumulates metrics across restarts instead of overwriting", async () => {
  const home = tempDir();
  const env = makeEnv(home);
  const items = [
    { id: "u1", role: "user", text: "fix" },
    { id: "t1", role: "tool", tool: "bash", text: verboseLines("run1"), meta: { group: "command" } },
    { id: "t2", role: "tool", tool: "bash", text: "recent" },
  ];

  const p1 = createPipeline({ env, client: droppingClient(), logger: () => {} });
  await p1.run(items, { scope: "s-metrics-1", taskText: "fix" });
  p1.saveState();

  const afterFirst = createMetrics({ path: p1.config.metricsPath }).load();
  assert.equal(afterFirst.itemsDropped, 1);
  assert.equal(afterFirst.openjevCalls, 1);

  // Simulate a new process / hook invocation with a fresh pipeline instance
  const p2 = createPipeline({ env, client: droppingClient(), logger: () => {} });
  await p2.run(
    [
      { id: "u1", role: "user", text: "fix" },
      { id: "t1", role: "tool", tool: "bash", text: verboseLines("run2"), meta: { group: "command" } },
      { id: "t2", role: "tool", tool: "bash", text: "recent" },
    ],
    { scope: "s-metrics-2", taskText: "fix" },
  );
  p2.saveState();

  const afterSecond = createMetrics({ path: p2.config.metricsPath }).load();
  assert.equal(afterSecond.itemsDropped, 2, "cumulative itemsDropped must persist across pipeline instances");
  assert.equal(afterSecond.openjevCalls, 2, "cumulative openjevCalls must persist across pipeline instances");

  // Explicit reset must still zero disk metrics
  const mReset = createMetrics({ path: p2.config.metricsPath });
  mReset.reset();
  mReset.save();
  const afterReset = createMetrics({ path: p2.config.metricsPath }).load();
  assert.equal(afterReset.itemsDropped, 0, "reset() + save() must clear persisted metrics");
});

// ============================================================================
// P1 #7: agy/hooks.mjs persists decision cache after plan() in active mode
// ============================================================================
test("P1 #7: Agy active mode persists decision cache to disk after plan()", async () => {
  const fake = await startFakeOpenJev();
  const home = tempDir();
  const env = makeEnv(home, {
    OPENJEV_BASE_URL: fake.url,
    JEV_PRUNING_MODE: "active",
    JEV_PRUNING_WRITE_TIME_MIN_TOKENS: "10",
  });
  const agyScript = path.join(JEV_ROOT, "adapters", "agy", "hooks.mjs");
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "agy-cache-test",
    tool_name: "Bash",
    tool_input: { command: "npm install" },
    tool_response: verboseLines("agy install", 50),
  });

  try {
    const res1 = await runNodeScript(agyScript, payload, env);
    assert.equal(res1.code, 0);
    const out1 = JSON.parse(res1.stdout);
    assert.ok(typeof out1.overwrite_result === "string" && out1.overwrite_result.includes("[jev-prune:"), "first call should elide");
    assert.equal(fake.state.calls, 1);

    const cachePath = path.join(home, "decision-cache.json");
    assert.ok(fs.existsSync(cachePath), "decision-cache.json must be persisted after Agy active plan()");
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.ok(Object.keys(cached.entries || {}).length >= 1, "persisted cache must contain the learned drop decision");
  } finally {
    await fake.close();
  }
});

// ============================================================================
// P1 #8: hooks/handler.mjs Codex prewarm writeTime: true & proxy-matching scope
// ============================================================================
test("P1 #8: Codex PostToolUse prewarm passes writeTime: true and proxy-matching scope so proxy gets cache hit", async () => {
  const home = tempDir();
  const upstreamUrl = "http://127.0.0.1:43210";
  const env = makeEnv(home, {
    JEV_PRUNING_BACKGROUND: "true",
    JEV_PROXY_UPSTREAM: upstreamUrl,
  });

  let capturedJob = null;
  const toolText = verboseLines("codex build log", 50);

  const hookResult = await handleHookEvent(
    {
      hook_event_name: "PostToolUse",
      session_id: "codex-sess-1",
      tool_name: "bash",
      tool_input: { command: "npm run build" },
      tool_response: toolText,
    },
    {
      host: "codex",
      proxyUpstream: upstreamUrl,
      engineConfig: createPipeline({ env, client: droppingClient(), logger: () => {} }).config,
      spawnPrewarm: (job) => {
        capturedJob = job;
        return true;
      },
    },
  );

  assert.deepEqual(hookResult.response, {});
  assert.ok(capturedJob, "spawnPrewarm must be invoked");
  assert.equal(capturedJob.writeTime, true, "Codex prewarm must set writeTime: true so single item is not treated as recent");
  assert.equal(capturedJob.scope, "proxy:127.0.0.1:43210", "Codex prewarm scope must match proxy scope");

  // Run prewarm with captured job and verify proxy hits the warmed cache with 0 blocking OpenJEV calls
  const prewarmClient = droppingClient();
  const prewarmPipeline = createPipeline({ env, client: prewarmClient, logger: () => {} });
  const warmed = await prewarmPipeline.prewarm(capturedJob.items, {
    scope: capturedJob.scope,
    writeTime: capturedJob.writeTime,
    priorDigests: new Map(capturedJob.priorDigests),
  });
  assert.equal(warmed.classified, 1, "single-item writeTime prewarm must classify and cache the item");
  assert.equal(prewarmClient.calls, 1);

  const proxyClient = droppingClient();
  const proxyPipeline = createPipeline({ env, client: proxyClient, logger: () => {} });
  const proxy = createPruningProxy({ pipeline: proxyPipeline, upstream: upstreamUrl });
  const reqBody = JSON.stringify({
    model: "gpt-4o",
    messages: [
      { role: "user", content: "build project" },
      { role: "tool", tool_call_id: "call_1", name: "bash", content: toolText },
      { role: "tool", tool_call_id: "call_2", name: "bash", content: "recent tail" },
    ],
  });
  const prunedStr = await proxy.pruneRequestBody(reqBody);
  const pruned = JSON.parse(prunedStr);
  assert.match(pruned.messages[1].content, /\[jev-prune\]/, "proxy must prune using the cache entry warmed by Codex hook");
  assert.equal(proxyClient.calls, 0, "proxy must hit the warmed cache without calling OpenJEV");
});

// ============================================================================
// P2 #9: redact.mjs $1 capture expansion (no literal "$1" or $&/$$ expansion)
// ============================================================================
test("P2 #9: redact expands $1 capture groups cleanly without literal $1 or special pattern bugs", () => {
  const auth = redact("Authorization: Bearer abcdef1234567890");
  assert.equal(auth.text, "Authorization: [REDACTED:authorization-header]");
  assert.ok(!auth.text.includes("$1"));

  const assign = redact("MY_API_KEY=supersecretvalue123");
  assert.equal(assign.text, "MY_API_KEY=[REDACTED:secret-assignment]");
  assert.ok(!assign.text.includes("$1"));

  const uri = redact("postgres://admin:mysecretpass@db.local:5432/app");
  assert.equal(uri.text, "postgres://[REDACTED:uri-credentials]@db.local:5432/app");

  const curl = redact("curl -u user:secretpass123 https://example.com");
  assert.equal(curl.text, "curl -u [REDACTED:curl-userpass] https://example.com");

  const cookie = redact("Cookie: session=abcdef123456");
  assert.equal(cookie.text, "Cookie: [REDACTED:cookie-header]");
});

// ============================================================================
// P2 #10: elision.mjs path traversal prevention
// ============================================================================
test("P2 #10: elideItem prevents path traversal via scope and digest", () => {
  const base = tempDir("jev-elision-root-");
  const elisionPath = path.join(base, "elided");
  fs.mkdirSync(elisionPath, { recursive: true });
  const resolvedRoot = path.resolve(elisionPath);

  const cases = [
    { scope: "..", digest: "abc123" },
    { scope: "../../outside", digest: "abc123" },
    { scope: "normal", digest: "../../../pwned" },
    { scope: "..", digest: "../../pwned" },
  ];

  for (const c of cases) {
    const result = elideItem(
      { text: "verbose output", tokens: 100, tool: "bash", digest: c.digest },
      { scope: c.scope, config: { elisionStash: true, elisionPath } },
    );
    if (result.ok) {
      const resolvedStash = path.resolve(result.stashPath);
      assert.ok(
        resolvedStash.startsWith(`${resolvedRoot}${path.sep}`),
        `stashPath ${resolvedStash} escaped elision root ${resolvedRoot}`,
      );
    }
  }

  // Ensure nothing was created directly in parent `base` other than `elided`
  assert.deepEqual(fs.readdirSync(base), ["elided"]);
});

// ============================================================================
// P2 #11: classifier.mjs number !== string comparison bug (resourceNewest)
// ============================================================================
test("P2 #11: classifyAll protects newest snapshot of a resource in Stage 1 (flags.resourceNewest === true)", () => {
  const items = [
    { id: "u1", role: "user", text: "edit a.mjs", digest: "d_u1", meta: {} },
    { id: "read_old", role: "tool", tool: "read", text: "// v1", digest: "d_r1", meta: { group: "file", resourceKey: "file:/src/a.mjs" } },
    { id: "read_new", role: "tool", tool: "read", text: "// v2", digest: "d_r2", meta: { group: "file", resourceKey: "file:/src/a.mjs" } },
    { id: "tail_1", role: "tool", tool: "bash", text: "ok 1", digest: "d_t1", meta: { group: "command" } },
    { id: "tail_2", role: "tool", tool: "bash", text: "ok 2", digest: "d_t2", meta: { group: "command" } },
  ];

  const { verdicts } = classifyAll(items, { keepRecentItems: 2 });
  const oldVerdict = verdicts.find((v) => v.id === "read_old");
  const newVerdict = verdicts.find((v) => v.id === "read_new");

  assert.equal(oldVerdict.flags.resourceNewest, false);
  assert.equal(oldVerdict.action, "ask");
  assert.equal(newVerdict.flags.resourceNewest, true, "newest file snapshot must have resourceNewest=true");
  assert.equal(newVerdict.action, "keep", "newest file snapshot must be kept in Stage 1 without asking OpenJEV");
});

// ============================================================================
// P2 #12: proxy/server.mjs role: "tool" pruning in Responses API & numeric tokens
// ============================================================================
test("P2 #12: proxy prunes role:'tool' in Responses API and formats numeric token counts (no undefined tokens)", async () => {
  const home = tempDir();
  const pipeline = createPipeline({ env: makeEnv(home), client: droppingClient(), logger: () => {} });
  const proxy = createPruningProxy({ pipeline, upstream: "http://127.0.0.1:1" });

  // Responses API with role: "tool" (content field)
  const responsesBody = JSON.stringify({
    model: "gpt-4o",
    input: [
      { role: "user", content: "check logs" },
      { role: "tool", id: "r_tool_1", name: "bash", content: verboseLines("responses tool log", 40) },
      { type: "function_call_output", call_id: "r_fn_2", name: "bash", output: verboseLines("fn output", 40) },
      { role: "tool", id: "r_tail", name: "bash", content: "recent" },
    ],
  });
  const prunedResponses = JSON.parse(await proxy.pruneRequestBody(responsesBody));
  assert.match(prunedResponses.input[1].content, /\[jev-prune\] this tool output \(\d+ tokens\)/, "role:'tool' content must be pruned with numeric tokens");
  assert.ok(!prunedResponses.input[1].content.includes("undefined"), "must not contain undefined tokens");
  assert.equal(prunedResponses.input[1].output, undefined, "role:'tool' item should update content, not add bogus output field");
  assert.match(prunedResponses.input[2].output, /\[jev-prune\] this tool output \(\d+ tokens\)/, "function_call_output must be pruned with numeric tokens");

  // Chat Completions API
  const chatBody = JSON.stringify({
    model: "gpt-4o",
    messages: [
      { role: "user", content: "check logs" },
      { role: "tool", tool_call_id: "c_1", name: "bash", content: verboseLines("chat tool log", 40) },
      { role: "tool", tool_call_id: "c_tail", name: "bash", content: "recent" },
    ],
  });
  const prunedChat = JSON.parse(await proxy.pruneRequestBody(chatBody));
  assert.match(prunedChat.messages[1].content, /\[jev-prune\] this tool output \(\d+ tokens\)/);
  assert.ok(!prunedChat.messages[1].content.includes("undefined"));
});

// ============================================================================
// P2 #13: opencode/plugin.mjs non-blocking background, numeric tokens, part removal
// ============================================================================
test("P2 #13: OpenCode plugin is non-blocking in background mode, formats numeric tokens, and removes parts without part.id", async () => {
  const slowFake = await startFakeOpenJev({ delayMs: 350 });
  const prevEnv = { ...process.env };
  try {
    // 13a: background mode does not block transform on OpenJEV
    const homeBg = tempDir();
    Object.assign(
      process.env,
      makeEnv(homeBg, {
        OPENJEV_BASE_URL: slowFake.url,
        JEV_PRUNING_MODE: "active",
        JEV_PRUNING_BACKGROUND: "true",
        JEV_PRUNING_OPENCODE_TOMBSTONE: "true",
      }),
    );
    const { JevPrunePlugin } = await import("../jev-context/adapters/opencode/plugin.mjs");
    const bgHooks = await JevPrunePlugin();
    const bgMessages = [
      { info: { role: "user", sessionID: "bg-1" }, parts: [{ id: "u1", type: "text", text: "go" }] },
      { info: { role: "assistant", sessionID: "bg-1" }, parts: [{ id: "p1", type: "tool", tool: "bash", state: { status: "completed", output: verboseLines("bg") } }] },
      { info: { role: "assistant", sessionID: "bg-1" }, parts: [{ id: "p2", type: "tool", tool: "bash", state: { status: "completed", output: "tail" } }] },
    ];
    const t0 = Date.now();
    await bgHooks["experimental.chat.messages.transform"]({}, { messages: bgMessages });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 200, `background transform should not block on slow OpenJEV (took ${elapsed}ms)`);
    // Give background prewarm time to finish before closing slowFake
    await new Promise((r) => setTimeout(r, 450));

    // 13b: tombstone has numeric tokens (never "undefined tokens")
    const fastFake = await startFakeOpenJev({ delayMs: 0 });
    try {
      const homeTomb = tempDir();
      Object.assign(
        process.env,
        makeEnv(homeTomb, {
          OPENJEV_BASE_URL: fastFake.url,
          JEV_PRUNING_MODE: "active",
          JEV_PRUNING_BACKGROUND: "false",
          JEV_PRUNING_OPENCODE_TOMBSTONE: "true",
        }),
      );
      const tombHooks = await JevPrunePlugin();
      const tombMessages = [
        { info: { role: "user", sessionID: "tomb-1" }, parts: [{ id: "u1", type: "text", text: "go" }] },
        { info: { role: "assistant", sessionID: "tomb-1" }, parts: [{ id: "p1", type: "tool", tool: "bash", state: { status: "completed", output: verboseLines("tomb") } }] },
        { info: { role: "assistant", sessionID: "tomb-1" }, parts: [{ id: "p2", type: "tool", tool: "bash", state: { status: "completed", output: "tail" } }] },
      ];
      await tombHooks["experimental.chat.messages.transform"]({}, { messages: tombMessages });
      const tombOut = tombMessages[1].parts[0].state.output;
      assert.match(tombOut, /\(\d+ tokens, tool=bash\)/, "tombstone must display numeric token count");
      assert.ok(!tombOut.includes("undefined"), "tombstone must not contain undefined");

      // 13c: tombstone=false removes parts even when they only have callID or no id at all
      const homeDrop = tempDir();
      Object.assign(
        process.env,
        makeEnv(homeDrop, {
          OPENJEV_BASE_URL: fastFake.url,
          JEV_PRUNING_MODE: "active",
          JEV_PRUNING_BACKGROUND: "false",
          JEV_PRUNING_OPENCODE_TOMBSTONE: "false",
        }),
      );
      const dropHooks = await JevPrunePlugin();
      const dropMessages = [
        { info: { role: "user", sessionID: "drop-1" }, parts: [{ id: "u1", type: "text", text: "go" }] },
        {
          info: { role: "assistant", sessionID: "drop-1" },
          parts: [
            { callID: "call_only_id", type: "tool", tool: "bash", state: { status: "completed", output: verboseLines("callid") } },
            { type: "tool", tool: "bash", state: { status: "completed", output: verboseLines("no_id") } },
          ],
        },
        { info: { role: "assistant", sessionID: "drop-1" }, parts: [{ id: "p_tail", type: "tool", tool: "bash", state: { status: "completed", output: "tail" } }] },
      ];
      await dropHooks["experimental.chat.messages.transform"]({}, { messages: dropMessages });
      assert.equal(dropMessages[1].parts.length, 0, "tool parts with callID-only or no id must be removed when tombstone=false");
      assert.equal(dropMessages[2].parts.length, 1, "recent tail part must remain");
    } finally {
      await fastFake.close();
    }
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
    await slowFake.close();
  }
});

// ============================================================================
// P2 #14: bin/jev-prune.mjs off -> on must resume in shadow, not active
// ============================================================================
test("P2 #14: jev-prune on after off resumes in shadow mode even when JEV_PRUNING_MODE=active", () => {
  const home = tempDir();
  const binPath = path.join(JEV_ROOT, "bin", "jev-prune.mjs");
  const env = {
    ...process.env,
    JEV_PRUNING_HOME: home,
    JEV_PRUNING_MODE: "active",
    OPENJEV_API_KEY: "oj_test.cli-key-000000000000",
  };

  execFileSync(process.execPath, [binPath, "off"], { env, encoding: "utf8" });
  const afterOff = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
  assert.equal(afterOff.mode, "off");

  const stdout = execFileSync(process.execPath, [binPath, "on"], { env, encoding: "utf8" });
  assert.match(stdout, /mode set to shadow/, "jev-prune on after off must transition to shadow");
  const afterOn = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
  assert.equal(afterOn.mode, "shadow", "persisted mode must be shadow, not active");
});

// ============================================================================
// P2 #15: benchmark/run.mjs wouldDrop must not be inflated to total item count
// ============================================================================
test("P2 #15: benchmark agy shadow wouldDrop reflects actual prewarm decisions, not total item count", () => {
  const benchPath = path.join(JEV_ROOT, "benchmark", "run.mjs");
  const output = execFileSync(process.execPath, [benchPath], {
    env: {
      ...process.env,
      JEV_BENCH_TURNS: "4",
      JEV_BENCH_ROUND_TRIP_MS: "1",
    },
    encoding: "utf8",
  });

  const totalMatch = /(\d+)\s+context items/.exec(output);
  assert.ok(totalMatch, `expected context items count in benchmark output:\n${output}`);
  const totalItems = Number(totalMatch[1]);

  const shadowMatch = /agy shadow\s+[\d,]+\s+[\d.]+%\s+\d+\s+(\d+)/.exec(output);
  assert.ok(shadowMatch, `expected agy shadow row in benchmark output:\n${output}`);
  const agyShadowWouldDrop = Number(shadowMatch[1]);

  assert.ok(agyShadowWouldDrop > 0, `agy shadow wouldDrop (${agyShadowWouldDrop}) should be > 0`);
  assert.ok(
    agyShadowWouldDrop < totalItems,
    `agy shadow wouldDrop (${agyShadowWouldDrop}) must be strictly less than total context items (${totalItems})`,
  );
});
