import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeFileVerified } from '../scripts/userscript-publication.mjs';

test('issue #9517: staged output cannot be replaced before publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'userscript-9517-'));
  const output = path.join(root, 'generated.js');

  const io = {
    ...fs,
    async readFile(p, ...args) {
      const bytes = await fs.readFile(p, ...args);
      if (String(p).endsWith('.stage')) {
        const attacker = `${p}.attacker`;
        await fs.writeFile(attacker, 'UNVERIFIED\n');
        await fs.rename(attacker, p); // replace the verified stage inode
      }
      return bytes;
    },
  };

  await assert.rejects(
    async () => {
      await writeFileVerified(output, Buffer.from('VERIFIED\n'), {
        io,
        containmentRoot: root,
      });
    },
    /userscript-publication-stage-identity-changed/,
  );

  // The output file should not exist or not have UNVERIFIED content
  let outputExists = false;
  try {
    await fs.lstat(output);
    outputExists = true;
  } catch {}
  assert.equal(outputExists, false, 'output file must not be published when stage identity changed');

  await fs.rm(root, { recursive: true, force: true });
});
