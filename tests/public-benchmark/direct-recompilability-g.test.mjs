import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGCaseRunner } from '../../tools/validation/direct-recompilability/measure-g.mjs';

test('function-level case without main passes object recompilation', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-g-object-regression-'));
  const runCase = createGCaseRunner({
    tmpRoot,
    clangTimeoutMs: 30000,
    runSubject: async () => ({
      row: {
        state: 'PASS',
        reason: null,
        functions: [{ pseudocode: 'int recovered_function(void) { return 7; }' }],
      },
    }),
  });

  const result = await runCase({ id: 'no-main', path: '/unused/input' });
  assert.equal(result.state, 'PASS');
  assert.equal(result.reason, null);
  assert.equal(result.functions.total, 1);
});
