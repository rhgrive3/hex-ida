// Builds real aarch64 C++ ELF fixtures for the C++ recovery suites.
//
// Nothing is committed as binary: the fixtures are produced at test time from
// `game.cpp` + `abi-stubs.cpp` with clang/ld.lld into the OS temp directory,
// exactly like tests/compiler-truth builds its aarch64 inputs. When the
// toolchain is not available the caller gets `{ available:false, reason }` and
// can skip instead of silently substituting a hand-written binary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = 'aarch64-unknown-linux-gnu';

// Built binaries are never written into the repository. A build output inside
// the tree would need a `.gitignore` entry, and `.gitignore` is outside this
// lane's ownership, so the fixtures are rebuilt into the OS temp directory on
// every run instead.
export const CXX_FIXTURE_OUT_DIR = path.join(os.tmpdir(), 'hex-cxx-fixtures');

// name -> { optimize, rtti }
export const CXX_FIXTURES = Object.freeze({
  'game-rtti-o2': { optimize: '-O2', rtti: true },
  'game-rtti-o0': { optimize: '-O0', rtti: true },
  'game-nortti-o2': { optimize: '-O2', rtti: false },
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) return { ok: false, reason: String(result.error.message || result.error) };
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 4).join(' ').slice(0, 400);
    return { ok: false, reason: `${command} exited ${result.status}: ${detail}` };
  }
  return { ok: true, stdout: result.stdout || '' };
}

export function cxxToolchainAvailable() {
  const clang = process.env.CLANGXX || 'clang++';
  const found = run(clang, ['--version']);
  if (!found.ok) return { available: false, reason: `clang++ unavailable: ${found.reason}` };
  const lld = process.env.LD_LLD || 'ld.lld';
  const lldFound = run(lld, ['--version']);
  if (!lldFound.ok) return { available: false, reason: `ld.lld unavailable: ${lldFound.reason}` };
  return { available: true, clang, lld };
}

/**
 * Builds every fixture into `outDir`. Returns a map of name -> { bytes, path }.
 */
export function buildCxxFixtures({ outDir = CXX_FIXTURE_OUT_DIR } = {}) {
  const toolchain = cxxToolchainAvailable();
  if (!toolchain.available) return { available: false, reason: toolchain.reason, artifacts: {} };

  fs.mkdirSync(outDir, { recursive: true });
  const sources = [path.join(HERE, 'game.cpp'), path.join(HERE, 'abi-stubs.cpp')];
  const artifacts = {};

  for (const [name, spec] of Object.entries(CXX_FIXTURES)) {
    const elfPath = path.join(outDir, `${name}.elf`);
    const objects = [];
    for (const source of sources) {
      const object = path.join(outDir, `${name}-${path.basename(source, '.cpp')}.o`);
      const args = [
        `--target=${TARGET}`,
        spec.optimize,
        '-fno-exceptions',
        '-fno-unwind-tables',
        '-fno-asynchronous-unwind-tables',
        '-ffreestanding',
        ...(spec.rtti ? [] : ['-fno-rtti']),
        '-c',
        source,
        '-o',
        object,
      ];
      const built = run(toolchain.clang, args);
      if (!built.ok) return { available: false, reason: `compile failed for ${name}: ${built.reason}`, artifacts: {} };
      objects.push(object);
    }
    const linked = run(toolchain.lld, ['-static', '-e', '_start', '--build-id=none', '-o', elfPath, ...objects]);
    if (!linked.ok) return { available: false, reason: `link failed for ${name}: ${linked.reason}`, artifacts: {} };
    artifacts[name] = { path: elfPath, bytes: fs.readFileSync(elfPath) };
  }
  return { available: true, reason: null, artifacts };
}

export function readCxxFixture(name, options = {}) {
  const built = buildCxxFixtures(options);
  if (!built.available) throw new Error(`cxx fixture unavailable: ${built.reason}`);
  const artifact = built.artifacts[name];
  if (!artifact) throw new Error(`unknown cxx fixture: ${name}`);
  return artifact.bytes;
}
