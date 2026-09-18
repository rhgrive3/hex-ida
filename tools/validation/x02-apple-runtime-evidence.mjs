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

function runDyldRuntimeProbe() {
  const dir = path.join(os.tmpdir(), `hex-x02-dyld-runtime-${process.pid}`);
  command('/bin/mkdir', ['-p', dir]);
  const source = path.join(dir, 'runtime-map.c');
  const binary = path.join(dir, 'runtime-map');
  const sourceText = String.raw`#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef const void *(*shared_cache_range_fn)(size_t *);
typedef bool (*shared_cache_uuid_fn)(unsigned char *);

static void print_uuid(const unsigned char uuid[16]) {
  for (int i = 0; i < 16; i++) printf("%02x", uuid[i]);
}

int main(void) {
  shared_cache_range_fn get_range = (shared_cache_range_fn)dlsym(RTLD_DEFAULT, "_dyld_get_shared_cache_range");
  shared_cache_uuid_fn get_uuid = (shared_cache_uuid_fn)dlsym(RTLD_DEFAULT, "_dyld_get_shared_cache_uuid");
  if (get_range == NULL) return 20;
  size_t length = 0;
  const unsigned char *start = (const unsigned char *)get_range(&length);
  if (start == NULL || length < 0x100) return 21;

  unsigned char uuid[16] = {0};
  bool uuid_ok = get_uuid != NULL && get_uuid(uuid);
  if (!uuid_ok) {
    if (memcmp(start, "dyld_v1", 7) != 0) return 22;
    memcpy(uuid, start + 0x58, 16);
  }

  printf("CACHE\t0x%llx\t0x%llx\t", (unsigned long long)(uintptr_t)start, (unsigned long long)length);
  print_uuid(uuid);
  printf("\n");

  uint32_t total = _dyld_image_count();
  uint32_t cached = 0;
  for (uint32_t i = 0; i < total; i++) {
    const struct mach_header *header = _dyld_get_image_header(i);
    if (header == NULL) continue;
    uintptr_t address = (uintptr_t)header;
    uintptr_t begin = (uintptr_t)start;
    if (address < begin || address >= begin + length) continue;
    intptr_t slide = _dyld_get_image_vmaddr_slide(i);
    const char *name = _dyld_get_image_name(i);
    if (cached < 16) {
      printf("IMAGE\t0x%llx\t%lld\t%s\n", (unsigned long long)address, (long long)slide, name == NULL ? "" : name);
    }
    cached++;
  }
  printf("COUNTS\t%u\t%u\n", total, cached);
  return cached == 0 ? 23 : 0;
}
`;
  execFileSync('/usr/bin/python3', ['-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])', source, sourceText], { timeout: 10_000 });
  const compile = spawnSync('xcrun', ['clang', '-arch', 'arm64', '-O2', source, '-o', binary], { encoding: 'utf8', timeout: 30_000 });
  if (compile.status !== 0) throw new Error(`dyld-runtime-probe-compile:${compile.status}:${(compile.stderr || '').slice(0, 2000)}`);
  const sign = spawnSync('codesign', ['--force', '--sign', '-', binary], { encoding: 'utf8', timeout: 20_000 });
  if (sign.status !== 0) throw new Error(`dyld-runtime-probe-codesign:${sign.status}:${(sign.stderr || '').slice(0, 1000)}`);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
  if (run.status !== 0) throw new Error(`dyld-runtime-probe-run:${run.status}:${run.signal || ''}:${(run.stderr || '').slice(0, 1000)}`);

  let cache = null;
  let counts = null;
  const images = [];
  for (const line of (run.stdout || '').trim().split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields[0] === 'CACHE' && fields.length === 4) {
      cache = { start: BigInt(fields[1]), size: BigInt(fields[2]), uuid: fields[3].toLowerCase() };
    } else if (fields[0] === 'IMAGE' && fields.length >= 4) {
      images.push({ header: BigInt(fields[1]), slide: BigInt(fields[2]), path: fields.slice(3).join('\t') });
    } else if (fields[0] === 'COUNTS' && fields.length === 3) {
      counts = { total: Number(fields[1]), cached: Number(fields[2]) };
    }
  }
  if (!cache || !counts || counts.cached < 1 || images.length < 1) throw new Error('dyld-runtime-probe-output-incomplete');
  return { cache, counts, images };
}

