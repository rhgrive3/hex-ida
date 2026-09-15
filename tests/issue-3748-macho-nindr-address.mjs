import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho-core.js';

const N_UNDF = 0x0, N_ABS = 0x02, N_INDR = 0x0a, N_SECT = 0x0e, N_EXT = 0x01;

function build() {
  const bytes = new Uint8Array(0x400);
  const dv = new DataView(bytes.buffer);
  const u32 = (o, v) => dv.setUint32(o, v, true);
  const u64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  u32(0, 0xfeedfacf);
  dv.setInt32(4, 0x0100000c, true);
  dv.setInt32(8, 0, true);
  u32(12, 2);
  u32(16, 1);
  u32(20, 24);
  u32(24, 0);
  u32(28, 0);

  const symoff = 64;
  const nsyms = 8;
  const stroff = symoff + nsyms * 16;
  const strsize = 52;
  u32(32, 0x2); u32(36, 24);
  u32(40, symoff); u32(44, nsyms);
  u32(48, stroff); u32(52, strsize);

  put(stroff + 1, 'alias');
  put(stroff + 8, 'target');
  put(stroff + 15, 'tfunc');
  put(stroff + 21, 'nound');
  put(stroff + 27, 'common');
  put(stroff + 34, 'abs');
  put(stroff + 38, 'bad');
  put(stroff + 42, 'noind');
  put(stroff + 48, 'tail');

  const sym = (i, strx, type, sect, desc, value) => {
    const p = symoff + i * 16;
    u32(p, strx);
    bytes[p + 4] = type;
    bytes[p + 5] = sect;
    u32(p + 6, desc);
    u64(p + 8, value);
  };
  sym(0, 15, N_SECT | N_EXT, 1, 0, 0x400);
  sym(1, 1, N_INDR | N_EXT, 0, 0, 8);
  sym(2, 38, N_INDR | N_EXT, 0, 0, 100);
  sym(3, 42, N_INDR | N_EXT, 0, 0, 48);
  sym(4, 21, N_UNDF | N_EXT, 0, 0, 0);
  sym(5, 27, N_UNDF | N_EXT, 0, 0, 4);
  sym(6, 34, N_ABS | N_EXT, 0, 0, 0x20);
  sym(7, 8, N_INDR, 0, 0, 15);
  return bytes;
}

const image = parseMachO(build());
const byName = (n) => image.symbols.find((s) => s.name === n);

assert.ok(byName('alias'), 'valid N_INDR symbol must remain visible');
assert.equal(byName('alias').address, 0n, 'N_INDR n_value must not become a VM address');
assert.equal(byName('alias').defined, false, 'N_INDR alias must not be marked defined');
assert.equal(byName('alias').indirectTarget, 'target', 'aliased target name must be preserved losslessly');
assert.equal(image.exports.some((e) => e.name === 'alias'), false, 'N_INDR must not fabricate an export');
assert.equal(image.functions.some((f) => f.address === 8n), false, 'N_INDR string index must not seed a function');

assert.ok(!byName('bad'), 'out-of-range N_INDR target must not produce a symbol');
assert.ok(!byName('noind'), 'unterminated N_INDR target must not produce a symbol');
assert.equal(image.metadata.machoMetadata.complete, false, 'malformed N_INDR targets must mark metadata partial');
assert.ok(image.metadata.machoMetadata.reasons.includes('indirect-symbol-target-out-of-range'));
assert.ok(image.metadata.machoMetadata.reasons.includes('indirect-symbol-target-not-terminated'));

const local = byName('target');
assert.ok(local, 'local (non-external) N_INDR must remain visible');
assert.equal(local.address, 0n);
assert.equal(local.indirectTarget, 'tfunc');
assert.equal(local.binding, 'local');
assert.equal(image.exports.some((e) => e.name === 'target'), false, 'local N_INDR must not export');

const tfunc = byName('tfunc');
assert.equal(tfunc.address, 0x400n, 'N_SECT address semantics must be preserved');
assert.equal(tfunc.defined, true);
assert.ok(image.exports.some((e) => e.name === 'tfunc' && e.address === 0x400n), 'N_SECT export semantics must be preserved');

const nound = byName('nound');
assert.equal(nound.address, 0n);
assert.equal(nound.defined, false);
assert.equal(nound.kind, 'undefined');
assert.ok(image.imports.some((i) => i.name === 'nound'), 'external N_UNDF must stay an import');

const common = byName('common');
assert.equal(common.common, true, 'N_UNDF common semantics must be preserved');
assert.equal(common.size, 4n);
assert.equal(common.address, 0n);

const abs = byName('abs');
assert.equal(abs.address, 0x20n, 'N_ABS absolute-value semantics must be preserved');
assert.equal(abs.defined, true);

console.log('issue-3748 Mach-O N_INDR n_value must not be a VM address: PASS');
