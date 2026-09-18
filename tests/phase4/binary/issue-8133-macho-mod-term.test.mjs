import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMachO } from '../../../js/binary/macho.js';

function fixture64({ sectionType = 0x0a, sectionName = '__mod_term_func', target = 0x1180n, sectionSize = 8n, dataInitProt = 3 } = {}) {
  const bytes = new Uint8Array(0x400);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, x >>> 0, true);
  const i32 = (o, x) => v.setInt32(o, x, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  u32(0, 0xfeedfacf); i32(4, 0x0100000c); i32(8, 0); u32(12, 6);
  u32(16, 2); u32(20, 304); u32(24, 0); u32(28, 0);

  let p = 32;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__TEXT');
  u64(p + 24, 0x1000n); u64(p + 32, 0x1000n);
  u64(p + 40, 0n); u64(p + 48, 0x200n);
  i32(p + 56, 5); i32(p + 60, 5); u32(p + 64, 1);
  let q = p + 72;
  put(q, '__text'); put(q + 16, '__TEXT');
  u64(q + 32, 0x1180n); u64(q + 40, 4n);
  u32(q + 48, 0x180); u32(q + 52, 2); u32(q + 64, 0x80000400);

  p = 184;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__DATA');
  u64(p + 24, 0x2000n); u64(p + 32, 0x1000n);
  u64(p + 40, 0x200n); u64(p + 48, 0x100n);
  i32(p + 56, 3); i32(p + 60, dataInitProt); u32(p + 64, 1);
  q = p + 72;
  put(q, sectionName); put(q + 16, '__DATA');
  u64(q + 32, 0x2000n); u64(q + 40, sectionSize);
  u32(q + 48, 0x200); u32(q + 52, 3); u32(q + 64, sectionType);

  u32(0x180, 0xd65f03c0);
  u64(0x200, target);
  return bytes;
}

function fixture32({ sectionType = 0x0a, sectionName = '__mod_term_func', target = 0x1180 } = {}) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, x >>> 0, true);
  const i32 = (o, x) => view.setInt32(o, x, true);
  const put = (o, value) => bytes.set(Buffer.from(value), o);

  u32(0, 0xfeedface); i32(4, 7); i32(8, 3); u32(12, 6);
  u32(16, 2); u32(20, 248); u32(24, 0);

  let p = 28;
  u32(p, 1); u32(p + 4, 124); put(p + 8, '__TEXT');
  u32(p + 24, 0x1000); u32(p + 28, 0x1000);
  u32(p + 32, 0); u32(p + 36, 0x200);
  i32(p + 40, 5); i32(p + 44, 5); u32(p + 48, 1);
  let q = p + 56;
  put(q, '__text'); put(q + 16, '__TEXT');
  u32(q + 32, 0x1180); u32(q + 36, 1);
  u32(q + 40, 0x180); u32(q + 44, 0); u32(q + 56, 0x80000400);

  p = 152;
  u32(p, 1); u32(p + 4, 124); put(p + 8, '__DATA');
  u32(p + 24, 0x2000); u32(p + 28, 0x1000);
  u32(p + 32, 0x200); u32(p + 36, 0x100);
  i32(p + 40, 3); i32(p + 44, 3); u32(p + 48, 1);
  q = p + 56;
  put(q, sectionName); put(q + 16, '__DATA');
  u32(q + 32, 0x2000); u32(q + 36, 4);
  u32(q + 40, 0x200); u32(q + 44, 2); u32(q + 56, sectionType);

  bytes[0x180] = 0xc3;
  u32(0x200, target);
  return bytes;
}

