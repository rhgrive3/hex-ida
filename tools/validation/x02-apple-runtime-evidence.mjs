import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { open, stat, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { ByteView } from '../../js/binary/reader.js';
import { parseSlideInfo5Structure, walkSlideInfo5Source } from '../../js/binary/dyld-shared-cache-slide-v5.js';

const OUTPUT = process.argv[2] || 'x02-apple-runtime-evidence.json';
const CACHE_CANDIDATES = [
  '/System/Library/dyld/dyld_shared_cache_arm64e',
  '/System/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64e',
  '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64e',
];

function command(file, args = []) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }).trim();
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function readExactly(handle, offset, length) {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, Number(offset));
  if (bytesRead !== length) throw new Error(`short-read:${offset}:${length}:${bytesRead}`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readSlideMapping(view, offset) {
  return {
    address: view.u64(offset),
    size: view.u64(offset + 8),
    fileOffset: view.u64(offset + 16),
    slideInfoFileOffset: view.u64(offset + 24),
    slideInfoFileSize: view.u64(offset + 32),
    flags: view.u64(offset + 40),
    maxProt: view.u32(offset + 48),
    initProt: view.u32(offset + 52),
  };
}

function hex(value) { return `0x${value.toString(16)}`; }

function choosePages(starts) {
  const candidates = [];
  for (let i = 0; i < starts.length; i++) if (starts[i] !== 0xffff) candidates.push(i);
  if (!candidates.length) throw new Error('real-v5-cache-has-no-rebase-pages');
  const positions = [0, Math.floor((candidates.length - 1) / 3), Math.floor((candidates.length - 1) * 2 / 3), candidates.length - 1];
  return [...new Set(positions.map((i) => candidates[i]))];
}

function runPacProbe(arch) {
  const dir = path.join(os.tmpdir(), `hex-x02-pac-${arch}-${process.pid}`);
  command('/bin/mkdir', ['-p', dir]);
  const source = path.join(dir, 'probe.c');
  const binary = path.join(dir, 'probe');
  const sourceText = '#include <stdint.h>\n__attribute__((noinline)) static uintptr_t leaf(uintptr_t x){return (x*33u)^0x5au;}\n__attribute__((noinline)) static uintptr_t caller(uintptr_t x){return leaf(x)+1u;}\nint main(int argc,char**argv){(void)argv;uintptr_t x=(uintptr_t)argc;return caller(x)==(((x*33u)^0x5au)+1u)?0:3;}\n';
  execFileSync('/usr/bin/python3', ['-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])', source, sourceText], { timeout: 10_000 });
  const compile = spawnSync('xcrun', ['clang', '-arch', arch, '-O1', '-fno-omit-frame-pointer', '-msign-return-address=all', source, '-o', binary], { encoding: 'utf8', timeout: 30_000 });
  if (compile.status !== 0) return { architectureRequested: arch, compileExit: compile.status, compileError: (compile.stderr || '').slice(0, 1000) };
  spawnSync('codesign', ['--force', '--sign', '-', binary], { encoding: 'utf8', timeout: 20_000 });
  const disassembly = command('otool', ['-tvV', binary]);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
  return {
    architectureRequested: arch,
    compileExit: compile.status,
    runExit: run.status,
    signal: run.signal,
    pacInstructionObserved: /\bpac(?:i|d|ib|ia|da|db|ga)/i.test(disassembly),
    authenticationInstructionObserved: /\b(?:auti|autd|retaa|retab)/i.test(disassembly),
  };
}

const cachePath = CACHE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!cachePath) throw new Error('real-apple-dyld-cache-not-found');

