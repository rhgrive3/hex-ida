import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Use Node's module parser, including re-exports and side-effect imports, rather
// than a source regexp that could mistake comments or strings for dependencies.
if (typeof vm.SourceTextModule !== 'function') {
  const result = spawnSync(process.execPath, [
    '--no-warnings', '--experimental-vm-modules', fileURLToPath(import.meta.url),
  ], { encoding: 'utf8', env: process.env });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, 'Ghidra trigger contract subprocess failed');
} else {
  checkTriggerContract();
}

function selected(file, patterns) {
  // GitHub paths are ordered: a matching ! exclusion can override an inclusion.
  return patterns.reduce((included, pattern) => {
    const exclude = pattern.startsWith('!');
    return path.posix.matchesGlob(file, exclude ? pattern.slice(1) : pattern)
      ? !exclude : included;
  }, false);
}

function importClosure(entries, readSource) {
  const pending = [...entries];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const module = new vm.SourceTextModule(readSource(file), { identifier: file });
    for (const specifier of module.dependencySpecifiers) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      assert.ok(!resolved.startsWith('../'), `dependency escapes repository: ${file} -> ${specifier}`);
      pending.push(resolved);
    }
  }
  return [...visited].sort();
}

function assertCoverage(files, patterns) {
  const missing = files.filter(file => !selected(file, patterns));
  assert.deepEqual(missing, [], `Ghidra trigger misses reachable dependencies:\n${missing.join('\n')}`);
}

function checkTriggerContract() {
  const workflow = fs.readFileSync('.github/workflows/ghidra-differential.yml', 'utf8');
  const push = workflow.match(/^  push:\n((?:^    .*\n|^\n)*)/m)?.[1];
  assert.ok(push, 'Ghidra differential must retain its main-push trigger');
  assert.match(push, /^    branches: \[main\]$/m);
  const patterns = [...push.matchAll(/^      - '([^']+)'$/gm)].map(match => match[1]);
  assert.ok(patterns.length > 0, 'main-push paths must be parsed from the event block');

  const canonicalOwners = [
    'js/semantics/ir/**', 'js/semantics/cfg/**', 'js/semantics/ssa/**',
    'js/semantics/memoryssa/**', 'js/analysis/**', 'js/targets/abi/**',
  ];
  for (const owner of canonicalOwners) {
    assert.ok(patterns.includes(owner), `canonical owner must be explicitly monitored: ${owner}`);
  }
  const canonicalChanges = [
    'js/semantics/memoryssa/build.js', 'js/semantics/ir/nodes.js',
    'js/semantics/cfg/index.js', 'js/semantics/ssa/build.js',
    'js/analysis/types/future-owner.js', 'js/analysis/alias/solver.js',
    'js/analysis/pointsto/local.js', 'js/analysis/summary/contract.js',
    'js/targets/abi/aapcs64.js',
  ];
  for (const file of canonicalChanges) {
    assert.ok(selected(file, patterns), `one-file change must trigger Ghidra: ${file}`);
  }
  // Reconstruct the old ownership filter: the reported counterexample must fail.
  const legacyPatterns = patterns.filter(pattern => !canonicalOwners.includes(pattern));
  for (const file of canonicalChanges) {
    assert.equal(selected(file, legacyPatterns), false, `old ownership filter must miss ${file}`);
  }

  for (const file of [
    '.github/workflows/ghidra-differential.yml', 'js/decompile.js',
    'js/decompiler/semantic.js', 'js/arm64.js', 'js/types.js', 'js/controlflow.js',
    'js/ir.js', 'js/ir-core.js', 'js/dataflow.js', 'js/dataflow-arm64.js', 'js/blocks.js',
    'js/targets/architecture/arm64/decode.js', 'js/semantics/effects/arm64.js',
    'js/semantics/compat/legacy.js', 'tools/decompiler/ghidra-diff.mjs',
    'tools/benchmark/compare.mjs', 'tools/validation/machine-effects/check.mjs',
    'tests/compiler-truth/run.mjs', 'tests/machine-effects/arm64/control.test.mjs',
    'tests/benchmark-baseline.mjs', 'tests/issue-458-ghidra-trigger.mjs', 'package.json',
  ]) assert.ok(selected(file, patterns), `existing trigger must remain selected: ${file}`);
  for (const file of [
    'tests/machine-effects/run.mjs', 'docs/README.md', 'README.md',
    'js/ai/chat.js', 'js/ui/panels/unrelated.js', 'tests/unrelated.test.mjs',
    'js/semantics/memoryssa-adjacent/unrelated.js',
  ]) assert.equal(selected(file, patterns), false, `unrelated/runner-only change must stay excluded: ${file}`);

  const entries = [
    'js/decompile.js', 'tests/compiler-truth/run-core.mjs',
    'tests/compiler-truth/extended.mjs', 'tests/compiler-truth/language-matrix.mjs',
  ];
  const readSource = file => fs.readFileSync(file, 'utf8');
  const closure = importClosure(entries, readSource);
  assert.ok(closure.includes('js/semantics/memoryssa/build.js'), 'real decompiler closure must reach MemorySSA');
  assertCoverage(closure, patterns);

  // A real reachable owner gains an import into a new directory. Existing globs
  // must fail until that ownership migration is explicitly covered.
  const moved = 'js/future-analysis-owner/moved.js';
  const migratedClosure = importClosure(entries, file => {
    if (file === moved) return 'export const value = 1;';
    const source = readSource(file);
    return file === 'js/analysis/semantic-function.js'
      ? `${source}\nexport { value } from '../future-analysis-owner/moved.js';\n` : source;
  });
  assert.throws(() => assertCoverage(migratedClosure, patterns), /js\/future-analysis-owner\/moved\.js/);
  assertCoverage(migratedClosure, [...patterns, 'js/future-analysis-owner/**']);

  // Parser/graph controls: side effects, re-exports, cycles, and fake imports.
  const fixture = new Map([
    ['entry.js', "import './side.js'; export { value } from './owner.js'; // import './fake.js'\nconst text = \"import './also-fake.js'\";"],
    ['side.js', "import './entry.js';"],
    ['owner.js', 'export const value = 1;'],
  ]);
  assert.deepEqual(importClosure(['entry.js'], file => {
    assert.ok(fixture.has(file), `unexpected fixture dependency: ${file}`);
    return fixture.get(file);
  }), ['entry.js', 'owner.js', 'side.js']);

  assert.match(workflow, /run: node tests\/issue-458-ghidra-trigger\.mjs/);
  const fast = fs.readFileSync('.github/workflows/pr-fast-gate.yml', 'utf8');
  const pr = fast.match(/^  pull_request:\n((?:^    .*\n|^\n)*)/m)?.[1];
  assert.ok(pr, 'PR fast gate must run the drift check before merge');
  assert.doesNotMatch(pr, /^    paths(?:-ignore)?:/m, 'drift check must not share the paths filter it checks');
  assert.match(fast, /run: node tests\/ci-development-mode\.mjs/);
  assert.match(fs.readFileSync('tests/ci-development-mode.mjs', 'utf8'),
    /^import '\.\/issue-458-ghidra-trigger\.mjs';$/m);
  console.log(`issues #458/#5905 Ghidra trigger contract passed (${closure.length} reachable modules; migration and exclusion controls passed)`);
}
