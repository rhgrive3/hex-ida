import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../../scripts/deploy-production.mjs';
import { validateAuthConfig } from '../../scripts/validate-auth-config.mjs';

function productionConfig(assetDirectory = './dist') {
  return {
    main: './worker-entry.js',
    assets: { directory: assetDirectory, run_worker_first: true },
    d1_databases: [{
      binding: 'AUTH_DB',
      database_name: 'hex-auth',
      database_id: '12345678-1234-1234-1234-123456789abc',
      migrations_dir: 'migrations/auth',
    }],
  };
}

function makeRoot(prefix = 'deploy-9438-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(root, 'wrangler.jsonc');
  fs.writeFileSync(configPath, JSON.stringify(productionConfig(), null, 2));
  fs.writeFileSync(path.join(root, 'worker-entry.js'), 'export default {};\n');
  return { root, configPath };
}

function runner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
}

test('production config admits only dist as asset directory', () => {
  for (const accepted of ['./dist', 'dist']) {
    assert.doesNotThrow(() => validateAuthConfig(productionConfig(accepted), { local: false }));
  }
  for (const rejected of ['/tmp/external-assets', '../private-export', './scripts', '', undefined]) {
    const config = productionConfig(rejected);
    if (rejected === undefined) delete config.assets.directory;
    assert.throws(
      () => validateAuthConfig(config, { local: false }),
      /Production assets directory must be \.\/dist/,
    );
  }
});

test('regular production dist is handed to Wrangler through inherited directory descriptor', () => {
  const { root, configPath } = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<h1>ok</h1>\n');
    const calls = [];
    const status = runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      run: runner(calls),
      randomUUIDImpl: () => 'assets-ok',
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args.slice(-2), ['--assets', '/proc/self/fd/4']);
    assert.equal(Number.isInteger(calls[1].options.stdio[4]), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const assetDirectory of ['/tmp/external-assets', '../private-export', './scripts']) {
  test(`production wrapper rejects unapproved asset root ${assetDirectory}`, () => {
    const { root, configPath } = makeRoot('deploy-9438-policy-');
    try {
      fs.writeFileSync(configPath, JSON.stringify(productionConfig(assetDirectory), null, 2));
      const calls = [];
      assert.throws(
        () => runProductionDeploy({
          configPath,
          snapshotDirectory: root,
          run: runner(calls),
          randomUUIDImpl: () => 'assets-policy',
        }),
        /Production assets directory must be \.\/dist/,
      );
      assert.equal(calls.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('missing, file, and escaping-symlink dist fail closed before Wrangler', () => {
  for (const variant of ['missing', 'file', 'symlink', 'multihop']) {
    const { root, configPath } = makeRoot(`deploy-9438-${variant}-`);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-9438-outside-'));
    try {
      const dist = path.join(root, 'dist');
      if (variant === 'file') fs.writeFileSync(dist, 'not a directory\n');
      if (variant === 'symlink') {
        const external = path.join(outside, 'assets');
        fs.mkdirSync(external);
        fs.symlinkSync(external, dist, 'dir');
      }
      if (variant === 'multihop') {
        const external = path.join(outside, 'assets');
        fs.mkdirSync(external);
        fs.symlinkSync(external, path.join(root, 'dist-target'), 'dir');
        fs.symlinkSync('dist-target', dist, 'dir');
      }

      const calls = [];
      assert.throws(
        () => runProductionDeploy({
          configPath,
          snapshotDirectory: root,
          run: runner(calls),
          randomUUIDImpl: () => `assets-${variant}`,
        }),
        variant === 'missing'
          ? /assets directory provenance could not be established/
          : /assets path must be a real directory/,
      );
      assert.equal(calls.length, 1, 'validator may run, Wrangler must not');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('dist replacement between lstat and open is detected by directory identity', () => {
  const { root, configPath } = makeRoot('deploy-9438-race-');
  try {
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'index.html'), 'original\n');
    const originalOpen = fs.openSync;
    let swapped = false;
    const calls = [];

    assert.throws(
      () => runProductionDeploy({
        configPath,
        snapshotDirectory: root,
        run: runner(calls),
        randomUUIDImpl: () => 'assets-race',
        openSync(target, flags, mode) {
          if (!swapped && path.resolve(String(target)) === path.resolve(dist)) {
            swapped = true;
            fs.renameSync(dist, path.join(root, 'dist-original'));
            fs.mkdirSync(dist);
            fs.writeFileSync(path.join(dist, 'index.html'), 'replacement\n');
          }
          return originalOpen(target, flags, mode);
        },
      }),
      /assets directory identity changed before deployment/,
    );
    assert.equal(swapped, true);
    assert.equal(calls.length, 1, 'validator may run, Wrangler must not');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
