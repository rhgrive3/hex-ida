/*
 * #3684 — MTE tag instructions (STG/STZG/LDG and siblings) must not be
 * explained through the generic `^st`/`^ld` load/store fallback: they operate
 * on the Allocation Tag of 16-byte granules, not on ordinary 64-bit data.
 */
import assert from 'node:assert/strict';
import { explain } from '../js/arm64.js';
import { lang, setLang } from '../js/i18n.js';

console.log('Testing #3684 MTE tag-instruction explanations...');

const prevLang = lang();
try {
  setLang('en');

  const rendered = (e) => [e.title, e.summary, e.pseudo, ...e.detail].join(' ');

  for (const [mn, ops] of [
    ['stg', 'x0, [x1]'], ['stzg', 'x0, [x1]'], ['ldg', 'x0, [x1]'],
    ['st2g', 'x0, [x1]'], ['stz2g', 'x0, [x1]'],
    ['stgm', 'x0, [x1]'], ['stzgm', 'x0, [x1]'], ['ldgm', 'x0, [x1]'],
    ['ldgfe', 'x0, [x1]'],
  ]) {
    const e = explain(mn, ops, 0x1000n, {});
    assert.equal(e.handlerError, undefined, `${mn} ${ops} threw: ${e.handlerError}`);
    const text = rendered(e);
    assert.ok(e.title && e.summary && e.pseudo, `${mn} must keep a full explanation`);
    assert.ok(!/\(uint64\*\)|\(int64\*\)/.test(e.pseudo),
      `${mn} ${ops} must not fabricate an ordinary 64-bit data transfer: ${e.pseudo}`);
    assert.ok(!/Store to memory|Load from memory/i.test(text),
      `${mn} ${ops} must not be classified as an ordinary data load/store: ${text}`);
    assert.ok(/tag/i.test(text), `${mn} ${ops} must explain the Allocation Tag: ${text}`);
    assert.ok(/granule/i.test(text), `${mn} ${ops} must explain the 16-byte granule scope: ${text}`);
    assert.ok(/16[- ]byte|16 bytes|granule/i.test(text), `${mn} ${ops} must state the granule width`);
  }

  const stg = explain('stg', 'x0, [x1]', 0x1000n, {});
  assert.ok(!/write 8 bytes|read 8 bytes/i.test(rendered(stg)),
    `STG must not claim an 8-byte data transfer: ${rendered(stg)}`);

  const stzg = explain('stzg', 'x0, [x1]', 0x1000n, {});
  assert.ok(/zero/i.test(rendered(stzg)), `STZG must explain the granule zeroing: ${rendered(stzg)}`);

  const ldg = explain('ldg', 'x0, [x1]', 0x1000n, {});
  assert.equal(ldg.pseudo, 'x0 = AllocationTag(x1) /* carried tag; data bits zeroed */',
    'LDG must show the tag-load form, not a data load');

  const stgPseudo = explain('stg', 'x0, [x1]', 0x1000n, {}).pseudo;
  assert.equal(stgPseudo, 'AllocationTag[x1] = Tag(x0)', 'STG must show the tag-store form');
  assert.equal(explain('stzg', 'x0, [x1]', 0x1000n, {}).pseudo,
    'AllocationTag[x1] = Tag(x0); zero(*[16 bytes]x1) /* granule zeroing */',
    'STZG must show tag store plus granule zeroing');

  // Ordinary data transfers keep their established wording.
  assert.equal(explain('str', 'x0, [x1]', 0x1000n, {}).pseudo, '*(uint64*)(x1) = x0');
  assert.equal(explain('ldr', 'x0, [x1]', 0x1000n, {}).pseudo, 'x0 = *(uint64*)(x1)');
  assert.match(explain('strb', 'w0, [x1]', 0x1000n, {}).pseudo, /\(uint8\*\)/);
  assert.match(explain('strh', 'w0, [x1]', 0x1000n, {}).pseudo, /\(uint16\*\)/);
} finally {
  setLang(prevLang);
}

console.log('  ok #3684 MTE tag ops separated from ordinary data transfers');
