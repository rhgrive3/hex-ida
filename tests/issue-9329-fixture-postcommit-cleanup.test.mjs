import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishFixtureFile } from '../scripts/fetch-real-fixtures.mjs';

test('#9329 backup cleanup failure never rolls back an already-published fixture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9329-'));
  try {
    const target = path.join(root, 'fixture.bin');
    const temp = path.join(root, 'fixture.partial');
    await fs.writeFile(target, 'OLD');
    await fs.writeFile(temp, 'NEW');
    let firstPublish = true;
    const cleanupErrors = [];
    await publishFixtureFile(temp, target, {
      platform:'win32',
      randomUUIDImpl:() => 'fixed',
      renameImpl:async (from, to) => {
        if (firstPublish && from === temp && to === target) {
          firstPublish = false;
          throw Object.assign(new Error('destination exists'), { code:'EPERM' });
        }
        return fs.rename(from, to);
      },
      rmImpl:async (file, options) => {
        if (String(file).includes('.replace-backup-')) throw Object.assign(new Error('cleanup I/O failure'), { code:'EIO' });
        return fs.rm(file, options);
      },
      onCleanupError:error => cleanupErrors.push(error),
    });
    assert.equal(await fs.readFile(target, 'utf8'), 'NEW');
    assert.equal(cleanupErrors.length, 1);
    assert.equal(cleanupErrors[0].code, 'EIO');
    assert.ok((await fs.readdir(root)).some((name) => name.includes('.replace-backup-')));
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});