const cacheStat = await stat(cachePath);
const handle = await open(cachePath, 'r');
try {
  const headerBytes = await readExactly(handle, 0n, 0x200);
  const header = new ByteView(headerBytes, { littleEndian: true });
  const slideTableOffset = header.u32(0x138);
  const slideCount = header.u32(0x13c);
  const sharedRegionStart = header.u64(0xe0);
  const sharedRegionSize = header.u64(0xe8);
  if (!slideTableOffset || !slideCount || !sharedRegionSize) throw new Error('real-cache-modern-slide-metadata-missing');
  const slideBytes = await readExactly(handle, BigInt(slideTableOffset), slideCount * 56);
  const slideView = new ByteView(slideBytes, { littleEndian: true });
  const slideMappings = Array.from({ length: slideCount }, (_, i) => readSlideMapping(slideView, i * 56));

  let selected = null;
  for (let i = 0; i < slideMappings.length; i++) {
    const item = slideMappings[i];
    if (item.slideInfoFileSize === 0n || item.slideInfoFileSize > 16n * 1024n * 1024n) continue;
    const prefix = await readExactly(handle, item.slideInfoFileOffset, 4);
    if (new ByteView(prefix, { littleEndian: true }).u32(0) === 5) { selected = { index: i, item }; break; }
  }
  if (!selected) throw new Error('real-cache-v5-slide-mapping-not-found');

  const infoBytes = await readExactly(handle, selected.item.slideInfoFileOffset, Number(selected.item.slideInfoFileSize));
  const info = parseSlideInfo5Structure(infoBytes, selected.item, BigInt(cacheStat.size));
  const selectedPages = choosePages(info.starts);
  const sampledInfo = { ...info, starts: info.starts.map((start, page) => selectedPages.includes(page) ? start : 0xffff) };
  const read64 = async (offset) => new ByteView(await readExactly(handle, offset, 8), { littleEndian: true }).u64(0);
  const targetRange = { start: sharedRegionStart, size: sharedRegionSize };
  const rebases = await walkSlideInfo5Source(read64, selected.item, sampledInfo, 0n, [], 32768, targetRange);
  if (!rebases.length || rebases.some((record) => !record.targetInSharedRegion)) throw new Error('real-cache-v5-sample-provenance-invalid');

  const signedBinary = '/usr/bin/true';
  const codesignVerify = spawnSync('codesign', ['--verify', '--strict', '--verbose=4', signedBinary], { encoding: 'utf8', timeout: 20_000 });
  if (codesignVerify.status !== 0) throw new Error(`trusted-signing-validation-failed:${codesignVerify.status}`);
  const codesignDetails = command('codesign', ['--display', '--verbose=4', signedBinary]);
  const binaryFile = command('file', [signedBinary]);

  const evidence = {
    schema: 'hex-x02-apple-runtime-evidence/v1',
    appleEnvironment: {
      osProductVersion: command('sw_vers', ['-productVersion']),
      osBuildVersion: command('sw_vers', ['-buildVersion']),
      machine: command('uname', ['-m']),
      xcodeVersion: command('xcodebuild', ['-version']),
      clangVersion: command('xcrun', ['clang', '--version']),
      pointerAuthenticationFeature: command('sysctl', ['-n', 'hw.optional.arm.FEAT_PAuth']),
    },
    signedMachO: {
      path: signedBinary,
      sha256: await sha256File(signedBinary),
      file: binaryFile,
      codesignStrictVerified: true,
      codesignDetails,
    },
    realDyldCache: {
      path: cachePath,
      size: cacheStat.size,
      sha256: await sha256File(cachePath),
      sharedRegionStart: hex(sharedRegionStart),
      sharedRegionSize: hex(sharedRegionSize),
      slideMappingIndex: selected.index,
      slideInfoVersion: 5,
      pageSize: info.pageSize,
      selectedPages,
      sampledRebaseCount: rebases.length,
      authenticatedRebaseCount: rebases.filter((record) => record.authenticated).length,
      allSampleTargetsInDeclaredSharedRegion: rebases.every((record) => record.targetInSharedRegion),
      boundedSample: true,
      exhaustiveCacheWalk: false,
    },
    pacRuntime: {
      arm64: runPacProbe('arm64'),
      arm64e: runPacProbe('arm64e'),
    },
  };
  await writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    schema: evidence.schema,
    os: evidence.appleEnvironment.osProductVersion,
    cacheSha256: evidence.realDyldCache.sha256,
    sampledRebaseCount: evidence.realDyldCache.sampledRebaseCount,
    signedMachOVerified: evidence.signedMachO.codesignStrictVerified,
    arm64PacRun: evidence.pacRuntime.arm64.runExit,
    arm64ePacRun: evidence.pacRuntime.arm64e.runExit,
  }));
} finally {
  await handle.close();
}