function fixture64InitAndTermSameTarget() {
  const bytes = new Uint8Array(0x600);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, x >>> 0, true);
  const i32 = (o, x) => view.setInt32(o, x, true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x), true);
  const put = (o, value) => bytes.set(Buffer.from(value), o);

  u32(0, 0xfeedfacf); i32(4, 0x0100000c); i32(8, 0); u32(12, 6);
  u32(16, 2); u32(20, 384); u32(24, 0); u32(28, 0);

  let p = 32;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__TEXT');
  u64(p + 24, 0x1000n); u64(p + 32, 0x1000n);
  u64(p + 40, 0n); u64(p + 48, 0x400n);
  i32(p + 56, 5); i32(p + 60, 5); u32(p + 64, 1);
  let q = p + 72;
  put(q, '__text'); put(q + 16, '__TEXT');
  u64(q + 32, 0x1300n); u64(q + 40, 4n);
  u32(q + 48, 0x300); u32(q + 52, 2); u32(q + 64, 0x80000400);

  p = 184;
  u32(p, 0x19); u32(p + 4, 232); put(p + 8, '__DATA');
  u64(p + 24, 0x2000n); u64(p + 32, 0x1000n);
  u64(p + 40, 0x400n); u64(p + 48, 0x100n);
  i32(p + 56, 3); i32(p + 60, 3); u32(p + 64, 2);

  q = p + 72;
  put(q, '__mod_init_func'); put(q + 16, '__DATA');
  u64(q + 32, 0x2000n); u64(q + 40, 8n);
  u32(q + 48, 0x400); u32(q + 52, 3); u32(q + 64, 0x9);

  q += 80;
  put(q, '__mod_term_func'); put(q + 16, '__DATA');
  u64(q + 32, 0x2008n); u64(q + 40, 8n);
  u32(q + 48, 0x408); u32(q + 52, 3); u32(q + 64, 0x0a);

  u32(0x300, 0xd65f03c0);
  u64(0x400, 0x1300n);
  u64(0x408, 0x1300n);
  return bytes;
}

test('valid S_MOD_TERM_FUNC_POINTERS becomes termination metadata and an exact function seed', () => {
  const image = parseMachO(fixture64());
  assert.equal(image.metadata.terminators?.length, 1);
  assert.equal(image.metadata.terminators[0].address, 0x1180n);
  assert.equal(image.metadata.terminators[0].slotAddress, 0x2000n);
  assert.equal(image.metadata.terminators[0].valid, true);
  const seed = image.functions.find((f) => f.address === 0x1180n);
  assert.ok(seed);
  assert.equal(seed.source, 'terminator');
  assert.equal(seed.exactFunctionStart, true);
  assert.match(seed.functionStartEvidence, /S_MOD_TERM_FUNC_POINTERS/);
});

test('S_MOD_INIT_FUNC_POINTERS keeps initializer/constructor semantics', () => {
  const image = parseMachO(fixture64({ sectionType: 0x9, sectionName: '__mod_init_func' }));
  assert.equal(image.metadata.initializers?.length, 1);
  assert.equal(image.metadata.terminators, undefined);
  assert.equal(image.functions.find((f) => f.address === 0x1180n)?.source, 'constructor');
});

test('misaligned terminator target is retained as invalid lifecycle metadata and never seeded', () => {
  const image = parseMachO(fixture64({ target: 0x1182n }));
  assert.equal(image.metadata.terminators?.length, 1);
  assert.equal(image.metadata.terminators[0].valid, false);
  assert.ok(!image.functions.some((f) => f.address === 0x1182n));
  assert.ok(image.metadata.machoMetadata.reasons.includes('mod-term:misaligned'));
});

test('partial pointer tail is diagnosed without over-reading it', () => {
  const image = parseMachO(fixture64({ sectionSize: 9n }));
  assert.equal(image.metadata.terminators?.length, 1);
  assert.ok(image.metadata.machoMetadata.reasons.includes('mod-term:truncated-section'));
});


test('32-bit S_MOD_TERM_FUNC_POINTERS uses 4-byte entries and terminator provenance', () => {
  const image = parseMachO(fixture32());
  assert.equal(image.metadata.terminators?.length, 1);
  assert.equal(image.metadata.terminators[0].address, 0x1180n);
  const seed = image.functions.find((f) => f.address === 0x1180n);
  assert.ok(seed);
  assert.equal(seed.source, 'terminator');
  assert.equal(seed.exactFunctionStart, true);
});


test('initializer and terminator pointing at the same target deduplicate while preserving both provenance sources', () => {
  const image = parseMachO(fixture64InitAndTermSameTarget());
  assert.equal(image.metadata.initializers?.length, 1);
  assert.equal(image.metadata.terminators?.length, 1);
  assert.equal(image.functions.length, 1);
  assert.deepEqual(new Set(image.functions[0].sources), new Set(['constructor', 'terminator']));
  assert.equal(image.functions[0].exactFunctionStart, true);
});
