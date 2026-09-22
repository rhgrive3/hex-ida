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
    fs.writeFileSync(configPath, '{"name":"fixture","main":"worker.js"}\n');
    const token = 'identity-failure';
    const snapshotPath = path.join(root, `.wrangler.production-snapshot-${process.pid}-${token}.jsonc`);
    let intercepted = false;
    const injected = Object.assign(new Error('snapshot identity unavailable'), { code: 'EIO' });

    const lstatSync = (target) => {
      if (target === snapshotPath && !intercepted) {
        intercepted = true;
        fs.rmSync(target, { force: true });
        fs.writeFileSync(target, 'DO-NOT-DELETE\n');
        throw injected;
      }
      return fs.lstatSync(target);
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
