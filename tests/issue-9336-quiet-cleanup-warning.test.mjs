import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runQuietCommand } from '../scripts/run-quiet-command.mjs';

function capture() { const parts=[]; return { stream:{ write(v){ parts.push(String(v)); } }, text:()=>parts.join('') }; }

test('#9336 cleanup-only failure preserves successful child result with explicit warning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9336-'));
  const out = capture();
  const err = capture();
  const cleanupError = Object.assign(new Error('cleanup I/O failure'), { code:'EIO' });
  try {
    const result = await runQuietCommand({
      label:'issue-9336', command:process.execPath, args:['-e','process.exit(0)'], tempRoot:root,
      stdout:out.stream, stderr:err.stream,
      removeDirectory(){ throw cleanupError; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.equal(result.cleanupError, cleanupError);
    assert.ok(result.logPath);
    assert.match(out.text(), /issue-9336: PASS/);
    assert.match(err.text(), /WARN diagnostic temp cleanup failed \(EIO\)/);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
