import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runQuietCommand } from '../scripts/run-quiet-command.mjs';

test('#9608 synchronous spawn failure remains primary when cleanup also fails', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-9608-'));
  const spawnError = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
  const cleanupError = Object.assign(new Error('cleanup failed'), { code: 'EIO' });
  try {
    await assert.rejects(
      () => runQuietCommand({
        label: 'sync-spawn-failure',
        command: 'missing-command',
        tempRoot,
        spawnImpl() { throw spawnError; },
        removeDirectory() { throw cleanupError; },
        stdout: { write() {} },
        stderr: { write() {} },
      }),
      (error) => error === spawnError,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
