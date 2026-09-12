// Regression for #4890: WASM instruction origin byteRanges must be anchored at
// the absolute binary offset of `codeBody.bytecode[0]` (the first real opcode),
// not at `bodyOffset` (the body-size ULEB start). The parser and lifter used two
// different offset spaces: the Code-section decoder saved `bodyOffset` at the
// body-size prefix while `bytecode` skipped the locals declaration, yet the
// lifter added `bodyOffset + opOffset`, so every VMEffect origin pointed
// (body-size ULEB bytes + locals header bytes) too early and evidenced the
// wrong bytes.
import assert from 'node:assert/strict';

import { parseWasm } from '../js/managed/wasm/parser.js';
import { liftWasmFunction } from '../js/managed/wasm/lifter.js';

console.log('[phase11] running WASM instruction origin byte-offset regression #4890...');

function uleb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

// Assembles a module with one () -> () type per function and returns, alongside
// the raw bytes, the independently computed absolute binary offsets of each body:
// `instructionBase` (offset of the first opcode) and `bodyDataOffset` (offset of
// the locals-declaration byte), which is what the buggy lifter used as base.
function buildModule(bodies) {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const section = (id, payload) => [id, ...uleb(payload.length), ...payload];

  const typePayload = [bodies.length, 0x60, 0x00, 0x00];
  const funcPayload = [...uleb(bodies.length), ...bodies.map(() => 0)];

  let codePayload = uleb(bodies.length);
  const relInstruction = [];
  const relBodyData = [];
  for (const body of bodies) {
    let localsHeader = uleb(body.localsGroups.length);
    for (const [count, type] of body.localsGroups) localsHeader = [...localsHeader, ...uleb(count), type];
    const bodyData = [...localsHeader, ...body.instructions];
    const bodySize = uleb(bodyData.length);
    relBodyData.push(codePayload.length + bodySize.length);
    relInstruction.push(codePayload.length + bodySize.length + localsHeader.length);
    codePayload = [...codePayload, ...bodySize, ...bodyData];
  }

  const bytes = Uint8Array.from([...header, ...section(0x01, typePayload), ...section(0x03, funcPayload), ...section(0x0a, codePayload)]);
  const codePayloadStart =
    header.length +
    section(0x01, typePayload).length +
    section(0x03, funcPayload).length +
    1 +
    uleb(codePayload.length).length;
  return {
    bytes,
    bodies: bodies.map((_, i) => ({
      instructionBase: codePayloadStart + relInstruction[i],
      bodyDataOffset: codePayloadStart + relBodyData[i],
      instructionCount: bodies[i].instructions.length,
    })),
  };
}

function ranges(fn) {
  return fn.bundles.map((bundle) => ({
    mnemonic: bundle.mnemonic,
    start: Number(bundle.origin.byteRanges[0].start),
    end: Number(bundle.origin.byteRanges[0].end),
  }));
}

// Fixture A: locals 0, body_size 1-byte ULEB, first opcode `i32.const` is 2 bytes,
// then `drop`, `nop`, `end`. Also validates 2nd/3rd instruction absolute ranges.
const a = buildModule([
  { localsGroups: [], instructions: [0x41, 0x07, 0x1a, 0x01, 0x0b] },
]);
const parsedA = parseWasm(a.bytes);
const liftedA = ranges(liftWasmFunction(0, parsedA));
assert.deepEqual(liftedA, [
  { mnemonic: 'i32.const', start: a.bodies[0].instructionBase, end: a.bodies[0].instructionBase + 2 },
  { mnemonic: 'drop', start: a.bodies[0].instructionBase + 2, end: a.bodies[0].instructionBase + 3 },
  { mnemonic: 'nop', start: a.bodies[0].instructionBase + 3, end: a.bodies[0].instructionBase + 4 },
  { mnemonic: 'end', start: a.bodies[0].instructionBase + 4, end: a.bodies[0].instructionBase + 5 },
], 'locals-0 body: every origin anchors at the true opcode byte, not the body-size prefix');
assert.ok(a.bodies[0].instructionBase > a.bodies[0].bodyDataOffset - 0 && liftedA[0].start === a.bodies[0].instructionBase,
  'first opcode origin must not precede bytecode[0]');
