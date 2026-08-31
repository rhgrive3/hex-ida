#!/usr/bin/env node

// Single-step quiet gate for a named npm script.
//
// Purpose: fast feedback during development without running the full check.
// This does NOT replace `npm run check` — it runs exactly one existing
// package.json script through the standard quiet wrapper. No test is skipped
// or weakened anywhere; this only chooses how much you re-run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQuietCommand } from './run-quiet-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error('usage: node scripts/run-one-check.mjs <npm-script> [extra args...]');
  console.error('       node scripts/run-one-check.mjs --list');
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [first, ...rest] = process.argv.slice(2);
if (!first || first === '--help' || first === '-h') usage();
if (first === '--list') {
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) console.log(`${name.padEnd(24)} ${script}`);
  process.exit(0);
}
if (!(pkg.scripts?.[first])) {
  console.error(`unknown npm script: ${first}`);
  usage();
}

const result = await runQuietCommand({
  label: first,
  command: 'npm',
  args: ['run', first, ...rest],
  cwd: root,
});
if (!result.ok) process.exitCode = result.status || 1;
