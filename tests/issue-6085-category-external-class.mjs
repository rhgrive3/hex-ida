import assert from 'node:assert/strict';
import test from 'node:test';
import { parseObjcExtendedMetadata } from '../js/apple/objc-metadata.js';
import { buildObjcRuntimeIndex } from '../js/apple/objc-runtime.js';

const CATLIST = 0x1000;
const CAT = 0x2000;
const CAT_NAME = 0x3000;
const ML = 0x5000;
const SEL = 0x6000;
const TYPES = 0x6100;
const IMP = 0x7000;
const CLS_STORAGE = CAT + 8; // category cls field storage address

function buildMem() {
  const mem = new Uint8Array(0x10000);
  const v = new DataView(mem.buffer);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const u32 = (o, x) => v.setUint32(o, x, true);
  const str = (o, s) => mem.set(new TextEncoder().encode(s + '\0'), o);
  u64(CATLIST, CAT);
  u64(CAT, CAT_NAME);
  // cls field raw word: use bind sentinel (non-zero, will be treated as bind via resolvePointer->null)
  u64(CAT + 8, 0xdeadbeef);
  u64(CAT + 16, ML);
  u64(CAT + 24, 0);
  u64(CAT + 32, 0);
  u64(CAT + 40, 0);
  u64(CAT + 48, 0);
  str(CAT_NAME, 'HexAudit');
  u32(ML, 24); u32(ML + 4, 1);
  u64(ML + 8, SEL); u64(ML + 16, TYPES); u64(ML + 24, IMP);
  str(SEL, 'hex_isInteresting');
  str(TYPES, 'c@:');
  return mem;
}

function makeRead(mem) {
  return async (addr, len) => {
    const at = Number(addr);
    if (at < 0 || at + len > mem.length) return null;
    return mem.subarray(at, at + len);
  };
}

test('issue #6085 - external class category restores owner from bind symbol', async () => {
  const mem = buildMem();
  const read = makeRead(mem);
  const sections = { categoryList: { vmAddr: BigInt(CATLIST), size: 8n } };
  // resolvePointer fails closed for the bind (returns null), like chained bind
  const resolvePointer = async (raw, ctx) => {
    const storage = ctx?.address != null ? BigInt(ctx.address) : null;
    if (storage === BigInt(CLS_STORAGE)) return null;
    return BigInt(raw);
  };
  const extra = await parseObjcExtendedMetadata(read, sections, {
    classes: [],
    resolvePointer,
    validateImplementation: async () => ({ ok: true }),
    requireImplementationProof: false,
    bindingAt: (addr) => {
      if (BigInt(addr) === BigInt(CLS_STORAGE)) return { name: '_OBJC_CLASS_$_NSString', complete: true };
      return null;
    },
  });
  assert.equal(extra.categories.length, 1);
  assert.equal(extra.categories[0].className, 'NSString');
  assert.equal(extra.categories[0].methods[0].className, 'NSString');
});

test('issue #6085 - local class category still uses address map', async () => {
  const mem = buildMem();
  // overwrite cls field to point at local class address
  new DataView(mem.buffer).setBigUint64(CAT + 8, 0x4000n, true);
  const read = makeRead(mem);
  const sections = { categoryList: { vmAddr: BigInt(CATLIST), size: 8n } };
  const extra = await parseObjcExtendedMetadata(read, sections, {
    classes: [{ addr: 0x4000n, name: 'LocalClass' }],
    resolvePointer: async (raw) => BigInt(raw),
    validateImplementation: async () => ({ ok: true }),
    requireImplementationProof: false,
  });
  assert.equal(extra.categories[0].className, 'LocalClass');
});

test('issue #6085 - generic bind is not promoted to class identity', async () => {
  const mem = buildMem();
  const read = makeRead(mem);
  const sections = { categoryList: { vmAddr: BigInt(CATLIST), size: 8n } };
  const extra = await parseObjcExtendedMetadata(read, sections, {
    classes: [],
    resolvePointer: async (raw, ctx) => {
      if (BigInt(ctx?.address) === BigInt(CLS_STORAGE)) return null;
      return BigInt(raw);
    },
    validateImplementation: async () => ({ ok: true }),
    requireImplementationProof: false,
    bindingAt: (addr) => {
      if (BigInt(addr) === BigInt(CLS_STORAGE)) return { name: '_some_other_symbol' };
      return null;
    },
  });
  assert.equal(extra.categories[0].className, null);
});

