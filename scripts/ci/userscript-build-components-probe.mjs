import { build, transform } from 'esbuild';
import { createCipheriv, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { resolveUserscriptReleaseVersion } from '../userscript-release-version.mjs';
import { parseImportScriptsArguments } from '../userscript-classic-imports.mjs';

const root = resolve(new URL('../../', import.meta.url).pathname);
const test = process.argv[2];

async function bundle(entry, format = 'iife') {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format,
    platform: 'browser',
    target: ['safari17.4'],
    charset: 'utf8',
    legalComments: 'none',
    minify: true,
    sourcemap: false,
  });
  if (!result.outputFiles?.[0]?.contents) throw new Error(`no output: ${entry}`);
}

async function collectClassic(path, sources) {
  path = posix.normalize(path).replace(/^\.\//, '');
  if (sources.has(path)) return;
  const source = await readFile(resolve(root, path), 'utf8');
  sources.set(path, source);
  for (const call of source.matchAll(/\bimportScripts\s*\(([^;]*?)\)\s*;/gs)) {
    for (const specifier of parseImportScriptsArguments(call[1], path)) {
      await collectClassic(posix.normalize(posix.join(posix.dirname(path), specifier)), sources);
    }
  }
}

function inlineClassic(path, sources, stack = []) {
  if (stack.includes(path)) throw new Error(`cycle: ${[...stack, path].join(' -> ')}`);
  const source = sources.get(path);
  if (source == null) throw new Error(`missing source: ${path}`);
  return source.replace(/\bimportScripts\s*\(([^;]*?)\)\s*;/gs, (_all, args) =>
    parseImportScriptsArguments(args, path)
      .map((specifier) => posix.normalize(posix.join(posix.dirname(path), specifier)))
      .map((dep) => inlineClassic(dep, sources, [...stack, path]))
      .join('\n'));
}

switch (test) {
  case 'crypto': {
    const key = randomBytes(32), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('probe'));
    Buffer.concat([cipher.update(gzipSync(Buffer.from('probe'))), cipher.final(), cipher.getAuthTag()]);
    break;
  }
  case 'css': {
    const result = await build({
      absWorkingDir: root,
      stdin: { contents: '@import "./css/app.css";\n@import "./css/ux.css";', resolveDir: root, loader: 'css' },
      bundle: true,
      write: false,
      minify: true,
      sourcemap: false,
      legalComments: 'none',
      target: ['safari17.4'],
    });
    if (!result.outputFiles?.[0]) throw new Error('no css output');
    break;
  }
  case 'runtime':
    await bundle('js/userscript/protected-entry.js', 'esm');
    break;
  case 'loader':
    await bundle('js/userscript/loader.js', 'iife');
    break;
  case 'module-workers':
    await bundle('js/platform/worker.js', 'iife');
    await bundle('js/symbolic/solver/worker-entry.js', 'esm');
    break;
  case 'classic-workers': {
    const entries = ['js/worker.js', 'js/platform/capstone-probe-worker.js', 'js/platform/capstone-disasm-worker.js'];
    const sources = new Map();
    for (const entry of entries) await collectClassic(entry, sources);
    for (const entry of entries) {
      await transform(inlineClassic(entry, sources), { loader: 'js', target: 'safari17.4', minify: true, legalComments: 'none', sourcemap: false });
    }
    break;
  }
  case 'wasm': {
    const wasm = await readFile(resolve(root, 'capstone.wasm'));
    if (wasm.length === 0) throw new Error('empty capstone.wasm');
    break;
  }
  case 'release-version': {
    const previous = JSON.parse(await readFile(resolve(root, 'userscript/release-version.json'), 'utf8'));
    resolveUserscriptReleaseVersion(previous, { releaseIdentity: 'a'.repeat(64), buildId: 'b'.repeat(24) });
    break;
  }
  default:
    throw new Error(`unknown probe: ${test}`);
}

console.log(`userscript component ${test}: PASS`);
