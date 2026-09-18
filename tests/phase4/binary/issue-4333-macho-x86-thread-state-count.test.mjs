import assert from 'node:assert/strict';
import { parseMachO } from '../../../js/binary/macho.js';

// #4333: x86_THREAD_STATE64 is 42 uint32_t words (168 bytes).  A state
// truncated after RIP is still malformed and must not become entrypoint truth.
const CPU_TYPE_X86_64 = 0x01000007;
const LC_SEGMENT_64 = 0x19;
const LC_UNIXTHREAD = 0x5;
const X86_THREAD_STATE64 = 4;
const X86_THREAD_STATE64_COUNT = 42;
const X86_THREAD_STATE64_RIP_OFFSET = 128;
const IMAGE_BASE = 0x100000000n;

function makeMachO({
  count = X86_THREAD_STATE64_COUNT,
  stateWords = count,
  rip = IMAGE_BASE + 0x40n,
} = {}) {
  const segCmdSize = 72;
  const threadStateBytes = stateWords * 4;
  const threadCmdSize = 16 + threadStateBytes;
  const loadCommandsSize = segCmdSize + threadCmdSize;
  const fileSize = 32 + loadCommandsSize;
  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);
  const u32 = (offset, value) => view.setUint32(offset, Number(value) >>> 0, true);
  const i32 = (offset, value) => view.setInt32(offset, Number(value), true);
  const u64 = (offset, value) => view.setBigUint64(offset, BigInt(value), true);

  u32(0, 0xfeedfacf);
  i32(4, CPU_TYPE_X86_64);
  i32(8, 3);
  u32(12, 2);
  u32(16, 2);
  u32(20, loadCommandsSize);
  u32(24, 0);
  u32(28, 0);

  let p = 32;
  u32(p, LC_SEGMENT_64);
  u32(p + 4, segCmdSize);
  bytes.set(Buffer.from('__TEXT'), p + 8);
  u64(p + 24, IMAGE_BASE);
  u64(p + 32, 0x2000n);
  u64(p + 40, 0n);
  u64(p + 48, BigInt(fileSize));
  i32(p + 56, 5);
  i32(p + 60, 5);
  u32(p + 64, 0);
  u32(p + 68, 0);

  p += segCmdSize;
  u32(p, LC_UNIXTHREAD);
  u32(p + 4, threadCmdSize);
  u32(p + 8, X86_THREAD_STATE64);
  u32(p + 12, count);
  if (threadStateBytes >= X86_THREAD_STATE64_RIP_OFFSET + 8) {
    u64(p + 16 + X86_THREAD_STATE64_RIP_OFFSET, rip);
  }
  return bytes;
}

function entrypointSeeds(image) {
  return image.functions.filter((fn) => fn.source === 'entrypoint');
}

{
  const image = parseMachO(makeMachO());
  assert.equal(image.entrypoint, IMAGE_BASE + 0x40n);
  assert.equal(image.metadata.entrypointSource, 'LC_UNIXTHREAD');
  assert.equal(image.metadata.entrypointValid, true);
  assert.equal(entrypointSeeds(image).length, 1);
}

for (const count of [34, 41, 43]) {
  const image = parseMachO(makeMachO({ count }));
  assert.equal(image.entrypoint, null,
    `noncanonical x86_THREAD_STATE64 count=${count} must not publish RIP`);
  assert.equal(entrypointSeeds(image).length, 0);
}

{
  const image = parseMachO(makeMachO({ count:42, stateWords:41 }));
  assert.equal(image.entrypoint, null,
    'canonical count with a truncated command span must fail closed');
  assert.equal(entrypointSeeds(image).length, 0);
}

{
  const zeroFillRip = IMAGE_BASE + 0x1000n;
  const image = parseMachO(makeMachO({ rip:zeroFillRip }));
  assert.equal(image.entrypoint, zeroFillRip,
    'thread-state RIP remains observable for downstream mapping validation');
  assert.equal(image.metadata.entrypointValid, false);
  assert.equal(entrypointSeeds(image).length, 0,
    'a canonical thread state cannot seed an entrypoint without file-backed code');
}

console.log('issue #4333 Mach-O x86_THREAD_STATE64 count regression: PASS');
