import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../scripts/deploy-production.mjs';

const validA = Buffer.from(JSON.stringify({
  main: './worker-entry.js',
  assets: { directory: './dist', run_worker_first: true },
  d1_databases: [{
    binding: 'AUTH_DB',
    database_name: 'hex-auth',
    database_id: '11111111-2222-3333-4444-555555555555',
    migrations_dir: 'migrations/auth',
  }],
}));
const replacementB = Buffer.from(JSON.stringify({
  main: './attacker.js',
  assets: { directory: './attacker-dist', run_worker_first: false },
  d1_databases: [],
}));
const ok = { status: 0, signal: null, error: undefined };

function publicSnapshotPath(root) {
  return path.join(root, `.wrangler.production-snapshot-${process.pid}-fixed.jsonc`);
}

function setupFixture(root) {
  const configPath = path.join(root, 'wrangler.jsonc');
  fs.writeFileSync(configPath, validA);
  fs.writeFileSync(path.join(root, 'worker-entry.js'), 'export default {};');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), 'OK');
  return { configPath, distDir };
}

test('#9356 replacement of the old snapshot pathname cannot change Wrangler config bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9356-'));
  try {
    const { configPath } = setupFixture(root);
    const snapshotPath = publicSnapshotPath(root);
    let calls = 0;

    const status = runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      randomUUIDImpl: () => 'fixed',
      run(_file, args, options) {
        calls++;
        const inheritedDirectoryFd = options.stdio[3];
        const stablePath = `/proc/self/fd/${inheritedDirectoryFd}/wrangler.jsonc`;
        assert.deepEqual(fs.readFileSync(stablePath), validA);
        assert.equal(fs.fstatSync(inheritedDirectoryFd).mode & 0o222, 0, 'handoff directory must be write-locked');

        if (calls === 1) {
          assert.equal(args[1], '--config=/proc/self/fd/3/wrangler.jsonc');
          assert.equal(fs.existsSync(snapshotPath), false, 'workspace snapshot pathname must be retired before validation');
          return ok;
        }

        // Recreate the old public pathname in the vulnerable interval. Wrangler
        // consumes the inherited directory descriptor instead of this path.
        fs.writeFileSync(snapshotPath, replacementB);
        assert.equal(args.includes('/proc/self/fd/3/wrangler.jsonc'), true);
        assert.deepEqual(fs.readFileSync(stablePath), validA);
        assert.deepEqual(fs.readFileSync(snapshotPath), replacementB);
        return ok;
      },
    });

    assert.equal(status, 0);
    assert.equal(calls, 2);
    assert.deepEqual(fs.readFileSync(snapshotPath), replacementB, 'cleanup must not delete another actor\'s replacement');
    assert.deepEqual(fs.readdirSync(root).sort(), [path.basename(snapshotPath), 'dist', 'worker-entry.js', 'wrangler.jsonc'].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9356 Wrangler path-sensitive inputs are derived from the approved config root, not /proc', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9356-root-'));
  try {
    const { configPath } = setupFixture(root);
    const calls = [];
    const status = runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      randomUUIDImpl: () => 'fixed',
      run(file, args, options) { calls.push({ file, args, options }); return ok; },
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 2);
    const deployArgs = calls[1].args;
    // Under post-#9479 / #9504 contract, entrypoint and assets are snapshot handed off via /proc/self/fd
    assert.equal(deployArgs[2], '/proc/self/fd/3/worker-entry.js');
    assert.deepEqual(deployArgs.slice(-2), ['--assets', '/proc/self/fd/4']);
    assert.equal(deployArgs.includes('/proc/self/fd/3/wrangler.jsonc'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9356 the real validator can parse the inherited stable jsonc path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9356-validator-'));
  try {
    const { configPath } = setupFixture(root);
    let calls = 0;
    const status = runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      randomUUIDImpl: () => 'fixed',
      run(file, args, options) {
        calls++;
        if (calls === 1) {
          return spawnSync(file, args, {
            ...options,
            stdio: ['ignore', 'pipe', 'pipe', options.stdio[3]],
            encoding: 'utf8',
          });
        }
        return ok;
      },
    });
    assert.equal(status, 0);
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
