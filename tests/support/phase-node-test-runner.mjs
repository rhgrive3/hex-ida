import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

export function phaseTestConcurrency(env = process.env) {
  const fallback = env.CI ? Math.min(4, Math.max(1, os.availableParallelism())) : Math.min(2, Math.max(1, os.availableParallelism()));
  const raw = env.HEX_PHASE_TEST_CONCURRENCY;
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4) {
    throw new TypeError("HEX_PHASE_TEST_CONCURRENCY must be an integer in [1,4]");
  }
  return parsed;
}

export function runPhaseNodeTests({
  phase,
  root,
  argv = [],
  label = null,
  cwd = path.resolve(root, "../.."),
  spawn = spawnSync,
}) {
  const all = discoverPhaseTests(root);
  if (all.length === 0) throw new Error(`${phase}: no contract tests discovered`);
  const group = parsePhaseGroup(argv, { phase });
  const selected = selectPhaseTests(all, { root, group });
  if (selected.length === 0) throw new Error(`${phase}: group has no discovered tests: ${group}`);

  for (const file of selected) {
    process.stdout.write(`[${phase}] ${path.relative(root, file).replaceAll("\\", "/")}\n`);
  }

  const concurrency = spawn === spawnSync ? phaseTestConcurrency() : 1;
  const child = spawn(process.execPath, ["--test", "--test-reporter=spec", `--test-concurrency=${concurrency}`, ...selected], {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });

  if (child.stderr) process.stderr.write(child.stderr);
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`${phase}: test runner failed with status ${child.status ?? "signal"}`);

  console.log(`${phase}: PASS (${selected.length}/${all.length} discovered test files${group ? `, group ${group}` : ""}; concurrency=${concurrency})`);
  return Object.freeze({ selected: selected.length, total: all.length, group });
}