test('issue #6085 - missing bind stays unknown (fail closed)', async () => {
  const mem = buildMem();
  const read = makeRead(mem);
  const sections = { categoryList: { vmAddr: BigInt(CATLIST), size: 8n } };
  const extra = await parseObjcExtendedMetadata(read, sections, {
    classes: [],
    resolvePointer: async (raw, ctx) => {
      if (BigInt(ctx?.address) === BigInt(CLS_STORAGE)) return null;
      return BigInt(raw);
    },
    validateImplementation: async () => ({ ok: true }),
    requireImplementationProof: false,
  });
  assert.equal(extra.categories[0].className, null);
});

test('issue #6085 - external category joins runtime dispatch via receiver', async () => {
  const mem = buildMem();
  const read = makeRead(mem);
  const sections = { categoryList: { vmAddr: BigInt(CATLIST), size: 8n } };
  const extra = await parseObjcExtendedMetadata(read, sections, {
    classes: [],
    resolvePointer: async (raw, ctx) => {
      if (BigInt(ctx?.address) === BigInt(CLS_STORAGE)) return null;
      return BigInt(raw);
    },
    validateImplementation: async () => ({ ok: true }),
    requireImplementationProof: false,
    bindingAt: () => ({ name: '_OBJC_CLASS_$_NSString' }),
  });
  const index = buildObjcRuntimeIndex({ classes: [], protocols: [], categories: extra.categories });
  const found = (index.methodsBySelector.get('-:hex_isInteresting') || [])[0];
  assert.ok(found);
  assert.equal(found.className, 'NSString');
});

test('issue #6085 - binaryImage imports provide bind identity without explicit bindingAt', async () => {
  const mem = buildMem();
  const read = makeRead(mem);
  const sections = {
    categoryList: { vmAddr: BigInt(CATLIST), size: 8n },
    binaryImage: {
      imports: [{ name: '_OBJC_CLASS_$_NSString', sites: [{ address: BigInt(CLS_STORAGE) }] }],
    },
  };
  const extra = await parseObjcExtendedMetadata(read, sections, {
    classes: [],
    resolvePointer: async (raw, ctx) => {
      if (BigInt(ctx?.address) === BigInt(CLS_STORAGE)) return null;
      return BigInt(raw);
    },
    validateImplementation: async () => ({ ok: true }),
    requireImplementationProof: false,
  });
  assert.equal(extra.categories[0].className, 'NSString');
  assert.equal(extra.categories[0].targetClass, 'NSString');
});

test('issue #6085 - metaclass and non-class binds are not promoted', async () => {
  const mem = buildMem();
  const read = makeRead(mem);
  const sections = { categoryList: { vmAddr: BigInt(CATLIST), size: 8n } };
  for (const bad of ['_OBJC_METACLASS_$_NSString', '_OBJC_IVAR_$_NSString._x', '']) {
    const extra = await parseObjcExtendedMetadata(read, sections, {
      classes: [],
      resolvePointer: async (raw, ctx) => {
        if (BigInt(ctx?.address) === BigInt(CLS_STORAGE)) return null;
        return BigInt(raw);
      },
      validateImplementation: async () => ({ ok: true }),
      requireImplementationProof: false,
      bindingAt: () => ({ name: bad }),
    });
    assert.equal(extra.categories[0].className, null, bad);
  }
});

test('issue #6085 - resolveClassReference fallback restores owner', async () => {
  const mem = buildMem();
  const read = makeRead(mem);
  const sections = { categoryList: { vmAddr: BigInt(CATLIST), size: 8n } };
  const extra = await parseObjcExtendedMetadata(read, sections, {
    classes: [],
    resolvePointer: async (raw, ctx) => {
      if (BigInt(ctx?.address) === BigInt(CLS_STORAGE)) return null;
      return BigInt(raw);
    },
    validateImplementation: async () => ({ ok: true }),
    requireImplementationProof: false,
    resolveClassReference: async (addr) => {
      assert.equal(BigInt(addr), BigInt(CLS_STORAGE));
      return '_OBJC_CLASS_$_NSString';
    },
  });
  assert.equal(extra.categories[0].className, 'NSString');
});
