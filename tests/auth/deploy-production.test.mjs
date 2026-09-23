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
  const fakeDist = resolve(repoRoot, 'dist');
  let createdDist = false;
  const fs = await import('node:fs');
  if (!fs.existsSync(fakeDist)) {
    fs.mkdirSync(fakeDist, { recursive: true });
    fs.writeFileSync(resolve(fakeDist, 'index.html'), '<html></html>');
    createdDist = true;
  }
  let status;
  try {
    status = runProductionDeploy({
      run(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });
  } finally {
    if (createdDist) {
      fs.rmSync(fakeDist, { recursive: true, force: true });
    }
  }

  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  const validator = calls[0];
  const deployment = calls[1];
  assert.equal(validator.command, process.execPath);
  assert.equal(validator.args[0], resolve(repoRoot, 'scripts/validate-auth-config.mjs'));
  assert.equal(validator.args[1], '--config=/proc/self/fd/3/wrangler.jsonc');
  assert.equal(validator.options.cwd, repoRoot);
  assert.deepEqual(validator.options.stdio.slice(0, 3), ['inherit', 'inherit', 'inherit']);
  assert.equal(Number.isInteger(validator.options.stdio[3]), true);
  assert.equal(deployment.command, process.execPath);
  assert.deepEqual(deployment.args, [
    resolve(repoRoot, 'node_modules/wrangler/bin/wrangler.js'),
    'deploy',
    '/proc/self/fd/3/worker-entry.js',
    '--config',
    '/proc/self/fd/3/wrangler.jsonc',
    '--assets',
    '/proc/self/fd/4',
  ]);
  assert.equal(deployment.options.cwd, validator.options.cwd);
  assert.deepEqual(deployment.options.stdio.slice(0, 3), validator.options.stdio.slice(0, 3));
  assert.equal(deployment.options.stdio[3], validator.options.stdio[3]);
  assert.equal(Number.isInteger(deployment.options.stdio[4]), true);
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
