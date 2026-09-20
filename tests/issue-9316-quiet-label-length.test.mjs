import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runQuietCommand, safeLabel } from '../scripts/run-quiet-command.mjs';

function capture() {
  const chunks = [];
  return { stream:{ write(value) { chunks.push(String(value)); } }, text:() => chunks.join('') };
}

test('#9316 long diagnostic labels produce bounded distinct filesystem components', () => {
  const a = 'a'.repeat(300);
  const b = `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab`;
  assert.ok(safeLabel(a).length <= 113);
  assert.ok(safeLabel(b).length <= 113);
  assert.notEqual(safeLabel(a), safeLabel(b));
  assert.equal(safeLabel('normal-label'), 'normal-label');
});

test('#9316 quiet execution with a 300-character label still spawns and reports success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9316-'));
  const label = 'a'.repeat(300);
  const out = capture();
  let capturedLogPath = null;
  try {
    const result = await runQuietCommand({
      label,
      command:process.execPath,
      args:['-e', 'process.exit(0)'],
      tempRoot:root,
      stdout:out.stream,
      stderr:{ write() {} },
      createLogStream(filePath) {
        capturedLogPath = filePath;
        return fs.createWriteStream(filePath, { flags:'wx', mode:0o600 });
      },
    });
    assert.equal(result.ok, true);
    assert.ok(capturedLogPath);
    assert.ok(path.basename(path.dirname(capturedLogPath)).length < 200);
    assert.match(out.text(), new RegExp(`^${label}: PASS`));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
