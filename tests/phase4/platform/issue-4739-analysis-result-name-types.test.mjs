import assert from 'node:assert/strict';
import vm from 'node:vm';
import { analysisFromBinaryImage } from '../../../js/platform/analysis-result.js';
import { SymbolIndex } from '../../../js/symbols.js';

function baseImage(overrides = {}) {
  return {
    format: 'macho',
    symbols: [],
    exports: [],
    imports: [],
    functions: [],
    metadata: { functionDiscovery: { complete: false } },
    ...overrides,
  };
}

// #4739: platform metadata is an identity boundary. Structured values must
// never be String()-coerced into canonical symbol names before SymbolIndex.
{
  let coercions = 0;
  const structured = {
    toString() { coercions++; return '_laundered'; },
    valueOf() { coercions++; return '_laundered'; },
    [Symbol.toPrimitive]() { coercions++; return '_laundered'; },
  };
  const result = analysisFromBinaryImage(baseImage({
    symbols: [
      { defined: true, address: 0x1000n, name: ['array_symbol'], source: 'LC_SYMTAB' },
      { defined: true, address: 0x1004n, name: structured, source: 'LC_SYMTAB' },
      { defined: true, address: 0x1008n, name: 42, source: 'LC_SYMTAB' },
      { defined: true, address: 0x100cn, name: true, source: 'LC_SYMTAB' },
      { defined: true, address: 0x1010n, name: new String('boxed_symbol'), source: 'LC_SYMTAB' },
      { defined: true, address: 0x1014n, name: Symbol('symbol_name'), source: 'LC_SYMTAB' },
    ],
    exports: [
      { address: 0x1020n, name: ['array_export'], source: 'exports-trie' },
      { address: 0x1024n, name: structured, source: 'exports-trie' },
    ],
    imports: [
      { name: ['array_import'], source: 'dyld-bind', sites: [{ address: 0x2000n, kind: 'bind' }] },
      { name: structured, source: 'dyld-bind', sites: [{ address: 0x2008n, kind: 'bind' }] },
    ],
  }));

  assert.deepEqual(result.names, [], 'structured names must not enter canonical analysis transport');
  assert.equal(result.symbolCount, 0);
  assert.equal(result.nameProvenance.length, 0);
  assert.equal(coercions, 0, 'rejecting a structured identity must not execute user-controlled coercion hooks');

  const index = new SymbolIndex({ ...result, regions: [] });
  assert.equal(index.symbolTransportValid, true, 'filtered transport remains internally valid');
  assert.equal(index.symbolCount, 0);
  assert.equal(index.nameAt(0x1000n), null);
  assert.equal(index.nearest(0x2008n), null);
}

// Valid primitive strings preserve existing symbol/export/import priority,
// merge, export flag, and provenance semantics byte-for-byte.
{
  const crossRealmName = vm.runInNewContext(`'cross_realm'`);
  assert.equal(typeof crossRealmName, 'string');
  const result = analysisFromBinaryImage(baseImage({
    symbols: [
      { defined: true, address: 0x3000n, name: 'symbol_name', exported: false, source: 'LC_SYMTAB' },
      { defined: true, address: 0x3010n, name: '', exported: false, source: 'LC_SYMTAB' },
    ],
    exports: [
      { address: 0x3000n, name: 'export_name', source: 'exports-trie' },
      { address: 0x3020n, name: '  whitespace-preserved  ', source: 'exports-trie' },
      { address: 0x3028n, name: crossRealmName, source: 'exports-trie' },
    ],
    imports: [
      { name: 'import_name', source: 'dyld-bind', sites: [{ address: 0x3000n, kind: 'bind' }] },
      { name: 'other_import', source: 'lazy-bind', sites: [{ address: 0x3030n, kind: 'lazy-bind' }] },
    ],
  }));

  assert.deepEqual([...result.addrs], [0x3000n, 0x3020n, 0x3028n, 0x3030n]);
  assert.deepEqual(result.names, ['import_name', '  whitespace-preserved  ', 'cross_realm', 'other_import']);
  assert.deepEqual([...result.kinds], [2, 0, 0, 2]);
  assert.deepEqual([...result.flags], [1, 1, 1, 0], 'lower-priority exported evidence still merges its export bit');
  assert.equal(result.nameProvenance[0]?.source, 'bind');
  assert.equal(result.nameProvenance[1]?.source, 'exports-trie');
  assert.equal(result.nameProvenance[2]?.source, 'exports-trie');
  assert.equal(result.nameProvenance[3]?.source, 'lazy-bind');

  const index = new SymbolIndex({ ...result, regions: [] });
  assert.equal(index.symbolTransportValid, true);
  assert.equal(index.nameAt(0x3000n), 'import_name');
  assert.equal(index.nameAt(0x3020n), '  whitespace-preserved  ');
  assert.equal(index.nameAt(0x3028n), 'cross_realm');
  assert.equal(index.nameAt(0x3030n), 'other_import');
}

console.log('issue #4739 platform analysis symbol-name identity regression: PASS');
