import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductionDeploy } from '../../scripts/deploy-production.mjs';

function makeRoot(prefix = 'deploy-9434-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(root, 'wrangler.jsonc');
  fs.writeFileSync(configPath, JSON.stringify({
    main: './worker-entry.js',
    assets: { directory: './dist', run_worker_first: true },
    d1_databases: [{
      binding: 'AUTH_DB',
      database_name: 'hex-auth',
      database_id: '12345678-1234-1234-1234-123456789abc',
      migrations_dir: 'migrations/auth',
    }],
  }, null, 2));
  fs.mkdirSync(path.join(root, 'dist'));
  return { root, configPath };
}

function runStub(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
}

test('regular production entrypoint is handed to Wrangler through locked inode path', () => {
  const { root, configPath } = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'worker-entry.js'), 'export default {};\n');
    const calls = [];
    const status = runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      run: runStub(calls),
      randomUUIDImpl: () => 'entrypoint-ok',
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args[2], '/proc/self/fd/3/worker-entry.js');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const kind of ['absolute', 'relative', 'multihop']) {
  test(`production entrypoint rejects ${kind} escaping symlink before Wrangler`, () => {
    const { root, configPath } = makeRoot(`deploy-9434-${kind}-`);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-9434-outside-'));
    try {
      const external = path.join(outside, 'evil-worker.js');
      fs.writeFileSync(external, 'export default { evil: true };\n');
      const entry = path.join(root, 'worker-entry.js');
      if (kind === 'absolute') {
        fs.symlinkSync(external, entry);
      } else if (kind === 'relative') {
        fs.symlinkSync(path.relative(root, external), entry);
      } else {
        const hop = path.join(root, 'hop.js');
        fs.symlinkSync(external, hop);
        fs.symlinkSync('hop.js', entry);
      }
      const calls = [];
      assert.throws(
        () => runProductionDeploy({
          configPath,
          snapshotDirectory: root,
          run: runStub(calls),
          randomUUIDImpl: () => `entrypoint-${kind}`,
        }),
        /entrypoint must be a real regular file/,
      );
      assert.equal(calls.length, 0, 'provenance rejection must occur before validator/Wrangler handoff');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
}

test('missing and non-regular production entrypoints fail closed', () => {
  for (const variant of ['missing', 'directory']) {
    const { root, configPath } = makeRoot(`deploy-9434-${variant}-`);
    try {
      if (variant === 'directory') fs.mkdirSync(path.join(root, 'worker-entry.js'));
      assert.throws(
        () => runProductionDeploy({
          configPath,
          snapshotDirectory: root,
          run: () => ({ status: 0 }),
          randomUUIDImpl: () => `entrypoint-${variant}`,
        }),
        variant === 'missing'
          ? /entrypoint provenance could not be established/
          : /entrypoint must be a real regular file/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('entrypoint replacement between lstat and open is detected by inode identity', () => {
  const { root, configPath } = makeRoot('deploy-9434-race-');
  try {
    const entry = path.join(root, 'worker-entry.js');
    fs.writeFileSync(entry, 'export const ORIGINAL = true;\n');
    let swapped = false;
    const calls = [];
    assert.throws(
      () => runProductionDeploy({
        configPath,
        snapshotDirectory: root,
        run: runStub(calls),
        randomUUIDImpl: () => 'entrypoint-race',
        openSync(target, flags, mode) {
          if (!swapped && path.resolve(String(target)) === path.resolve(entry)) {
            swapped = true;
            fs.renameSync(entry, path.join(root, 'worker-entry.original.js'));
            fs.writeFileSync(entry, 'export const REPLACEMENT = true;\n');
          }
          return fs.openSync(target, flags, mode);
        },
      }),
      /entrypoint identity changed before snapshot/,
    );
    assert.equal(swapped, true);
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9468 in-place workspace rewrite cannot mutate stable entrypoint snapshot', () => {
  const { root, configPath } = makeRoot('deploy-9468-inplace-');
  try {
    const entry = path.join(root, 'worker-entry.js');
    const original = 'export const REVIEWED = true;\n';
    const replacement = 'export const UNREVIEWED = true;\n';
    fs.writeFileSync(entry, original);

    let call = 0;
    let wranglerBytes = null;
    const status = runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      randomUUIDImpl: () => 'entrypoint-inplace',
      run(command, args, options) {
        call++;
        if (call === 1) {
          fs.writeFileSync(entry, replacement);
          return { status: 0 };
        }
        wranglerBytes = fs.readFileSync(`/proc/self/fd/${options.stdio[3]}/worker-entry.js`, 'utf8');
        return { status: 0 };
      },
    });

    assert.equal(status, 0);
    assert.equal(call, 2);
    assert.equal(fs.readFileSync(entry, 'utf8'), replacement);
    assert.equal(wranglerBytes, original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9468 truncate-rewrite through a second hardlink cannot mutate stable snapshot', () => {
  const { root, configPath } = makeRoot('deploy-9468-hardlink-');
  try {
    const entry = path.join(root, 'worker-entry.js');
    const alias = path.join(root, 'worker-entry.alias.js');
    const original = 'export const REVIEWED = true;\n';
    const replacement = 'export const REWRITTEN = true;\n';
    fs.writeFileSync(entry, original);
    fs.linkSync(entry, alias);

    let call = 0;
    let wranglerBytes = null;
    const status = runProductionDeploy({
      configPath,
      snapshotDirectory: root,
      randomUUIDImpl: () => 'entrypoint-hardlink',
      run(command, args, options) {
        call++;
        if (call === 1) {
          fs.writeFileSync(alias, replacement);
          return { status: 0 };
        }
        wranglerBytes = fs.readFileSync(`/proc/self/fd/${options.stdio[3]}/worker-entry.js`, 'utf8');
        return { status: 0 };
      },
    });

    assert.equal(status, 0);
    assert.equal(call, 2);
    assert.equal(fs.readFileSync(entry, 'utf8'), replacement);
    assert.equal(wranglerBytes, original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
