import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openStableMigrationSource } from '../scripts/freebuff-setup.mjs';

test('issue #9481: source-file close failure does not strand parent directory descriptor', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9481-'));
  const sourceRoot = path.join(tmp, 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });

  const srcFile = path.join(sourceRoot, 'file.txt');
  fs.writeFileSync(srcFile, 'hello');

  const closedFds = [];
  let fileFd = null;
  let parentFd = null;

  const mockFs = {
    ...fs,
    openSync(p, flags, mode) {
      const fd = fs.openSync(p, flags, mode);
      if (flags && (flags & fs.constants.O_DIRECTORY)) {
        parentFd = fd;
      } else {
        fileFd = fd;
      }
      return fd;
    },
    closeSync(fd) {
      closedFds.push(fd);
      if (fd === fileFd) {
        throw Object.assign(new Error('simulated file close failure'), { code: 'EIO' });
      }
      return fs.closeSync(fd);
    },
  };

  const handle = openStableMigrationSource(sourceRoot, srcFile, { fsImpl: mockFs });
  assert.ok(handle, 'handle opened');
  assert.throws(() => handle.close(), /simulated file close failure/);

  assert.ok(closedFds.includes(fileFd), 'fileFd must have had a close attempt');
  assert.ok(closedFds.includes(parentFd), 'parentFd must have had a close attempt even if fileFd close failed');

  const prevClosedLen = closedFds.length;
  try { handle.close(); } catch {}
  assert.ok(closedFds.filter(fd => fd === parentFd).length === 1, 'parentFd must not be closed multiple times');

  try { fs.closeSync(fileFd); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});
