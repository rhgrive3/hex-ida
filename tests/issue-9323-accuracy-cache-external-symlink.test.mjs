import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { partitionDigest, partitionFiles } from '../scripts/accuracy-partition-cache-key.mjs';

test('#9323 external directory symlink is hashed by identity but never traversed', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9323-'));
  try {
    const root = path.join(sandbox, 'repo');
    const outsideA = path.join(sandbox, 'outside-a');
    const outsideB = path.join(sandbox, 'outside-b');
    fs.mkdirSync(path.join(root, 'js'), { recursive:true });
    fs.mkdirSync(outsideA);
    fs.mkdirSync(outsideB);
    fs.writeFileSync(path.join(outsideA, 'a.js'), 'one');
    fs.writeFileSync(path.join(outsideB, 'a.js'), 'two');
    const link = path.join(root, 'js', 'external');
    fs.symlinkSync(outsideA, link);

    const files = partitionFiles(root, 'core');
    assert.ok(files.includes('js/external'));
    assert.equal(files.includes('js/external/a.js'), false);
    const first = partitionDigest(root, 'core');
    fs.writeFileSync(path.join(outsideA, 'a.js'), 'changed-outside-only');
    assert.equal(partitionDigest(root, 'core'), first);

    fs.unlinkSync(link);
    fs.symlinkSync(outsideB, link);
    assert.notEqual(partitionDigest(root, 'core'), first, 'symlink target identity must still affect the digest');
  } finally {
    fs.rmSync(sandbox, { recursive:true, force:true });
  }
});
