import assert from 'node:assert/strict';
import test from 'node:test';

import {
  demangleRustV0,
  RustMetadataProvider,
} from '../../../js/metadata/rust.js';

// #8655: the Rust v0 Punycode decoder did `output.splice(0, 0, …)` per decoded
// scalar; RFC 3492 lets an attacker force every insertion at index 0, so one
// accepted ~sub-MiB symbol spends Θ(n²) CPU, and repeated records multiply the
// cost because the provider had no per-symbol/aggregate budget or cache.

const base = 36, tmin = 1, tmax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128;
function digitToBasic(d) { return d < 26 ? String.fromCharCode(d + 97) : String.fromCharCode(d - 26 + 48); }
function adapt(delta, numpoints, firsttime) {
  let d = firsttime ? Math.floor(delta / damp) : Math.floor(delta / 2);
  d += Math.floor(d / numpoints);
  let k = 0;
  while (d > Math.floor(((base - tmin) * tmax) / 2)) { d = Math.floor(d / (base - tmin)); k += base; }
  return k + Math.floor(((base - tmin + 1) * d) / (d + skew));
}
// Encode deltas 0,1,2,… which the decoder resolves to insertion index 0 each
// step (the adversarial front-insertion shape from the issue).
function frontInsertPayload(count) {
  let out = '';
  let bias = initialBias;
  let i = 0;
  for (let delta = 0; delta < count; delta++) {
    let q = delta, k = base;
    for (;;) {
      let t;
      if (k > bias) t = (k >= bias + tmax) ? tmax : k - bias; else t = tmin;
      if (q > t) { out += digitToBasic((q - t) % base); q = Math.floor((q - t) / (base - t)); }
      else { out += digitToBasic(q); break; }
      k += base;
    }
    bias = adapt(delta, i + 1, i === 0);
    i = 0;
    i += delta % (i + 1) + 1;
  }
  return out;
}
function frontInsertSymbol(count) {
  const payload = frontInsertPayload(count);
  return { name: '_RCu' + payload.length + payload, payloadLength: payload.length };
}

test('#8655 adversarial front-insertion Punycode fails closed on the work budget', () => {
  // 20k scalars: beyond the per-symbol scalar/splice ceilings -> bounded failure,
  // never the quadratic completion the old decoder produced.
  const { name } = frontInsertSymbol(20_000);
  const started = Date.now();
  const result = demangleRustV0(name);
  assert.equal(result.parsed, false);
  assert.equal(result.reason, 'v0-resource-budget-exceeded');
  assert.equal(result.resourceLimited, true);
  assert.ok(Date.now() - started < 2000, 'must not stall for seconds');
  assert.ok(result.demangled.length <= name.length + 1, 'must not publish the expanded identifier');
});

test('#8655 a realistic-small Rust unicode symbol still demangles exactly (#6237 fidelity)', () => {
  const godel = demangleRustV0('_RNvNtNtC7mycrateu8gdel_5qa6escher4bach');
  assert.equal(godel.parsed, true);
  assert.equal(godel.demangled, 'mycrate::gödel::escher::bach');
  // A modest 40-scalar front-insert identifier is well inside every ceiling.
  const small = frontInsertSymbol(40);
  assert.equal(demangleRustV0(small.name).parsed, true);
});

test('#8655 provider on a single hostile symbol returns bounded partial and never crashes', () => {
  const { name } = frontInsertSymbol(20_000);
  const probe = new RustMetadataProvider({
    symbols: [{ name, address: 0x1000n }],
    binaryIdentity: 'sha256:hostile',
  }).probe();
  assert.equal(probe.completeness.complete, false);
  assert.equal(probe.completeness.capped, true);
  assert.equal(probe.counts.symbols, 0);
  assert.ok(probe.completeness.unreadableEntries >= 1);
});

test('#8655 repeated identical symbols are demangled once (provider cache)', () => {
  // 4000 records sharing one front-insert identifier. Each record alone stays
  // comfortably under the per-symbol ceilings (~0.5M splice work), but 4000
  // independent decodes (≈2G splice work) would exhaust the provider aggregate
  // budget. Cache reuse keeps the aggregate at a single decode, so the provider
  // stays complete.
  const { name } = frontInsertSymbol(600);
  assert.equal(demangleRustV0(name).parsed, true, 'control: one copy demangles within per-symbol ceilings');
  const symbols = Array.from({ length: 4000 }, (_, k) => ({ name, address: BigInt(0x1000 + k) }));
  const probe = new RustMetadataProvider({ symbols, binaryIdentity: 'sha256:cache' }).probe();
  assert.equal(probe.completeness.complete, true, 'cache must prevent aggregate-budget poisoning by duplicates');
  assert.equal(probe.counts.symbols, 4000);
});

test('#8655 distinct heavy symbols are bounded by the provider-wide aggregate budget', () => {
  // Each of ~40 distinct identifiers decodes fine against the per-symbol budget,
  // but a tiny aggregate allowance must stop the provider from doing unbounded
  // cumulative work across many distinct records.
  const symbols = [];
  for (let j = 0; j < 40; j++) {
    const { name } = frontInsertSymbol(200 + j);
    symbols.push({ name, address: BigInt(0x10000 + j) });
  }
  const bounded = new RustMetadataProvider({
    symbols,
    binaryIdentity: 'sha256:agg',
    options: { rustDemangle: { aggregateMaxScalars: 400 } },
  }).probe();
  assert.equal(bounded.completeness.complete, false);
  assert.equal(bounded.completeness.capped, true);
  assert.ok(bounded.counts.symbols < symbols.length, 'aggregate budget must leave later distinct records unparsed');
  // With no aggregate cap, every distinct symbol individually demangles.
  const unbounded = new RustMetadataProvider({ symbols, binaryIdentity: 'sha256:agg' }).probe();
  assert.equal(unbounded.completeness.complete, true);
  assert.equal(unbounded.counts.symbols, symbols.length);
});
