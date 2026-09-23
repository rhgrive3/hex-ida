import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runProductionDeploy } from '../scripts/deploy-production.mjs';

test('issue #9479: dist child mutations do not leak into Wrangler assets snapshot', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-9479-'));
  const configRoot = tmp;
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

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
  fs.writeFileSync(path.join(distDir, 'index.html'), 'REVIEWED');

  let observedAssetsContent = null;
  const run = (cmd, args, options) => {
    if (args.includes('--assets')) {
      const assetsFd = options.stdio[4];
      const assetsPath = `/proc/self/fd/${assetsFd}`;
      // In-place mutate workspace dist/index.html now
      fs.writeFileSync(path.join(distDir, 'index.html'), 'UNREVIEWED');
      observedAssetsContent = fs.readFileSync(path.join(assetsPath, 'index.html'), 'utf8');
      return { status: 0 };
    }
    return { status: 0 };
  };

  const result = runProductionDeploy({
    snapshotDirectory: tmp,
    configPath: path.join(tmp, 'wrangler.jsonc'),
    run,
  });

  assert.equal(observedAssetsContent, 'REVIEWED', 'Wrangler must see the reviewed snapshot bytes, not mutated UNREVIEWED');
  fs.rmSync(tmp, { recursive: true, force: true });
});
