// Regression for #5146: BinaryImage.finalize() dedupes imports/sites through
// dedupeImports(). Identity keys were built with String()/Array.join() coercion,
// so structured library/name/ordinal/addend/pointerFormat/type/version/
// versionLibrary values (and the same for sites) laundered into a
// canonical-looking key and merged into a real import.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BinaryImage } from '../js/binary/model.js';

function finalizeWith(...imports) {
  const image = new BinaryImage(new Uint8Array(1), { format: 'test' });
  image.imports.push(...imports);
  image.finalize();
  return image.imports;
}

test('#5146 structured import metadata never merges into a canonical import', () => {
  const imports = finalizeWith(
    {
      library: 'libA',
      name: 'foo',
      ordinal: 1,
      weak: false,
      address: 0x2000n,
      source: 'chained-fixups',
      sites: [{ address: 0x1000n, kind: 'got' }],
    },
    {
      library: ['libA'],
      name: ['foo'],
      ordinal: ['1'],
      weak: false,
      address: 0x3000n,
      source: 'structured-metadata',
      sites: [{ address: ['4096'], kind: ['got'] }],
    },
  );
  assert.equal(imports.length, 2);
  assert.deepEqual(imports.map((i) => i.source), ['chained-fixups', 'structured-metadata']);
  assert.equal(imports[0].sites.length, 1);
  assert.equal(imports[0].sites[0].address, 0x1000n);
  assert.equal(imports[0].address, 0x2000n);
  assert.deepEqual(imports[1].library, ['libA']);
});

test('#5146 a canonical import is not absorbed by a structured record that precedes it', () => {
  const imports = finalizeWith(
    { library: ['libA'], name: ['foo'], ordinal: ['1'], weak: false, source: 'structured', sites: [] },
    { library: 'libA', name: 'foo', ordinal: 1, weak: false, source: 'canonical', sites: [{ address: 0x1000n, kind: 'got' }] },
  );
  assert.equal(imports.length, 2);
  assert.equal(imports[0].source, 'structured');
  assert.equal(imports[0].sites.length, 0);
  assert.equal(imports[1].source, 'canonical');
  assert.equal(imports[1].sites.length, 1);
});

test('#5146 every structured identity field stays out of the canonical import key', () => {
  const fields = ['library', 'name', 'ordinal', 'addend', 'pointerFormat', 'type', 'version', 'versionLibrary'];
  for (const field of fields) {
    const canonical = { library: 'L', name: 'f', ordinal: 3, weak: false, sites: [] };
    const structured = { library: 'L', name: 'f', ordinal: 3, weak: false, sites: [] };
    structured[field] = field === 'library' || field === 'name' || field === 'version' || field === 'versionLibrary'
      ? ['L'] : ['3'];
    const imports = finalizeWith(canonical, structured);
    assert.equal(imports.length, 2, `structured ${field} laundered into canonical import identity`);
  }
  const structuredWeak = finalizeWith(
    { library: 'L', name: 'f', ordinal: 3, weak: false, sites: [] },
    { library: 'L', name: 'f', ordinal: 3, weak: ['x'], sites: [] },
  );
  assert.equal(structuredWeak.length, 2);
});

function launders(text) {
  return { toString: () => text, valueOf: () => text };
}

test('#5146 structured site identity never dedupes into a canonical site', () => {
  const imports = finalizeWith({
    library: 'L',
    name: 'f',
    ordinal: 1,
    sites: [
      { address: 1n, offset: 0n, kind: 'bind', type: 1, addend: 0n, pointerFormat: 1, weak: false },
      {
        address: [1n], offset: [0n], kind: ['bind'], type: [1], addend: [0n],
        pointerFormat: [1], weak: false,
      },
      {
        address: launders('1'), offset: launders('0'), kind: launders('bind'), type: launders('1'),
        addend: launders('0'), pointerFormat: launders('1'), weak: false,
      },
    ],
  });
  assert.equal(imports.length, 1);
  assert.equal(imports[0].sites.length, 3);
});

test('#5146 structured import metadata keeps its own sites separate', () => {
  const imports = finalizeWith(
    { library: 'L', name: 'f', ordinal: 1, sites: [{ address: 1n, offset: 0n, kind: 'bind' }] },
    {
      library: launders('L'), name: launders('f'), ordinal: launders('1'),
      sites: [{ address: launders('1'), offset: launders('0'), kind: launders('bind') }],
    },
  );
  assert.equal(imports.length, 2);
  assert.equal(imports[0].sites.length, 1);
  assert.equal(imports[1].sites.length, 1);
});

test('#5146 valid duplicate imports and sites keep merging', () => {
  const imports = finalizeWith(
    {
      library: 'L',
      name: 'f',
      ordinal: 1n,
      weak: false,
      addend: 0n,
      pointerFormat: 2,
      version: 'v1',
      versionLibrary: 'L',
      sites: [{ address: 1n, offset: 1n, kind: 'bind', type: 1, addend: 0n, pointerFormat: 2, weak: false }],
    },
    {
      library: 'L',
      name: 'f',
      ordinal: 1n,
      weak: false,
      addend: 0n,
      pointerFormat: 2,
      version: 'v1',
      versionLibrary: 'L',
      source: 'elf-dynsym',
      address: 0x4000n,
      sites: [
        { address: 1n, offset: 1n, kind: 'bind', type: 1, addend: 0n, pointerFormat: 2, weak: false },
        { address: 2n, offset: 2n, kind: 'bind', type: 1, addend: 0n, pointerFormat: 2, weak: false },
      ],
    },
  );
  assert.equal(imports.length, 1);
  assert.equal(imports[0].source, 'elf-dynsym');
  assert.equal(imports[0].address, 0x4000n);
  assert.equal(imports[0].sites.length, 2);
});

test('#5146 distinct valid imports and sites are never merged', () => {
  const imports = finalizeWith(
    { library: 'L', name: 'f', ordinal: 1, sites: [{ address: 1n, kind: 'bind' }] },
    { library: 'L', name: 'f', ordinal: 2, sites: [{ address: 1n, kind: 'bind' }] },
    { library: 'M', name: 'f', ordinal: 1, sites: [{ address: 1n, kind: 'bind' }] },
    { library: 'L', name: 'g', ordinal: 1, sites: [{ address: 1n, kind: 'bind' }] },
    { library: 'L', name: 'f', ordinal: 1, weak: true, sites: [{ address: 1n, kind: 'bind' }] },
    { library: 'L', name: 'f', ordinal: 1, addend: 4n, sites: [{ address: 1n, kind: 'bind' }] },
    { library: 'L', name: 'f', ordinal: 1, pointerFormat: 3, sites: [{ address: 1n, kind: 'bind' }] },
    { library: 'L', name: 'f', ordinal: 1, version: 'v2', sites: [{ address: 1n, kind: 'bind' }] },
    { library: 'L', name: 'f', ordinal: 1, versionLibrary: 'V', sites: [{ address: 1n, kind: 'bind' }] },
  );
  assert.equal(imports.length, 9);
});
