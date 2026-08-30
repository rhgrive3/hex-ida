import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUIET_TEST_REPORTER,
  discoverPhaseTests,
  parsePhaseGroup,
  parseTestOutputMode,
  selectPhaseTests,
  runPhaseNodeTests,
} from "./support/phase-node-test-runner.mjs";
import { discoverPhase8Tests } from "./phase8/run.mjs";
import { discoverPhase9Tests } from "./phase9/run.mjs";
import { discoverPhase10Tests } from "./phase10/run.mjs";
import { parseQuietCommandArgs, runQuietCommand } from "../scripts/run-quiet-command.mjs";

console.log("Testing Phase test runner contract...");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hex-phase-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureSink() {
  const chunks = [];
  return {
    stream: { write(chunk) { chunks.push(String(chunk)); } },
    text() { return chunks.join(""); },
  };
}

// 1. recursive discovery
withTempDir((temp) => {
  fs.mkdirSync(path.join(temp, "foundation"), { recursive: true });
  fs.mkdirSync(path.join(temp, "vertical"), { recursive: true });
  fs.writeFileSync(path.join(temp, "foundation", "a.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "vertical", "b.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "c.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "ignore.mjs"), "");
  fs.writeFileSync(path.join(temp, "ignore.js"), "");

  const discovered = discoverPhaseTests(temp);
  assert.equal(discovered.length, 3);
  assert.ok(discovered.every((f) => f.endsWith(".test.mjs")));
  console.log("  ok 1 recursive discovery");
});

// 2. deterministic byte ordering
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "z.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "m.test.mjs"), "");
  const discovered = discoverPhaseTests(temp).map((f) => path.basename(f));
  assert.deepEqual(discovered, ["a.test.mjs", "m.test.mjs", "z.test.mjs"]);
  console.log("  ok 2 deterministic byte ordering");
});

// 3. no-test failure
withTempDir((temp) => {
  assert.throws(() => runPhaseNodeTests({ phase: "testphase", root: temp }), (err) => {
    return err.message === "testphase: no contract tests discovered";
  });
  console.log("  ok 3 no-test failure");
});

// 4. argv contract
{
  assert.equal(parsePhaseGroup([], { phase: "p" }), null);
  assert.equal(parsePhaseGroup(["--group", "foundation"], { phase: "p" }), "foundation");
  assert.equal(parsePhaseGroup(["--group", "foundation/"], { phase: "p" }), "foundation");
  assert.throws(() => parsePhaseGroup(["--group", "foundation", "extra"], { phase: "p" }), TypeError);
  assert.throws(() => parsePhaseGroup(["--group=foundation"], { phase: "p" }), TypeError);
  assert.throws(() => parsePhaseGroup(["--group", "../x"], { phase: "p" }), TypeError);
  assert.throws(() => parsePhaseGroup(["--group", "Upper"], { phase: "p" }), TypeError);
  assert.throws(() => parsePhaseGroup(["--group", "foo\\bar"], { phase: "p" }), TypeError);
  console.log("  ok 4 argv contract");
}

// 5. file group selection
withTempDir((temp) => {
  const files = [
    path.join(temp, "smoke.test.mjs"),
    path.join(temp, "smoke-extra.test.mjs"),
  ];
  const selected = selectPhaseTests(files, { root: temp, group: "smoke" });
  assert.deepEqual(selected, [path.join(temp, "smoke.test.mjs")]);
  console.log("  ok 5 file group selection");
});

// 6. directory group selection
withTempDir((temp) => {
  const files = [
    path.join(temp, "foundation", "a.test.mjs"),
    path.join(temp, "foundation", "sub", "b.test.mjs"),
    path.join(temp, "vertical", "c.test.mjs"),
  ];
  const selected = selectPhaseTests(files, { root: temp, group: "foundation" });
  assert.equal(selected.length, 2);
  console.log("  ok 6 directory group selection");
});

// 7. empty group failure
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  assert.throws(() => runPhaseNodeTests({ phase: "testphase", root: temp, argv: ["--group", "nonexistent"] }), (err) => {
    return err.message === "testphase: group has no discovered tests: nonexistent";
  });
  console.log("  ok 7 empty group failure");
});

// 8. spawn argv lock
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  const spawnCalls = [];
  const fakeSpawn = (execPath, args, options) => {
    spawnCalls.push({ execPath, args, options });
    return { status: 0 };
  };
  runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].execPath, process.execPath);
  assert.equal(spawnCalls[0].args[0], "--test");
  assert.match(spawnCalls[0].args[1], /^--test-reporter=.*quiet-test-reporter\.mjs$/);
  assert.equal(spawnCalls[0].options.env.HEX_TEST_REPORTER_MACHINE, "0");
  assert.equal(spawnCalls[0].args[2], "--test-concurrency=1");
  assert.equal(spawnCalls[0].args[3], path.join(temp, "a.test.mjs"));
  console.log("  ok 8 spawn argv lock");
});

