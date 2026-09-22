import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verify } from '../scripts/fetch-real-fixtures.mjs';

test('fixture verification rejects a symlink leaf even when target bytes are pinned-valid', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9406-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9406-outside-'));
  try {
    const bytes = Buffer.from('pinned-fixture-bytes\n');
    const external = path.join(outside, 'fixture.bin');
    const leaf = path.join(root, 'fixture.bin');
    fs.writeFileSync(external, bytes);
    fs.symlinkSync(external, leaf);
    const spec = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

    await assert.rejects(
      () => verify('fixture', leaf, spec),
      /must not be a symbolic link/,
    );
    assert.equal(fs.readFileSync(external).equals(bytes), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('fixture verification still accepts a regular pinned-valid file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9406-regular-'));
  try {
    const bytes = Buffer.from('regular-fixture\n');
    const leaf = path.join(root, 'fixture.bin');
    fs.writeFileSync(leaf, bytes);
    const spec = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const result = await verify('fixture', leaf, spec);
    assert.equal(result.size, bytes.length);
    assert.equal(result.sha256, spec.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
