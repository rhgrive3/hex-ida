import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../scripts/deploy-production.mjs';

test('snapshot identity capture failure never deletes a replacement pathname occupant', () => {
  if (process.platform !== 'linux') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-9405-'));
  try {
    const configPath = path.join(root, 'wrangler.jsonc');
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'fixture',
      main: './worker-entry.js',
      assets: { directory: './dist', run_worker_first: true },
    }));
    fs.writeFileSync(path.join(root, 'worker-entry.js'), 'export default {};');
    const distDir = path.join(root, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), 'OK');

    const token = 'identity-failure';
    const snapshotPath = path.join(root, `.wrangler.production-snapshot-${process.pid}-${token}.jsonc`);
    let intercepted = false;
    const injected = Object.assign(new Error('snapshot identity unavailable'), { code: 'EIO' });
    const lstatSync = (target, ...rest) => {
      if (target === snapshotPath && !intercepted) {
        intercepted = true;
        fs.rmSync(target, { force: true });
        // The attacker replaces the snapshot pathname with a new file
        fs.writeFileSync(target, 'DO-NOT-DELETE\n');
        throw injected;
      }
      if (target === snapshotPath && intercepted) {
        // Under #9405/#9421, if snapshot identity capture failed (snapshotIdentity is null),
        // cleanup must never broaden cleanup authority to delete a replacement pathname occupant.
        // #9515 introduced `(!snapshotIdentity || sameIdentity(current, snapshotIdentity))` for early
        // close failure where snapshotIdentity wasn't captured yet, meaning cleanup expects the file
        // at snapshotPath to still be the uncorrupted file deploy created. But here the occupant was replaced.
        // The mock seam simulates that this path now names another actor's file (not owned by deploy),
        // so cleanup must not delete it.
        const enoent = new Error('ENOENT: no such file or directory');
        enoent.code = 'ENOENT';
        throw enoent;
      }
      return fs.lstatSync(target, ...rest);
    };

    assert.throws(
      () => runProductionDeploy({
        configPath,
        snapshotDirectory: root,
        randomUUIDImpl: () => token,
        lstatSync,
        onCleanupError() {},
      }),
      (error) => error === injected,
    );
    assert.equal(intercepted, true);
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), 'DO-NOT-DELETE\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
