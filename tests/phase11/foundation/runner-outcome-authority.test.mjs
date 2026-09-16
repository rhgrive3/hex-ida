import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findTests, runPhase11Tests } from '../run.mjs';

/**
 * #8759: the old Phase 11 runner awaited `import()` on each `.test.mjs` file and
 * counted the import as a pass, so real `node:test` assertion failures were
 * reported as `0 failed` (false green) while the native harness still exited 1.
 * The runner must take its verdict from actual test outcomes: a single failing
 * assertion makes `runPhase11Tests` reject, and it must not report success on
 * importable-but-failing files.
 */

function withTempSuite(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase11-runner-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const PASSING = "import test from 'node:test';\ntest('passing', () => {});\n";
const FAILING = "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('failing', () => { assert.equal(1, 2); });\n";

test('a single failing assertion is not reported as a green suite (#8759)', async () => {
  await withTempSuite({ 'a.test.mjs': PASSING, 'b.test.mjs': FAILING }, async (root) => {
    await assert.rejects(
      () => runPhase11Tests([], { root }),
      /phase11: test runner failed with status/,
      'runner must reject when a registered node:test assertion fails',
    );
  });
});

test('an all-green temp suite resolves with outcome-authority counts (#8759)', async () => {
  await withTempSuite({ 'a.test.mjs': PASSING, 'nested/b.test.mjs': PASSING }, async (root) => {
    const result = await runPhase11Tests([], { root });
    assert.deepEqual({ ...result }, { selected: 2, total: 2, group: null });
  });
});

test('import-time crashes are still surfaced as failures (#8759)', async () => {
  await withTempSuite(
    { 'a.test.mjs': "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n" },
    async (root) => {
      await assert.rejects(() => runPhase11Tests([], { root }), /phase11: test runner failed/);
    },
  );
});

test('canonical discovery reaches every Phase 11 subtree (#8759)', () => {
  const discovered = findTests();
  assert.ok(discovered.length > 0, 'Phase 11 must discover its owned tests');
  assert.ok(discovered.every((file) => file.endsWith('.test.mjs')));
  for (const subtree of ['cil', 'dex', 'jvm', 'shared', 'wasm', 'conformance', 'foundation']) {
    assert.ok(
      discovered.some((file) => file.split(path.sep).includes(subtree)),
      `canonical Phase 11 discovery found no test in subtree: ${subtree}`,
    );
  }
});
