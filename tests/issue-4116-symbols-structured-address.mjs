/**
 * #4116 regression: SymbolIndex.addNames/addFunctions are metadata insertion
 * boundaries. Structured addresses (Array/Object/boolean) must not be promoted
 * into canonical symbol/function identity through BigUint64Array ToBigInt or
 * toString() coercion; they must be refused fail-closed without provenance.
 */
import assert from 'node:assert/strict';
import { SymbolIndex } from '../js/symbols.js';

function emptyIndex() {
  return new SymbolIndex({
    addrs: new BigUint64Array(0), kinds: new Uint8Array(0), flags: new Uint8Array(0), names: [],
  });
}

// 1. addFunctions([['4096']]) must not mint a 4096n function start.
{
  const index = emptyIndex();
  const added = index.addFunctions([['4096']]);
  assert.equal(added, 0, 'array-wrapped address adds no function');
  assert.equal(index.funcs.length, 0, 'funcs transport stays empty');
  assert.equal(index.isFunctionStart(4096n), false);
  assert.equal(index.functionEvidence(4096n), null, 'no provenance may exist for a refused address');
}

// 2. addNames([{addr:['4096'],...}]) must not mint a 4096n symbol.
{
  const index = emptyIndex();
  const added = index.addNames([{ addr: ['4096'], name: 'forged_name' }]);
  assert.equal(added, 0, 'array-wrapped address adds no name');
  assert.equal(index.symbolCount, 0);
  assert.equal(index.nameAt(4096n), null);
  assert.equal(index.nameEvidence(4096n), null, 'no confirmed metadata provenance from structured address');
}

// 3. Other structured/non-canonical shapes are refused identically.
for (const malformed of [
  { toString() { return '4096'; } },
  true,
  false,
  {},
  ['4096', 'extra'],
  '0xzz',
  '4 0 9 6',
  1.5,
  -1,
  -4096n,
]) {
  const fnIndex = emptyIndex();
  assert.equal(fnIndex.addFunctions([malformed]), 0, `addFunctions refuses ${JSON.stringify(String(malformed))}`);
  assert.equal(fnIndex.funcs.length, 0);
  assert.equal(fnIndex.functionEvidence(4096n), null);
  const nameIndex = emptyIndex();
  assert.equal(nameIndex.addNames([{ addr: malformed, name: 'forged' }]), 0, `addNames refuses ${JSON.stringify(String(malformed))}`);
  assert.equal(nameIndex.symbolCount, 0);
  assert.equal(nameIndex.nameAt(4096n), null);
}

// 4. Canonical primitive inputs keep existing behavior (bigint, safe number,
// canonical decimal/hex strings) with provenance semantics intact.
{
  const index = emptyIndex();
  assert.equal(index.addFunctions([4096n, 8192, '12288', '0x1000']), 3, 'canonical bigint/number/string accepted, duplicate counts once');
  assert.equal(index.isFunctionStart(4096n), true);
  assert.equal(index.isFunctionStart(8192n), true);
  assert.equal(index.isFunctionStart(12288n), true);
  const evidence = index.functionEvidence(4096n);
  assert.equal(evidence.source, 'metadata');
  assert.equal(evidence.confirmed, false);

  const names = emptyIndex();
  assert.equal(names.addNames([
    { addr: 0x1000n, name: 'a' },
    { addr: 0x2000n, name: 'b' },
    { addr: 0x1500n, name: 'c' },
  ]), 3);
  assert.equal(names.symbolCount, 3);
  const sorted = [...names.addrs].every((a, i, arr) => i === 0 || arr[i - 1] < a);
  assert.ok(sorted, 'merged addresses remain sorted');
  assert.equal(names.nameAt(0x1500n), 'c');
  const nameEvidence = names.nameEvidence(0x1000n);
  assert.equal(nameEvidence.source, 'metadata');
  assert.equal(nameEvidence.confirmed, true);
}

// 5. Duplicate handling and funcEnds preservation across a refused insert.
{
  const index = new SymbolIndex({
    addrs: new BigUint64Array(0), kinds: new Uint8Array(0), flags: new Uint8Array(0), names: [],
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x2000n]),
  });
  assert.equal(index.addFunctions([['4096'], 0x1500n, ['0x2500']]), 1, 'canonical bigint kept, structured refused');
  assert.equal(index.funcs.length, 2);
  assert.ok(index.funcEnds && index.funcEnds.length === 2 && index.funcEnds[0] === 0x2000n, 'exact ends preserved');
  assert.equal(index.addNames([{ addr: ['4096'], name: 'x' }]), 0);
  assert.equal(index.addNames([{ addr: 0x1000n, name: 'first' }]), 1);
  assert.equal(index.addNames([{ addr: 0x1000n, name: 'dup' }]), 0, 'existing canonical address stays deduplicated');
  assert.equal(index.nameAt(0x1000n), 'first');
}

console.log('issue #4116 SymbolIndex structured address refusal: PASS');
