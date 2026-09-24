import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishUserscriptFiles, writeFileVerified } from '../scripts/userscript-publication.mjs';

function mutatingIo(matchBase, badBytes) {
  let stageReadBack = false;
  let beforeMutation = null;
  let afterMutation = null;
  return {
    io: {
      ...fs,
      async readFile(file, ...args) {
        const bytes = await fs.readFile(file, ...args);
        if (String(file).endsWith('.stage') && path.basename(String(file)).startsWith(`${matchBase}.`)) stageReadBack = true;
        return bytes;
      },
      async lstat(file, ...args) {
        const before = await fs.lstat(file, ...args);
        if (stageReadBack && String(file).endsWith('.stage') && path.basename(String(file)).startsWith(`${matchBase}.`)) {
          beforeMutation = before;
          await fs.writeFile(file, badBytes);
          afterMutation = await fs.lstat(file);
          stageReadBack = false;
        }
        return before;
      },
    },
    mutationIdentity() { return { before:beforeMutation, after:afterMutation }; },
  };
}

test('#9611 single-file same-inode overwrite after readback is rejected before publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'userscript-9611-single-'));
  try {
    const output = path.join(root, 'generated.js');
    const expected = Buffer.from('VERIFIED\n');
    const bad = Buffer.from('BADBYTES\n');
    const injected = mutatingIo('generated.js', bad);
    await assert.rejects(
      () => writeFileVerified(output, expected, { io:injected.io, containmentRoot:root }),
      /userscript-publication-stage-(?:contents|identity)-changed/,
    );
    await assert.rejects(fs.lstat(output), { code:'ENOENT' });
    const { before, after } = injected.mutationIdentity();
    assert.equal(String(before.dev), String(after.dev));
    assert.equal(String(before.ino), String(after.ino));
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});

for (const index of [0, 1]) {
  test(`#9611 pair publication rejects mutated stage ${index + 1} and preserves originals`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `userscript-9611-pair-${index}-`));
    try {
      const names = ['loader.js', 'release.js'];
      const entries = [];
      for (const [i, name] of names.entries()) {
        const file = path.join(root, name);
        const old = Buffer.from(`OLD-${i}-000`);
        const content = Buffer.from(`NEW-${i}-000`);
        await fs.writeFile(file, old);
        entries.push({ path:file, expected:old, content });
      }
      const bad = Buffer.from(`BAD-${index}-000`);
      const injected = mutatingIo(names[index], bad);
      await assert.rejects(
        () => publishUserscriptFiles(entries, { io:injected.io, containmentRoot:root }),
        /userscript-publication-stage-(?:contents|identity)-changed/,
      );
      for (const entry of entries) assert.deepEqual(await fs.readFile(entry.path), entry.expected);
    } finally { await fs.rm(root, { recursive:true, force:true }); }
  });
}

test('#9611 unchanged staged bytes still publish normally', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'userscript-9611-ok-'));
  try {
    const output = path.join(root, 'generated.js');
    const bytes = Buffer.from('VERIFIED\n');
    await writeFileVerified(output, bytes, { containmentRoot:root });
    assert.deepEqual(await fs.readFile(output), bytes);
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});
