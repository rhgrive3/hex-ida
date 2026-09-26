import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { MAX_HOOK_INPUT_BYTES, readHookInput } from "../adapters/hooks/protocol.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const JEV_ROOT = path.resolve(TEST_DIR, "..");

function paddedSessionStart(size) {
  const body = Buffer.from('{"hook_event_name":"SessionStart"}');
  assert.ok(body.length <= size);
  return Buffer.concat([body, Buffer.alloc(size - body.length, 0x20)]);
}

async function runHook(adapter, input, home) {
  const hookPath = path.join(JEV_ROOT, "adapters", adapter, "hooks.mjs");
  const child = spawn(process.execPath, [hookPath], {
    cwd: JEV_ROOT,
    env: {
      ...process.env,
      OPENJEV_API_KEY: "",
      JEV_PRUNING_HOME: home,
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      TMP: process.env.TMP || process.env.TMPDIR || os.tmpdir(),
      TEMP: process.env.TEMP || process.env.TMPDIR || os.tmpdir(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  // Closing stdin as soon as the adapter rejects an oversized body can produce
  // EPIPE in this writer; that is expected and does not affect the host result.
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  child.stdin.end(input);
  return closed;
}

export async function hookStdinTests(test) {
  await test("normal JSON hook payload parses, including a split UTF-8 character", async () => {
    const wire = Buffer.from(JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_response: "kept locally 🐈",
    }));
    const split = wire.indexOf(Buffer.from("🐈")) + 2;
    const stream = Readable.from([wire.subarray(0, split), wire.subarray(split)], { objectMode: false });
    assert.deepEqual(await readHookInput(stream), {
      hook_event_name: "PostToolUse",
      tool_response: "kept locally 🐈",
    });
    assert.deepEqual(await readHookInput(Readable.from([Buffer.from("not json")], { objectMode: false })), {});
  });

  await test("valid payloads at limit minus one and exactly the byte limit parse", async () => {
    for (const size of [MAX_HOOK_INPUT_BYTES - 1, MAX_HOOK_INPUT_BYTES]) {
      const parsed = await readHookInput(Readable.from([paddedSessionStart(size)], { objectMode: false }));
      assert.equal(parsed.hook_event_name, "SessionStart", `payload of ${size} bytes should parse`);
    }
  });

  await test("one oversized chunk is rejected before JSON parsing", async () => {
    const oversized = Buffer.alloc(MAX_HOOK_INPUT_BYTES + 1, 0x41);
    Buffer.from("not json:").copy(oversized);
    const stream = Readable.from([oversized], { objectMode: false });
    await assert.rejects(readHookInput(stream), { code: "JEV_HOOK_INPUT_TOO_LARGE" });
    assert.equal(stream.destroyed, true, "oversized single-chunk source should be destroyed");
  });

  await test("oversized input is rejected and its source stops before EOF", async () => {
    const payloadBytes = MAX_HOOK_INPUT_BYTES * 4;
    const prefix = Buffer.from('{"tool_response":"');
    const suffix = Buffer.from('"}');
    const chunkBytes = 1024;
    let emittedBytes = 0;
    let sourceCompleted = false;

    async function* body() {
      emittedBytes += prefix.length;
      yield prefix;
      for (let offset = 0; offset < payloadBytes; offset += chunkBytes) {
        const size = Math.min(chunkBytes, payloadBytes - offset);
        emittedBytes += size;
        yield Buffer.alloc(size, 0x41);
      }
      emittedBytes += suffix.length;
      yield suffix;
      sourceCompleted = true;
    }

    const stream = Readable.from(body(), { objectMode: false, highWaterMark: chunkBytes });
    await assert.rejects(readHookInput(stream), (error) => {
      assert.equal(error.code, "JEV_HOOK_INPUT_TOO_LARGE");
      assert.match(error.message, new RegExp(`maximum supported size is ${MAX_HOOK_INPUT_BYTES} bytes`));
      return true;
    });
    assert.equal(stream.destroyed, true, "oversized source should be destroyed");
    assert.equal(sourceCompleted, false, "reader must stop before the source reaches EOF");
    assert.ok(emittedBytes < payloadBytes + prefix.length + suffix.length, "the complete input must not be consumed");
  });

  await test("Codex and Agy oversized hooks return no opinion and record no facts", async () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "oversized-session",
      tool_name: "Bash",
      tool_response: "x".repeat(MAX_HOOK_INPUT_BYTES),
    });

    for (const [adapter, storeName] of [["codex", "codex-sessions.json"], ["agy", "agy-sessions.json"]]) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-iss9643-hook-"));
      try {
        const result = await runHook(adapter, input, home);
        assert.equal(result.code, 0, `${adapter} must keep the host tool successful: ${result.stderr}`);
        assert.deepEqual(JSON.parse(result.stdout), {}, `${adapter} must fail closed with no rewrite`);
        assert.equal(fs.existsSync(path.join(home, storeName)), false, `${adapter} must not mint a session fact`);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = [];
  process.stdout.write("jev-context hook stdin\n");
  await hookStdinTests(async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      process.stdout.write(`  ok    ${name}\n`);
    } catch (error) {
      results.push({ name, ok: false });
      process.stdout.write(`  FAIL  ${name}\n        ${String(error?.stack || error).split("\n").join("\n        ")}\n`);
    }
  });
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} hook stdin checks passed`);
  if (failed.length) process.stdout.write(`, ${failed.length} failed`);
  process.stdout.write("\n");
  if (failed.length) process.exitCode = 1;
}
