import assert from 'node:assert/strict';
import { buildObjcModel } from '../js/objc.js';

const VM_BASE = 0x100000000n;
const IMG = 0x8000n;

function image() {
  const bytes = new Uint8Array(Number(IMG));
  const view = new DataView(bytes.buffer);
  const put = (off, v) => view.setBigUint64(off, BigInt(v), true);
  const u32 = (off, v) => view.setUint32(off, Number(v), true);
  const str = (off, text) => { for (let i = 0; i < text.length; i++) bytes[off + i] = text.charCodeAt(i); return VM_BASE + BigInt(off); };
  return { bytes, view, put, u32, str };
}

function readerFor(bytes) {
  return async (addr, len) => {
    const off = Number(BigInt(addr) - VM_BASE);
    if (!Number.isSafeInteger(off) || off < 0 || off >= bytes.length) return null;
    return bytes.subarray(off, Math.min(bytes.length, off + len));
  };
}

function propertyListAt(img, off, props) {
  const { put, u32 } = img;
  u32(off, 16);
  u32(off + 4, props.length);
  props.forEach((p, i) => { put(off + 8 + i * 16, p.name); put(off + 16 + i * 16, p.attrs); });
  return VM_BASE + BigInt(off);
}

function buildFixture() {
  const img = image();
  const { bytes, put, u32, str } = img;
  const sInst = str(0x040, 'InstOnly');
  const sAnswer = str(0x050, 'answer');
  const sName = str(0x060, 'name');
  const sAttrs = str(0x070, 'Tq,N,andAnswer');
  const sAttrsName = str(0x080, 'T@,N,andName');
  const sEmpty = str(0x090, '');
  void sEmpty;

  // InstOnly: instance property list only; metaclass baseProperties empty.
  const instProps = propertyListAt(img, 0x100, [{ name: sInst, attrs: sAttrs }]);
  const metaEmptyProps = propertyListAt(img, 0x140, []);
  // ClassOnly: no instance properties; metaclass baseProperties has `answer`.
  const classProps = propertyListAt(img, 0x180, [{ name: sAnswer, attrs: sAttrs }]);
  // SameName: `name` declared as instance property and as class property.
  const instName = propertyListAt(img, 0x1c0, [{ name: sName, attrs: sAttrsName }]);
  const classSameName = propertyListAt(img, 0x200, [{ name: sName, attrs: sAttrsName }]);
  // MalformedMeta: metaclass list declares an entry whose pointers are garbage.
  u32(0x240, 16);
  u32(0x244, 1);
  put(0x248, VM_BASE + 0xdead0000n);
  put(0x250, VM_BASE + 0xdead0000n);
  const malformedProps = VM_BASE + 0x240n;

  const classes = [
    { off: 0x1000, name: str(0x0a0, 'InstOnly'), inst: instProps, metaEmpty: metaEmptyProps },
    { off: 0x1400, name: str(0x0b0, 'ClassOnly'), inst: 0n },
    { off: 0x1800, name: str(0x0c0, 'SameName'), inst: instName },
    { off: 0x1c00, name: str(0x0d0, 'MalformedMeta'), inst: 0n },
  ];
  const metaPropsFor = [metaEmptyProps, classProps, classSameName, malformedProps];

  const slots = [];
  for (const [i, c] of classes.entries()) {
    const ro = c.off;
    const roMeta = c.off + 0x100;
    const metaProps = metaPropsFor[i];
    u32(ro + 8, 0x20);
    put(ro + 24, c.name);
    put(ro + 32, 0);
    put(ro + 40, 0);
    put(ro + 48, 0);
    put(ro + 64, c.inst);
    u32(roMeta + 8, 0x20);
    put(roMeta + 24, c.name);
    put(roMeta + 64, metaProps);
    const classAddr = c.off + 0x200;
    put(classAddr, VM_BASE + BigInt(roMeta));   // isa -> metaclass
    put(classAddr + 8, 0);                      // super
    put(classAddr + 32, VM_BASE + BigInt(ro));  // data -> ro
    put(roMeta, VM_BASE + BigInt(roMeta));      // metaclass isa self
    put(roMeta + 8, 0);
    put(roMeta + 32, VM_BASE + BigInt(roMeta)); // metaclass data -> roMeta
    slots.push(classAddr);
  }
  const table = 0x7000;
  slots.forEach((s, i) => put(table + i * 8, VM_BASE + BigInt(s)));
  return {
    read: readerFor(bytes),
    classList: { vmAddr: VM_BASE + BigInt(table), size: BigInt(slots.length * 8) },
  };
}

const model = await buildObjcModel(buildFixture().read, buildFixture().classList, null, VM_BASE, null);
const byName = new Map(model.classes.map((c) => [c.name, c]));

const instOnly = byName.get('InstOnly');
assert.ok(instOnly);
assert.deepEqual(instOnly.properties.map((p) => p.name), ['InstOnly']);
assert.deepEqual(instOnly.classProperties, [], 'instance-only class keeps no class properties');

const classOnly = byName.get('ClassOnly');
assert.ok(classOnly);
assert.deepEqual(classOnly.properties, [], 'class property must not masquerade as an instance property');
assert.deepEqual(classOnly.classProperties.map((p) => p.name), ['answer'], '@property(class) survives via metaclass baseProperties');
assert.equal(classOnly.classProperties[0].type?.kind, 'int', 'class property keeps its declared type metadata');

const sameName = byName.get('SameName');
assert.ok(sameName);
assert.deepEqual(sameName.properties.map((p) => p.name), ['name']);
assert.deepEqual(sameName.classProperties.map((p) => p.name), ['name'], 'same-name instance/class properties stay in separate namespaces');

const malformed = byName.get('MalformedMeta');
assert.ok(malformed);
assert.ok((malformed.classProperties ?? []).every((p) => p.name !== undefined && p.name !== ''), 'no fabricated class property names');
assert.equal(model.completeness.classes.complete, false, 'malformed metaclass property list degrades completeness');

console.log('issue #3990 metaclass baseProperties classProperties: PASS');
