import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDarwinArm64Arguments } from '../../../js/targets/abi/darwin-arm64.js';

// Issue #5607: Darwin ARM64 stack arguments must consume their natural layout
// size ("Function arguments may consume slots on the stack that are not
// multiples of 8 bytes"). The former aggregate path widened every aggregate
// slot to Math.max(8, ceil(bytes/8)*8), pushing later arguments past bytes the
// callee never reserved.

const struct3 = {
  type:'struct S3', aggregate:true, bits:24, alignmentBytes:1,
  layout:{ bits:24, bytes:3, alignmentBytes:1, members:[
    { type:'char', bits:8, bytes:1, byteOffset:0, alignmentBytes:1 },
    { type:'char', bits:8, bytes:1, byteOffset:1, alignmentBytes:1 },
    { type:'char', bits:8, bytes:1, byteOffset:2, alignmentBytes:1 },
  ] },
};
const struct12 = {
  type:'struct S12', aggregate:true, bits:96, alignmentBytes:4,
  layout:{ bits:96, bytes:12, alignmentBytes:4, members:[
    { type:'int32_t', bits:32, bytes:4, byteOffset:0, alignmentBytes:4 },
    { type:'int32_t', bits:32, bytes:4, byteOffset:4, alignmentBytes:4 },
    { type:'int32_t', bits:32, bytes:4, byteOffset:8, alignmentBytes:4 },
  ] },
};
const struct8 = {
  type:'struct S8', aggregate:true, bits:64, alignmentBytes:8,
  layout:{ bits:64, bytes:8, alignmentBytes:8, members:[
    { type:'uint64_t', bits:64, bytes:8, byteOffset:0, alignmentBytes:8 },
  ] },
};
const gprs = Array.from({ length:8 }, () => ({ type:'uint64_t', bits:64 }));

test('#5607 a 3-byte aggregate consumes 3 stack bytes, not a widened 8-byte slot', () => {
  const result = classifyDarwinArm64Arguments({ callPrototype:{ args:[...gprs, struct3, { type:'char', bits:8 }] } });
  const s = result.arguments[8];
  const tail = result.arguments[9];
  assert.equal(s.location, 'stack');
  assert.equal(s.offset, 0);
  assert.equal(s.bytes, 3);
  assert.equal(tail.offset, 3, 'the following char must start right after the compact aggregate slot');
  assert.equal(tail.bytes, 1);
});

test('#5607 a 12-byte aggregate occupies 12 bytes; next argument honors its own alignment', () => {
  const result = classifyDarwinArm64Arguments({ callPrototype:{ args:[...gprs, struct12, { type:'char', bits:8 }] } });
  const s = result.arguments[8];
  const tail = result.arguments[9];
  assert.equal(s.bytes, 12);
  assert.equal(tail.offset, 12);
});

test('#5607 the next 8-aligned argument after a compact aggregate still gets alignment padding', () => {
  const result = classifyDarwinArm64Arguments({ callPrototype:{ args:[...gprs, struct3, { type:'uint64_t', bits:64 }] } });
  const s = result.arguments[8];
  const next = result.arguments[9];
  assert.equal(s.bytes, 3);
  assert.equal(next.offset, 8, 'alignUp(3, 8) = 8 — natural padding for the next argument alignment');
  assert.equal(next.bytes, 8);
});

test('#5607 an 8-byte aggregate keeps its full-slot layout (control)', () => {
  const result = classifyDarwinArm64Arguments({ callPrototype:{ args:[...gprs, struct8, { type:'char', bits:8 }] } });
  const s = result.arguments[8];
  const tail = result.arguments[9];
  assert.equal(s.bytes, 8);
  assert.equal(tail.offset, 8);
});
