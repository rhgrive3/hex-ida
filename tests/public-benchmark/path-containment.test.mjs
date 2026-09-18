import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyInputs } from '../../tools/validation/public-benchmark/manifest.mjs';
import { compareCase } from '../../tools/validation/public-benchmark/compare.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

test('manifest and reference paths cannot follow symlinks outside the suite', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-public-path-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const suiteRoot = path.join(parent, 'suite');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(suiteRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'binary.bin'), 'binary');
  fs.writeFileSync(path.join(outside, 'reference.c'), 'int outside(void) { return 1; }');
  fs.writeFileSync(path.join(suiteRoot, 'reference.c'), 'int inside(void) { return 1; }');

  try {
    fs.symlinkSync('../outside/binary.bin', path.join(suiteRoot, 'binary.bin'));
  } catch (error) {
    if (['EACCES', 'EINVAL', 'ENOSYS', 'EPERM'].includes(error.code)) {
      t.skip('file symlinks are unavailable in this environment');
      return;
    }
    throw error;
  }

  const manifest = { cases: [{
    id: 'case', binary: 'binary.bin', binarySha256: digest('binary'),
    reference: { path: 'reference.c', sha256: digest('int inside(void) { return 1; }') },
  }] };
  assert.throws(() => verifyInputs(manifest, suiteRoot), /public-benchmark-binary-path:case/);
  fs.unlinkSync(path.join(suiteRoot, 'binary.bin'));
  fs.writeFileSync(path.join(suiteRoot, 'binary.bin'), 'binary');
  fs.unlinkSync(path.join(suiteRoot, 'reference.c'));
  fs.symlinkSync('../outside/reference.c', path.join(suiteRoot, 'reference.c'));
  assert.throws(() => verifyInputs(manifest, suiteRoot), /public-benchmark-reference-path:case/);
  assert.throws(() => compareCase({
    caseEntry: { id: 'case', reference: { path: 'reference.c' } },
    hexResult: {},
    suiteRoot,
  }), /reference-path-escapes-root/);
});
