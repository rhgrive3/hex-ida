import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

console.log('[phase11] running JVM exception table range tests...');

function buildClassWithExceptionEntry({ startPc, endPc, handlerPc }) {
  const bytes = [];
  const u1 = (value) => bytes.push(value & 0xff);
  const u2 = (value) => bytes.push((value >>> 8) & 0xff, value & 0xff);
  const u4 = (value) => bytes.push(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
  const utf8 = (text) => {
    u1(1);
    u2(text.length);
    for (const char of text) u1(char.charCodeAt(0));
  };

  u4(0xcafebabe); u2(0); u2(52);
  u2(6);
  utf8('A');
  u1(7); u2(1);
  utf8('m');
  utf8('()V');
  utf8('Code');

  u2(0x0021); u2(2); u2(0);
  u2(0);
  u2(0);
  u2(1);

  u2(0x0009); u2(3); u2(4); u2(1);
  u2(5); u4(21);
  u2(0); u2(0);
  u4(1); u1(0xb1);
  u2(1);
  u2(startPc); u2(endPc); u2(handlerPc); u2(0);
  u2(0);

  u2(0);
  return Uint8Array.from(bytes);
}

const valid = parseJvm(buildClassWithExceptionEntry({ startPc: 0, endPc: 1, handlerPc: 0 }));
assert.deepEqual(valid.methods[0].code.exceptionTable, [{
  startPc: 0,
  endPc: 1,
  handlerPc: 0,
  catchType: null,
}]);

for (const entry of [
  { startPc: 1, endPc: 2, handlerPc: 1 },
  { startPc: 0, endPc: 0, handlerPc: 0 },
  { startPc: 0, endPc: 2, handlerPc: 0 },
  { startPc: 0, endPc: 1, handlerPc: 1 },
]) {
  assert.throws(
    () => parseJvm(buildClassWithExceptionEntry(entry)),
    /jvm-invalid-exception-table-range/,
  );
}

console.log('  ok JVM exception table range tests passed');
