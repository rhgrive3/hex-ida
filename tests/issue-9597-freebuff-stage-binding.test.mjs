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

function stageLeaf(root) {
  return fs.readdirSync(root).find((name) => name.includes('.migration-')) || null;
}

test('#9597 staged leaf replacement is rejected and the substitute is not deleted', () => {
  if (process.platform !== 'linux') return;
  const f = fixture('freebuff-9597-replace-');
  try {
    fs.writeFileSync(f.src, 'GOOD');
    let copies = 0;
    const fsImpl = {
      ...fs,
      copyFileSync(from, to, flags) {
        copies++;
        const result = fs.copyFileSync(from, to, flags);
        if (copies === 1) {
          const leaf = stageLeaf(f.destinationRoot);
          assert.ok(leaf, 'owned stage must exist during the first copy');
          const stage = path.join(f.destinationRoot, leaf);
          const replacement = `${stage}.attacker`;
          fs.writeFileSync(replacement, 'BAD!');
          fs.renameSync(replacement, stage);
        }
        return result;
      },
    };
    assert.throws(
      () => copyIfMissing(f.src, f.dst, false, f.destinationRoot, { fsImpl, sourceRoot: f.sourceRoot }),
      /staged migration copy changed before publication/,
    );
    assert.equal(fs.existsSync(f.dst), false);
    const remaining = fs.readdirSync(f.destinationRoot);
    assert.equal(remaining.length, 1, 'cleanup must not unlink a substituted stage leaf');
    assert.equal(fs.readFileSync(path.join(f.destinationRoot, remaining[0]), 'utf8'), 'BAD!');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('#9597 same-inode stage mutation cannot be published', () => {
  if (process.platform !== 'linux') return;
  const f = fixture('freebuff-9597-inplace-');
  try {
    fs.writeFileSync(f.src, 'GOOD');
    let copies = 0;
    const fsImpl = {
      ...fs,
      copyFileSync(from, to, flags) {
        copies++;
        const result = fs.copyFileSync(from, to, flags);
        if (copies === 1) {
          const leaf = stageLeaf(f.destinationRoot);
          assert.ok(leaf);
          fs.writeFileSync(path.join(f.destinationRoot, leaf), 'BAD!');
        }
        return result;
      },
    };
    assert.throws(
      () => copyIfMissing(f.src, f.dst, false, f.destinationRoot, { fsImpl, sourceRoot: f.sourceRoot }),
      /staged migration bytes do not match stable source/,
    );
    assert.equal(fs.existsSync(f.dst), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('#9597 unchanged stage publishes and concurrent destination still wins', () => {
  if (process.platform !== 'linux') return;
  const f = fixture('freebuff-9597-normal-');
  try {
    fs.writeFileSync(f.src, 'GOOD');
    assert.equal(copyIfMissing(f.src, f.dst, false, f.destinationRoot, { sourceRoot: f.sourceRoot }), true);
    assert.equal(fs.readFileSync(f.dst, 'utf8'), 'GOOD');
    assert.equal(copyIfMissing(f.src, f.dst, false, f.destinationRoot, { sourceRoot: f.sourceRoot }), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
