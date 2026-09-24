import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveIfMissing } from '../scripts/freebuff-setup.mjs';

test('#9560 substituted shared migration source is never promoted', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9560-src-'));
  const dstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9560-dst-'));
  const src = path.join(sourceRoot, 'message-history.json');
  const parked = path.join(sourceRoot, 'message-history.validated.json');
  const replacement = path.join(sourceRoot, 'replacement.json');
  const dst = path.join(dstRoot, 'history', 'message-history.json');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(src, 'EXPECTED');
  fs.writeFileSync(replacement, 'SUBSTITUTED');

  let attacked = false;
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => {
    if (!attacked && path.basename(String(from)) === path.basename(src)) {
      attacked = true;
      fs.renameSync(src, parked);
      fs.renameSync(replacement, src);
    }
    return fs.renameSync(from, to);
  };

  try {
    assert.throws(
      () => moveIfMissing(src, dst, dstRoot, { fsImpl }),
      /migration source identity changed/,
    );
    assert.equal(attacked, true);
    assert.equal(fs.existsSync(dst), false, 'replacement must not reach persistent destination');
    assert.equal(fs.readFileSync(parked, 'utf8'), 'EXPECTED');
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(dstRoot, { recursive: true, force: true });
  }
});