// The buggy base would have been the body-size ULEB start = bodyDataOffset - (size uleb bytes).
assert.ok(liftedA[0].start > a.bodies[0].bodyDataOffset - 3,
  'origin must be past the locals header, not on body-size/locals bytes');

// Fixture B: body_size is a 2-byte ULEB (>=128 body bytes) so the size prefix
// alone contributes 2 bytes of drift; nops keep the stack trivially valid.
const nopRun = new Array(130).fill(0x01);
const b = buildModule([
  { localsGroups: [], instructions: [...nopRun, 0x0b] },
]);
const parsedB = parseWasm(b.bytes);
assert.equal(parsedB.codeBodies[0].bytecode.length, nopRun.length + 1);
const liftedB = ranges(liftWasmFunction(0, parsedB));
assert.equal(liftedB[0].mnemonic, 'nop');
assert.equal(liftedB[0].start, b.bodies[0].instructionBase, '2-byte body_size ULEB: first opcode origin is exact');
assert.equal(liftedB[0].end, b.bodies[0].instructionBase + 1, '2-byte body_size ULEB: single-byte op end is exact');
assert.equal(liftedB[liftedB.length - 1].mnemonic, 'end');
assert.equal(liftedB[liftedB.length - 1].end, b.bodies[0].instructionBase + b.bodies[0].instructionCount,
  '2-byte body_size ULEB: last opcode end meets the raw body end');

// Fixture C: exactly one local group; the locals header (count + count + type)
// must be skipped by the origin base.
const c = buildModule([
  { localsGroups: [[2, 0x7f]], instructions: [0x20, 0x00, 0x1a, 0x0b] },
]);
const parsedC = parseWasm(c.bytes);
const liftedC = ranges(liftWasmFunction(0, parsedC));
assert.deepEqual(liftedC, [
  { mnemonic: 'local.get', start: c.bodies[0].instructionBase, end: c.bodies[0].instructionBase + 2 },
  { mnemonic: 'drop', start: c.bodies[0].instructionBase + 2, end: c.bodies[0].instructionBase + 3 },
  { mnemonic: 'end', start: c.bodies[0].instructionBase + 3, end: c.bodies[0].instructionBase + 4 },
], 'one local group: first opcode origin skips the locals declaration');

// Fixture D: multiple local groups (variable-length counts) amplify the drift.
const d = buildModule([
  { localsGroups: [[1, 0x7f], [3, 0x7e], [2, 0x7f]], instructions: [0x20, 0x00, 0x1a, 0x41, 0x03, 0x1a, 0x0b] },
]);
const parsedD = parseWasm(d.bytes);
const liftedD = ranges(liftWasmFunction(0, parsedD));
assert.equal(liftedD[0].start, d.bodies[0].instructionBase, 'multiple local groups: first opcode origin is exact');
assert.equal(liftedD[0].mnemonic, 'local.get');
assert.deepEqual(liftedD[0], { mnemonic: 'local.get', start: d.bodies[0].instructionBase, end: d.bodies[0].instructionBase + 2 });
// i32.const 3 is a 2-byte instruction (opcode + 1-byte SLEB immediate).
const constBundle = liftedD[2];
assert.equal(constBundle.mnemonic, 'i32.const');
assert.equal(constBundle.start, d.bodies[0].instructionBase + 3);
assert.equal(constBundle.end, d.bodies[0].instructionBase + 5, 'multi-byte instruction end reflects opcode + immediate');

// Cross-fixture invariant: instruction origins must live strictly inside the raw
// body and never land on the body-size prefix or locals-header bytes.
for (const [mod, parsed] of [[a, parsedA], [b, parsedB], [c, parsedC], [d, parsedD]]) {
  const body = parsed.codeBodies[0];
  assert.equal(typeof body.bytecodeOffset, 'number', 'parser records an explicit absolute bytecodeOffset');
  assert.equal(body.bytecodeOffset, mod.bodies[0].instructionBase, 'bytecodeOffset == absolute offset of bytecode[0]');
  for (const fn of ranges(liftWasmFunction(0, parsed))) {
    assert.ok(fn.start >= body.bytecodeOffset, `origin start ${fn.start} >= bytecodeOffset ${body.bytecodeOffset}`);
    assert.ok(fn.end <= body.bytecodeOffset + body.bytecode.length, `origin end ${fn.end} within bytecode extent`);
  }
}

console.log('  ok WASM instruction origin byte-offset regression #4890 passed');
