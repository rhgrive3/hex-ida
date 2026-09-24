import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bundle } from '../scripts/build-userscript.mjs';

function installLoader(plugin) {
  let load = null;
  plugin.setup({
    onLoad(_options, callback) {
      load = callback;
    },
  });
  assert.equal(typeof load, 'function');
  return load;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('#9569 standard graph authorizes captured source, not a later allowed replacement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9569-standard-'));
  const privileged = path.join(root, 'js/auth/admin-app.js');
  const alias = path.join(root, 'js/public/alias.js');
  fs.mkdirSync(path.dirname(privileged), { recursive: true });
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.writeFileSync(privileged, "globalThis.BUNDLED_SENTINEL = 'forbidden-old';\n");
  fs.symlinkSync('../auth/admin-app.js', alias);

  let loadedBytes = null;
  const buildImpl = async (options) => {
    const load = installLoader(options.plugins[0]);
    const loaded = await load({ path: alias, namespace: 'file' });
    loadedBytes = Buffer.from(loaded.contents);

    fs.unlinkSync(alias);
    fs.writeFileSync(alias, "globalThis.BUNDLED_SENTINEL = 'allowed-new';\n");

    return {
      metafile: { inputs: { 'js/public/alias.js': {} } },
      outputFiles: [{ contents: loadedBytes }],
    };
  };

  try {
    await assert.rejects(
      () => bundle('js/public/alias.js', { graph: 'standard', rootDir: root, buildImpl }),
      /leaks privileged implementation.*alias\.js -> js\/auth\/admin-app\.js/,
    );
    assert.match(loadedBytes.toString('utf8'), /forbidden-old/);
    assert.match(fs.readFileSync(alias, 'utf8'), /allowed-new/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9569 same-size post-load mutation cannot change bytes already handed to esbuild', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9569-mutate-'));
  const entry = path.join(root, 'js/public/input.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  const oldSource = "export const marker = 'AAAAAAAA';\n";
  const newSource = "export const marker = 'BBBBBBBB';\n";
  assert.equal(Buffer.byteLength(oldSource), Buffer.byteLength(newSource));
  fs.writeFileSync(entry, oldSource);

  let capturedDigest = null;
  const buildImpl = async (options) => {
    const load = installLoader(options.plugins[0]);
    const loaded = await load({ path: entry, namespace: 'file' });
    const bundled = Buffer.from(loaded.contents);
    capturedDigest = digest(bundled);

    const fd = fs.openSync(entry, 'r+');
    try {
      fs.writeFileSync(fd, newSource);
    } finally {
      fs.closeSync(fd);
    }

    return {
      metafile: { inputs: { 'js/public/input.js': {} } },
      outputFiles: [{ contents: bundled }],
    };
  };

  try {
    const output = await bundle('js/public/input.js', { graph: 'standard', rootDir: root, buildImpl });
    assert.equal(output.toString('utf8'), oldSource);
    assert.equal(capturedDigest, digest(oldSource));
    assert.equal(fs.readFileSync(entry, 'utf8'), newSource);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9569 every metafile input must have captured bundled-source provenance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9569-missing-'));
  const entry = path.join(root, 'js/public/input.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'export const ok = true;\n');

  try {
    await assert.rejects(
      () => bundle('js/public/input.js', {
        graph: 'standard',
        rootDir: root,
        buildImpl: async () => ({
          metafile: { inputs: { 'js/public/input.js': {} } },
          outputFiles: [{ contents: Buffer.from('export const ok=true;') }],
        }),
      }),
      /cannot establish bundled source provenance/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9569 privileged parent graph consumes captured stable bytes for every required source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9569-privileged-'));
  const required = [
    'js/userscript/dev/parent-worker-runtime.js',
    'js/userscript/dev/parent-rpc.js',
    'js/userscript/dev/bootstrap-host.js',
  ];
  for (const rel of required) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `export const marker = ${JSON.stringify(rel)};\n`);
  }

  const buildImpl = async (options) => {
    const load = installLoader(options.plugins[0]);
    const loaded = [];
    for (const rel of required) {
      loaded.push(await load({ path: path.join(root, rel), namespace: 'file' }));
    }
    const first = path.join(root, required[0]);
    const before = fs.readFileSync(first);
    const replacement = Buffer.from(before);
    replacement[replacement.length - 2] = replacement[replacement.length - 2] === 65 ? 66 : 65;
    fs.writeFileSync(first, replacement);
    return {
      metafile: { inputs: Object.fromEntries(required.map((rel) => [rel, {}])) },
      outputFiles: [{ contents: Buffer.from(loaded[0].contents) }],
    };
  };

  try {
    const output = await bundle(required[0], { graph: 'parent', rootDir: root, buildImpl });
    assert.match(output.toString('utf8'), /parent-worker-runtime/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
