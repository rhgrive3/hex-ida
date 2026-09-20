import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishUserscriptFiles } from '../scripts/userscript-publication.mjs';

async function exists(file) { try { await realFs.lstat(file); return true; } catch (e) { if (e?.code === 'ENOENT') return false; throw e; } }

test('#9327 artifact cleanup failure retains recovery lock and blocks the next publisher', async () => {
  const dir = await realFs.mkdtemp(path.join(os.tmpdir(), 'hex-9327-'));
  try {
    const files = [path.join(dir, 'hex.user.js'), path.join(dir, 'hex-release.user.js')];
    await realFs.writeFile(files[0], 'OLD1');
    await realFs.writeFile(files[1], 'OLD2');
    const injected = Object.assign(new Error('backup cleanup EIO'), { code:'EIO' });
    const io = {
      ...realFs,
      async unlink(file) {
        if (String(file).endsWith('.backup')) throw injected;
        return realFs.unlink(file);
      },
    };
    const entries = [
      { path:files[0], expected:Buffer.from('OLD1'), content:Buffer.from('NEW1') },
      { path:files[1], expected:Buffer.from('OLD2'), content:Buffer.from('NEW2') },
    ];
    await assert.rejects(
      () => publishUserscriptFiles(entries, { io, containmentRoot:dir }),
      (error) => error instanceof AggregateError
        && /userscript-publication-cleanup-failed/.test(error.message)
        && error.errors.some((item) => item === injected || /backup cleanup EIO/.test(item?.message || '')),
    );
    const lock = path.join(dir, '.userscript-publication.lock');
    assert.equal(await exists(lock), true);
    assert.ok((await realFs.readdir(dir)).some((name) => name.endsWith('.backup')));
    await assert.rejects(() => publishUserscriptFiles(entries, { containmentRoot:dir }), (error) => error?.code === 'EEXIST');
  } finally {
    await realFs.rm(dir, { recursive:true, force:true });
  }
});
