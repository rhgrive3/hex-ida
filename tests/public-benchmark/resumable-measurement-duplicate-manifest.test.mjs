import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRun } from '../../tools/validation/direct-recompilability/resumable-measurement.mjs';

const HEAD = 'a'.repeat(40);

test('duplicate manifest case ids fail closed before creating run artifacts', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-resumable-duplicate-manifest-'));
  const storeDir = path.join(parent, 'run');
  const manifest = {
    schema: 'test-manifest/v1',
    cases: [{ id: 'dup' }, { id: 'dup' }],
  };

  assert.throws(
    () => openRun({ storeDir, manifest, headSha: HEAD }),
    /measurement-manifest-duplicate-case-id:dup/,
  );
  assert.equal(fs.existsSync(storeDir), false);
});

test('empty manifest case ids fail closed before creating run artifacts', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-resumable-invalid-id-'));
  const storeDir = path.join(parent, 'run');
  const manifest = {
    schema: 'test-manifest/v1',
    cases: [{ id: '' }],
  };

  assert.throws(
    () => openRun({ storeDir, manifest, headSha: HEAD }),
    /measurement-manifest-case-id-invalid/,
  );
  assert.equal(fs.existsSync(storeDir), false);
});
