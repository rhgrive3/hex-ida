import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { partitionFiles, partitionDigest } from '../scripts/accuracy-partition-cache-key.mjs';

test('#9199 accuracy cache key includes broken file and directory symlinks and tracks target changes', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9199-'));

  try {
    // Setup minimal project structure with required common files
    fs.mkdirSync(path.join(tempRoot, 'js'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'tests'), { recursive: true });

    fs.writeFileSync(path.join(tempRoot, 'package.json'), '{}');
    fs.writeFileSync(
      path.join(tempRoot, 'tests/accuracy-partitions.json'),
      JSON.stringify({ core: ['test'] }),
    );

    // 1. Broken file symlink
    const linkPath = path.join(tempRoot, 'js/selected.js');
    fs.symlinkSync('./missing-a.js', linkPath);

    const filesA = partitionFiles(tempRoot, 'core');
    assert.ok(filesA.includes('js/selected.js'), 'broken symlink must be included in partition files');

    const digestA = partitionDigest(tempRoot, 'core');
    assert.ok(typeof digestA === 'string' && digestA.length === 64);

    // 2. Retarget broken symlink to another missing target
    fs.unlinkSync(linkPath);
    fs.symlinkSync('./missing-b.js', linkPath);

    const digestB = partitionDigest(tempRoot, 'core');
    assert.notEqual(digestA, digestB, 'digest must change when broken symlink target changes');

    // 3. Broken directory symlink
    const dirLink = path.join(tempRoot, 'js/missing-dir-link');
    fs.symlinkSync('./non-existent-dir', dirLink);

    const filesWithDir = partitionFiles(tempRoot, 'core');
    assert.ok(filesWithDir.includes('js/missing-dir-link'), 'broken directory symlink must be included');

    const digestDirA = partitionDigest(tempRoot, 'core');

    // 4. Retarget directory symlink to another missing directory
    fs.unlinkSync(dirLink);
    fs.symlinkSync('./another-missing-dir', dirLink);

    const digestDirB = partitionDigest(tempRoot, 'core');
    assert.notEqual(digestDirA, digestDirB, 'digest must change when directory symlink target changes');

    // 5. Target availability test: creating and removing the target dir
    // must not drop the symlink itself from representation
    const actualDir = path.join(tempRoot, 'actual-target-dir');
    fs.mkdirSync(actualDir, { recursive: true });
    fs.writeFileSync(path.join(actualDir, 'file.js'), 'console.log("inside");');

    fs.unlinkSync(dirLink);
    fs.symlinkSync('../actual-target-dir', dirLink);

    const filesAvailable = partitionFiles(tempRoot, 'core');
    assert.ok(filesAvailable.includes('js/missing-dir-link'), 'dir symlink entry must be present when target is available');
    assert.ok(filesAvailable.includes('js/missing-dir-link/file.js'), 'dir symlink children must be present');
    const digestAvailable = partitionDigest(tempRoot, 'core');

    // Remove target dir (making link broken)
    fs.rmSync(actualDir, { recursive: true, force: true });
    const filesBroken = partitionFiles(tempRoot, 'core');
    assert.ok(filesBroken.includes('js/missing-dir-link'), 'dir symlink entry must still be present when target is absent');
    const digestBroken = partitionDigest(tempRoot, 'core');
    assert.notEqual(digestAvailable, digestBroken, 'digest must reflect target availability without omitting symlink identity');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
