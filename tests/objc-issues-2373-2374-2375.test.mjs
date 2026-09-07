import assert from 'node:assert/strict';
import test from 'node:test';

import { buildObjcModel } from '../js/objc-legacy.js';
import { buildObjcRuntimeModel } from '../js/objc.js';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';

function sparseMemory() {
  const bytes = new Map();
  const put = (addr, data) => {
    const a = BigInt(addr);
    const u8 = data instanceof Uint8Array ? data : Uint8Array.from(data);
    for (let i = 0; i < u8.length; i++) bytes.set((a + BigInt(i)).toString(), u8[i]);
  };
  const p32 = (addr, value) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, Number(value) >>> 0, true);
    put(addr, b);
  };
  const p64 = (addr, value) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(value), true);
    put(addr, b);
  };
  const str = (addr, value, raw = null) => {
    const b = raw || new TextEncoder().encode(String(value));
    const out = new Uint8Array(b.length + 1);
    out.set(b);
    put(addr, out);
  };
  const read = async (addr, len) => {
    const a = BigInt(addr);
    const out = [];
    for (let i = 0; i < len; i++) {
      const value = bytes.get((a + BigInt(i)).toString());
      if (value == null) break;
      out.push(value);
    }
    return out.length ? Uint8Array.from(out) : null;
  };
  return { put, p32, p64, str, read };
}

function legacyClassFixture({ className = 'プレイヤー', selector = '保存する:', malformedClassName = false } = {}) {
  const mem = sparseMemory();
  const classList = 0x1000n;
  const cls = 0x2000n;
  const ro = 0x3000n;
  const classNameAddr = 0x4000n;
  const selectorAddr = 0x4100n;
  const typesAddr = 0x4200n;
  const methods = 0x5000n;
  const imp = 0x6000n;

  mem.p64(classList, cls);
  mem.put(cls, new Uint8Array(40));
  mem.p64(cls + 32n, ro);
  mem.put(ro, new Uint8Array(72));
  mem.p32(ro + 8n, 32);
  mem.p64(ro + 24n, classNameAddr);
  mem.p64(ro + 32n, methods);

  if (malformedClassName) mem.str(classNameAddr, '', Uint8Array.from([0xe3, 0x81]));
  else mem.str(classNameAddr, className);
  mem.str(selectorAddr, selector);
  mem.str(typesAddr, 'v16@0:8');

  mem.p32(methods, 24);
  mem.p32(methods + 4n, 1);
  mem.p64(methods + 8n, selectorAddr);
  mem.p64(methods + 16n, typesAddr);
  mem.p64(methods + 24n, imp);

  return { mem, classList: { vmAddr: classList, size: 8n }, imp };
}

test('#2373 legacy Objective-C parser accepts valid UTF-8 class names and selectors', async () => {
  const { mem, classList, imp } = legacyClassFixture();
  const model = await buildObjcModel(mem.read, classList);
  assert.equal(model.classes[0]?.name, 'プレイヤー');
  assert.equal(model.names[0]?.name, '-[プレイヤー 保存する:]');
  assert.equal(model.names[0]?.addr, imp);
  assert.equal(model.completeness.complete, true);
});

test('#2373 malformed UTF-8 still fails closed and marks the class universe partial', async () => {
  const { mem, classList } = legacyClassFixture({ malformedClassName: true });
  const model = await buildObjcModel(mem.read, classList);
  assert.equal(model.classes.length, 0);
  assert.equal(model.completeness.complete, false);
  assert.ok(model.completeness.classes.reasons.includes('class-name-invalid'));
});

test('#2374 runtime facade propagates arm64e chained-pointer decoding to categories and protocols', async () => {
  const mem = sparseMemory();
  const base = 0x100000000n;
  const catList = base + 0x1000n;
  const protoList = base + 0x2000n;
  const cat = base + 0x3000n;
  const proto = base + 0x5000n;
  const catName = base + 0x4000n;
  const protoName = base + 0x6000n;

  // Authenticated rebases carry a 32-bit runtime offset in arm64e format 1.
  mem.p64(catList, (1n << 63n) | 0x3000n);
  mem.p64(protoList, (1n << 63n) | 0x5000n);
  mem.put(cat, new Uint8Array(56));
  mem.p64(cat, catName);
  mem.str(catName, '国際化カテゴリ');
  mem.put(proto, new Uint8Array(64));
  mem.p64(proto + 8n, protoName);
  mem.str(protoName, '保存可能');

  const model = await buildObjcRuntimeModel(
    mem.read,
    null,
    { categoryList: { vmAddr: catList, size: 8n }, protocolList: { vmAddr: protoList, size: 8n } },
    null,
    base,
    1,
  );
  assert.equal(model.categories[0]?.name, '国際化カテゴリ');
  assert.equal(model.protocols[0]?.name, '保存可能');
  assert.equal(model.runtimeCompleteness.complete, true);
});

test('#2375 class-list cap/truncation is explicit and blocks global exact dispatch', async () => {
  const model = await buildObjcModel(
    async () => { throw new Error('truncated'); },
    { vmAddr: 0x1000n, size: BigInt(20001 * 8) },
  );
  assert.equal(model.completeness.classes.capped, true);
  assert.equal(model.completeness.complete, false);

  const index = buildObjcRuntimeIndex({
    classes: [{ name: 'Visible', methods: [{ sel: 'save:', addr: 0x1234n }] }],
    runtimeCompleteness: {
      classes: model.completeness.classes,
      categories: { complete: true },
      protocols: { complete: true },
      complete: false,
    },
  });
  const result = resolveObjcDispatch(index, { selector: 'save:' });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.resolved, null);
  assert.equal(result.partial, true);
});
