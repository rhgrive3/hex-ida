import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';

// A defining DIE need not repeat attributes already present on the
// non-defining declaration it specifies via DW_AT_specification (DWARF v5
// §2.13, §3.3.5). The provider must resolve that chain for name/type, and
// must not claim complete evidence when the reference dangles (#5738).

function uleb(value) {
  const out = [];
  do { let b = value & 0x7f; value >>>= 7; if (value) b |= 0x80; out.push(b); } while (value);
  return out;
}
const str = (s) => [...new TextEncoder().encode(s), 0];
const addr = (v) => { const out = []; for (let i = 0; i < 8; i++) out.push(Number((v >> BigInt(i * 8)) & 0xffn)); return out; };
const ref4 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];

const abbrev = Uint8Array.from([
  // 1: subprogram declaration: name/string, type/ref4, declaration/flag_present,
  // external/flag_present
  ...uleb(1), 0x2e, 0x00,
    ...uleb(0x03), ...uleb(0x08),
    ...uleb(0x49), ...uleb(0x13),
    ...uleb(0x3c), ...uleb(0x19),
    ...uleb(0x3f), ...uleb(0x19),
    0x00, 0x00,
  // 2: subprogram definition: specification/ref4, low_pc/addr, high_pc/data1
  ...uleb(2), 0x2e, 0x00,
    ...uleb(0x47), ...uleb(0x13),
    ...uleb(0x11), ...uleb(0x01),
    ...uleb(0x12), ...uleb(0x0b),
    0x00, 0x00,
  // 3: base type: name/string, byte_size/data1, encoding/data1
  ...uleb(3), 0x24, 0x00,
    ...uleb(0x03), ...uleb(0x08),
    ...uleb(0x0b), ...uleb(0x0b),
    ...uleb(0x3e), ...uleb(0x0b),
    0x00, 0x00,
  // 4: subprogram declaration/link: specification/ref4 only
  ...uleb(4), 0x2e, 0x00,
    ...uleb(0x47), ...uleb(0x13),
    0x00, 0x00,
  // 5: definition with direct name/type plus specification, address facts,
  // and an explicit external=false override
  ...uleb(5), 0x2e, 0x00,
    ...uleb(0x47), ...uleb(0x13),
    ...uleb(0x03), ...uleb(0x08),
    ...uleb(0x49), ...uleb(0x13),
    ...uleb(0x11), ...uleb(0x01),
    ...uleb(0x12), ...uleb(0x0b),
    ...uleb(0x3f), ...uleb(0x0c),
    0x00, 0x00,
  0x00,
]);

function buildDebugInfo(specTarget) {
  // DIE A @ 0x0b: declaration "C::f", type -> base DIE
  const dieA = [...uleb(1), ...str('C::f'), ...ref4(35)];
  // DIE B @ 0x15: definition via specification -> A, low_pc 0x1000, high_pc 0x10
  const dieB = [...uleb(2), ...ref4(specTarget), ...addr(0x1000n), 0x10];
  // DIE C @ 0x23: base type "int"
  const dieC = [...uleb(3), ...str('int'), 4, 5];
  const debug_info = Uint8Array.from([0, 0, 0, 0, 0x04, 0x00, 0, 0, 0, 0, 8, ...dieA, ...dieB, ...dieC]);
  new DataView(debug_info.buffer).setUint32(0, debug_info.length - 4, true);
  return debug_info;
}

function buildLinkedDebugInfo(emit) {
  const body = [];
  const labels = new Map();
  const patches = [];
  const builder = {
    label(name) { labels.set(name, 11 + body.length); },
    code(value) { body.push(...uleb(value)); },
    string(value) { body.push(...str(value)); },
    ref(target) {
      if (typeof target === 'number') body.push(...ref4(target));
      else { patches.push({ at: 11 + body.length, target }); body.push(0, 0, 0, 0); }
    },
    address(value) { body.push(...addr(value)); },
    byte(value) { body.push(value); },
  };
  emit(builder);
  const debug_info = Uint8Array.from([0, 0, 0, 0, 0x04, 0x00, 0, 0, 0, 0, 8, ...body]);
  const view = new DataView(debug_info.buffer);
  view.setUint32(0, debug_info.length - 4, true);
  for (const patch of patches) {
    const target = labels.get(patch.target);
    assert.notEqual(target, undefined, `missing DIE label ${patch.target}`);
    view.setUint32(patch.at, target, true);
  }
  return { debug_info, offsets: Object.fromEntries(labels) };
}

