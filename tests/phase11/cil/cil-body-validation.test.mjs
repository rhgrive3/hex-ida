import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { buildMinimalCil } from './cil-parser.test.mjs';

/**
 * CIL method-body validation and lifter provenance hardening. The parser
 * fails closed with typed errors on malformed bodies; the lifter bounds-checks
 * every operand read, maps EH union fields by clause kind, and anchors
 * provenance ranges at the IL stream start rather than the method header
 * (#5331, #5350, #5356, #5396).
 */

function fatBodyBuffer(localVarSigTok) {
  const buf = new Uint8Array(0x300);
  const view = new DataView(buf.buffer);
  buf[0x100] = 0x42; buf[0x101] = 0x53; buf[0x102] = 0x4a; buf[0x103] = 0x42; // 'BSJB'
  view.setUint16(0x104, 1, true);
  view.setUint16(0x106, 1, true);
  view.setUint32(0x10c, 0, true);
  // Fat header at 0x200: flags 0x3003 (fat, 3-DWORD header), maxStack 8,
  // codeSize 1, LocalVarSigTok, code [ret].
  view.setUint16(0x200, 0x3003, true);
  view.setUint16(0x202, 8, true);
  view.setUint32(0x204, 1, true);
  view.setUint32(0x208, localVarSigTok, true);
  buf[0x20c] = 0x2a; // ret
  return buf;
}

test('#5331 fat LocalVarSigTok with a non-StandAloneSig table kind is rejected', () => {
  const parsed = parseCil(fatBodyBuffer(0));
  assert.equal(parsed.methodBodies.length, 1, 'a zero token (no locals) still parses');
  assert.equal(parsed.methodBodies[0].localVarSigTok, 0);
  const carried = parseCil(fatBodyBuffer(0x11000001));
  assert.equal(carried.methodBodies.length, 1, 'StandAloneSig-kind tokens travel as-is (RID/blob need unparsed heaps)');
  assert.equal(carried.methodBodies[0].localVarSigTok, 0x11000001);
  // A TypeRef-kind token can never name a locals signature: the body is
  // malformed and must not surface as a parsed method.
  const rejected = parseCil(fatBodyBuffer(0x01000001));
  assert.equal(rejected.methodBodies.length, 0, 'wrong-kind tokens must not parse as methods');
});

test('#5350 truncated operands fail closed with a typed error', () => {
  const image = parseCil(buildMinimalCil());
  for (const bytecode of [
    Uint8Array.from([0x0e]), // ldarg.s without its index
    Uint8Array.from([0x20, 0x01]), // ldc.i4 without its 4 bytes
    Uint8Array.from([0xfe]), // prefix without its second byte
    Uint8Array.from([0x28, 0x01, 0x02]), // call without its token
  ]) {
    const bad = { ...image, methodBodies: [{ ...image.methodBodies[0], bytecode }] };
    assert.throws(() => liftCilMethod(0, bad), /cil-truncated-operand/,
      `truncated ${[...bytecode].map((b) => b.toString(16))} must not lift`);
  }
  // Complete operands still lift exactly.
  const good = liftCilMethod(0, image);
  assert.equal(good.bundles[0].mnemonic, 'ldc.i4.5');
  assert.equal(good.aggregateCompleteness, 'exact');
});

test('#5356 filter clauses publish filterOffset, not catchToken', () => {
  const body = {
    headerOffset: 0x100, codeOffset: 0x10c, isTiny: false, maxStack: 8, codeSize: 24,
    localVarSigTok: 0,
    bytecode: Uint8Array.from({ length: 24 }, (_, index) => (index === 23 ? 0x2a : 0x00)),
    exceptionClauses: [
      { kind: 'filter', tryOffset: 0, tryLength: 4, handlerOffset: 20, handlerLength: 4, classTokenOrFilter: 8 },
      { kind: 'catch', tryOffset: 0, tryLength: 4, handlerOffset: 20, handlerLength: 4, classTokenOrFilter: 0x01000001 },
      { kind: 'finally', tryOffset: 4, tryLength: 4, handlerOffset: 16, handlerLength: 4, classTokenOrFilter: 0xdeadbeef },
      { kind: 'fault', tryOffset: 8, tryLength: 4, handlerOffset: 12, handlerLength: 4, classTokenOrFilter: 0xcafebabe },
    ],
  };
  const lifted = liftCilMethod(0, { moduleId: 'test', vmSpecEdition: 'v4.0.30319', methodBodies: [body] });
  assert.equal(lifted.exceptionRegions[0].filterOffset, 8);
  assert.ok(!('catchToken' in lifted.exceptionRegions[0]), 'filter regions must not carry a catch token');
  assert.equal(lifted.exceptionRegions[1].catchToken, 0x01000001);
  assert.ok(!('filterOffset' in lifted.exceptionRegions[1]), 'catch regions must not carry a filter offset');
  for (const [index, kind] of [[2, 'finally'], [3, 'fault']]) {
    const region = lifted.exceptionRegions[index];
    assert.equal(region.handlerKind, kind);
    assert.ok(!('catchToken' in region), `${kind} regions must not carry a catch token`);
    assert.ok(!('filterOffset' in region), `${kind} regions must not carry a filter offset`);
  }
});

test('#5396 operation provenance starts at the IL stream, not the header', () => {
  const image = parseCil(buildMinimalCil());
  const body = image.methodBodies[0];
  assert.equal(body.codeOffset, body.headerOffset + 1, 'tiny code starts one byte past the header');
  const lifted = liftCilMethod(0, image);
  const ranges = lifted.bundles.map((bundle) => bundle.origin.byteRanges[0]);
  assert.equal(ranges[0].start, String(body.headerOffset + 1));
  assert.equal(ranges[ranges.length - 1].end, String(body.headerOffset + 1 + body.codeSize));
  for (const range of ranges) {
    assert.ok(BigInt(range.start) >= BigInt(body.headerOffset + 1), 'no range may point into the header');
  }
});
