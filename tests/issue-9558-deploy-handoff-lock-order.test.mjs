import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProductionDeploy } from '../scripts/deploy-production.mjs';

function fixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), 'OK');
  fs.writeFileSync(path.join(root, 'worker-entry.js'), 'export default {};');
  fs.writeFileSync(path.join(root, 'wrangler.jsonc'), JSON.stringify({
    name: 'test-worker', main: './worker-entry.js', compatibility_date: '2024-01-01',
    assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true },
  }));
  return root;
}

test('#9558 assets-snapshot is created before handoff parent is write-locked', () => {
  const root = fixture('hex-9558-');
  let parentLocked = false;
  let assetsMkdirWhileLocked = false;
  try {
    const status = runProductionDeploy({
      snapshotDirectory: root,
      configPath: path.join(root, 'wrangler.jsonc'),
      run: () => ({ status: 0 }),
      fchmodSync(fd, mode) {
        fs.fchmodSync(fd, mode);
        if (mode === 0o500) parentLocked = true;
        if (mode === 0o700) parentLocked = false;
      },
      mkdirSync(target, options) {
        if (String(target).endsWith('/assets-snapshot') && parentLocked) {
          assetsMkdirWhileLocked = true;
          throw Object.assign(new Error('simulated non-root EACCES'), { code: 'EACCES' });
        }
        return fs.mkdirSync(target, options);
      },
    });
    assert.equal(status, 0);
    assert.equal(assetsMkdirWhileLocked, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
