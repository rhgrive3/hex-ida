import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const OUTPUT = process.argv[2] || 'x02-a08-provenance.json';
const SOURCE = [
  '#include <stdint.h>',
  '__attribute__((noinline)) static uint64_t mix(uint64_t x) { return (x * 0x9e3779b185ebca87ULL) ^ (x >> 7); }',
  'int main(int argc, char **argv) { (void)argv; return mix((uint64_t)argc) ? 0 : 7; }',
  '',
].join('\n');

function command(file, args = [], options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  }).trim();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(file) {
  return sha256(await readFile(file));
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label}:${result.status}:${(result.stderr || '').slice(0, 1200)}`);
  }
}

const dir = await mkdtemp(path.join(tmpdir(), 'hex-x02-a08-'));
const sourcePath = path.join(dir, 'probe.c');
const objectPath = path.join(dir, 'probe.o');
const executablePath = path.join(dir, 'probe');
await writeFile(sourcePath, SOURCE);

const compileObjectArgs = ['--sdk', 'macosx', 'clang', '-arch', 'arm64', '-O2', '-c', sourcePath, '-o', objectPath];
const compileExecutableArgs = ['--sdk', 'macosx', 'clang', '-arch', 'arm64', '-O2', sourcePath, '-o', executablePath];
const objectCompile = spawnSync('xcrun', compileObjectArgs, { encoding: 'utf8', timeout: 60_000 });
requireSuccess(objectCompile, 'compile-object');
const executableCompile = spawnSync('xcrun', compileExecutableArgs, { encoding: 'utf8', timeout: 60_000 });
requireSuccess(executableCompile, 'compile-executable');
const runtime = spawnSync(executablePath, [], { encoding: 'utf8', timeout: 15_000 });
requireSuccess(runtime, 'execute-probe');

const objectBytes = await readFile(objectPath);
const executableBytes = await readFile(executablePath);
const objectOtool = command('otool', ['-l', objectPath]);
const executableOtool = command('otool', ['-l', executablePath]);

const evidence = {
  schema: 'hex-x02-a08-provenance-point/v1',
  runner: {
    requestedLabel: process.env.X02_RUNNER_LABEL || null,
    runnerOs: process.env.RUNNER_OS || null,
    runnerArch: process.env.RUNNER_ARCH || null,
    imageOs: process.env.ImageOS || null,
    imageVersion: process.env.ImageVersion || null,
  },
  appleEnvironment: {
    osProductVersion: command('sw_vers', ['-productVersion']),
    osBuildVersion: command('sw_vers', ['-buildVersion']),
    darwinRelease: command('uname', ['-r']),
    machine: command('uname', ['-m']),
    xcodeVersion: command('xcodebuild', ['-version']),
    clangVersion: command('xcrun', ['--sdk', 'macosx', 'clang', '--version']),
    sdkVersion: command('xcrun', ['--sdk', 'macosx', '--show-sdk-version']),
    developerDir: command('xcode-select', ['-p']),
    pointerAuthenticationFeature: command('sysctl', ['-n', 'hw.optional.arm.FEAT_PAuth']),
  },
  source: {
    language: 'c',
    sha256: sha256(Buffer.from(SOURCE)),
    byteLength: Buffer.byteLength(SOURCE),
  },
  compilerProducedArtifacts: {
    object: {
      sha256: sha256(objectBytes),
      byteLength: objectBytes.byteLength,
      file: command('file', [objectPath]),
      loadCommandsSha256: sha256(Buffer.from(objectOtool)),
    },
    executable: {
      sha256: sha256(executableBytes),
      byteLength: executableBytes.byteLength,
      file: command('file', [executablePath]),
      loadCommandsSha256: sha256(Buffer.from(executableOtool)),
    },
    compileObjectArgs: compileObjectArgs.slice(2).map((arg) => arg === sourcePath ? '<source>' : arg === objectPath ? '<object>' : arg),
    compileExecutableArgs: compileExecutableArgs.slice(2).map((arg) => arg === sourcePath ? '<source>' : arg === executablePath ? '<executable>' : arg),
  },
  runtimeObservation: {
    executedOnCapturedOs: true,
    exitStatus: runtime.status,
    signal: runtime.signal,
  },
};

if (evidence.appleEnvironment.machine !== 'arm64') throw new Error(`unexpected-machine:${evidence.appleEnvironment.machine}`);
if (evidence.runner.runnerArch && evidence.runner.runnerArch !== 'ARM64') throw new Error(`unexpected-runner-arch:${evidence.runner.runnerArch}`);
if (!/Mach-O/i.test(evidence.compilerProducedArtifacts.object.file) || !/arm64/i.test(evidence.compilerProducedArtifacts.object.file)) throw new Error('object-not-arm64-macho');
if (!/Mach-O/i.test(evidence.compilerProducedArtifacts.executable.file) || !/arm64/i.test(evidence.compilerProducedArtifacts.executable.file)) throw new Error('executable-not-arm64-macho');
if (evidence.runtimeObservation.exitStatus !== 0) throw new Error('runtime-probe-failed');

await writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
