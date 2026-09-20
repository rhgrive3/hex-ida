import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runQuietCommand } from '../scripts/run-quiet-command.mjs';

class MockLog extends EventEmitter {
  write() { return true; }
  end() { queueMicrotask(() => this.emit('close')); }
}
function sink() { return { write() {} }; }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
}
async function waitUntil(predicate, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition did not become true before timeout');
}

test('#9301 sink failure terminates the owned POSIX process group, including a TERM-ignoring descendant', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9301-'));
  const pidFile = path.join(root, 'grandchild.pid');
  let log;
  let leader;
  let grandchildPid = null;
  try {
    const grandchildCode = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    const leaderCode = `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio:'ignore' });
      setInterval(() => {}, 1000);
    `;
    const promise = runQuietCommand({
      label:'issue-9301', command:process.execPath, args:['-e', leaderCode],
      spawnImpl(command, args, options) { leader = spawn(command, args, options); return leader; },
      createLogStream() { log = new MockLog(); return log; },
      stdout:sink(), stderr:sink(), tempRoot:root,
      terminationGraceMs:40, forceSettleMs:500,
    });
    await waitUntil(() => fs.existsSync(pidFile));
    grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    assert.equal(alive(leader.pid), true);
    assert.equal(alive(grandchildPid), true);

    const sinkError = Object.assign(new Error('EIO: injected sink failure'), { code:'EIO' });
    log.emit('error', sinkError);
    await assert.rejects(() => promise, (error) => error === sinkError);
    await waitUntil(() => !alive(grandchildPid), 1500);
    assert.equal(alive(leader.pid), false);
    assert.equal(alive(grandchildPid), false);
  } finally {
    try { if (leader?.pid && alive(leader.pid)) process.kill(-leader.pid, 'SIGKILL'); } catch {}
    try { if (grandchildPid && alive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL'); } catch {}
    fs.rmSync(root, { recursive:true, force:true });
  }
});
