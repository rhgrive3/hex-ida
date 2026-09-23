import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runProductionDeploy } from '../scripts/deploy-production.mjs';

test('issue #9515: snapshot close failure does not strand owned config artifact', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-9515-'));
  const wranglerConfig = {
    name: 'test-worker',
    main: './worker-entry.js',
    compatibility_date: '2024-01-01',
    assets: {
      directory: './dist',
      binding: 'ASSETS',
      run_worker_first: true,
    },
  };
  fs.writeFileSync(path.join(tmp, 'wrangler.jsonc'), JSON.stringify(wranglerConfig));
  fs.writeFileSync(path.join(tmp, 'worker-entry.js'), 'export default {};');
  fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'dist/index.html'), 'OK');

  let failNextClose = true;
  let firstCloseFd = null;
  const mockCloseSync = (fd) => {
    if (failNextClose) {
      failNextClose = false;
      firstCloseFd = fd;
      fs.closeSync(fd);
      throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
    }
    return fs.closeSync(fd);
  };

  try {
    runProductionDeploy({
      snapshotDirectory: tmp,
      configPath: path.join(tmp, 'wrangler.jsonc'),
      closeSync: mockCloseSync,
      randomUUIDImpl: () => 'close-fail-uuid',
    });
  } catch (err) {
    // Expected to fail
  }

  // Check that no .wrangler.production-snapshot-* files remain stranded in tmp
  const files = fs.readdirSync(tmp);
  const snapshotFiles = files.filter(f => f.startsWith('.wrangler.production-snapshot'));
  assert.equal(snapshotFiles.length, 0, `no snapshot file should be stranded, found: ${snapshotFiles.join(', ')}`);

  fs.rmSync(tmp, { recursive: true, force: true });
});
