import assert from 'node:assert/strict';
import { parseMachO } from '../../../js/binary/macho.js';

// #4336: ARM_THREAD_STATE is 17 uint32_t words (68 bytes), including CPSR.
// A 16-word state contains the PC but is still truncated and must not become
// authoritative LC_UNIXTHREAD/LC_THREAD entrypoint evidence.
const CPU_TYPE_ARM = 12;
const LC_SEGMENT = 0x1;
const LC_THREAD = 0x4;
const LC_UNIXTHREAD = 0x5;
const ARM_THREAD_STATE = 1;
const ARM_THREAD_STATE_COUNT = 17;
const ARM_THREAD_STATE_PC_OFFSET = 60;
const ARM_THREAD_STATE_CPSR_OFFSET = 64;
const IMAGE_BASE = 0x1000n;
const VALID_PC = IMAGE_BASE + 0x100n;

function makeMachO({
  command = LC_UNIXTHREAD,
  count = ARM_THREAD_STATE_COUNT,
  stateWords = count,
  pc = VALID_PC,
} = {}) {
  const segmentCmdSize = 56;
  const threadStateBytes = stateWords * 4;
  const threadCmdSize = 16 + threadStateBytes;
  const loadCommandsSize = segmentCmdSize + threadCmdSize;
  const fileSize = 0x200;
  assert.ok(28 + loadCommandsSize <= fileSize, 'fixture load commands must fit in file');

  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);
  const u32 = (offset, value) => view.setUint32(offset, Number(value) >>> 0, true);
  const i32 = (offset, value) => view.setInt32(offset, Number(value), true);

  // mach_header (32-bit little-endian ARM)
  u32(0, 0xfeedface);
  i32(4, CPU_TYPE_ARM);
  i32(8, 9); // CPU_SUBTYPE_ARM_V7
  u32(12, 2); // MH_EXECUTE
  u32(16, 2);
  u32(20, loadCommandsSize);
  u32(24, 0);

  // One RX LC_SEGMENT maps the entire file at IMAGE_BASE.
  let p = 28;
  u32(p, LC_SEGMENT);
  u32(p + 4, segmentCmdSize);
  bytes.set(Buffer.from('__TEXT'), p + 8);
  u32(p + 24, IMAGE_BASE);
  u32(p + 28, 0x1000);
  u32(p + 32, 0);
  u32(p + 36, fileSize);
  i32(p + 40, 5);
  i32(p + 44, 5);
  u32(p + 48, 0);
  u32(p + 52, 0);

  // ARM_THREAD_STATE record.  stateWords may deliberately be shorter than
  // the advertised count to exercise command-span validation.
  p += segmentCmdSize;
  u32(p, command);
  u32(p + 4, threadCmdSize);
  u32(p + 8, ARM_THREAD_STATE);
  u32(p + 12, count);
  if (threadStateBytes >= ARM_THREAD_STATE_PC_OFFSET + 4) {
    u32(p + 16 + ARM_THREAD_STATE_PC_OFFSET, pc);
  }
  if (threadStateBytes >= ARM_THREAD_STATE_CPSR_OFFSET + 4) {
    u32(p + 16 + ARM_THREAD_STATE_CPSR_OFFSET, 0x10); // user-mode CPSR
  }

  // The parser only requires file-backed executable bytes at the entrypoint;
  // keep a deterministic instruction word there for the valid fixture.
  u32(Number(VALID_PC - IMAGE_BASE), 0xe12fff1e); // bx lr
  return bytes;
}

function entrypointSeeds(image) {
  return image.functions.filter((fn) => fn.source === 'entrypoint');
}

for (const command of [LC_UNIXTHREAD, LC_THREAD]) {
  const image = parseMachO(makeMachO({ command }));
  assert.equal(image.entrypoint, VALID_PC, 'canonical ARM_THREAD_STATE publishes PC');
  assert.equal(image.metadata.entrypointValid, true);
  assert.equal(entrypointSeeds(image).length, 1);
}

for (const count of [15, 16, 18]) {
  const image = parseMachO(makeMachO({ count }));
  assert.equal(image.entrypoint, null,
    `noncanonical ARM_THREAD_STATE count=${count} must not publish PC`);
  assert.equal(image.metadata.entrypointSource, undefined);
  assert.equal(entrypointSeeds(image).length, 0);
}

{
  const image = parseMachO(makeMachO({ count:ARM_THREAD_STATE_COUNT, stateWords:16 }));
  assert.equal(image.entrypoint, null,
    'canonical count with a truncated command span must fail closed');
  assert.equal(entrypointSeeds(image).length, 0);
}

{
  const misaligned = VALID_PC + 1n;
  const image = parseMachO(makeMachO({ pc:misaligned }));
  assert.equal(image.entrypoint, misaligned,
    'canonical thread-state PC remains observable for downstream validation');
  assert.equal(image.metadata.entrypointValid, false);
  assert.equal(entrypointSeeds(image).length, 0,
    'misaligned ARM PC must not mint an entrypoint function seed');
}

console.log('issue #4336 Mach-O ARM_THREAD_STATE count regression: PASS');
