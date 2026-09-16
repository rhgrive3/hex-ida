import assert from 'node:assert/strict';
import test from 'node:test';
import { applyVersionMetadata } from '../../../js/binary/elf-dynamic.js';

test('issue #4192: applyVersionMetadata disambiguates by tableIndex when .symtab and .dynsym have colliding symbolIndex', () => {
  const image = {
    imports: [
      { name: 'local_func', symbolIndex: 1, tableIndex: 2, version: null, versionIndex: null, versionLibrary: null },
      { name: 'puts', symbolIndex: 1, tableIndex: 4, version: null, versionIndex: null, versionLibrary: null },
    ],
    exports: [
      { name: 'local_export', symbolIndex: 2, tableIndex: 2, address: 0x1000n, version: null, versionIndex: null },
      { name: 'export_func', symbolIndex: 2, tableIndex: 4, address: 0x2000n, version: null, versionIndex: null },
    ],
    symbols: [
      { name: 'local_func', index: 1, tableIndex: 2, source: 'symtab', defined: false },
      { name: 'puts', index: 1, tableIndex: 4, source: 'dynsym', defined: false },
      { name: 'local_export', index: 2, tableIndex: 2, source: 'symtab', defined: true, address: 0x1000n },
      { name: 'export_func', index: 2, tableIndex: 4, source: 'dynsym', defined: true, address: 0x2000n },
    ],
  };

  const versions = new Map([
    [1, { index: 2, name: 'GLIBC_2.17', hidden: false, library: 'libc.so.6' }],
    [2, { index: 3, name: 'MY_LIB_1.0', hidden: false, library: null }],
  ]);

  applyVersionMetadata(image, versions);

  // puts import (dynsym) should have version GLIBC_2.17 and index 2
  const putsImport = image.imports.find((imp) => imp.name === 'puts');
  assert.equal(putsImport.version, 'GLIBC_2.17');
  assert.equal(putsImport.versionIndex, 2);
  assert.equal(putsImport.versionLibrary, 'libc.so.6');

  // local_func import (symtab) should NOT receive version
  const localImport = image.imports.find((imp) => imp.name === 'local_func');
  assert.equal(localImport.version, null);
  assert.equal(localImport.versionIndex, null);

  // export_func export (dynsym) should receive version MY_LIB_1.0 and index 3
  const dynExport = image.exports.find((ex) => ex.name === 'export_func');
  assert.equal(dynExport.version, 'MY_LIB_1.0');
  assert.equal(dynExport.versionIndex, 3);

  // local_export export (symtab) should NOT receive version
  const localExport = image.exports.find((ex) => ex.name === 'local_export');
  assert.equal(localExport.version, null);
  assert.equal(localExport.versionIndex, null);
});

test('issue #4192: applyVersionMetadata does not overwrite dynsym version when symtab has identical symbol name and index', () => {
  const image = {
    imports: [
      { name: 'puts', symbolIndex: 1, tableIndex: 2, version: null, versionIndex: null, versionLibrary: null },
      { name: 'puts', symbolIndex: 1, tableIndex: 4, version: null, versionIndex: null, versionLibrary: null },
    ],
    symbols: [
      { name: 'puts', index: 1, tableIndex: 2, source: 'symtab', defined: false },
      { name: 'puts', index: 1, tableIndex: 4, source: 'dynsym', defined: false },
    ],
  };

  const versions = new Map([
    [1, { index: 2, name: 'GLIBC_2.17', hidden: false, library: 'libc.so.6' }],
  ]);

  applyVersionMetadata(image, versions);

  const symtabImport = image.imports.find((imp) => imp.tableIndex === 2);
  const dynsymImport = image.imports.find((imp) => imp.tableIndex === 4);

  assert.equal(symtabImport.versionIndex, null, 'symtab import must not be touched');
  assert.equal(dynsymImport.versionIndex, 2, 'dynsym import must receive version');
  assert.equal(dynsymImport.version, 'GLIBC_2.17');
});
