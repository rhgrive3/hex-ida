import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTRUCTION_SIZE = 240;
const OFF_SIZE = 16;
const OFF_MNEMONIC = 42;
const OFF_OPERANDS = 74;

export async function createCapstoneArm64Session() {
  const modulePath = path.join(os.tmpdir(), `hex-arm64-capstone-${process.pid}-${Date.now()}.cjs`);
  fs.copyFileSync(path.join(ROOT, 'capstone.js'), modulePath);
  const require = createRequire(import.meta.url);
  const factory = require(modulePath);
  const M = await factory({ locateFile:(name) => path.join(ROOT, name), print:()=>{}, printErr:()=>{} });
  const handlePointer = M._malloc(4);
  const outputPointer = M._malloc(4);
  const majorPointer = M._malloc(4);
  const minorPointer = M._malloc(4);
  const packedVersion = M.ccall('cs_version', 'number', ['pointer','pointer'], [majorPointer, minorPointer]);
  const version = Object.freeze({
    packed:packedVersion,
    major:M.getValue(majorPointer, 'i32'),
    minor:M.getValue(minorPointer, 'i32'),
  });
  M._free(minorPointer);
  M._free(majorPointer);
  const opened = M.ccall('cs_open', 'number', ['number','number','pointer'], [M.ARCH_ARM64, M.MODE_ARM | M.MODE_LITTLE_ENDIAN, handlePointer]);
  if (opened !== 0) throw new Error(`arm64-capstone-open-failed:${opened}`);
  const handle = M.getValue(handlePointer, 'i32');

  function decode(bytes, startAddress = 0x1000n) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const buffer = M._malloc(Math.max(1, input.length));
    if (input.length) M.writeArrayToMemory(input, buffer);
    const count = M.ccall('cs_disasm', 'number', ['number','number','number','number','number','number'], [handle, buffer, input.length, BigInt(startAddress), 0, outputPointer]);
    const pointer = M.getValue(outputPointer, 'i32');
    try {
      const instructions = [];
      for (let index = 0; index < count; index++) {
        const p = pointer + index * INSTRUCTION_SIZE;
        const size = M.getValue(p + OFF_SIZE, 'i16');
        instructions.push(Object.freeze({
          address:BigInt(M.getValue(p + 8, 'i64')),
          size,
          mnemonic:M.UTF8ToString(p + OFF_MNEMONIC).toLowerCase(),
          opStr:M.UTF8ToString(p + OFF_OPERANDS),
        }));
      }
      return Object.freeze(instructions);
    } finally {
      if (pointer) M.ccall('cs_free', 'void', ['number','number'], [pointer, count]);
      M._free(buffer);
    }
  }

  function instructionName(instructionId) {
    const pointer = M.ccall('cs_insn_name', 'number', ['number','number'], [handle, Number(instructionId)]);
    return pointer ? M.UTF8ToString(pointer).toLowerCase() : null;
  }

  function close() {
    M.ccall('cs_close', 'number', ['pointer'], [handlePointer]);
    M._free(outputPointer);
    M._free(handlePointer);
    try { fs.unlinkSync(modulePath); } catch { /* best effort */ }
  }
  return Object.freeze({ decode, instructionName, version, close });
}
