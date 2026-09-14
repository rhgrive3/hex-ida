import assert from 'node:assert/strict';
import test from 'node:test';

import { RustMetadataProvider, demangleRustSymbol } from '../../../js/metadata/rust.js';

/* A user function named `vtable` (`_RNvC3foo6vtable` -> `foo::vtable`) and any
 * name merely containing "vtable" are ordinary Rust symbols (issue #5881).
 * Vtable evidence must be structural, never a demangled-name substring. */

function providerFor(symbols) {
  return new RustMetadataProvider({ symbols, binaryIdentity:'issue-5881' });
}

test('a user function named vtable is not promoted to a vtable record', () => {
  assert.equal(demangleRustSymbol('_RNvC3foo6vtable').demangled, 'foo::vtable');
  const provider = providerFor([{ name:'_RNvC3foo6vtable', address:0x1000 }]);
  const probe = provider.probe();
  assert.equal(probe.counts.symbols, 1, 'the symbol stays in the symbol page');
  assert.equal(probe.counts.vtables, 0, 'no vtable record may be minted from the name');
  assert.equal(provider.vtables().records.length, 0);
  const symbol = provider.symbols().records[0];
  assert.equal(symbol.name, 'foo::vtable', 'the ordinary symbol must remain present');
});

test('names merely containing vtable stay ordinary symbols', () => {
  const provider = providerFor([
    { name:'_RNvC3foo13vtable_helper', address:0x1010 },
    { name:'_RNvC3baz14get_vtable_ptr', address:0x1020 },
  ]);
  const probe = provider.probe();
  assert.equal(probe.counts.symbols, 2);
  assert.equal(probe.counts.vtables, 0);
  assert.equal(provider.vtables().records.length, 0);
  assert.equal(provider.symbols().records[0].name, 'foo::vtable_helper');
});

test('explicit structural evidence still produces vtable records', () => {
  const provider = providerFor([
    { name:'_ZN6my_app13MyTraitvtable17h1122334455667788E', address:0x3000, vtable:true },
  ]);
  const probe = provider.probe();
  assert.equal(probe.counts.vtables, 1);
  const records = provider.vtables().records;
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'vtable');
  assert.equal(records[0].name, 'my_app::MyTraitvtable');
  assert.equal(records[0].address, '0x3000');
});

test('legacy Rust symbols get no vtable authority from their spelling either', () => {
  const provider = providerFor([
    { name:'__ZN6my_app6vtableE', address:0x4000 },
  ]);
  const probe = provider.probe();
  const parsed = demangleRustSymbol('__ZN6my_app6vtableE');
  if (parsed.parsed) {
    assert.equal(probe.counts.vtables, 0,
      'legacy-spelled names cannot mint vtable evidence');
  }
});

test('vtable counts never grow from name substrings', () => {
  const provider = providerFor([
    { name:'_RNvC3foo6vtable', address:0x1000 },
    { name:'_RNvC3bar13vtable_helper', address:0x1010 },
    { name:'_RNvC3baz14get_vtable_ptr', address:0x1020 },
  ]);
  const probe = provider.probe();
  assert.equal(probe.counts.vtables, 0);
});
