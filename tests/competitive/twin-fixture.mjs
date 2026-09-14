import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE_TEXT = `#include <stdint.h>
__attribute__((noinline)) int32_t twin_add(int32_t left, int32_t right) {
  return left + right + 7;
}
int main(void) { return twin_add(20, 22) == 49 ? 0 : 1; }
`;

function executable(candidates) {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error(`required native tool unavailable: ${candidates.join(', ')}`);
}

function versionOf(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`native tool version probe failed: ${command}`);
  }
  return String(result.stdout || '').split(/\r?\n/, 1)[0].trim();
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', SOURCE_DATE_EPOCH: '0' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`native command failed (${result.status}): ${command} ${args.join(' ')}\n${result.stderr || ''}`);
  }
  return result;
}

function sha256(file) {
  const result = spawnSync('sha256sum', [file], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`sha256sum failed: ${file}`);
  return result.stdout.trim().split(/\s+/, 1)[0];
}

function buildId(file) {
  const result = run('readelf', ['-n', file]);
  return result.stdout.match(/Build ID:\s*([0-9a-f]+)/i)?.[1] ?? null;
}

function linkerVersion() {
  const result = spawnSync('ld', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('native linker version probe failed: ld');
  return String(result.stdout || '').split(/\r?\n/, 1)[0].trim();
}

function textOffset(file) {
  const result = run('readelf', ['-SW', file]);
  // GNU binutils and LLVM readelf both print the section offset after the
  // virtual address. Keep the fallback deterministic for another ELF reader.
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/\]\s+\.text\s+\S+\s+\S+\s+([0-9a-f]+)\s+/i);
    if (match) return Number.parseInt(match[1], 16);
  }
  return Math.max(0, Math.floor(fs.statSync(file).size / 2));
}

export function patchOneByte(input, output) {
  const bytes = fs.readFileSync(input);
  const offset = textOffset(input);
  assert.ok(offset >= 0 && offset < bytes.length, `text patch offset is outside ${input}`);
  const patched = Buffer.from(bytes);
  patched[offset] ^= 0x01;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, patched);
  return Object.freeze({ path: output, offset, digest: sha256(output) });
}

export function copyArtifact(input, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(input, output);
  return Object.freeze({ path: output, digest: sha256(output) });
}

export function stripDebug(input, output, tool = executable(['strip', 'llvm-strip'])) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(input, output);
  run(tool, ['--strip-debug', '--', output], path.dirname(output));
  return Object.freeze({ path: output, digest: sha256(output), operation: 'strip-debug' });
}

function compile({ compiler, source, output, cwd, optimization = 'O0' }) {
  run(compiler, [
    '-g',
    `-${optimization}`,
    '-fno-omit-frame-pointer',
    '-Wl,--build-id=uuid',
    source,
    '-o',
    output,
  ], cwd);
  return Object.freeze({
    path: output,
    digest: sha256(output),
    buildId: buildId(output),
    optimization,
  });
}

/**
 * Build one real debug-bearing ELF fixture and all negative controls from it.
 * The test suite deliberately fails when the compiler/strip tools are absent;
 * missing native evidence must not become a green skipped lane.
 */
export function buildTwinFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-c0-twin-'));
  const compiler = executable(['clang', 'cc']);
  const stripTool = executable(['strip', 'llvm-strip']);
  const compilerVersion = versionOf(compiler);
  const stripToolVersion = versionOf(stripTool);
  const source = path.join(root, 'fixture.c');
  fs.writeFileSync(source, SOURCE_TEXT);
  const debug = compile({ compiler, source, output: path.join(root, 'debug.elf'), cwd: root });

  // --build-id=uuid makes a same-source rebuild a distinct artifact/lineage
  // while preserving the compiler, target, and optimization context.
  const rebuilt = compile({ compiler, source, output: path.join(root, 'rebuilt.elf'), cwd: root });
  assert.notEqual(debug.digest, rebuilt.digest, 'same-source rebuild must be a distinct fixture');

  const driftSource = path.join(root, 'drift.c');
  fs.writeFileSync(driftSource, `${SOURCE_TEXT}\n/* source drift */\n`);
  const sourceDrift = compile({ compiler, source: driftSource, output: path.join(root, 'source-drift.elf'), cwd: root });
  const optimized = compile({ compiler, source, output: path.join(root, 'optimized.elf'), cwd: root, optimization: 'O2' });

  const context = Object.freeze({
    corpusId: 'fr-c0-real-tiny-c',
    corpusVersion: 1,
    sourceIdentity: { id: 'fr-c0-tiny-c-fixture', sha256: sha256(source) },
    compiler: { id: path.basename(compiler), version: compilerVersion },
    targetTriple: 'x86_64-unknown-linux-gnu',
    architecture: { id: 'x86_64', profile: 'long-64' },
    profile: 'x86_64-debug-o0',
    compileArgs: ['-g', '-O0', '-fno-omit-frame-pointer', '-Wl,--build-id=uuid'],
    compileOptions: { debug: true, optimization: 'O0', target: 'x86_64-unknown-linux-gnu' },
    linker: { id: 'ld', version: linkerVersion(), options: { buildId: 'uuid' } },
    buildIdentity: debug.buildId,
    stripTool: { id: path.basename(stripTool), version: stripToolVersion },
    stripArgv: ['--strip-debug'],
    stripConfig: { mode: 'debug-only', inPlace: true },
  });

  const copiedDebug = copyArtifact(debug.path, path.join(root, 'copies', 'nested', 'debug-copy.elf'));
  const copiedDebugOtherPath = copyArtifact(debug.path, path.join(root, 'other-location', 'debug-copy.elf'));
  const stripped = stripDebug(debug.path, path.join(root, 'twins', 'stripped.elf'), stripTool);
  const rebuiltStripped = stripDebug(rebuilt.path, path.join(root, 'wrong-lineage.stripped.elf'), stripTool);
  const optimizedStripped = stripDebug(optimized.path, path.join(root, 'wrong-optimization.stripped.elf'), stripTool);
  const sourceDriftStripped = stripDebug(sourceDrift.path, path.join(root, 'wrong-source.stripped.elf'), stripTool);
  const patchedDebug = patchOneByte(debug.path, path.join(root, 'patched-debug.elf'));
  const patchedStripped = patchOneByte(stripped.path, path.join(root, 'patched-stripped.elf'));

  return Object.freeze({
    root,
    source,
    sourceText: SOURCE_TEXT,
    compiler,
    compilerVersion,
    stripTool,
    stripToolVersion,
    context,
    debug,
    rebuilt,
    sourceDrift,
    optimized,
    copiedDebug,
    copiedDebugOtherPath,
    stripped,
    rebuiltStripped,
    optimizedStripped,
    sourceDriftStripped,
    patchedDebug,
    patchedStripped,
  });
}

export function removeTwinFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}
