import assert from 'node:assert/strict';
import { buildObjcModel } from '../js/objc-legacy.js';

const RELATIVE = 0x80000000;
const DIRECT_SELECTOR = 0x40000000;

function fixture(instanceKind, classKind) {
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

  const classAddr = 0x1000;
  const metaAddr = 0x1100;
  const classRo = 0x1200;
  const metaRo = 0x1300;
  const instanceList = 0x1400;
  const classList = 0x1500;
  const className = 0x1800;

  p64(0x200, classAddr);
  p64(classAddr + 0, metaAddr);
  p64(classAddr + 32, classRo);
  p64(metaAddr + 0, 0);
  p64(metaAddr + 32, metaRo);
  p64(classRo + 24, className);
  p64(classRo + 32, instanceList);
  p64(metaRo + 24, className);
  p64(metaRo + 32, classList);
  str(className, 'Victim');

  const writeList = (listAddr, kind, selectorSlot, selectorAddr, imp) => {
    p32(listAddr, RELATIVE | (kind === 'direct' ? DIRECT_SELECTOR : 0) | 12);
    p32(listAddr + 4, 1);
    const entry = listAddr + 8;
    if (kind === 'direct') {
      str(selectorAddr, selectorAddr === 0x1900 ? 'instanceOK:' : 'classOK:');
      pi32(entry + 0, selectorAddr - entry);
    } else if (kind === 'indirect') {
      p64(selectorSlot, selectorAddr);
      str(selectorAddr, selectorAddr === 0x1900 ? 'instanceOK:' : 'classOK:');
      pi32(entry + 0, selectorSlot - entry);
    } else {
      str(selectorSlot, 'fake:');
      pi32(entry + 0, selectorSlot - entry);
    }
    pi32(entry + 4, 0);
    pi32(entry + 8, imp - (entry + 8));
  };

  writeList(instanceList, instanceKind, 0x1600, 0x1900, 0x2100);
  writeList(classList, classKind, 0x1700, 0x1a00, 0x2200);

  return { read, classList: { vmAddr: 0x200n, size: 8n } };
}

{
  const { read, classList } = fixture('invalid', 'invalid');
  const parsed = await buildObjcModel(read, classList, null, 0n);
  assert.equal(parsed.classes.length, 1);
  assert.equal(parsed.names.length, 0, 'legacy parser must not fabricate selectors from indirect selref storage');
  assert.equal(parsed.classes[0].methods.length, 0);
  assert.equal(parsed.classes[0].classMethods.length, 0);
  assert.equal(parsed.names.some((method) => method.sel === 'fake:'), false);
  assert.equal(parsed.completeness.complete, false);
  assert.equal(parsed.completeness.classes.reasons.includes('method-selector-invalid'), true);
}

{
  const { read, classList } = fixture('direct', 'indirect');
  const parsed = await buildObjcModel(read, classList, null, 0n);
  assert.deepEqual(parsed.names.map((method) => method.sel).sort(), ['classOK:', 'instanceOK:']);
  assert.equal(parsed.classes[0].methods[0].name, '-[Victim instanceOK:]');
  assert.equal(parsed.classes[0].classMethods[0].name, '+[Victim classOK:]');
}

console.log('objc-issue-2392-legacy-indirect-selector: ok');
