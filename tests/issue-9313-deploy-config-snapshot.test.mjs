import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../scripts/deploy-production.mjs';

const validA = Buffer.from('{"main":"worker-entry.js","assets":{"directory":"./dist","run_worker_first":true},"d1_databases":[{"binding":"AUTH_DB","database_name":"hex-auth","database_id":"11111111-2222-3333-4444-555555555555","migrations_dir":"migrations/auth"}]}');
const invalidB = Buffer.from('{"main":"worker.js","assets":{"directory":"./dist","run_worker_first":false},"d1_databases":[]}');
const ok = { status:0, signal:null, error:undefined };

function setupFixture(root) {
  const configPath = path.join(root, 'wrangler.jsonc');
  fs.writeFileSync(configPath, validA);
  fs.writeFileSync(path.join(root, 'worker-entry.js'), 'export default {};');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), 'OK');
  return { configPath, distDir };
}

test('#9313 Wrangler receives the immutable approved snapshot, not a later original-path replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9313-'));
  try {
    const { configPath } = setupFixture(root);
    let calls = 0;
    const code = runProductionDeploy({
      configPath,
      snapshotDirectory:root,
      randomUUIDImpl:() => 'fixed',
      run(_file, args, options) {
        calls++;
        const inheritedFd = options.stdio[3];
        assert.equal(args.some((arg) => String(arg).includes('/proc/self/fd/3/wrangler.jsonc')), true);
        assert.deepEqual(fs.readFileSync(`/proc/self/fd/${inheritedFd}/wrangler.jsonc`), validA);
        if (calls === 1) fs.writeFileSync(configPath, invalidB);
        else assert.deepEqual(fs.readFileSync(configPath), invalidB);
        return ok;
      },
    });
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.deepEqual(fs.readdirSync(root).sort(), ['dist', 'worker-entry.js', 'wrangler.jsonc'].sort());
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9313 changed snapshot after validation fails closed before Wrangler invocation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9313-tamper-'));
  try {
    const { configPath } = setupFixture(root);
    let calls = 0;
    let reads = 0;
    assert.throws(() => runProductionDeploy({
      configPath,
      snapshotDirectory:root,
      randomUUIDImpl:() => 'fixed',
      readSnapshotSync(file) {
        reads++;
        // 1: approvedMainBytes = readSnapshotSync(mainFd)
        // 2: stableMainBytes = readSnapshotSync(parentStableMainPath)
        // 3: lockedBytes = readSnapshotSync(parentStableConfigPath)
        // 4: beforeDeploy = readSnapshotSync(parentStableConfigPath)
        return reads === 4 ? invalidB : fs.readFileSync(file);
      },
      run() { calls++; return ok; },
    }), /snapshot changed after validation/);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(root).sort(), ['dist', 'worker-entry.js', 'wrangler.jsonc'].sort());
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9313 validator failure cleans the snapshot and never invokes Wrangler', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9313-fail-'));
  try {
    const { configPath } = setupFixture(root);
    let calls = 0;
    const code = runProductionDeploy({
      configPath, snapshotDirectory:root, randomUUIDImpl:() => 'fixed',
      run() { calls++; return { status:7, signal:null, error:undefined }; },
    });
    assert.equal(code, 7);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(root).sort(), ['dist', 'worker-entry.js', 'wrangler.jsonc'].sort());
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
