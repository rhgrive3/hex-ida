import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { partitionFiles, partitionDigest } from '../scripts/accuracy-partition-cache-key.mjs';

test('#9154 partitionFiles and partitionDigest handle symlinked files, directories, and cycles', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9154-'));

  try {
    // Setup minimal project structure
    fs.mkdirSync(path.join(tempRoot, 'js'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'tests'), { recursive: true });

    fs.writeFileSync(path.join(tempRoot, 'package.json'), '{}');
    fs.writeFileSync(
      path.join(tempRoot, 'tests/accuracy-partitions.json'),
      JSON.stringify({ core: ['test'] }),
    );

    // Regular file in js/
    fs.writeFileSync(path.join(tempRoot, 'js/regular.js'), 'console.log("regular");');

    // External target file
    const externalDir = path.join(tempRoot, 'external');
    fs.mkdirSync(externalDir, { recursive: true });
    const targetA = path.join(externalDir, 'targetA.js');
    const targetB = path.join(externalDir, 'targetB.js');
    fs.writeFileSync(targetA, 'console.log("target content");');
    fs.writeFileSync(targetB, 'console.log("target content");'); // same content, different path

    // 1. Symlinked file in js/
    const symlinkFile = path.join(tempRoot, 'js/linked-file.js');
    fs.symlinkSync(targetA, symlinkFile);

    // 2. Symlinked directory in js/
    const subDir = path.join(externalDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'nested.js'), 'console.log("nested");');
    fs.symlinkSync(subDir, path.join(tempRoot, 'js/linked-dir'));

    // 3. Cyclic symlink: linked-dir2 -> js
    fs.symlinkSync(path.join(tempRoot, 'js'), path.join(tempRoot, 'js/cycle-link'));

    const files = partitionFiles(tempRoot, 'core');
    assert.ok(files.includes('js/regular.js'), 'must include regular files');
    assert.ok(files.includes('js/linked-file.js'), 'must include symlinked file');
    assert.ok(files.includes('js/linked-dir/nested.js'), 'must include files inside symlinked dir');

    const digest1 = partitionDigest(tempRoot, 'core');
    assert.ok(typeof digest1 === 'string' && digest1.length === 64, 'digest must be valid sha256');

    // 4. Change symlink target to targetB (same content, different target)
    fs.unlinkSync(symlinkFile);
    fs.symlinkSync(targetB, symlinkFile);
    const digest2 = partitionDigest(tempRoot, 'core');
    assert.notEqual(digest1, digest2, 'digest must change when symlink target changes');

    // 5. Change content of targetB
    fs.writeFileSync(targetB, 'console.log("modified target content");');
    const digest3 = partitionDigest(tempRoot, 'core');
    assert.notEqual(digest2, digest3, 'digest must change when symlink content changes');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
