import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../scripts/deploy-production.mjs';

const approved = Buffer.from('{"main":"worker-entry.js","assets":{"run_worker_first":true},"d1_databases":[{"binding":"AUTH_DB","database_name":"hex-auth","database_id":"11111111-2222-3333-4444-555555555555","migrations_dir":"migrations/auth"}]}');
const replacements = [
  Buffer.from('{"main":"evil-entry.js","assets":{"run_worker_first":true},"d1_databases":[{"binding":"AUTH_DB","database_name":"hex-auth","database_id":"11111111-2222-3333-4444-555555555555","migrations_dir":"migrations/auth"}]}'),
  Buffer.from('{"main":"worker-entry.js","assets":{"run_worker_first":false},"d1_databases":[{"binding":"AUTH_DB","database_name":"hex-auth","database_id":"11111111-2222-3333-4444-555555555555","migrations_dir":"migrations/auth"}]}'),
  Buffer.from('{"main":"worker-entry.js","assets":{"run_worker_first":true},"d1_databases":[{"binding":"AUTH_DB","database_name":"other","database_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","migrations_dir":"migrations/auth"}]}'),
];
const ok = { status:0, signal:null, error:undefined };

function readFd(fd, length) {
  const bytes = Buffer.alloc(length);
  assert.equal(fs.readSync(fd, bytes, 0, length, 0), length);
  return bytes;
}

for (const [index, replacement] of replacements.entries()) {
  test(`#9356 pathname replacement variant ${index + 1} cannot change the config consumed by Wrangler`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9356-'));
    try {
      const configPath = path.join(root, 'wrangler.jsonc');
      const snapshotPath = path.join(root, `.wrangler.production-snapshot-${process.pid}-stable.jsonc`);
      fs.writeFileSync(configPath, approved);
      let calls = 0;
      let inheritedFd = null;
      const status = runProductionDeploy({
        configPath,
        snapshotDirectory:root,
        randomUUIDImpl:() => 'stable',
        descriptorPathImpl:() => '<stable-fd-3>',
        run(_command, args, _options, handoff) {
          calls++;
          inheritedFd ??= handoff.inheritFd;
          assert.equal(handoff.inheritFd, inheritedFd);
          assert.deepEqual(readFd(inheritedFd, approved.length), approved);
          if (calls === 1) {
            assert.equal(fs.existsSync(snapshotPath), false, 'mutable snapshot pathname is detached before validation');
            fs.writeFileSync(snapshotPath, replacement, { mode:0o400 });
            return ok;
          }
          assert.deepEqual(args.slice(-2), ['--config', '<stable-fd-3>']);
          assert.deepEqual(readFd(inheritedFd, approved.length), approved, 'Wrangler handoff remains bound to approved inode');
          assert.deepEqual(fs.readFileSync(snapshotPath), replacement, 'replacement pathname is a distinct file object');
          return ok;
        },
      });
      assert.equal(status, 0);
      assert.equal(calls, 2);
      assert.deepEqual(fs.readFileSync(snapshotPath), replacement, 'cleanup must not delete a replacement it does not own');
    } finally {
      fs.rmSync(root, { recursive:true, force:true });
    }
  });
}

test('#9356 unsupported platforms fail closed before validator or Wrangler can consume a pathname snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9356-platform-'));
  try {
    const configPath = path.join(root, 'wrangler.jsonc');
    fs.writeFileSync(configPath, approved);
    let calls = 0;
    assert.throws(() => runProductionDeploy({
      configPath,
      snapshotDirectory:root,
      randomUUIDImpl:() => 'unsupported',
      descriptorPathImpl() { throw new Error('stable fd path unsupported'); },
      run() { calls++; return ok; },
    }), /stable fd path unsupported/);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(root), ['wrangler.jsonc']);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
