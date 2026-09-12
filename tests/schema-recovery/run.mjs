import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/**
 * Canonical schema-recovery test runner.
 *
 * Schema recovery regressions (e.g. #5810 architecture identity authority in
 * js/schema.js) must be part of the required CI denominator: a regression file
 * that no required runner discovers can never gate a landed degradation
 * (EP-005). Discovery is recursive over this directory, like the phase
 * runners, so every `*.test.mjs` here is required by `npm test`.
 */
export function discoverSchemaRecoveryTests(root = DIRECTORY) {
  const discovered = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) discovered.push(absolute);
    }
  }
  visit(root);
  return discovered.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export function runSchemaRecoveryTests(argv = process.argv.slice(2), { root = DIRECTORY } = {}) {
  if (argv.length !== 0) throw new TypeError('usage: node tests/schema-recovery/run.mjs');
  const selected = discoverSchemaRecoveryTests(root);
  if (selected.length === 0) throw new Error('schema-recovery: no test files discovered');
  for (const file of selected) process.stdout.write(`[schema-recovery] ${path.relative(root, file).replaceAll('\\', '/')}\n`);
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', ...selected], {
    cwd: path.resolve(root, '../..'),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`schema-recovery: test runner failed with status ${child.status ?? 'signal'}`);
  console.log(`schema-recovery: PASS (${selected.length} discovered test files)`);
  return Object.freeze({ selected: selected.length, total: selected.length });
}

runSchemaRecoveryTests(process.argv.slice(2));
