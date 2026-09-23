import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { partitionDigest } from '../scripts/accuracy-partition-cache-key.mjs';

function fsWith(overrides = {}) {
  return { ...fs, ...overrides };
}

test('#9294 selected regular-file read failures fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9294-file-'));
  try {
    fs.mkdirSync(path.join(root, 'js'), { recursive: true });
    const selected = path.join(root, 'js/selected.js');
    fs.writeFileSync(selected, 'export default 1;\n');
    const selectedOnly = () => ['js/selected.js'];

    for (const code of ['EACCES', 'EIO']) {
      const injected = fsWith({
        readFileSync(file, ...args) {
          const matches = typeof file === 'number'
            ? (() => {
                try {
                  const fdStat = fs.fstatSync(file);
                  const selStat = fs.statSync(selected);
                  return fdStat.dev === selStat.dev && fdStat.ino === selStat.ino;
                } catch {
                  return false;
                }
              })()
            : path.resolve(file) === path.resolve(selected);
          if (matches) {
            const error = new Error(`${code}: injected read failure`);
            error.code = code;
            throw error;
          }
          return fs.readFileSync(file, ...args);
        },
      });
      assert.throws(
        () => partitionDigest(root, 'core', { fsImpl: injected, partitionFilesImpl: selectedOnly }),
        (error) => error?.code === code,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9294 selected symlink identity failures fail closed while broken targets remain representable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9294-link-'));
  try {
    fs.mkdirSync(path.join(root, 'js'), { recursive: true });
    const link = path.join(root, 'js/selected.js');
    fs.symlinkSync('./missing-target.js', link);
    const selectedOnly = () => ['js/selected.js'];

    const brokenDigest = partitionDigest(root, 'core', { partitionFilesImpl: selectedOnly });
    assert.equal(brokenDigest.length, 64, 'broken symlink target remains an intentional represented state');

    const readlinkFailure = fsWith({
      readlinkSync(file, ...args) {
        if (path.resolve(file) === path.resolve(link)) {
          const error = new Error('EIO: injected readlink failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.readlinkSync(file, ...args);
      },
    });
    assert.throws(
      () => partitionDigest(root, 'core', { fsImpl: readlinkFailure, partitionFilesImpl: selectedOnly }),
      (error) => error?.code === 'EIO',
    );

    const lstatFailure = fsWith({
      lstatSync(file, ...args) {
        if (path.resolve(file) === path.resolve(link)) {
          const error = new Error('EACCES: injected lstat failure');
          error.code = 'EACCES';
          throw error;
        }
        return fs.lstatSync(file, ...args);
      },
    });
    assert.throws(
      () => partitionDigest(root, 'core', { fsImpl: lstatFailure, partitionFilesImpl: selectedOnly }),
      (error) => error?.code === 'EACCES',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9294 normal selected input remains deterministic and absent unselected input is irrelevant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9294-normal-'));
  try {
    fs.mkdirSync(path.join(root, 'js'), { recursive: true });
    fs.writeFileSync(path.join(root, 'js/selected.js'), 'export const x = 1;\n');
    const selectedOnly = () => ['js/selected.js'];
    assert.equal(
      partitionDigest(root, 'core', { partitionFilesImpl: selectedOnly }),
      partitionDigest(root, 'core', { partitionFilesImpl: selectedOnly }),
    );
    assert.equal(partitionDigest(root, 'core', { partitionFilesImpl: () => [] }).length, 64);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
