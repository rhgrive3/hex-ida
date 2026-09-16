import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJvm } from '../../../js/managed/jvm/parser.js';

// Constant-pool assembler with an explicit entry list so tests can alias one
// Utf8 through thousands of CONSTANT_Class/NameAndType entries (#8718).
function assembleClass({ entries, thisClass, superClass, majorVersion = 52 }) {
  const enc = new TextEncoder();
  const chunks = [];
  const header = new Uint8Array(10);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0xcafebabe, false);
  hv.setUint16(4, 0, false);
  hv.setUint16(6, majorVersion, false);
  hv.setUint16(8, entries.length + 1, false);
  chunks.push(header);
  for (const entry of entries) {
    if (entry.utf8 !== undefined) {
      const bytes = enc.encode(entry.utf8);
      const head = new Uint8Array(3);
      new DataView(head.buffer).setUint16(1, bytes.length, false);
      head[0] = 1;
      chunks.push(head, bytes);
    } else if (entry.tag === 7 || entry.tag === 12) {
      const b = new Uint8Array(entry.tag === 7 ? 3 : 5);
      b[0] = entry.tag;
      const v = new DataView(b.buffer);
      v.setUint16(1, entry.a, false);
      if (entry.tag === 12) v.setUint16(3, entry.b, false);
      chunks.push(b);
    } else {
      throw new Error(`unsupported fixture entry ${JSON.stringify(entry)}`);
    }
  }
  const tail = new Uint8Array(14);
  const tv = new DataView(tail.buffer);
  tv.setUint16(0, 0x0001, false); // access_flags: public
  tv.setUint16(2, thisClass, false);
  tv.setUint16(4, superClass, false);
  tv.setUint16(6, 0, false); // interfaces_count
  tv.setUint16(8, 0, false); // fields_count
  tv.setUint16(10, 0, false); // methods_count
  tv.setUint16(12, 0, false); // attributes_count
  chunks.push(tail);
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of chunks) { out.set(chunk, p); p += chunk.length; }
  return out;
}

function aliasEntries(nameText, aliasCount, tag = 7) {
  // CP #1 is the shared Utf8; #2..(N+1) alias it; returns entries plus the
  // first free CP index.
  const entries = [{ utf8: nameText }];
  for (let i = 0; i < aliasCount; i++) entries.push(tag === 7 ? { tag: 7, a: 1 } : { tag: 12, a: 2, b: 1 });
  return entries;
}

test('#8718 20k CONSTANT_Class aliases of one 60 KiB name complete in linear work', () => {
  const shared = `${'a/'.repeat(29999)}a`; // ~60 KiB, 30k non-empty segments, valid
  const entries = aliasEntries(shared, 20000);
  const tIdx = entries.length + 1;
  entries.push({ utf8: 'T' }, { tag: 7, a: tIdx });
  const oIdx = entries.length + 1;
  entries.push({ utf8: 'java/lang/Object' }, { tag: 7, a: oIdx });
  const bytes = assembleClass({ entries, thisClass: tIdx + 1, superClass: oIdx + 1 });
  assert.ok(bytes.length > 100000, `fixture stays ~120 KiB (got ${bytes.length})`);
  const started = process.hrtime.bigint();
  const image = parseJvm(bytes); // deterministic guard: a re-introduced
  // per-reference rescan trips jvm-constant-pool-validation-budget-exceeded
  // instead of silently re-splitting the shared name.
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(image.thisClassName, 'T');
  assert.equal(image.constantPool.length, entries.length + 1);
  assert.ok(elapsedMs < 1500, `parse took ${elapsedMs}ms`);
});

test('#8718 slash-heavy valid class names are still accepted exactly as before', () => {
  const long = `${'pkg/'.repeat(500)}Main`;
  const entries = [{ utf8: long }, { tag: 7, a: 1 }, { utf8: 'java/lang/Object' }, { tag: 7, a: 3 }];
  const image = parseJvm(assembleClass({ entries, thisClass: 2, superClass: 4 }));
  assert.equal(image.thisClassName, long);
});

test('#8718 malformed class names fail closed regardless of aliasing', () => {
  for (const bad of ['a//b', '/a', 'a/', '.', 'a.b', 'a;b', 'a[;', '']) {
    const entries = aliasEntries(bad, 50);
    const objectNameIdx = entries.length + 1;
    entries.push({ utf8: 'java/lang/Object' }, { tag: 7, a: objectNameIdx });
    assert.throws(
      () => parseJvm(assembleClass({ entries, thisClass: 2, superClass: entries.length })),
      (error) => error instanceof TypeError && error.message.includes('jvm-invalid'),
      `name ${JSON.stringify(bad)} must fail closed`,
    );
  }
});

test('#8718 array-type class names keep their asymmetric rules under aliases', () => {
  // '[I' is a legal CONSTANT_Class_info name (JVMS §4.4.1)…
  const entries = aliasEntries('[I', 500);
  entries.push({ utf8: 'java/lang/Object' }, { tag: 7, a: entries.length + 1 });
  const asMember = assembleClass({ entries, thisClass: 503, superClass: 503 });
  assert.equal(parseJvm(asMember).thisClassName, 'java/lang/Object');

  // …but never a defining-class identity (#7162).
  const defining = aliasEntries('[I', 5);
  const objectNameIdx = defining.length + 1;
  defining.push({ utf8: 'java/lang/Object' }, { tag: 7, a: objectNameIdx });
  assert.throws(
    () => parseJvm(assembleClass({ entries: defining, thisClass: 2, superClass: objectNameIdx + 1 })),
    (error) => error instanceof TypeError && error.message === 'jvm-invalid-this-class-index',
  );
});

test('#8718 thousands of NameAndType aliases of one 60 KiB field descriptor parse once', () => {
  const descriptor = `[L${'a/'.repeat(20000)}a;`; // ~40 KiB valid field descriptor
  const nameIdx = 1, descIdx = 2;
  const entries = [{ utf8: 'm' }, { utf8: descriptor }];
  for (let i = 0; i < 20000; i++) entries.push({ tag: 12, a: nameIdx, b: descIdx });
  const oIdx = entries.length + 1;
  entries.push({ utf8: 'java/lang/Object' }, { tag: 7, a: oIdx });
  const started = process.hrtime.bigint();
  const image = parseJvm(assembleClass({ entries, thisClass: oIdx + 1, superClass: oIdx + 1 }));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(image.thisClassName, 'java/lang/Object');
  assert.ok(elapsedMs < 1500, `parse took ${elapsedMs}ms`);

  // An invalid shared descriptor still fails closed.
  const badEntries = [{ utf8: 'm' }, { utf8: `[L${'a//'.repeat(200)}b;` }];
  for (let i = 0; i < 10; i++) badEntries.push({ tag: 12, a: nameIdx, b: descIdx });
  assert.throws(
    () => parseJvm(assembleClass({ entries: badEntries, thisClass: 0, superClass: 0 })),
    (error) => error instanceof TypeError && error.message === 'jvm-invalid-cp-nameandtype-descriptor',
  );
});
