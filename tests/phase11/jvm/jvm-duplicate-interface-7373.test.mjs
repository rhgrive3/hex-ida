import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJvm } from '../../../js/managed/jvm/parser.js';

// Minimal Java 17 class file with a configurable interfaces[] table.
// Constant pool: #1 Utf8 'C', #2 Class->#1, #3 Utf8 'java/lang/Object',
// #4 Class->#3, #5 Utf8 'java/lang/Runnable', #6 Class->#5, #7 Class->#5
// (a second CONSTANT_Class entry aliasing the same name, as the JVM permits
// within the pool but not within interfaces[]).
function buildClass(interfaceIndices) {
  const a = [];
  const u1 = (n) => a.push(n & 255);
  const u2 = (n) => { u1(n >>> 8); u1(n); };
  const u4 = (n) => { u2(n >>> 16); u2(n); };
  const utf = (s) => { const b = Buffer.from(s, 'utf8'); u1(1); u2(b.length); a.push(...b); };
  const cls = (i) => { u1(7); u2(i); };

  u4(0xcafebabe); u2(0); u2(61);
  u2(8);
  utf('C'); cls(1);
  utf('java/lang/Object'); cls(3);
  utf('java/lang/Runnable'); cls(5);
  cls(5);
  u2(0x0021); u2(2); u2(4);
  u2(interfaceIndices.length);
  for (const idx of interfaceIndices) u2(idx);
  u2(0); u2(0); u2(0);
  return Uint8Array.from(a);
}

test('#7373 the same CP index twice in interfaces[] is rejected as a duplicate interface name', () => {
  assert.throws(
    () => parseJvm(buildClass([6, 6])),
    (error) => error instanceof TypeError && error.message === 'jvm-duplicate-interface-name',
  );
});

test('#7373 two aliasing CONSTANT_Class entries naming one interface are rejected too', () => {
  assert.throws(
    () => parseJvm(buildClass([6, 7])),
    (error) => error instanceof TypeError && error.message === 'jvm-duplicate-interface-name',
  );
});

test('#7373 distinct direct superinterfaces keep parsing', () => {
  const parsed = parseJvm(buildClass([4, 6]));
  assert.deepEqual([...parsed.interfaces], ['java/lang/Object', 'java/lang/Runnable']);
});
