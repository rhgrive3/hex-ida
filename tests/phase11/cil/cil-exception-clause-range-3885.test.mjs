import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCil } from '../../../js/managed/cil/parser.js';

function buildEhPeCli({
  fatClause = true,
  codeSize = 16,
  clause = {},
} = {}) {
  const buf = new Uint8Array(0x900);
  const view = new DataView(buf.buffer);

  // One-section PE32 image. RVA 0x2000 maps to file offset 0x200.
  buf[0] = 0x4d; buf[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  buf.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x86, 1, true);
  view.setUint16(0x94, 0xe0, true);
  const optionalOffset = 0x98;
  view.setUint16(optionalOffset, 0x10b, true);
  view.setUint32(optionalOffset + 92, 16, true);
  view.setUint32(optionalOffset + 96 + 14 * 8, 0x2000, true);
  view.setUint32(optionalOffset + 96 + 14 * 8 + 4, 72, true);

  const sectionOffset = optionalOffset + 0xe0;
  view.setUint32(sectionOffset + 8, 0x700, true);
  view.setUint32(sectionOffset + 12, 0x2000, true);
  view.setUint32(sectionOffset + 16, 0x700, true);
  view.setUint32(sectionOffset + 20, 0x200, true);

  const cliOffset = 0x200;
  view.setUint32(cliOffset, 72, true);
  view.setUint32(cliOffset + 8, 0x2100, true);
  view.setUint32(cliOffset + 12, 0x200, true);

  const metadataOffset = 0x300;
  view.setUint32(metadataOffset, 0x424a5342, true);
  view.setUint16(metadataOffset + 4, 1, true);
  view.setUint16(metadataOffset + 6, 1, true);
  const version = new TextEncoder().encode('v4.0.30319\0\0');
  view.setUint32(metadataOffset + 12, version.length, true);
  buf.set(version, metadataOffset + 16);

  const flagsOffset = (metadataOffset + 16 + version.length + 3) & ~3;
  view.setUint16(flagsOffset + 2, 1, true);
  let streamPos = flagsOffset + 4;
  view.setUint32(streamPos, 0x80, true);
  view.setUint32(streamPos + 4, 0x80, true);
  streamPos += 8;
  buf.set(new TextEncoder().encode('#~\0'), streamPos);

  const tablesOffset = metadataOffset + 0x80;
  view.setUint32(tablesOffset + 8, 1 << 6, true);
  let tablePos = tablesOffset + 24;
  view.setUint32(tablePos, 1, true);
  tablePos += 4;
  view.setUint32(tablePos, 0x2300, true);

  const methodOffset = 0x500;
  view.setUint16(methodOffset, 0x300b, true); // fat format, 3-DWORD header, MoreSects
  view.setUint16(methodOffset + 2, 8, true);
  view.setUint32(methodOffset + 4, codeSize, true);
  view.setUint32(methodOffset + 8, 0, true);
  const codeOffset = methodOffset + 12;
  if (codeSize > 0) {
    buf.fill(0x00, codeOffset, codeOffset + codeSize);
    buf[codeOffset + codeSize - 1] = 0x2a;
  }

  const values = {
    kind: 'catch',
    tryOffset: 0,
    tryLength: 4,
    handlerOffset: 8,
    handlerLength: 4,
    classTokenOrFilter: 0x01000001,
    ...clause,
  };
  const clauseFlags = values.flags ?? (values.kind === 'filter' ? 1 : values.kind === 'finally' ? 2 : values.kind === 'fault' ? 4 : 0);
  const extraOffset = (codeOffset + codeSize + 3) & ~3;
  const clauseSize = fatClause ? 24 : 12;
  const dataSize = 4 + clauseSize;
  buf[extraOffset] = fatClause ? 0x41 : 0x01;
  buf[extraOffset + 1] = dataSize & 0xff;
  buf[extraOffset + 2] = (dataSize >>> 8) & 0xff;
  buf[extraOffset + 3] = (dataSize >>> 16) & 0xff;
  const clauseOffset = extraOffset + 4;

  if (fatClause) {
    view.setUint32(clauseOffset, clauseFlags, true);
    view.setUint32(clauseOffset + 4, values.tryOffset, true);
    view.setUint32(clauseOffset + 8, values.tryLength, true);
    view.setUint32(clauseOffset + 12, values.handlerOffset, true);
    view.setUint32(clauseOffset + 16, values.handlerLength, true);
    view.setUint32(clauseOffset + 20, values.classTokenOrFilter, true);
  } else {
    view.setUint16(clauseOffset, clauseFlags, true);
    view.setUint16(clauseOffset + 2, values.tryOffset, true);
    buf[clauseOffset + 4] = values.tryLength;
    view.setUint16(clauseOffset + 5, values.handlerOffset, true);
    buf[clauseOffset + 7] = values.handlerLength;
    view.setUint32(clauseOffset + 8, values.classTokenOrFilter, true);
  }

  return buf;
}

