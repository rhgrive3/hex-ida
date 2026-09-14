import assert from 'node:assert/strict';
import test from 'node:test';

import {
  demangleRustV0,
  RustMetadataProvider,
} from '../../../js/metadata/rust.js';

// #8766: Rust v0 backreference expansion is exponential; a 125-byte symbol must
// not OOM a 128 MiB heap, and the demangler must fail closed on a resource
// ceiling independent of the syntactic depth cap.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function b62(n) {
  if (n === 0) return '_';
  let x = n - 1;
  let s = '';
  do {
    s = ALPHABET[x % 62] + s;
    x = Math.floor(x / 62);
  } while (x);
  return s + '_';
}
// P(n) renders a doubly-exponential path through nested backreferences.
function P(n, start = 0) {
  if (n === 0) return 'C1a';
  return 'I' + P(n - 1, start + 1) + 'B' + b62(start + 1) + 'E';
}

test('#8766 exponential backreference symbols fail closed without unbounded rendering', () => {
  for (const level of [15, 18, 20, 24, 28, 32]) {
    const symbol = '_R' + P(level);
    const result = demangleRustV0(symbol);
    assert.equal(result.parsed, false, `level ${level} (${symbol.length}B) must not be accepted`);
    assert.ok(
      result.reason === 'v0-depth-limit-exceeded' || result.reason === 'v0-resource-budget-exceeded',
      `level ${level} must stop at a resource/depth boundary, got ${result.reason}`,
    );
    // A failed demangle never publishes the (huge) expanded render.
    assert.ok(result.demangled.length <= symbol.length + 1, `level ${level} must not publish expanded output`);
    assert.notEqual(result.demangled, undefined);
  }
});

test('#8766 output ceiling is enforced before allocating large renders (deterministic reason)', () => {
  const symbol = '_R' + P(14);
  const capped = demangleRustV0(symbol, 40, { maxOutputChars: 64 });
  assert.equal(capped.parsed, false);
  assert.equal(capped.reason, 'v0-resource-budget-exceeded');
  assert.equal(capped.resourceLimited, true);
});

test('#8766 operations ceiling is enforced independently of output size', () => {
  // A multi-node path needs more than one parse operation; a maxOps of 1 must
  // stop it at the work boundary rather than completing the demangle.
  const capped = demangleRustV0('_RINvC4core3fooE', 32, { maxOps: 1 });
  assert.equal(capped.parsed, false);
  assert.equal(capped.reason, 'v0-resource-budget-exceeded');
});

test('#8766 provider probe on a hostile single symbol returns partial, never crashes', () => {
  const hostile = '_R' + P(24);
  const probe = new RustMetadataProvider({
    symbols: [{ name: hostile, address: 0x1000n }],
    binaryIdentity: 'sha256:hostile',
  }).probe();
  assert.equal(probe.completeness.complete, false, 'provider must not report complete when a symbol is bounded out');
  assert.equal(probe.counts.symbols, 0);
  assert.ok(probe.completeness.unreadableEntries >= 1);
});

test('#8766 backreference memoization preserves exact render for known fixtures', () => {
  // Regression guards from #6203: a referenced subtree must still render identically.
  assert.equal(demangleRustV0('_RNCNvCsgStHSCytQ6I_7mycrate4main0B3_').demangled, 'mycrate::main::{closure}');
  assert.equal(demangleRustV0('_RINvC4core3fooAtj8_Bc_E').demangled, 'core::foo<[u16; 8], [u16; 8]>');
  assert.equal(demangleRustV0('_RNvNtC4core3fmt3num').demangled, 'core::fmt::num');
  // A shared backreference reused many times renders the shared structure once (identical output).
  assert.equal(demangleRustV0('_RINvC4core3fooAtj8_Bc_Bc_E').demangled, 'core::foo<[u16; 8], [u16; 8], [u16; 8]>');
});

test('#8766 out-of-range / forward / self backreferences still fail closed', () => {
  assert.equal(demangleRustV0('_RB99_').parsed, false);
  assert.equal(demangleRustV0('_RB_').parsed, false);
  assert.equal(demangleRustV0('_RB???_').parsed, false);
});

test('#8766 normal rustc v0 corpus demangles exactly as before', () => {
  const basics = {
    a: 'i8', b: 'bool', c: 'char', d: 'f64', e: 'str', f: 'f32', h: 'u8',
    i: 'isize', j: 'usize', l: 'i32', m: 'u32', s: 'i16', t: 'u16', x: 'i64', y: 'u64',
  };
  for (const [code, type] of Object.entries(basics)) {
    const r = demangleRustV0(`_RMC1a${code}`);
    assert.equal(r.parsed, true, `basic ${code}`);
    assert.equal(r.demangled, `<a::${type}>`);
  }
});
