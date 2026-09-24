import assert from 'node:assert/strict';
import test from 'node:test';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishUserscriptFiles } from '../scripts/userscript-publication.mjs';

test('#9534 rollback refuses a substituted backup leaf', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hex-9534-'));
  const first = path.join(root, 'a.user.js');
  const second = path.join(root, 'b.user.js');
  await fsp.writeFile(first, 'OLD-A');
  await fsp.writeFile(second, 'OLD-B');

  let firstBackup = null;
  let publishRenames = 0;
  const io = {
    ...fsp,
    async link(source, backup) {
      if (source === first) firstBackup = backup;
      return fsp.link(source, backup);
    },
    async rename(from, to) {
      if (to === first || to === second) {
        publishRenames += 1;
        if (publishRenames === 2) {
          assert.ok(firstBackup);
          const substitute = `${firstBackup}.substitute`;
          await fsp.writeFile(substitute, 'SUBSTITUTED');
          await fsp.unlink(firstBackup);
          await fsp.rename(substitute, firstBackup);
          throw Object.assign(new Error('injected second publication failure'), { code: 'EIO' });
        }
      }
      return fsp.rename(from, to);
    },
  };

  try {
    await assert.rejects(
      () => publishUserscriptFiles([
        { path: first, expected: Buffer.from('OLD-A'), content: Buffer.from('NEW-A') },
        { path: second, expected: Buffer.from('OLD-B'), content: Buffer.from('NEW-B') },
      ], { io, containmentRoot: root }),
      (error) => {
        assert.match(error.message, /recovery-required|cleanup-failed/);
        const nested = error instanceof AggregateError ? error.errors : [];
        assert.ok(nested.some((item) => item?.code === 'USERSCRIPT_PUBLICATION_BACKUP_CHANGED')
          || nested.some((item) => item instanceof AggregateError && item.errors?.some((sub) => sub?.code === 'USERSCRIPT_PUBLICATION_BACKUP_CHANGED')));
        return true;
      },
    );
    assert.notEqual(await fsp.readFile(first, 'utf8'), 'SUBSTITUTED');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
