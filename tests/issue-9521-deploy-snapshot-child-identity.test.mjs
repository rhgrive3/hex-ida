import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runProductionDeploy } from '../scripts/deploy-production.mjs';

function stableLeafMatches(target, original) {
  return target === original
    || (String(target).startsWith('/proc/self/fd/') && path.basename(String(target)) === path.basename(original));
}

function createFixture(prefix = 'deploy-9521-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const distDir = path.join(root, 'dist');
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
  fs.writeFileSync(path.join(root, 'wrangler.jsonc'), JSON.stringify(wranglerConfig));
  fs.writeFileSync(path.join(root, 'worker-entry.js'), 'export default {};');

  return { root, distDir };
}

test('issue #9521: regular file replaced by absolute external symlink between enumeration and read fails closed', async () => {
  const { root, distDir } = createFixture('deploy-9521-abs-symlink-');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-9521-outside-'));
  const secretPath = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(secretPath, 'EXTERNAL_SECRET_BYTES');

  const assetFile = path.join(distDir, 'index.html');
  fs.writeFileSync(assetFile, 'INITIAL_HTML');

  let observedSnapshotContent = null;
  const run = (cmd, args, options) => {
    if (args.includes('--assets')) {
      const assetsFd = options.stdio[4];
      const assetsPath = `/proc/self/fd/${assetsFd}`;
      try {
        observedSnapshotContent = fs.readFileSync(path.join(assetsPath, 'index.html'), 'utf8');
      } catch {}
      return { status: 0 };
    }
    return { status: 0 };
  };

  try {
    let replaced = false;
    assert.throws(
      () => runProductionDeploy({
        snapshotDirectory: root,
        configPath: path.join(root, 'wrangler.jsonc'),
        run,
        lstatSync(target, opts) {
          if (stableLeafMatches(target, assetFile) && !replaced) {
            replaced = true;
            fs.unlinkSync(assetFile);
            fs.symlinkSync(secretPath, assetFile);
          }
          return fs.lstatSync(target, opts);
        },
      }),
      (err) => {
        assert.equal(err.code, 'DEPLOY_ASSET_CHILD_CHANGED');
        return true;
      },
    );

    assert.equal(observedSnapshotContent, null, 'EXTERNAL bytes must never be in snapshot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('issue #9521: regular file replaced by relative escaping symlink between enumeration and read fails closed', async () => {
  const { root, distDir } = createFixture('deploy-9521-rel-symlink-');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-9521-outside-'));
  const secretPath = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(secretPath, 'ESCAPE_SECRET_BYTES');

  const assetFile = path.join(distDir, 'index.html');
  fs.writeFileSync(assetFile, 'INITIAL_HTML');

  let observedSnapshotContent = null;
  const run = (cmd, args, options) => {
    if (args.includes('--assets')) {
      const assetsFd = options.stdio[4];
      const assetsPath = `/proc/self/fd/${assetsFd}`;
      try {
        observedSnapshotContent = fs.readFileSync(path.join(assetsPath, 'index.html'), 'utf8');
      } catch {}
      return { status: 0 };
    }
    return { status: 0 };
  };

  try {
    let replaced = false;
    const relTarget = path.relative(distDir, secretPath);
    assert.throws(
      () => runProductionDeploy({
        snapshotDirectory: root,
        configPath: path.join(root, 'wrangler.jsonc'),
        run,
        lstatSync(target, opts) {
          if (stableLeafMatches(target, assetFile) && !replaced) {
            replaced = true;
            fs.unlinkSync(assetFile);
            fs.symlinkSync(relTarget, assetFile);
          }
          return fs.lstatSync(target, opts);
        },
      }),
      (err) => {
        assert.equal(err.code, 'DEPLOY_ASSET_CHILD_CHANGED');
        return true;
      },
    );

    assert.equal(observedSnapshotContent, null, 'EXTERNAL bytes must never be in snapshot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('issue #9521: regular file replaced by different regular inode between enumeration and read fails closed', async () => {
  const { root, distDir } = createFixture('deploy-9521-diff-inode-');
  const assetFile = path.join(distDir, 'index.html');
  fs.writeFileSync(assetFile, 'INITIAL_HTML');

  // Allocate a file beforehand so we can guarantee a different inode
  const otherFile = path.join(root, 'other-file.html');
  fs.writeFileSync(otherFile, 'REPLACED_INODE_HTML');

  let observedSnapshotContent = null;
  const run = (cmd, args, options) => {
    if (args.includes('--assets')) {
      const assetsFd = options.stdio[4];
      const assetsPath = `/proc/self/fd/${assetsFd}`;
      try {
        observedSnapshotContent = fs.readFileSync(path.join(assetsPath, 'index.html'), 'utf8');
      } catch {}
      return { status: 0 };
    }
    return { status: 0 };
  };

  try {
    let replaced = false;
    assert.throws(
      () => runProductionDeploy({
        snapshotDirectory: root,
        configPath: path.join(root, 'wrangler.jsonc'),
        run,
        openSync(target, flags, mode) {
          if (stableLeafMatches(target, assetFile) && !replaced) {
            replaced = true;
            // Atomic replacement by rename of existing file to guarantee different inode
            fs.renameSync(otherFile, assetFile);
          }
          return fs.openSync(target, flags, mode);
        },
      }),
      (err) => {
        assert.equal(err.code, 'DEPLOY_ASSET_CHILD_CHANGED');
        return true;
      },
    );

    assert.equal(observedSnapshotContent, null, 'Replaced inode bytes must never be in snapshot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('issue #9521: nested directory swapped for symlink fails closed', async () => {
  const { root, distDir } = createFixture('deploy-9521-nested-dir-');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-9521-outside-dir-'));
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE_DIR_SECRET');

  const subDir = path.join(distDir, 'nested');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'file.txt'), 'INSIDE_NESTED');

  let observedSnapshotContent = null;
  const run = (cmd, args, options) => {
    if (args.includes('--assets')) {
      const assetsFd = options.stdio[4];
      const assetsPath = `/proc/self/fd/${assetsFd}`;
      try {
        observedSnapshotContent = fs.readFileSync(path.join(assetsPath, 'nested/secret.txt'), 'utf8');
      } catch {}
      return { status: 0 };
    }
    return { status: 0 };
  };

  try {
    let swapped = false;
    assert.throws(
      () => runProductionDeploy({
        snapshotDirectory: root,
        configPath: path.join(root, 'wrangler.jsonc'),
        run,
        lstatSync(target, opts) {
          if (stableLeafMatches(target, subDir) && !swapped) {
            swapped = true;
            fs.rmSync(subDir, { recursive: true, force: true });
            fs.symlinkSync(outsideDir, subDir, 'dir');
          }
          return fs.lstatSync(target, opts);
        },
      }),
      (err) => {
        assert.equal(err.code, 'DEPLOY_ASSET_CHILD_CHANGED');
        return true;
      },
    );

    assert.equal(observedSnapshotContent, null, 'Outside directory contents must never enter snapshot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('issue #9521: unchanged tree snapshots normally and byte-identical', async () => {
  const { root, distDir } = createFixture('deploy-9521-unchanged-');
  const subDir = path.join(distDir, 'nested');
  fs.mkdirSync(subDir, { recursive: true });

  const rootFileContent = 'ROOT_INDEX_HTML_CONTENT_12345';
  const nestedFileContent = 'NESTED_FILE_CONTENT_67890';
  fs.writeFileSync(path.join(distDir, 'index.html'), rootFileContent);
  fs.writeFileSync(path.join(subDir, 'nested.txt'), nestedFileContent);

  // Also include a pre-existing symlink entry in distDir which should be skipped
  const outsideFile = path.join(root, 'outside-ignored.txt');
  fs.writeFileSync(outsideFile, 'SHOULD_BE_SKIPPED');
  fs.symlinkSync(outsideFile, path.join(distDir, 'symlink-ignored.txt'));

  let observedRootFile = null;
  let observedNestedFile = null;
  let observedSymlinkExists = null;

  const run = (cmd, args, options) => {
    if (args.includes('--assets')) {
      const assetsFd = options.stdio[4];
      const assetsPath = `/proc/self/fd/${assetsFd}`;
      observedRootFile = fs.readFileSync(path.join(assetsPath, 'index.html'), 'utf8');
      observedNestedFile = fs.readFileSync(path.join(assetsPath, 'nested', 'nested.txt'), 'utf8');
      observedSymlinkExists = fs.existsSync(path.join(assetsPath, 'symlink-ignored.txt'));
      return { status: 0 };
    }
    return { status: 0 };
  };

  try {
    const status = runProductionDeploy({
      snapshotDirectory: root,
      configPath: path.join(root, 'wrangler.jsonc'),
      run,
    });

    assert.equal(status, 0);
    assert.equal(observedRootFile, rootFileContent);
    assert.equal(observedNestedFile, nestedFileContent);
    assert.equal(observedSymlinkExists, false, 'Pre-existing symlinks remain skipped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
