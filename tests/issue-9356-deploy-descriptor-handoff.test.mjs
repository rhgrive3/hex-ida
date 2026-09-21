import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../scripts/deploy-production.mjs';

const approved = Buffer.from('{"main":"worker-entry.js","assets":{"run_worker_first":true},"d1_databases":[{"binding":"AUTH_DB","database_name":"hex-auth","database_id":"11111111-2222-3333-4444-555555555555","migrations_dir":"migrations/auth"}]}');
const replacement = Buffer.from('{"main":"evil-worker.js","assets":{"run_worker_first":false},"d1_databases":[]}');
const ok = { status:0, signal:null, error:undefined };

test('#9356 replacement immediately after post-validation read fails identity binding before Wrangler', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9356-read-race-'));
  try {
    const configPath = path.join(root, 'wrangler.jsonc');
    fs.writeFileSync(configPath, approved);
    const snapshotPath = path.join(root, `.wrangler.production-snapshot-${process.pid}-fixed.jsonc`);
    let calls = 0;
    assert.throws(() => runProductionDeploy({
      configPath,
      snapshotDirectory:root,
      randomUUIDImpl:() => 'fixed',
      readSnapshotSync(file) {
        const bytes = fs.readFileSync(file);
        if (file === snapshotPath) {
          const staged = path.join(root, 'replacement.jsonc');
          fs.writeFileSync(staged, replacement);
          fs.renameSync(staged, snapshotPath);
        }
        return bytes;
      },
      run() { calls += 1; return ok; },
    }), /snapshot identity changed before deployment handoff/);
    assert.equal(calls, 1, 'Wrangler must not run after snapshot identity replacement');
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9356 pathname replacement after descriptor detachment cannot change Wrangler config bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9356-detached-'));
  try {
    const configPath = path.join(root, 'wrangler.jsonc');
    fs.writeFileSync(configPath, approved);
    const snapshotPath = path.join(root, `.wrangler.production-snapshot-${process.pid}-fixed.jsonc`);
    let calls = 0;
    const status = runProductionDeploy({
      configPath,
      snapshotDirectory:root,
      randomUUIDImpl:() => 'fixed',
      run(_file, args, options) {
        calls += 1;
        if (calls === 1) return ok;
        assert.deepEqual(args.slice(-2), ['--config', '/proc/self/fd/3']);
        assert.equal(fs.existsSync(snapshotPath), false, 'original pathname must be unlinked before Wrangler handoff');
        fs.writeFileSync(snapshotPath, replacement);
        assert.deepEqual(fs.readFileSync(`/proc/self/fd/${options.stdio[3]}`), approved);
        assert.notDeepEqual(fs.readFileSync(snapshotPath), approved);
        return ok;
      },
    });
    assert.equal(status, 0);
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
