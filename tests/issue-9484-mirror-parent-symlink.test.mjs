import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureMirror } from '../scripts/freebuff-setup.mjs';

test('issue #9484: freebuff mirror publication does not follow symlinked parent directories outside restore root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9484-'));
  const mirrorRoot = path.join(tmp, 'restore-root');
  const victimDir = path.join(tmp, 'victim');

  fs.mkdirSync(mirrorRoot, { recursive: true });
  fs.mkdirSync(victimDir, { recursive: true });

  const scriptsSymlink = path.join(mirrorRoot, 'scripts');
  fs.symlinkSync(victimDir, scriptsSymlink, 'dir');

  const wrote = ensureMirror({ mirrorRoot });

  const victimFiles = fs.readdirSync(victimDir);
  assert.equal(victimFiles.length, 0, `victim dir must not be written to: ${victimFiles}`);

  fs.rmSync(tmp, { recursive: true, force: true });
});