function probe(debug_info) {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    snapshotId: 'snap-5738',
    identity: {},
    debugSections: { '.debug_info': debug_info, '.debug_abbrev': abbrev },
  });
  return { result, symbols: provider.symbols(result).records, types: provider.types(result).records };
}

test('#5738: definition DIE inherits its name through DW_AT_specification', () => {
  const { symbols } = probe(buildDebugInfo(0x0b));
  const definition = symbols.find((r) => r.entityId === 'dwarf_die_21');
  assert.ok(definition, 'the definition DIE is present');
  assert.equal(definition.name, 'C::f', 'the name is inherited from the specification target');
  assert.equal(definition.address, '0x1000');
  assert.equal(definition.descriptor.external, true, 'the external flag is inherited from the specification target');
  assert.equal(definition.descriptor.complete, true);
});

test('#5738: definition DIE reaches its type through the specification chain', () => {
  const { types } = probe(buildDebugInfo(0x0b));
  const definition = types.find((r) => r.entityId === 'dwarf_die_21');
  assert.ok(definition, 'the definition participates in the type records');
  assert.equal(definition.descriptor.claim.name, 'int', 'the type is inherited through the specification target');
});

test('#5738: a dangling DW_AT_specification fails the record closed', () => {
  const { symbols } = probe(buildDebugInfo(0x7777));
  const definition = symbols.find((r) => r.entityId === 'dwarf_die_21');
  assert.ok(definition);
  assert.equal(definition.descriptor.complete, false, 'an unresolved specification is not complete evidence');
});

test('#5738: a nested dangling specification chain fails the definition closed', () => {
  const { debug_info, offsets } = buildLinkedDebugInfo((b) => {
    b.label('declaration'); b.code(4); b.ref(0x7777);
    b.label('definition'); b.code(2); b.ref('declaration'); b.address(0x2000n); b.byte(0x10);
  });
  const { symbols } = probe(debug_info);
  const definition = symbols.find((r) => r.entityId === `dwarf_die_${offsets.definition}`);
  assert.ok(definition);
  assert.equal(definition.name, null);
  assert.equal(definition.descriptor.complete, false, 'every specification hop must resolve');
});

test('#5738: a specification cycle fails closed without publishing complete evidence', () => {
  const { debug_info, offsets } = buildLinkedDebugInfo((b) => {
    b.label('declaration'); b.code(4); b.ref('definition');
    b.label('definition'); b.code(2); b.ref('declaration'); b.address(0x3000n); b.byte(0x10);
  });
  const { symbols } = probe(debug_info);
  const definition = symbols.find((r) => r.entityId === `dwarf_die_${offsets.definition}`);
  assert.ok(definition);
  assert.equal(definition.name, null);
  assert.equal(definition.descriptor.complete, false, 'cycles are unresolved specification evidence');
});

test('#5738: definition-owned name and type override specification attributes', () => {
  const { debug_info, offsets } = buildLinkedDebugInfo((b) => {
    b.label('declaration'); b.code(1); b.string('decl_fn'); b.ref('declType');
    b.label('definition'); b.code(5); b.ref('declaration'); b.string('direct_fn'); b.ref('directType'); b.address(0x4000n); b.byte(0x10); b.byte(0);
    b.label('declType'); b.code(3); b.string('int'); b.byte(4); b.byte(5);
    b.label('directType'); b.code(3); b.string('char'); b.byte(1); b.byte(6);
  });
  const { symbols, types } = probe(debug_info);
  const symbol = symbols.find((r) => r.entityId === `dwarf_die_${offsets.definition}`);
  const type = types.find((r) => r.entityId === `dwarf_die_${offsets.definition}`);
  assert.ok(symbol);
  assert.ok(type);
  assert.equal(symbol.name, 'direct_fn', 'definition-owned name wins');
  assert.equal(type.name, 'direct_fn');
  assert.equal(type.descriptor.claim.name, 'char', 'definition-owned type wins');
  assert.equal(symbol.descriptor.external, false, 'a direct false external flag overrides inherited true');
  assert.equal(symbol.descriptor.complete, true);
  assert.equal(type.descriptor.complete, true);
});