// 9. spawn options lock
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  let capturedOpts = null;
  const fakeSpawn = (execPath, args, options) => {
    capturedOpts = options;
    return { status: 0 };
  };
  runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn, cwd: "/custom/cwd" });
  assert.equal(capturedOpts.cwd, "/custom/cwd");
  assert.equal(capturedOpts.encoding, "utf8");
  assert.equal(capturedOpts.maxBuffer, 512 * 1024 * 1024);
  console.log("  ok 9 spawn options lock");
});

// 10. child error propagation
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  const sentinel = new Error("sentinel error");
  const fakeSpawn = () => ({ error: sentinel });
  assert.throws(() => runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn }), (err) => err === sentinel);
  console.log("  ok 10 child error propagation");
});

// 11. non-zero status
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  const fakeSpawn = () => ({ status: 7 });
  assert.throws(() => runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn }), (err) => {
    return err.message === "testphase: test runner failed with status 7";
  });
  console.log("  ok 11 non-zero status");
});

// 12. success result
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  const fakeSpawn = () => ({ status: 0 });
  const result = runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(result, { selected: 1, total: 1, group: null });
  console.log("  ok 12 success result");
});

// 13. wrapper discovery parity
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  assert.deepEqual(discoverPhase8Tests(temp), discoverPhaseTests(temp));
  assert.deepEqual(discoverPhase9Tests(temp), discoverPhaseTests(temp));
  assert.deepEqual(discoverPhase10Tests(temp), discoverPhaseTests(temp));
  console.log("  ok 13 wrapper discovery parity");
});

// 14. wrapper execution parity
{
  const src8 = fs.readFileSync(new URL("./phase8/run.mjs", import.meta.url), "utf8");
  const src9 = fs.readFileSync(new URL("./phase9/run.mjs", import.meta.url), "utf8");
  const src10 = fs.readFileSync(new URL("./phase10/run.mjs", import.meta.url), "utf8");
  assert.ok(src8.includes('phase: "phase8"'));
  assert.ok(src9.includes('phase: "phase9"'));
  assert.ok(src10.includes('phase: "phase10"'));
  console.log("  ok 14 wrapper execution parity");
}

// 15. real current discovery counts
{
  const p8 = discoverPhase8Tests();
  const p9 = discoverPhase9Tests();
  const p10 = discoverPhase10Tests();
  assert.ok(p8.length > 0);
  assert.ok(p9.length > 0);
  assert.ok(p10.length > 0);
  assert.ok(p8.every((f) => f.endsWith(".test.mjs")));
  assert.ok(p9.every((f) => f.endsWith(".test.mjs")));
  assert.ok(p10.every((f) => f.endsWith(".test.mjs")));
  console.log("  ok 15 real current discovery non-empty");
}

// 16. Phase 8 recursive-discovery invariant
{
  const p8 = discoverPhase8Tests();
  const phase8Root = fileURLToPath(new URL("./phase8", import.meta.url));
  const nested = p8.some((f) => path.dirname(f) !== phase8Root);
  assert.ok(nested, "Phase 8 must discover tests in subdirectories");
  console.log("  ok 16 Phase 8 recursive-discovery invariant");
}

// 17. output modes
{
  assert.equal(parseTestOutputMode({}), "quiet");
  assert.equal(parseTestOutputMode({ HEX_TEST_OUTPUT: "machine" }), "machine");
  assert.equal(parseTestOutputMode({ HEX_TEST_OUTPUT: "verbose" }), "verbose");
  assert.equal(parseTestOutputMode({ HEX_TEST_OUTPUT: "full" }), "verbose");
  assert.throws(() => parseTestOutputMode({ HEX_TEST_OUTPUT: "almost-quiet" }), TypeError);
  console.log("  ok 17 output modes");
}

// 18. reporter suppresses pass chatter, preserves machine records, and explains failures
withTempDir((temp) => {
  const passFile = path.join(temp, "pass.test.mjs");
  const failFile = path.join(temp, "fail.test.mjs");
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...childEnv } = process.env;
  fs.writeFileSync(passFile, [
    "import test from 'node:test';",
    "test('pass', () => console.log('NOISY_PASS_LINE'));",
    "console.log('TEST_PROOF={\\\"ok\\\":true}');",
  ].join("\n"));
  fs.writeFileSync(failFile, [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "test('bad', () => { console.log('failure context'); assert.equal(1, 2); });",
  ].join("\n"));

  const quiet = spawnSync(process.execPath, ["--test", `--test-reporter=${QUIET_TEST_REPORTER}`, passFile], {
    encoding: "utf8",
    env: { ...childEnv, HEX_TEST_REPORTER_MACHINE: "0" },
  });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");

  const machine = spawnSync(process.execPath, ["--test", `--test-reporter=${QUIET_TEST_REPORTER}`, passFile], {
    encoding: "utf8",
    env: { ...childEnv, HEX_TEST_REPORTER_MACHINE: "1" },
  });
  assert.equal(machine.status, 0, machine.stderr);
  assert.match(machine.stdout, /TEST_PROOF=\{"ok":true\}/);
  assert.doesNotMatch(machine.stdout, /NOISY_PASS_LINE/);

  const failure = spawnSync(process.execPath, ["--test", `--test-reporter=${QUIET_TEST_REPORTER}`, failFile], {
    encoding: "utf8",
    env: { ...childEnv, HEX_TEST_REPORTER_MACHINE: "0" },
  });
  assert.equal(failure.status, 1);
  assert.match(failure.stdout, /FAIL bad/);
  assert.match(failure.stdout, /failure context/);
  assert.match(failure.stdout, /AssertionError/);
  console.log("  ok 18 reporter behavior");
});

