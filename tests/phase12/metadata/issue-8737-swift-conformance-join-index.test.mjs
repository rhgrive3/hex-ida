import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSwiftMetadataModel } from '../../../js/swift.js';

// #8737: buildSwiftMetadataModel() resolved every concrete conformance with two
// fresh linear scans (protocols.find / types.find) and every auto-vtable owner
// with another types.find, so the accepted shape was O(conformances x (types +
// protocols)). The fix indexes types/protocols by canonical address once and
// resolves in O(1), failing closed on ambiguous duplicate addresses.

function makeImage() {
  let buf;
  const put = (addr, bytes) => { for (let i = 0; i < bytes.length; i++) buf[Number(addr) + i] = bytes[i]; };
  const u32 = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const i32 = (v) => u32(v >>> 0);
  const u64 = (v) => { let x = BigInt(v); const b = new Uint8Array(8); for (let i = 0; i < 8; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
  const rel32 = (field, target) => i32(Number(BigInt(target) - BigInt(field)));
  const cstr = (s) => new TextEncoder().encode(s + '\0');
  const write32 = (a, v) => put(a, u32(v));
  const writeRel = (f, t) => put(f, rel32(f, t));
  const writeU64 = (a, v) => put(a, u64(v));
  const read = async (addr, len) => { const a = Number(addr); if (a >= buf.length) return null; return buf.subarray(a, Math.min(buf.length, a + len)); };
  const opts = { resolvePointer: async (raw) => raw };
  return { put, read, opts, write32, writeRel, writeU64, cstr, alloc: (n) => { buf = new Uint8Array(n); }, section: (vmAddr, size) => ({ section: vmAddr, size }) };
}

// A large, structurally valid but identity-worst-case image: N types, N
// protocols, N conformances each whose protocol/type pointers do not match any
// record (so the OLD .find() had to scan every type and protocol before failing),
// and each with a distinct non-null witness table so none is deduped.
function buildMassConformance(count) {
  const img = makeImage();
  img.alloc(0x700000);
  const TS = 0x10000n, PS = 0x20000n, CS = 0x30000n;
  const TD = 0x100000n, PN = 0x200000n, PD = 0x300000n, PND = 0x400000n, CD = 0x500000n, WT = 0x600000n;
  for (let i = 0; i < count; i++) {
    const t = TD + BigInt(i * 0x40), tn = PN + BigInt(i * 0x40);
    img.writeRel(TS + BigInt(i * 4), t); img.write32(t, 17); img.writeRel(t + 8n, tn); img.put(tn, img.cstr('T' + i));
    const p = PD + BigInt(i * 0x40), pn = PND + BigInt(i * 0x40);
    img.writeRel(PS + BigInt(i * 4), p); img.write32(p, 3); img.writeRel(p + 8n, pn); img.put(pn, img.cstr('P' + i)); img.write32(p + 16n, 0);
    const c = CD + BigInt(i * 0x40), w = WT + BigInt(i * 0x40);
    img.writeRel(CS + BigInt(i * 4), c); img.writeRel(c, 0xdead0000n); img.writeRel(c + 4n, 0xbeef0000n); img.writeRel(c + 8n, w); img.write32(c + 12n, 0);
  }
  const sections = [
    { section: '__swift5_types', vmAddr: TS, size: count * 4 },
    { section: '__swift5_protos', vmAddr: PS, size: count * 4 },
    { section: '__swift5_proto', vmAddr: CS, size: count * 4 },
  ];
  return { read: img.read, sections, opts: { ...img.opts, budget: count } };
}

test('#8737 conformance join scales linearly, not O(conformances x (types+protocols))', async () => {
  // Warm up the JIT so the ratio/absolute signal is stable.
  await buildSwiftMetadataModel(...(() => { const s = buildMassConformance(200); return [s.read, s.sections, s.opts]; })());

  const small = buildMassConformance(1000);
  const big = buildMassConformance(3000);

  const s0 = process.hrtime.bigint();
  const sModel = await buildSwiftMetadataModel(small.read, small.sections, small.opts);
  const sMs = Number(process.hrtime.bigint() - s0) / 1e6;

  const b0 = process.hrtime.bigint();
  const bModel = await buildSwiftMetadataModel(big.read, big.sections, big.opts);
  const bMs = Number(process.hrtime.bigint() - b0) / 1e6;

  // Structural: the indexed path must still parse every record (no dropped work).
  assert.equal(sModel.conformances.length, 1000);
  assert.equal(bModel.conformances.length, 3000);
  assert.equal(bModel.types.length, 3000);
  assert.equal(bModel.protocols.length, 3000);

  // Regression guard: with the old per-conformance .find() scans, a 3000-conformance
  // image spends many seconds here. The indexed build is comfortably sub-second, so
  // this absolute ceiling fails on the old quadratic behavior but passes with wide
  // margin on the fix even on slower CI runners. (The structural asserts above are
  // the primary oracle; this timing bound is the anti-regression tripwire.)
  assert.ok(bMs < 6000, `3000-conformance join must stay linear/bounded, took ${bMs.toFixed(0)}ms`);
  assert.ok(bMs < sMs * 6 + 1500, `join must not be super-linear: 3000=${bMs.toFixed(0)}ms vs 1000=${sMs.toFixed(0)}ms`);
});

test('#8737 indexed lookup resolves the correct type/protocol for first and last conformances', async () => {
  const img = makeImage();
  img.alloc(0x0);
  const mem = new Map();
  const put = (a, b) => { for (let i = 0; i < b.length; i++) mem.set(Number(a) + i, b[i]); };
  const read = async (addr, len) => { const out = new Uint8Array(len); for (let i = 0; i < len; i++) { const v = mem.get(Number(addr) + i); if (v == null) return i ? out.subarray(0, i) : null; out[i] = v; } return out; };
  const write32 = (a, v) => put(a, Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255));
  const writeRel = (f, t) => write32(f, Number(BigInt(t) - BigInt(f)));
  const writeU64 = (a, v) => { let x = BigInt(v); const b = new Uint8Array(8); for (let i = 0; i < 8; i++) { b[i] = Number(x & 255n); x >>= 8n; } put(a, b); };
  const cstr = (s) => new TextEncoder().encode(s + '\0');
  const T0 = 0x20000n, T1 = 0x20080n, P0 = 0x30000n, P1 = 0x30800n;
  const TS = 0x1000n, PS = 0x2000n, CS = 0x3000n, C0 = 0x40000n, C1 = 0x40040n, W0 = 0x50000n, W1 = 0x50040n, IMPL = 0x60000n;
  put(T0, new Uint8Array(28)); put(T1, new Uint8Array(28)); put(P0, new Uint8Array(32)); put(P1, new Uint8Array(32));
  put(C0, new Uint8Array(16)); put(C1, new Uint8Array(16));
  writeRel(TS, T0); writeRel(TS + 4n, T1); write32(T0, 17); writeRel(T0 + 8n, 0x21000n); put(0x21000n, cstr('T0')); write32(T1, 17); writeRel(T1 + 8n, 0x21040n); put(0x21040n, cstr('T1'));
  writeRel(PS, P0); writeRel(PS + 4n, P1);
  for (const [p, na] of [[P0, 0x31000n], [P1, 0x31040n]]) { write32(p, 3); writeRel(p + 8n, na); put(na, cstr('P')); write32(p + 16n, 1); write32(p + 24n, 1); writeU64(IMPL, IMPL); }
  writeRel(CS, C0); writeRel(CS + 4n, C1);
  writeRel(C0, P0); writeRel(C0 + 4n, T0); writeRel(C0 + 8n, W0); write32(C0 + 12n, 0);
  writeRel(C1, P1); writeRel(C1 + 4n, T1); writeRel(C1 + 8n, W1); write32(C1 + 12n, 0);
  const sections = [{ section: '__swift5_types', vmAddr: TS, size: 8 }, { section: '__swift5_protos', vmAddr: PS, size: 8 }, { section: '__swift5_proto', vmAddr: CS, size: 8 }];
  const model = await buildSwiftMetadataModel(read, sections, { budget: 128, resolvePointer: async (raw) => raw });
  const conf = model.witnessTables.filter((w) => w.source === 'conformance');
  // A naive first-only / last-write-wins map could not produce both correctly; the
  // canonical-address index resolves each conformance to its own type & protocol.
  assert.ok(conf.some((w) => String(w.typeAddress) === String(T0) && String(w.protocolAddress) === String(P0)), 'first conformance');
  assert.ok(conf.some((w) => String(w.typeAddress) === String(T1) && String(w.protocolAddress) === String(P1)), 'last conformance resolved, not only the first match');
});

test('#8737 ambiguous duplicate canonical address is never promoted to a unique identity', async () => {
  const mem = new Map();
  const put = (a, b) => { for (let i = 0; i < b.length; i++) mem.set(Number(a) + i, b[i]); };
  const read = async (addr, len) => { const out = new Uint8Array(len); for (let i = 0; i < len; i++) { const v = mem.get(Number(addr) + i); if (v == null) return i ? out.subarray(0, i) : null; out[i] = v; } return out; };
  const write32 = (a, v) => put(a, Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255));
  const writeRel = (f, t) => write32(f, Number(BigInt(t) - BigInt(f)));
  const writeU64 = (a, v) => { let x = BigInt(v); const b = new Uint8Array(8); for (let i = 0; i < 8; i++) { b[i] = Number(x & 255n); x >>= 8n; } put(a, b); };
  const cstr = (s) => new TextEncoder().encode(s + '\0');
  const T0 = 0x20000n, P0 = 0x30000n, TS = 0x1000n, PS = 0x2000n, CS = 0x3000n, CD = 0x40000n, WT = 0x50000n, IMPL = 0x60000n;
  put(T0, new Uint8Array(28)); put(P0, new Uint8Array(32)); put(CD, new Uint8Array(16));
  // Two type-table entries that both resolve to the same descriptor address with
  // distinct parsed objects => the canonical address is ambiguous.
  writeRel(TS, T0); writeRel(TS + 4n, T0);
  write32(T0, 17); writeRel(T0 + 8n, 0x21000n); put(0x21000n, cstr('T0'));
  writeRel(PS, P0); write32(P0, 3); writeRel(P0 + 8n, 0x31000n); put(0x31000n, cstr('P0')); write32(P0 + 16n, 1); write32(P0 + 24n, 1); writeU64(IMPL, IMPL);
  writeRel(CS, CD); writeRel(CD, P0); writeRel(CD + 4n, T0); writeRel(CD + 8n, WT); write32(CD + 12n, 0);
  const sections = [{ section: '__swift5_types', vmAddr: TS, size: 8 }, { section: '__swift5_protos', vmAddr: PS, size: 4 }, { section: '__swift5_proto', vmAddr: CS, size: 4 }];
  const model = await buildSwiftMetadataModel(read, sections, { budget: 128, resolvePointer: async (raw) => raw });
  const conf = model.witnessTables.filter((w) => w.source === 'conformance');
  assert.equal(conf.length, 0, 'a conformance over an ambiguous duplicate type address must fail closed, not pick one silently');
  assert.equal(model.completeness.witnessTables.complete, false, 'ambiguous identity must mark the model incomplete');
});
