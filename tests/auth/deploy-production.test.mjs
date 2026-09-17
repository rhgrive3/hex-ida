import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, runProductionDeploy } from '../../scripts/deploy-production.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('canonical production deploy validates the default config before invoking Wrangler', async () => {
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(resolve(repoRoot, 'wrangler.jsonc'), 'utf8'));
  const deploymentGuide = await readFile(resolve(repoRoot, 'docs/chatgpt-userscript.md'), 'utf8');
  assert.equal(packageJson.scripts['deploy:production'], 'node scripts/deploy-production.mjs');
  assert.match(deploymentGuide, /npm run deploy:production/);
  assert.doesNotMatch(deploymentGuide, /npx wrangler deploy/);
  assert.match(config.build.command, /npm run userscript:build/);
  assert.doesNotMatch(config.build.command, /validate-auth-config|deploy-production/);

  const calls = [];
  const status = runProductionDeploy({
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    {
      command: process.execPath,
      args: [resolve(repoRoot, 'scripts/validate-auth-config.mjs')],
      options: { cwd: repoRoot, stdio: 'inherit' },
    },
    {
      command: process.execPath,
      args: [resolve(repoRoot, 'node_modules/wrangler/bin/wrangler.js'), 'deploy'],
      options: { cwd: repoRoot, stdio: 'inherit' },
    },
  ]);
});

test('production deploy stops before Wrangler when auth config validation fails', () => {
  const calls = [];
  const status = runProductionDeploy({
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 1 };
    },
  });

  assert.equal(status, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[0], /validate-auth-config\.mjs$/);
});

test('production deploy cannot select a different Wrangler config or environment', () => {
  let invoked = false;
  const run = () => { invoked = true; return { status: 0 }; };
  assert.equal(main(['--env=staging'], { run, reportError() {} }), 1);
  assert.equal(main(['--config=other.jsonc'], { run, reportError() {} }), 1);
  assert.equal(invoked, false);
});
