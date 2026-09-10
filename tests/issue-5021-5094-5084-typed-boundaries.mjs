import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { FunctionMatchIndex } from '../js/recognition/index.js';
import { createMatchBudget } from '../js/recognition/match-budget.js';
import { SymbolIndex } from '../js/symbols.js';

// #5021: FunctionMatchIndex.candidates() fingerprinted raw query functions
// without the constructor's preprocess budget, bypassing the public API
// budget boundary entirely.
{
  const budget = createMatchBudget({ maxPreprocessInputBytes: 1, maxPreprocessEstimatedBytes: 1024, maxPreprocessWork: 1, maxPreprocessFunctions: 1, maxWallMs: 5000 });
  const index = new FunctionMatchIndex([], { budget });
  assert.equal(index.complete, true);
  const raw = { architecture: 'arm64', bytes: new Uint8Array(4096), instructions: [{ mnemonic: 'mov', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'imm', value: 8n }] }] };
  const result = index.candidates(raw);
  assert.deepEqual(result, [], 'an oversized raw query must produce no candidates');
  assert.equal(index.complete, false, 'the refused gate marks the index incomplete');
  // A precomputed fingerprint does not consume preprocessing budget.
  const fpBudget = createMatchBudget({ maxPreprocessInputBytes: 1 });
  const fpIndex = new FunctionMatchIndex([], { budget: fpBudget });
  const fingerprint = { schema: 'hex.function-fingerprint-fast', version: 4, buckets: new Map() };
  assert.doesNotThrow(() => fpIndex.candidates(fingerprint), 'precomputed fingerprints skip the preprocess gate');
}

// #5094: a Number[] function-start transport survived as-is, so the
// Number/BigInt-coerced binary search passed while the strict-equality
// exact-start lookups failed and every start was invisible.
{
  const index = new SymbolIndex({
    addrs: new BigUint64Array(0), kinds: new Uint8Array(0), flags: new Uint8Array(0), names: [],
    funcs: [4096, 4200],
  });
  assert.ok(index.funcs instanceof BigUint64Array, 'the function-start transport is canonicalized');
  assert.equal(index.isFunctionStart(4096n), true, 'canonicalized starts are visible to isFunctionStart');
  assert.equal(index.functionAt(4096n) != null, true, 'canonicalized starts are visible to functionAt');
  // Malformed elements fail closed instead of laundering.
  assert.throws(() => new SymbolIndex({ addrs: new BigUint64Array(0), kinds: new Uint8Array(0), flags: new Uint8Array(0), names: [], funcs: [['4096']] }), /symbol-function-start-transport-invalid/);
  assert.throws(() => new SymbolIndex({ addrs: new BigUint64Array(0), kinds: new Uint8Array(0), flags: new Uint8Array(0), names: [], funcs: ['0xzz'] }), /symbol-function-start-transport-invalid/);
  // Canonical string/number elements and typed arrays keep working.
  const mixed = new SymbolIndex({ addrs: new BigUint64Array(0), kinds: new Uint8Array(0), flags: new Uint8Array(0), names: [], funcs: ['4096', 4200n, '0x1100'] });
  assert.equal(mixed.isFunctionStart(4352n), true);
  const typed = new SymbolIndex({ addrs: new BigUint64Array(0), kinds: new Uint8Array(0), flags: new Uint8Array(0), names: [], funcs: new BigUint64Array([4096n]) });
  assert.equal(typed.isFunctionStart(4096n), true);
  // Missing transport stays the legacy empty shape.
  const none = new SymbolIndex({ addrs: new BigUint64Array(0), kinds: new Uint8Array(0), flags: new Uint8Array(0), names: [] });
  assert.equal(none.funcs.length, 0);
}

// #5084: malformed functionStarts/branchEntries boundary elements were
// silently filtered, deleting the function boundary itself; they must fail
// closed with a named error.
{
  const ctx = { Words: { KIND: {} }, console, BigInt, Number, TypeError, Error, Int32Array, Array, Set, Map };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../js/address-provenance.js', import.meta.url), 'utf8'), ctx);
  const AP = ctx.AddressProvenance;
  const valid = AP.create({ words: ctx.Words, functionStarts: [4096] });
  assert.equal(valid.enter(4096), true, 'a canonical boundary is honored');
  assert.throws(() => AP.create({ words: ctx.Words, functionStarts: [['4096']] }), /address-provenance-boundary-address-invalid/, 'structured boundary elements fail closed');
  assert.throws(() => AP.create({ words: ctx.Words, functionStarts: [true] }), /address-provenance-boundary-address-invalid/);
  assert.throws(() => AP.create({ words: ctx.Words, branchEntries: [['4097']] }), /address-provenance-boundary-address-invalid/, 'malformed branch entries fail closed');
  // Semantic out-of-range filtering of canonical entries is preserved.
  const ranged = AP.create({ words: ctx.Words, branchEntries: [4097], rangeStart: 4096, rangeEnd: 4097 });
  assert.equal(ranged.pendingEntries, 0, 'out-of-range canonical entries stay semantically filtered');
}

console.log('issues-5021-5094-5084 boundary/transport typed contracts: ok');
