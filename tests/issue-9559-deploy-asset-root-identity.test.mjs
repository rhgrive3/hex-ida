import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProductionDeploy } from '../scripts/deploy-production.mjs';

test('#9559 asset snapshot remains bound to the validated dist root descriptor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9559-'));
  const dist = path.join(root, 'dist');
  const original = path.join(root, 'dist-original');
  const replacement = path.join(root, 'replacement');
  fs.mkdirSync(dist);
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(dist, 'index.html'), 'REVIEWED');
  fs.writeFileSync(path.join(replacement, 'pwn.html'), 'UNREVIEWED');
  fs.writeFileSync(path.join(root, 'worker-entry.js'), 'export default {};');
  fs.writeFileSync(path.join(root, 'wrangler.jsonc'), JSON.stringify({
    name: 'test-worker', main: './worker-entry.js', compatibility_date: '2024-01-01',
    assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true },
  }));

  let swapped = false;
  let snapshotFiles = [];
  let reviewed = null;
  try {
    const status = runProductionDeploy({
      snapshotDirectory: root,
      configPath: path.join(root, 'wrangler.jsonc'),
      readdirSync(target, options) {
        if (!swapped) {
          swapped = true;
          fs.renameSync(dist, original);
          fs.renameSync(replacement, dist);
        }
        return fs.readdirSync(target, options);
      },
      run(cmd, args, options) {
        if (args.includes('--assets')) {
          const assetsPath = `/proc/self/fd/${options.stdio[4]}`;
          snapshotFiles = fs.readdirSync(assetsPath).sort();
          if (snapshotFiles.includes('index.html')) reviewed = fs.readFileSync(path.join(assetsPath, 'index.html'), 'utf8');
        }
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(swapped, true);
    assert.deepEqual(snapshotFiles, ['index.html']);
    assert.equal(reviewed, 'REVIEWED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
