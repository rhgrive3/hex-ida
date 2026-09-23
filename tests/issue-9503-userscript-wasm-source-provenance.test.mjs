import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readStableRepositoryFile } from '../scripts/stable-repository-source.mjs';

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9503-')); }

for (const relative of [false, true]) {
  test(`#9503 rejects ${relative ? 'relative' : 'absolute'} external capstone symlink`, async () => {
    if (process.platform === 'win32') return;
    const repo = root(); const outside = root();
    try {
      const external = path.join(outside, 'external.wasm'); fs.writeFileSync(external, Buffer.from([0,97,115,109,1,0,0,0]));
      fs.symlinkSync(relative ? path.relative(repo, external) : external, path.join(repo, 'capstone.wasm'));
      await assert.rejects(() => readStableRepositoryFile('capstone.wasm', { rootDir:repo, sourceLabel:'Capstone WASM source' }), /escapes repository/);
    } finally { fs.rmSync(repo,{recursive:true,force:true}); fs.rmSync(outside,{recursive:true,force:true}); }
  });
}

test('#9503 rejects source identity replacement after validation', async () => {
  const repo = root();
  try {
    const wasm = path.join(repo, 'capstone.wasm');
    fs.writeFileSync(wasm, Buffer.from([0,97,115,109,1,0,0,0]));
    await assert.rejects(() => readStableRepositoryFile('capstone.wasm', {
      rootDir:repo, sourceLabel:'Capstone WASM source',
      async statImpl(target) {
        const info = await fsp.stat(target);
        fs.renameSync(target, `${target}.reviewed`);
        fs.writeFileSync(target, Buffer.from([9,9,9,9]));
        return info;
      },
    }), /identity changed before read/);
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
});

test('#9503 stable contained regular capstone bytes are read byte-exactly', async () => {
  const repo = root();
  try {
    const bytes = Buffer.from([0,97,115,109,1,0,0,0]);
    fs.writeFileSync(path.join(repo, 'capstone.wasm'), bytes);
    const actual = await readStableRepositoryFile('capstone.wasm', { rootDir:repo, sourceLabel:'Capstone WASM source' });
    assert.deepEqual(actual, bytes);
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
});

test('#9503 non-regular capstone source fails closed', async () => {
  const repo = root();
  try {
    fs.mkdirSync(path.join(repo, 'capstone.wasm'));
    await assert.rejects(() => readStableRepositoryFile('capstone.wasm', { rootDir:repo, sourceLabel:'Capstone WASM source' }), /not a regular file/);
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
});
