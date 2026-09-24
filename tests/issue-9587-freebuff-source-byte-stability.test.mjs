import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyIfMissing } from '../scripts/freebuff-setup.mjs';

function fixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sourceRoot = path.join(root, 'legacy');
  const destinationRoot = path.join(root, 'dest');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(destinationRoot, { recursive: true });
  const src = path.join(sourceRoot, 'credentials.json');
  const dst = path.join(destinationRoot, 'credentials.json');
  return { root, sourceRoot, destinationRoot, src, dst };
}

function age(file) {
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
}

test('#9587 same-inode overwrite during migration fails closed before destination publication', () => {
  if (process.platform !== 'linux') return;
  const f = fixture('freebuff-9587-overwrite-');
  try {
    fs.writeFileSync(f.src, 'A'.repeat(1024 * 1024));
    age(f.src);
    let copies = 0;
    const fsImpl = {
      ...fs,
      copyFileSync(from, to, flags) {
        copies++;
        if (copies === 1) fs.writeFileSync(f.src, 'B'.repeat(1024 * 1024));
        return fs.copyFileSync(from, to, flags);
      },
    };
    assert.throws(
      () => copyIfMissing(f.src, f.dst, false, f.destinationRoot, { fsImpl, sourceRoot: f.sourceRoot }),
      /migration source changed during copy/,
    );
    assert.equal(fs.existsSync(f.dst), false, 'unstable source bytes must never be published to the persistent destination');
    assert.deepEqual(fs.readdirSync(f.destinationRoot), [], 'failed staged copy must be cleaned up');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('#9587 unchanged regular source still migrates byte-exactly', () => {
  if (process.platform !== 'linux') return;
  const f = fixture('freebuff-9587-stable-');
  try {
    const content = '{"stable":true}\n';
    fs.writeFileSync(f.src, content);
    assert.equal(copyIfMissing(f.src, f.dst, false, f.destinationRoot, { sourceRoot: f.sourceRoot }), true);
    assert.equal(fs.readFileSync(f.dst, 'utf8'), content);
    assert.equal(copyIfMissing(f.src, f.dst, false, f.destinationRoot, { sourceRoot: f.sourceRoot }), false, 'existing destination remains destination-wins');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('#9587 concurrent destination winner is preserved during staged publication', () => {
  if (process.platform !== 'linux') return;
  const f = fixture('freebuff-9587-winner-');
  try {
    fs.writeFileSync(f.src, 'A'.repeat(4096));
    let copies = 0;
    const fsImpl = {
      ...fs,
      copyFileSync(from, to, flags) {
        copies++;
        if (copies === 2) fs.writeFileSync(f.dst, 'CONCURRENT-WINNER\n', { mode: 0o600 });
        return fs.copyFileSync(from, to, flags);
      },
    };
    assert.equal(
      copyIfMissing(f.src, f.dst, false, f.destinationRoot, { fsImpl, sourceRoot: f.sourceRoot }),
      false,
      'a destination that appears before publication must win',
    );
    assert.equal(fs.readFileSync(f.dst, 'utf8'), 'CONCURRENT-WINNER\n');
    assert.deepEqual(fs.readdirSync(f.destinationRoot), ['credentials.json'], 'staged file must be cleaned without deleting the winner');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
