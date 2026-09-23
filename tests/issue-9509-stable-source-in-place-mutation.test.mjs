import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readStableRepositoryFile } from '../scripts/stable-repository-source.mjs';

function makeRoot(prefix = 'hex-9509-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('#9509 detects in-place truncate mutation across read', async () => {
  const repo = makeRoot('hex-9509-truncate-');
  try {
    const file = path.join(repo, 'worker.js');
    fs.writeFileSync(file, 'const initialContent = 1234567890;\n');
    await assert.rejects(
      () => readStableRepositoryFile('worker.js', {
        rootDir: repo,
        sourceLabel: 'Worker source',
        async readHandleImpl(handle) {
          fs.writeFileSync(file, 'short;\n');
          return handle.readFile({ encoding: 'utf8' });
        },
      }),
      /changed during read/,
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('#9509 detects in-place rewrite (larger size) across read', async () => {
  const repo = makeRoot('hex-9509-rewrite-');
  try {
    const file = path.join(repo, 'worker.js');
    fs.writeFileSync(file, 'initial;\n');
    await assert.rejects(
      () => readStableRepositoryFile('worker.js', {
        rootDir: repo,
        sourceLabel: 'Worker source',
        async readHandleImpl(handle) {
          fs.writeFileSync(file, 'longer rewritten content;\n');
          return handle.readFile({ encoding: 'utf8' });
        },
      }),
      /changed during read/,
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('#9509 detects in-place same-size overwrite across read', async () => {
  const repo = makeRoot('hex-9509-same-size-');
  try {
    const file = path.join(repo, 'worker.js');
    fs.writeFileSync(file, 'const a = 12345678;\n');
    // File timestamps have kernel-tick granularity; age the original so the
    // in-place overwrite below always yields a distinguishable mtime/ctime.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    await assert.rejects(
      () => readStableRepositoryFile('worker.js', {
        rootDir: repo,
        sourceLabel: 'Worker source',
        async readHandleImpl(handle) {
          fs.writeFileSync(file, 'const b = 87654321;\n');
          return handle.readFile({ encoding: 'utf8' });
        },
      }),
      /changed during read/,
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('#9509 unchanged source reads successfully without error', async () => {
  const repo = makeRoot('hex-9509-unchanged-');
  try {
    const file = path.join(repo, 'worker.js');
    const content = 'export const unchanged = true;\n';
    fs.writeFileSync(file, content);
    const read = await readStableRepositoryFile('worker.js', {
      rootDir: repo,
      sourceLabel: 'Worker source',
      encoding: 'utf8',
    });
    assert.equal(read, content);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
