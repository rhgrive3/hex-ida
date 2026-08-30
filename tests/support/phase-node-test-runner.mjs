import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const QUIET_TEST_REPORTER = fileURLToPath(new URL("./quiet-test-reporter.mjs", import.meta.url));

export function discoverPhaseTests(root) {
  const discovered = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs")) discovered.push(absolute);
    }
  }
  visit(root);
  return discovered.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export function parsePhaseGroup(argv, { phase }) {
  if (!argv || argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== "--group" || !/^[a-z0-9][a-z0-9/-]*$/.test(argv[1])) {
    throw new TypeError(`usage: node tests/${phase}/run.mjs [--group <relative-directory>]`);
  }
  return argv[1].replace(/\/$/, "");
}

export function selectPhaseTests(files, { root, group }) {
  if (group == null) return files;
  return files.filter((file) => {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    return relative === `${group}.test.mjs` || relative.startsWith(`${group}/`);
  });
}

export function parseTestOutputMode(env = process.env) {
  const value = String(env?.HEX_TEST_OUTPUT ?? "quiet").trim().toLowerCase();
  if (value === "" || value === "quiet") return "quiet";
  if (value === "machine") return "machine";
  if (value === "verbose" || value === "full") return "verbose";
  throw new TypeError(`HEX_TEST_OUTPUT must be quiet, machine, or verbose; got ${JSON.stringify(value)}`);
}

export function runPhaseNodeTests({
  phase,
  root,
  argv = [],
  label = null,
  cwd = path.resolve(root, "../.."),
  spawn = spawnSync,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  void label;
  const all = discoverPhaseTests(root);
  if (all.length === 0) throw new Error(`${phase}: no contract tests discovered`);
  const group = parsePhaseGroup(argv, { phase });
  const selected = selectPhaseTests(all, { root, group });
  if (selected.length === 0) throw new Error(`${phase}: group has no discovered tests: ${group}`);

  const outputMode = parseTestOutputMode(env);
  if (outputMode === "verbose") {
    for (const file of selected) {
      stdout.write(`[${phase}] ${path.relative(root, file).replaceAll("\\", "/")}\n`);
    }
  }

  const reporter = outputMode === "verbose" ? "spec" : QUIET_TEST_REPORTER;
  const child = spawn(process.execPath, ["--test", `--test-reporter=${reporter}`, "--test-concurrency=1", ...selected], {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: {
      ...env,
      HEX_TEST_REPORTER_MACHINE: outputMode === "machine" ? "1" : "0",
    },
  });

  if (child.error) throw child.error;
  if (child.status !== 0) {
    if (child.stderr) stderr.write(child.stderr);
    if (child.stdout) stderr.write(child.stdout);
    stderr.write(`[${phase}] rerun with HEX_TEST_OUTPUT=verbose for full test output.\n`);
    throw new Error(`${phase}: test runner failed with status ${child.status ?? "signal"}`);
  }

  if (outputMode === "verbose") {
    if (child.stderr) stderr.write(child.stderr);
    if (child.stdout) stdout.write(child.stdout);
  } else if (outputMode === "machine") {
    if (child.stderr) stderr.write(child.stderr);
    if (child.stdout) stdout.write(child.stdout);
  }

  stdout.write(`${phase}: PASS (${selected.length}/${all.length} discovered test files${group ? `, group ${group}` : ""})\n`);
  return Object.freeze({ selected: selected.length, total: all.length, group });
}