// 19. whole-command parser
{
  assert.deepEqual(parseQuietCommandArgs(["--label", "check", "--", "npm", "run", "check"]), {
    label: "check",
    command: "npm",
    args: ["run", "check"],
  });
  assert.throws(() => parseQuietCommandArgs(["npm", "run", "check"]), TypeError);
  assert.throws(() => parseQuietCommandArgs(["--"]), TypeError);
  console.log("  ok 19 whole-command parser");
}

// 20. successful whole-command run emits one line and deletes the full log
{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hex-quiet-success-"));
  try {
    const stdout = captureSink();
    const stderr = captureSink();
    const result = await runQuietCommand({
      label: "agent-check",
      command: process.execPath,
      args: ["-e", "for(let i=0;i<500;i++) console.log('success-log-'+i)"],
      env: { ...process.env, HEX_TEST_OUTPUT: "quiet" },
      stdout: stdout.stream,
      stderr: stderr.stream,
      tempRoot,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.equal(result.logPath, null);
    assert.match(stdout.text(), /^agent-check: PASS \([0-9.]+s\)\n$/);
    assert.doesNotMatch(stdout.text(), /success-log/);
    assert.equal(stderr.text(), "");
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("  ok 20 whole-command success");
}

// 21. failed whole-command run keeps the full log but bounds agent-visible output
{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hex-quiet-failure-"));
  try {
    const stdout = captureSink();
    const stderr = captureSink();
    const result = await runQuietCommand({
      label: "agent-test",
      command: process.execPath,
      args: ["-e", "for(let i=0;i<3000;i++) console.log('line-'+i); console.error('fatal-marker'); process.exit(7)"],
      env: { ...process.env, HEX_TEST_OUTPUT: "quiet" },
      stdout: stdout.stream,
      stderr: stderr.stream,
      tempRoot,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 7);
    assert.equal(stdout.text(), "");
    assert.match(stderr.text(), /agent-test: FAIL \(exit 7,/);
    assert.match(stderr.text(), /fatal-marker/);
    assert.match(stderr.text(), /failure tail \(max 64 KiB\)/);
    assert.match(stderr.text(), /Full log:/);
    assert.match(stderr.text(), /HEX_TEST_OUTPUT=verbose/);
    assert.ok(Buffer.byteLength(stderr.text()) < 70 * 1024, "diagnostic output must remain bounded");
    assert.ok(result.logPath && fs.existsSync(result.logPath));
    assert.equal(fs.statSync(result.logPath).mode & 0o777, 0o600);
    const full = fs.readFileSync(result.logPath, "utf8");
    assert.match(full, /line-0/);
    assert.match(full, /line-2999/);
    assert.match(full, /fatal-marker/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("  ok 21 whole-command failure");
}

// 22. command-not-found stays diagnostic and is retained in the private full log
{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hex-quiet-spawn-error-"));
  try {
    const stdout = captureSink();
    const stderr = captureSink();
    const missingCommand = path.join(tempRoot, "definitely-missing-command");
    const result = await runQuietCommand({
      label: "agent-spawn",
      command: missingCommand,
      args: [],
      env: { ...process.env, HEX_TEST_OUTPUT: "quiet" },
      stdout: stdout.stream,
      stderr: stderr.stream,
      tempRoot,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.equal(result.error?.code, "ENOENT");
    assert.equal(stdout.text(), "");
    assert.match(stderr.text(), /agent-spawn: FAIL \(spawn error: ENOENT,/);
    assert.match(stderr.text(), /failure tail \(max 64 KiB\)/);
    assert.match(stderr.text(), /ENOENT/);
    assert.match(stderr.text(), /Full log:/);
    assert.ok(result.logPath && fs.existsSync(result.logPath));
    assert.equal(fs.statSync(result.logPath).mode & 0o777, 0o600);
    const full = fs.readFileSync(result.logPath, "utf8");
    assert.match(full, /ENOENT/);
    assert.match(full, /definitely-missing-command/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("  ok 22 whole-command spawn error");
}

console.log("All Phase test runner contract tests PASS!");
