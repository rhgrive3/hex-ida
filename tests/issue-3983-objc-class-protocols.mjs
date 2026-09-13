import assert from 'node:assert/strict';
import { buildObjcModel, buildObjcRuntimeModel, resolveObjcDispatch } from '../js/objc.js';

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

function methodListAt(img, off, entries) {
  const { put, u32 } = img;
  u32(off, 24);
  u32(off + 4, entries.length);
  let at = off + 8;
  for (const e of entries) { put(at, e.sel); put(at + 8, e.types); put(at + 16, e.imp); at += 24; }
  return VM_BASE + BigInt(off);
}

function protocolListAt(img, off, protos, flags = 0) {
  const { put, u32 } = img;
  u32(off, protos.length);
  u32(off + 4, flags);
  protos.forEach((p, i) => put(off + 8 + i * 8, p));
  return VM_BASE + BigInt(off);
}

function protocolAt(img, off, { name, protocols = null, instanceMethods = null }) {
  const { put, u32 } = img;
  put(off + 8, name);
  if (protocols != null) put(off + 16, protocols);
  if (instanceMethods != null) put(off + 24, instanceMethods);
  u32(off + 64, 96);
  return VM_BASE + BigInt(off);
}

function buildFixture({ protocolEntryBad = false, protocolRelativeFlags = false } = {}) {
  const img = image();
  const { bytes, put, u32, str } = img;
  const sC = str(0x040, 'C');
  const sP = str(0x050, 'P');
  const sQ = str(0x060, 'Q');
  const sBaseP = str(0x070, 'BaseP');
  const sFoo = str(0x080, 'foo');
  const sBar = str(0x090, 'bar');
  const sTypes = str(0x0a0, '@:@');

  const mlC = methodListAt(img, 0x100, [{ sel: sFoo, types: sTypes, imp: 0x100002000n }]);
  const mlCMeta = methodListAt(img, 0x130, [{ sel: sFoo, types: sTypes, imp: 0x100002010n }]);
  const mlP = methodListAt(img, 0x160, [{ sel: sFoo, types: sTypes, imp: 0n }]);
  const mlQ = methodListAt(img, 0x190, [{ sel: sFoo, types: sTypes, imp: 0n }]);
  const mlBaseP = methodListAt(img, 0x1c0, [{ sel: sBar, types: sTypes, imp: 0n }]);

  const protoP = protocolAt(img, 0x200, { name: sP, instanceMethods: mlP, protocols: 0n });
  const protoQ = protocolAt(img, 0x280, { name: sQ, instanceMethods: mlQ });
  const protoBaseP = protocolAt(img, 0x300, { name: sBaseP, instanceMethods: mlBaseP });
  const inheritedP = protocolListAt(img, 0x380, [protoBaseP]);
  put(0x200 + 16, inheritedP);

  const adoptedC = protocolEntryBad
    ? (() => { const addr = protocolListAt(img, 0x3c0, [VM_BASE + 0xdead0000n]); return addr; })()
    : protocolListAt(img, 0x3c0, [protoP], protocolRelativeFlags ? 0x80000000 : 0);

  u32(0x400, 0x20); // instanceSize of roC
  put(0x400 + 24, sC);
  put(0x400 + 32, mlC);
  put(0x400 + 40, adoptedC); // class_ro_t.baseProtocols
  put(0x400 + 64, 0);        // baseProperties (instance)

  const roMeta = 0x480;
  put(roMeta + 24, sC);
  put(roMeta + 32, methodListAt(img, 0x520, []));
  put(roMeta + 40, 0);
  put(roMeta + 64, 0);

  put(0x600, VM_BASE + 0x680n); // class C: isa -> metaclass
  put(0x600 + 8, 0);            // super
  put(0x600 + 32, VM_BASE + 0x400n); // data -> roC
  put(0x680, VM_BASE + 0x680n); // metaclass isa
  put(0x680 + 8, 0);
  put(0x680 + 32, VM_BASE + BigInt(roMeta));

  const classList = { vmAddr: VM_BASE + 0x6000n, size: 8n };
  put(0x6000, VM_BASE + 0x600n);
  const protocolListSection = { vmAddr: VM_BASE + 0x6100n, size: 24n };
  put(0x6100, protoP);
  put(0x6108, protoQ);
  put(0x6110, protoBaseP);

  return {
    read: readerFor(bytes),
    classList,
    runtimeSections: { protocolList: protocolListSection, executableRanges: [{ vmAddr: VM_BASE, size: IMG }] },
  };
}

function legacyClassesOf(fixture) {
  return buildObjcModel(fixture.read, fixture.classList, null, VM_BASE, null);
}

const fixture = buildFixture();
{
  const model = await legacyClassesOf(fixture);
  const c = model.classes.find((x) => x.name === 'C');
  assert.ok(c, 'class C parsed');
  assert.ok(Array.isArray(c.protocols), 'class model carries a protocols array (baseProtocols read)');
  assert.deepEqual(c.protocols.map((p) => p.name ?? p), ['P'], 'C adopts P from class_ro_t.baseProtocols');
}
{
  const model = await buildObjcRuntimeModel(fixture.read, fixture.classList, fixture.runtimeSections, null, VM_BASE, null, {});
  const index = model.runtimeIndex;
  assert.ok(index, 'runtime index built');
  assert.ok((index.classes.get('C').protocols || []).includes('P'), 'runtime index keeps C conformance');
  const d = resolveObjcDispatch(index, { receiverType: 'C', selector: 'foo' });
  const owners = d.requirements.map((m) => m.className);
  assert.ok(owners.includes('P'), `P requirement kept, got ${JSON.stringify(owners)}`);
  assert.ok(!owners.includes('Q'), `unrelated protocol Q with the same selector must not leak into evidence, got ${JSON.stringify(owners)}`);
  const inherited = resolveObjcDispatch(index, { receiverType: 'C', selector: 'bar' });
  assert.ok(inherited.requirements.some((m) => m.className === 'BaseP'), 'inherited protocol adoption is transitive');
  assert.ok(inherited.requirements.every((m) => ['P', 'BaseP'].includes(m.className)), 'transitive closure only from C conformance');
}
{
  const bad = buildFixture({ protocolEntryBad: true });
  const model = await legacyClassesOf(bad);
  const c = model.classes.find((x) => x.name === 'C');
  assert.ok(c);
  assert.deepEqual(c.protocols, [], 'unreadable protocol list fabricates nothing');
  assert.equal(model.completeness.classes.complete, false, 'malformed protocol list degrades class completeness');
}
{
  const rel = buildFixture({ protocolRelativeFlags: true });
  const model = await legacyClassesOf(rel);
  const c = model.classes.find((x) => x.name === 'C');
  assert.ok(c);
  assert.equal(c.protocols.length, 0, 'relative/list-list representation is not laundered into direct pointers');
  assert.equal(model.completeness.classes.complete, false, 'capped/unknown protocol list keeps completeness false');
}
console.log('issue #3983 class_ro_t.baseProtocols conformance: PASS');
