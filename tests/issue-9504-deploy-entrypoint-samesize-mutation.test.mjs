import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../scripts/deploy-production.mjs';

function makeRoot(prefix = 'deploy-9504-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(root, 'wrangler.jsonc');
  fs.writeFileSync(configPath, JSON.stringify({
    main: './worker-entry.js',
    assets: { directory: './dist', run_worker_first: true },
    d1_databases: [{
      binding: 'AUTH_DB',
      database_name: 'hex-auth',
      database_id: '12345678-1234-1234-1234-123456789abc',
      migrations_dir: 'migrations/auth',
    }],
  }, null, 2));
  fs.mkdirSync(path.join(root, 'dist'));
  return { root, configPath };
}

function runStub(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
}

test('#9504 same-size in-place entrypoint rewrite during snapshot fails closed', () => {
  const { root, configPath } = makeRoot('deploy-9504-samesize-');
  try {
    const entry = path.join(root, 'worker-entry.js');
    const original = 'export const REVIEWED = 1234;\n';
    const mutated =  'export const MUTATED! = 9999;\n';
    assert.equal(Buffer.byteLength(original), Buffer.byteLength(mutated));

    fs.writeFileSync(entry, original);

    const calls = [];
    assert.throws(
      () => runProductionDeploy({
        configPath,
        snapshotDirectory: root,
        run: runStub(calls),
        randomUUIDImpl: () => 'samesize-mutation',
        readSnapshotSync(file) {
          // Attacker mutates the file in-place during snapshot read
          fs.writeFileSync(entry, mutated);
          return fs.readFileSync(file);
        },
      }),
      /Production worker entrypoint changed while snapshotting/,
    );
    assert.equal(calls.length, 0, 'deployment must not proceed when entrypoint changed during snapshot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9504 entrypoint content modification with simulated mtime change fails closed', () => {
  const { root, configPath } = makeRoot('deploy-9504-mtime-');
  try {
    const entry = path.join(root, 'worker-entry.js');
    const original = 'export const REVIEWED = 1234;\n';
    fs.writeFileSync(entry, original);

    let statCount = 0;
    const calls = [];
    assert.throws(
      () => runProductionDeploy({
        configPath,
        snapshotDirectory: root,
        run: runStub(calls),
        randomUUIDImpl: () => 'mtime-mutation',
        fstatSync(fd, options) {
          const st = fs.fstatSync(fd, options);
          statCount++;
          // First fstatSync is openedMain, second is afterReadMain
          if (statCount === 2) {
            // Simulate mtime change even if filesystem has coarse timestamp granularity
            return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
              mtimeMs: Number(st.mtimeMs) + 1000,
              mtimeNs: st.mtimeNs != null ? BigInt(st.mtimeNs) + 1000000000n : undefined,
            });
          }
          return st;
        },
      }),
      /Production worker entrypoint changed while snapshotting/,
    );
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9504 unchanged entrypoint succeeds through snapshot provenance check', () => {
  const { root, configPath } = makeRoot('deploy-9504-ok-');
  try {
    const entry = path.join(root, 'worker-entry.js');
    fs.writeFileSync(entry, 'export const REVIEWED = true;\n');

    const calls = [];
    const status = runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      run: runStub(calls),
      randomUUIDImpl: () => 'entrypoint-provenance-ok',
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
