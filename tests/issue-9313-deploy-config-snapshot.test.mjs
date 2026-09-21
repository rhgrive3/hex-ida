import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../scripts/deploy-production.mjs';

const validA = Buffer.from('{"main":"worker-entry.js","assets":{"run_worker_first":true},"d1_databases":[{"binding":"AUTH_DB","database_name":"hex-auth","database_id":"11111111-2222-3333-4444-555555555555","migrations_dir":"migrations/auth"}]}');
const invalidB = Buffer.from('{"main":"worker.js","assets":{"run_worker_first":false},"d1_databases":[]}');
const ok = { status:0, signal:null, error:undefined };

test('#9313 Wrangler receives the same inherited approved snapshot fd, not a later original-path replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9313-'));
  try {
    const configPath = path.join(root, 'wrangler.jsonc');
    fs.writeFileSync(configPath, validA);
    let calls = 0;
    let inheritedFd = null;
    const code = runProductionDeploy({
      configPath,
      snapshotDirectory:root,
      randomUUIDImpl:() => 'fixed',
      descriptorPathImpl:() => '<stable-config-fd>',
      run(_file, args, _options, handoff) {
        calls++;
        assert.ok(Number.isInteger(handoff.inheritFd));
        if (inheritedFd == null) inheritedFd = handoff.inheritFd;
        assert.equal(handoff.inheritFd, inheritedFd);
        const observed = Buffer.alloc(validA.length);
        assert.equal(fs.readSync(inheritedFd, observed, 0, observed.length, 0), observed.length);
        assert.deepEqual(observed, validA);
        if (calls === 1) {
          assert.equal(args.at(-1), '--config=<stable-config-fd>');
          fs.writeFileSync(configPath, invalidB);
        } else {
          assert.deepEqual(args.slice(-2), ['--config', '<stable-config-fd>']);
          assert.deepEqual(fs.readFileSync(configPath), invalidB);
        }
        return ok;
      },
    });
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.deepEqual(fs.readdirSync(root), ['wrangler.jsonc']);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9313 changed snapshot after validation fails closed before Wrangler invocation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9313-tamper-'));
  try {
    const configPath = path.join(root, 'wrangler.jsonc');
    fs.writeFileSync(configPath, validA);
    let calls = 0;
    let reads = 0;
    assert.throws(() => runProductionDeploy({
      configPath,
      snapshotDirectory:root,
      randomUUIDImpl:() => 'fixed',
      readSnapshotSync() {
        reads++;
        return reads === 1 ? validA : invalidB;
      },
      run() { calls++; return ok; },
    }), /snapshot changed after validation/);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(root), ['wrangler.jsonc']);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9313 validator failure cleans the snapshot and never invokes Wrangler', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9313-fail-'));
  try {
    const configPath = path.join(root, 'wrangler.jsonc');
    fs.writeFileSync(configPath, validA);
    let calls = 0;
    const code = runProductionDeploy({
      configPath, snapshotDirectory:root, randomUUIDImpl:() => 'fixed',
      run() { calls++; return { status:7, signal:null, error:undefined }; },
    });
    assert.equal(code, 7);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(root), ['wrangler.jsonc']);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
