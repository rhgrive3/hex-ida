import assert from 'node:assert/strict';
import { buildObjcModel } from '../js/objc-legacy.js';

const RELATIVE = 0x80000000;
const DIRECT_SELECTOR = 0x40000000;

function makeMem() {
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);
  const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const pi32 = (at, v) => dv.setInt32(at, Number(v), true);
  const str = (at, s) => { mem.set(new TextEncoder().encode(s), at); mem[at + s.length] = 0; };
  const read = async (addr, len) => {
    const at = Number(addr);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
  return { mem, p64, p32, pi32, str, read };
}

function classSkeleton(f, { listAddr, entsize }) {
  const { p64, p32, str, read } = f;
  const classAddr = 0x1000;
  const metaAddr = 0x1100;
  const classRo = 0x1200;
  const className = 0x1800;
  p64(0x200, classAddr);
  p64(classAddr + 0, metaAddr);
  p64(classAddr + 32, classRo);
  p64(metaAddr + 0, 0);
  p64(metaAddr + 32, 0x1300);
  p64(classRo + 24, className);
  p64(classRo + 32, listAddr);
  p64(0x1300 + 24, className);
  p64(0x1300 + 32, 0);
  str(className, 'Victim');
  p32(listAddr, entsize);
  p32(listAddr + 4, 1);
  return { classList: { vmAddr: 0x200n, size: 8n }, entry: listAddr + 8 };
}

{
  const f = makeMem();
  const listAddr = 0x1400;
  const { classList } = classSkeleton(f, {
    listAddr,
    entsize: RELATIVE | DIRECT_SELECTOR | 12,
  });
  const entry = BigInt(listAddr + 8);
  const typesAddr = 0x2400;
  f.str(0x1900, 'foo:');
  f.str(typesAddr, 'v24@0:8i16');
  f.pi32(Number(entry) + 0, 0x1900 - Number(entry));
  f.pi32(Number(entry) + 4, typesAddr - (Number(entry) + 4));
  f.pi32(Number(entry) + 8, 0x2100 - (Number(entry) + 8));
  const parsed = await buildObjcModel(f.read, classList, null, 0n);
  const method = parsed.classes[0].methods[0];
  assert.equal(method.sel, 'foo:');
  assert.equal(method.addr, 0x2100n);
  assert.equal(method.types, 'v24@0:8i16', 'relative method_t must decode the types field at entry+4');
}

{
  const f = makeMem();
  const listAddr = 0x1400;
  const { classList } = classSkeleton(f, { listAddr, entsize: 24 });
  const entry = listAddr + 8;
  f.p64(entry + 0, 0x1900);
  f.p64(entry + 8, 0x2500);
  f.p64(entry + 16, 0x3000);
  f.str(0x1900, 'bar:');
  f.str(0x2500, '@24@0:8q16');
  const parsed = await buildObjcModel(f.read, classList, null, 0n);
  const method = parsed.classes[0].methods[0];
  assert.equal(method.sel, 'bar:');
  assert.equal(method.addr, 0x3000n);
  assert.equal(method.types, '@24@0:8q16', 'big method_t must decode the types pointer at entry+8');
}

console.log('issue-4002-objc-legacy-method-types: ok');