test('#3885 valid fat and small EH clauses remain publishable', () => {
  for (const fatClause of [true, false]) {
    const image = parseCil(buildEhPeCli({ fatClause }));
    assert.equal(image.methodBodies.length, 1);
    assert.deepEqual(
      image.methodBodies[0].exceptionClauses[0],
      {
        kind: 'catch',
        tryOffset: 0,
        tryLength: 4,
        handlerOffset: 8,
        handlerLength: 4,
        classTokenOrFilter: 0x01000001,
      },
    );
  }
});

test('#3885 fat EH ranges fail closed when try or handler escapes code', () => {
  for (const clause of [
    { tryOffset: 1, tryLength: 100, handlerOffset: 1, handlerLength: 1 },
    { tryOffset: 0, tryLength: 0 },
    { tryOffset: 12, tryLength: 5 },
    { handlerOffset: 8, handlerLength: 0 },
    { handlerOffset: 16, handlerLength: 1 },
    { handlerOffset: 15, handlerLength: 2 },
  ]) {
    const codeSize = clause.tryLength === 100 ? 1 : 16;
    assert.throws(
      () => parseCil(buildEhPeCli({ codeSize, clause })),
      /cil-invalid-exception-clause-range/,
    );
  }
});

test('#3885 small EH clauses use the same code-range invariant', () => {
  assert.throws(
    () => parseCil(buildEhPeCli({
      fatClause: false,
      clause: { handlerOffset: 16, handlerLength: 1 },
    })),
    /cil-invalid-exception-clause-range/,
  );
});

test('#3885 filter offsets must identify code positions', () => {
  const valid = parseCil(buildEhPeCli({
    clause: { kind: 'filter', classTokenOrFilter: 4 },
  }));
  assert.equal(valid.methodBodies[0].exceptionClauses[0].classTokenOrFilter, 4);

  assert.throws(
    () => parseCil(buildEhPeCli({
      clause: { kind: 'filter', classTokenOrFilter: 16 },
    })),
    /cil-invalid-exception-filter-offset/,
  );
});

test('#3885 filters must form a non-empty range before their handler', () => {
  for (const fatClause of [true, false]) {
    for (const filterOffset of [8, 9, 15]) {
      assert.throws(
        () => parseCil(buildEhPeCli({
          fatClause,
          clause: { kind: 'filter', classTokenOrFilter: filterOffset },
        })),
        /cil-invalid-exception-filter-offset/,
        `filter ${filterOffset} must precede handler 8 (${fatClause ? 'fat' : 'small'})`,
      );
    }
  }
});

test('#3885 full-width fat EH offsets and lengths cannot wrap into code', () => {
  for (const clause of [
    { tryOffset: 0xffffffff, tryLength: 1 },
    { tryOffset: 1, tryLength: 0xffffffff },
    { handlerOffset: 0xffffffff, handlerLength: 1 },
    { handlerOffset: 1, handlerLength: 0xffffffff },
  ]) {
    assert.throws(
      () => parseCil(buildEhPeCli({ clause })),
      /cil-invalid-exception-clause-range/,
    );
  }
});


test('#4844 malformed fat and small EH flags cannot become catch metadata', () => {
  for (const fatClause of [true, false]) {
    const invalidFlags = [3, 5, 6, 7, 8, 0x8000, 0xffff];
    if (fatClause) invalidFlags.push(0x80000000, 0xffffffff);
    for (const flags of invalidFlags) {
      assert.throws(
        () => parseCil(buildEhPeCli({ fatClause, clause: { flags } })),
        /cil-invalid-exception-clause-flags/,
        `flags ${flags} must not become catch (${fatClause ? 'fat' : 'small'})`,
      );
    }
  }
});

test('#4844 every supported EH kind remains valid at the exact code-end boundary', () => {
  for (const fatClause of [true, false]) {
    for (const kind of ['catch', 'filter', 'finally', 'fault']) {
      const image = parseCil(buildEhPeCli({
        fatClause,
        clause: { kind, handlerLength: 8, classTokenOrFilter: kind === 'filter' ? 4 : 0x01000001 },
      }));
      const clause = image.methodBodies[0].exceptionClauses[0];
      assert.equal(clause.kind, kind);
      assert.equal(clause.handlerOffset + clause.handlerLength, image.methodBodies[0].codeSize);
    }
  }
});
