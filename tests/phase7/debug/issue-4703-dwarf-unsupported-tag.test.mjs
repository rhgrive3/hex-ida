import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

function uleb(value) {
  let n = BigInt(value);
  const out = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

function debugInfo(body) {
  const out = Uint8Array.from([
    0, 0, 0, 0,
    0x04, 0x00,
    0, 0, 0, 0,
    0x08,
    ...body,
  ]);
  new DataView(out.buffer).setUint32(0, out.length - 4, true);
  return out;
}

function abbrevEntry(code, tag, hasChildren = false, attributes = []) {
  return [
    ...uleb(code), ...uleb(tag), hasChildren ? 1 : 0,
    ...attributes.flatMap(([attribute, form]) => [...uleb(attribute), ...uleb(form)]),
    0, 0,
  ];
}

function parseWithUnsupportedTag(tag, { attributes = [], values = [] } = {}) {
  const debug_abbrev = Uint8Array.from([
    ...abbrevEntry(1, 0x11, true), // DW_TAG_compile_unit
    ...abbrevEntry(2, tag, false, attributes),
    ...abbrevEntry(3, 0x2e, false), // DW_TAG_subprogram
    0,
  ]);
  return parseDebugInfo({
    debug_abbrev,
    debug_info: debugInfo([1, 2, ...values, 3, 0]),
  });
}

test('#4703 supported DWARF tags can still produce complete evidence', () => {
  const out = parseDebugInfo({
    debug_abbrev: Uint8Array.from([...abbrevEntry(1, 0x11), 0]),
    debug_info: debugInfo([1]),
  });
  assert.equal(out.complete, true);
  assert.deepEqual(out.diagnostics, []);
  assert.equal([...out.dies.values()][0].complete, true);
});

test('#4703 an unsupported standard tag is diagnostic and incomplete without aborting siblings', () => {
  const out = parseWithUnsupportedTag(0x39); // DW_TAG_namespace, not modeled by this reader
  const dies = [...out.dies.values()];
  const unknown = dies.find((die) => die.tag === 0x39);
  const sibling = dies.find((die) => die.tag === 0x2e);

  assert.equal(out.complete, false);
  assert.ok(out.diagnostics.some((diagnostic) => diagnostic.includes('unsupported tag 0x39')),
    JSON.stringify(out.diagnostics));
  assert.equal(unknown?.complete, false);
  assert.equal(sibling?.complete, true, 'a semantically unsupported sibling must not desynchronize the DIE tree');
});

test('#4703 vendor tags fail closed too', () => {
  const out = parseWithUnsupportedTag(0x4080);
  const unknown = [...out.dies.values()].find((die) => die.tag === 0x4080);
  assert.equal(out.complete, false);
  assert.equal(unknown?.complete, false);
  assert.ok(out.diagnostics.some((diagnostic) => diagnostic.includes('unsupported tag 0x4080')));
});

test('#4703 known forms on an unsupported tag stay parsed but cannot authorize completeness', () => {
  // DW_AT_name / DW_FORM_string proves syntax can be retained while semantic
  // authority remains fail-closed for the unknown DIE kind.
  const out = parseWithUnsupportedTag(0x39, {
    attributes: [[0x03, 0x08]],
    values: [...new TextEncoder().encode('scope'), 0],
  });
  const unknown = [...out.dies.values()].find((die) => die.tag === 0x39);
  assert.equal(unknown?.attributes.get(0x03)?.value, 'scope');
  assert.equal(unknown?.complete, false);
  assert.equal(out.complete, false);
});

test('#4703 an unsupported tag with children preserves tree synchronization while staying incomplete', () => {
  const debug_abbrev = Uint8Array.from([
    ...abbrevEntry(1, 0x11, true),   // compile_unit
    ...abbrevEntry(2, 0x4081, true), // unknown vendor scope with children
    ...abbrevEntry(3, 0x2e, false),  // supported child/sibling subprogram
    0,
  ]);
  const out = parseDebugInfo({
    debug_abbrev,
    // CU -> unknown scope -> subprogram -> close unknown -> subprogram -> close CU
    debug_info: debugInfo([1, 2, 3, 0, 3, 0]),
  });
  const dies = [...out.dies.values()];
  const unknown = dies.find((die) => die.tag === 0x4081);
  const programs = dies.filter((die) => die.tag === 0x2e);

  assert.equal(out.complete, false);
  assert.equal(unknown?.complete, false);
  assert.equal(programs.length, 2);
  assert.equal(programs[0]?.parent, unknown?.offset, 'known descendants retain the parsed parent relation');
  assert.equal(programs[0]?.complete, true);
  assert.equal(programs[1]?.complete, true, 'the sibling after the unknown subtree remains synchronized');
  assert.ok(out.diagnostics.some((diagnostic) => diagnostic.includes('unsupported tag 0x4081')));
});
