import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProductionDeploy } from '../scripts/deploy-production.mjs';

test('#9562 same-inode mutation with restored mtime is rejected by asset snapshotting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9562-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  const asset = path.join(dist, 'app.bin');
  fs.writeFileSync(asset, Buffer.alloc(128 * 1024, 0x41));
  const before = fs.statSync(asset);
  fs.writeFileSync(path.join(root, 'worker-entry.js'), 'export default {};');
  fs.writeFileSync(path.join(root, 'wrangler.jsonc'), JSON.stringify({
    name: 'test-worker', main: './worker-entry.js', compatibility_date: '2024-01-01',
    assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true },
  }));

  let reads = 0;
  try {
    assert.throws(
      () => runProductionDeploy({
        snapshotDirectory: root,
        configPath: path.join(root, 'wrangler.jsonc'),
        run: () => ({ status: 0 }),
        readSync(...args) {
          reads += 1;
          if (reads === 2) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            const fd = fs.openSync(asset, 'r+');
            try {
              fs.writeSync(fd, Buffer.alloc(64 * 1024, 0x42), 0, 64 * 1024, 64 * 1024);
            } finally {
              fs.closeSync(fd);
            }
            fs.utimesSync(asset, before.atime, before.mtime);
          }
          return fs.readSync(...args);
        },
      }),
      (error) => {
        assert.equal(error.code, 'DEPLOY_ASSET_CHILD_CHANGED');
        assert.match(error.message, /changed while reading/);
        return true;
      },
    );
    assert.ok(reads >= 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
