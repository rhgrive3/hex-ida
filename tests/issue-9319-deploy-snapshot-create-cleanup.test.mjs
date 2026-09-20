import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../scripts/deploy-production.mjs';

const validConfig = Buffer.from('{"main":"worker-entry.js","assets":{"run_worker_first":true},"d1_databases":[{"binding":"AUTH_DB","database_name":"hex-auth","database_id":"11111111-2222-3333-4444-555555555555","migrations_dir":"migrations/auth"}]}');

test('#9319 partial snapshot write failure removes the file owned by this invocation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9319-partial-'));
  try {
    const configPath = path.join(root, 'wrangler.jsonc');
    fs.writeFileSync(configPath, validConfig);
    let runCalls = 0;

    assert.throws(() => runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      randomUUIDImpl: () => 'partial-write',
      writeFileSync(fd, bytes) {
        fs.writeFileSync(fd, bytes.subarray(0, Math.min(8, bytes.length)));
        const error = new Error('disk full');
        error.code = 'ENOSPC';
        throw error;
      },
      run() {
        runCalls++;
        return { status: 0, signal: null, error: undefined };
      },
    }), (error) => error?.code === 'ENOSPC');

    assert.equal(runCalls, 0);
    assert.deepEqual(fs.readdirSync(root), ['wrangler.jsonc']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9319 EEXIST never deletes a pre-existing snapshot path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9319-eexist-'));
  try {
    const configPath = path.join(root, 'wrangler.jsonc');
    fs.writeFileSync(configPath, validConfig);
    const snapshotPath = path.join(
      root,
      `.wrangler.production-snapshot-${process.pid}-already-there.jsonc`,
    );
    const sentinel = Buffer.from('do not delete');
    fs.writeFileSync(snapshotPath, sentinel, { mode: 0o400 });

    assert.throws(() => runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      randomUUIDImpl: () => 'already-there',
    }), (error) => error?.code === 'EEXIST');

    assert.deepEqual(fs.readFileSync(snapshotPath), sentinel);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
