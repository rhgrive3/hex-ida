import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStableDirectory } from '../scripts/freebuff-setup.mjs';

test('#9550 failed stable-directory close remains retryable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9550-'));
  const dir = path.join(root, 'dir');
  fs.mkdirSync(dir);
  let closeCalls = 0;
  const fsImpl = Object.create(fs);
  fsImpl.closeSync = (fd) => {
    closeCalls += 1;
    if (closeCalls === 1) throw Object.assign(new Error('transient close failure'), { code: 'EINTR' });
    return fs.closeSync(fd);
  };
  try {
    const stable = openStableDirectory(root, dir, { fsImpl });
    assert.throws(() => stable.close(), { code: 'EINTR' });
    stable.close();
    stable.close();
    assert.equal(closeCalls, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