const cachePath = CACHE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!cachePath) throw new Error('real-apple-dyld-cache-not-found');

const cacheStat = await stat(cachePath);
const handle = await open(cachePath, 'r');
try {
  const headerBytes = await readExactly(handle, 0n, 0x200);
  const headerBuffer = Buffer.from(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  if (!headerBuffer.subarray(0, 7).equals(Buffer.from('dyld_v1'))) throw new Error('real-cache-header-magic');
  const cacheUuid = headerBuffer.subarray(0x58, 0x68).toString('hex');
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

  const runtime = runDyldRuntimeProbe();
  if (runtime.cache.uuid !== cacheUuid) throw new Error(`dyld-runtime-cache-uuid-mismatch:${runtime.cache.uuid}:${cacheUuid}`);
  if (runtime.cache.start < sharedRegionStart) throw new Error('dyld-runtime-cache-start-before-unslid-region');
  if (runtime.cache.size < sharedRegionSize) throw new Error(`dyld-runtime-cache-range-too-small:${runtime.cache.size}:${sharedRegionSize}`);
  const runtimeSlide = runtime.cache.start - sharedRegionStart;
  if (!runtime.images.every((image) => image.slide === runtimeSlide)) throw new Error('dyld-runtime-image-slide-mismatch');

  const runtimeRebases = await walkSlideInfo5Source(read64, selected.item, sampledInfo, runtimeSlide, [], 32768, targetRange);
  if (runtimeRebases.length !== rebases.length) throw new Error('dyld-runtime-rebase-sample-count-mismatch');
  const runtimeRangeEnd = runtime.cache.start + runtime.cache.size;
  const runtimeAddressDerivationVerified = runtimeRebases.every((record, index) => {
    const base = rebases[index];
    return record.storageAddress === base.storageAddress
      && record.targetAddress === base.targetAddress
      && record.runtimeStorageAddress === base.storageAddress + runtimeSlide
      && record.runtimeTargetAddress === base.targetAddress + runtimeSlide;
  });
  const allRuntimeSampleTargetsInRuntimeSharedRegion = runtimeRebases.every((record) =>
    record.runtimeTargetAddress >= runtime.cache.start && record.runtimeTargetAddress < runtimeRangeEnd);
  if (!runtimeAddressDerivationVerified || !allRuntimeSampleTargetsInRuntimeSharedRegion) {
    throw new Error('dyld-runtime-address-derivation-invalid');
  }

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
      cacheUuid,
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
      runtimeLoadMapObserved: true,
      runtimeSlideObserved: true,
      runtimeCacheUuid: runtime.cache.uuid,
      runtimeCacheStart: hex(runtime.cache.start),
      runtimeCacheSize: hex(runtime.cache.size),
      runtimeSlide: hex(runtimeSlide),
      runtimeImageCount: runtime.counts.total,
      runtimeCacheImageCount: runtime.counts.cached,
      runtimeSampleImages: runtime.images.map((image) => ({ header: hex(image.header), slide: hex(image.slide), path: image.path })),
      runtimeImagesAllUseObservedSlide: runtime.images.every((image) => image.slide === runtimeSlide),
      runtimeDecodedRebaseCount: runtimeRebases.length,
      runtimeAddressDerivationVerified,
      allRuntimeSampleTargetsInRuntimeSharedRegion,
    },
    pacRuntime: {
      arm64: runPacProbe('arm64'),
      arm64e: runPacProbe('arm64e'),
    },
  };
  await writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally {
  await handle.close();
}
