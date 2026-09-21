import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../scripts/deploy-production.mjs';

const validConfig = Buffer.from('{"main":"worker-entry.js","assets":{"run_worker_first":true},"d1_databases":[{"binding":"AUTH_DB","database_name":"hex-auth","database_id":"11111111-2222-3333-4444-555555555555","migrations_dir":"migrations/auth"}]}');
const result = (status, error) => ({ status, signal:null, error });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9341-'));
  const configPath = path.join(root, 'wrangler.jsonc');
  fs.writeFileSync(configPath, validConfig);
  const cleanupError = Object.assign(new Error('snapshot cleanup EIO'), { code:'EIO' });
  return { root, configPath, cleanupError };
}

for (const scenario of [
  { name:'successful deployment', statuses:[0, 0], expected:0, committed:true, attempted:true },
  { name:'validator failure', statuses:[7], expected:7, committed:false, attempted:false },
  { name:'Wrangler failure', statuses:[0, 9], expected:9, committed:false, attempted:true },
]) {
  test(`#9341 ${scenario.name} is preserved when snapshot cleanup fails`, () => {
    const { root, configPath, cleanupError } = fixture();
    const warnings = [];
    let calls = 0;
    try {
      const status = runProductionDeploy({
        configPath,
        snapshotDirectory:root,
        randomUUIDImpl:() => 'cleanup-failure',
        run() { return result(scenario.statuses[calls++]); },
        rmSync() { throw cleanupError; },
        onCleanupError(error, details) { warnings.push({ error, details }); },
      });
      assert.equal(status, scenario.expected);
      assert.equal(calls, scenario.statuses.length);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].error, cleanupError);
      assert.equal(warnings[0].details.status, scenario.expected);
      assert.equal(warnings[0].details.deploymentCommitted, scenario.committed);
      assert.equal(warnings[0].details.deploymentAttempted, scenario.attempted);
    } finally {
      fs.rmSync(root, { recursive:true, force:true });
    }
  });
}

test('#9341 primary execution error remains identifiable when cleanup also fails', () => {
  const { root, configPath, cleanupError } = fixture();
  const spawnError = Object.assign(new Error('spawn failed'), { code:'EIO' });
  try {
    assert.throws(() => runProductionDeploy({
      configPath,
      snapshotDirectory:root,
      randomUUIDImpl:() => 'primary-plus-cleanup',
      run() { return result(null, spawnError); },
      rmSync() { throw cleanupError; },
    }), (error) => error instanceof AggregateError
      && error.errors.includes(spawnError)
      && error.errors.includes(cleanupError));
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
