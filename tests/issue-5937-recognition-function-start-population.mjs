import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SymbolIndex } from '../js/symbols.js';

/* Recognition's population is the function-start collection, not the
 * named-symbol collection (issue #5937): `addrs` also holds data/stub/pointer
 * symbols and can be legitimately empty while `funcs` carries the complete
 * function starts of a stripped binary. */

const textRegion = { id:'text', vmAddr:0x1000n, size:0x200n, exec:true };

{
  const sym = new SymbolIndex({
    addrs:new BigUint64Array(0),
    kinds:new Uint8Array(0),
    flags:new Uint8Array(0),
    names:[],
    funcs:new BigUint64Array([0x1000n, 0x1100n]),
    functionStartsComplete:true,
    regions:[textRegion],
  });
  assert.equal(sym.symbolCount, 0);
  assert.equal(sym.functionCount, 2, 'stripped functions live in funcs, not addrs');
  assert.equal(sym.nameAt(0x1000n), null, 'stripped functions have no name');
  const bound = sym.functionWindowBound(0x1000n);
  assert.equal(bound, 0x1100n, 'the function-window contract bounds the first function at the next start');
  assert.equal(sym.functionWindowBound(0x1100n), null, 'the last function has no derived window bound');
}

{
  const sym = new SymbolIndex({
    addrs:new BigUint64Array([0x2000n, 0x2010n]),
    kinds:new Uint8Array([2, 1]),
    flags:new Uint8Array([0, 0]),
    names:['_global_ptr', '_global_value'],
    funcs:new BigUint64Array([0x1000n]),
    functionStartsComplete:true,
    regions:[textRegion],
  });
  assert.equal(sym.functionCount, 1, 'data symbols are not function starts');
  assert.equal(sym.nameAt(0x1000n), null);
  assert.equal(sym.nameAt(0x2000n), '_global_ptr', 'names stay attached to their own collection');
  assert.equal(sym.functionWindowBound(0x1000n), null,
    'data-symbol distance must never bound a function window');
}

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const ensureRecognition = appSource.slice(
  appSource.indexOf('async ensureRecognition'),
  appSource.indexOf('ownerOf(addr) {'),
);

/* The recognition loop must consume the function-start contract. */
assert.match(ensureRecognition, /sym\?\.functionCount\|\|0/,
  'the recognition population total must be the function-start count');
assert.match(ensureRecognition, /sym\.funcs\[i\]/,
  'recognition must iterate function starts, not named symbols');
assert.match(ensureRecognition, /sym\.nameAt\?\.\(address\)/,
  'function names must come from the exact-name lookup at the function start');
assert.match(ensureRecognition, /sym\.functionWindowBound\?\.\(address\)/,
  'function sizes must come from the function-window contract');
assert.doesNotMatch(ensureRecognition, /sym\.addrs\[/,
  'ensureRecognition must no longer treat named symbols as functions');
assert.match(ensureRecognition, /complete:count===total&&sym\.functionStartsComplete===true/,
  'recognition completeness must reflect function-discovery completeness');
assert.match(ensureRecognition, /'function-discovery-incomplete'/,
  'incomplete function discovery must be reported as its own truncation reason');
