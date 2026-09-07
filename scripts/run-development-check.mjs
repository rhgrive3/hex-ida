#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LEGACY_CHECKPOINT_TESTS } from '../tests/final-closure/run.mjs';
import { runQuietCommand } from './run-quiet-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnableTest = p => /^tests\/.+\.(?:test\.)?m?js$/.test(p)
  && !/(?:^|\/)(?:fixtures?|corpus|support)(?:\/|\.)/.test(p)
  && !/(?:^|\/)run\.[cm]?js$/.test(p);
const codePath = p => /\.(?:[cm]?js|ts|tsx|jsx|wasm|css|html|ya?ml|jsonc?)$/.test(p)
  || /(?:^|\/)(?:package(?:-lock)?\.json)$/.test(p);

export function parseArgs(argv) {
  const options = { base: 'HEAD', tests: [], scripts: [], plan: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--plan') { options.plan = true; continue; }
    if (!['--base', '--test', '--script'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('-')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--base') options.base = value;
    else options[flag === '--test' ? 'tests' : 'scripts'].push(value);
  }
  return options;
}

export function changedPaths(root, base) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Resolve refs before diffing; no shell expansion, ref updates or checkout.
  const sha = git(['rev-parse', '--verify', `${base}^{commit}`]).trim();
  return [...new Set([
    ...git(['diff', '--name-only', '--no-renames', '-z', sha, '--']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
}

export function buildPlan({ paths, tests = [], scripts = [], exists, packageScripts = {}, ownership = {} }) {
  const selected = new Map();
  const add = argv => selected.set(JSON.stringify(argv), argv);
  const explicitTests = new Set(tests);
  for (const p of [...paths, ...tests]) {
    if (explicitTests.has(p) && (!runnableTest(p) || !exists(p))) throw new Error(`Not an executable test: ${p}`);
    if (runnableTest(p) && exists(p)
      && (explicitTests.has(p) || !p.startsWith('tests/final-closure/')
        || !LEGACY_CHECKPOINT_TESTS.has(p.slice('tests/final-closure/'.length)))) add(['node', p]);
  }
  // Reuse declared task tests. Do not replay rolling/shadow/checkpoint history.
  for (const [id, task] of Object.entries(ownership.tasks || {})) {
    const touchesSource = paths.some(p => p.startsWith('js/')
      && (task.allowedPaths || []).some(pattern => path.matchesGlob(p, pattern)));
    const groupPath = `tests/final-closure/${id.toLowerCase()}`;
    if (touchesSource && exists(groupPath)) {
      for (const [key, argv] of selected) {
        if (argv[0] === 'node' && argv[1].startsWith(groupPath + '/')) selected.delete(key);
      }
      add(['node', 'tests/final-closure/run.mjs', '--group', id.toLowerCase()]);
    }
  }
  for (const name of scripts) {
    if (!Object.hasOwn(packageScripts, name) || ['check:dev', 'check:one', 'check:parallel'].includes(name)) {
      throw new Error(`Unknown or recursive script: ${name}`);
    }
    add(['npm', 'run', name]);
  }
  const commands = [...selected.values()];
  const needsSelection = paths.some(codePath) && commands.length === 0;
  return { paths, commands, needsSelection, releaseEvaluated: false };
}

export async function main(argv = process.argv.slice(2), root = ROOT) {
  const options = parseArgs(argv);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ownershipPath = path.join(root, 'specs/005-analysis-final-closure/contracts/task-ownership.json');
  const ownership = fs.existsSync(ownershipPath) ? JSON.parse(fs.readFileSync(ownershipPath, 'utf8')) : {};
  const exists = p => {
    const resolved = path.resolve(root, p);
    return resolved.startsWith(root + path.sep) && fs.existsSync(resolved);
  };
  const plan = buildPlan({ ...options, paths: changedPaths(root, options.base), exists,
    packageScripts: pkg.scripts, ownership });
  if (options.plan) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  if (plan.needsSelection) {
    console.error('Changed code has no selected regression. Add --test tests/path.test.mjs or --script subsystem:test. Use --plan to inspect.');
    return 2;
  }
  if (!plan.commands.length) {
    console.log(`development: ${plan.paths.length} changed paths; no executable tests selected (documentation/configuration only, or empty diff). Release not evaluated.`);
    return 0;
  }
  console.log(`development: ${plan.paths.length} changed paths; ${plan.commands.length} focused commands; cwd=${root}`);
  for (const [command, ...args] of plan.commands) {
    const result = await runQuietCommand({ label: args.join(' '), command, args, cwd: root });
    if (!result.ok) return result.status || 1;
  }
  console.log('development: selected checks PASS; release not evaluated.');
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message); process.exitCode = 2;
  });
}
