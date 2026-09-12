import assert from 'node:assert/strict';
import { ObjcMetadataProvider } from '../js/metadata/objc.js';
import { isCanonicalLanguageRecord } from '../js/metadata/provider.js';

console.log('Testing #5092: ObjcMetadataProvider must publish category methods...');

// 1. Provider boundary: the issue's deterministic counter-example.
{
  const provider = new ObjcMetadataProvider();
  provider.cachedModel = {
    classes: [],
    categories: [{
      name: 'Extras',
      className: 'Target',
      instanceMethods: [{
        sel: 'extraMethod',
        selector: 'extraMethod',
        addr: 0x1000n,
        imp: 0x1000n,
        classMethod: false,
        implementationProven: true,
      }],
      classMethods: [],
    }],
  };

  const page = provider.methods();
  assert.equal(page.records.length, 1, 'a category instance method must reach the methods page');
  const record = page.records[0];
  assert.ok(isCanonicalLanguageRecord(record));
  assert.equal(record.kind, 'method');
  assert.equal(record.address, '0x1000');
  assert.equal(record.descriptor.selector, 'extraMethod');
  assert.equal(record.descriptor.className, 'Target');
  assert.equal(record.descriptor.classMethod, false);
}

// 2. Category records are attributed to the category owner and never collide
//    with the same selector implemented on the class body.
{
  const provider = new ObjcMetadataProvider();
  provider.cachedModel = {
    classes: [{
      name: 'Target',
      address: 0x900n,
      methods: [{ sel: 'shared', addr: 0x1000n, implementationProven: true }],
      classMethods: [{ sel: 'sharedClass', addr: 0x1100n, implementationProven: true }],
    }],
    categories: [{
      name: 'Extras',
      className: 'Target',
      methods: [{ sel: 'debugName', addr: 0x1200n, implementationProven: true }],
      instanceMethods: [{ sel: 'debugName', addr: 0x1200n, implementationProven: true }],
      classMethods: [{ sel: 'sharedClass', addr: 0x1300n, implementationProven: true }],
    }],
  };

  const page = provider.methods();
  const ids = page.records.map((r) => r.entityId);
  assert.equal(new Set(ids).size, ids.length, `record identity must not collide: ${ids.join(', ')}`);

  const classInstance = page.records.find((r) => r.entityId === 'method@Target:-:shared');
  assert.ok(classInstance, 'ordinary class instance methods must be preserved');
  assert.equal(classInstance.name, '-[Target shared]');
  assert.equal(classInstance.descriptor.classMethod, false);

  const classLevel = page.records.find((r) => r.entityId === 'method@Target:+:sharedClass');
  assert.ok(classLevel, 'ordinary class methods must be preserved');
  assert.equal(classLevel.name, '+[Target sharedClass]');

  const categoryInstance = page.records.find((r) => r.descriptor.selector === 'debugName');
  assert.ok(categoryInstance, 'a category instance method must be published');
  assert.equal(categoryInstance.descriptor.classMethod, false);
  assert.equal(categoryInstance.descriptor.className, 'Target');
  assert.match(categoryInstance.entityId, /Extras/);
  assert.equal(categoryInstance.name, '-[Target(Extras) debugName]');
  assert.equal(categoryInstance.address, '0x1200');

  const categoryLevel = page.records.find(
    (r) => r.descriptor.selector === 'sharedClass' && r.entityId !== 'method@Target:+:sharedClass',
  );
  assert.ok(categoryLevel, 'a category class method must be published');
  assert.equal(categoryLevel.descriptor.classMethod, true);
  assert.match(categoryLevel.entityId, /Extras/);
  assert.equal(categoryLevel.name, '+[Target(Extras) sharedClass]');
}

// 3. Real runtime model end to end: probe() counts and the published page must
//    agree, and both must contain category methods.
function image() {
  const mem = new Uint8Array(0x8000);
  const dv = new DataView(mem.buffer);
  const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  let cursor = 0x1900;
  const str = (s) => {
    const at = cursor;
    for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i);
    mem[at + s.length] = 0;
    cursor += s.length + 1;
    return at;
  };
  const methodList = (at, entries) => {
    p32(at, 24);
    p32(at + 4, entries.length);
    entries.forEach((entry, i) => {
      const slot = at + 8 + i * 24;
      p64(slot, str(entry.sel));
      p64(slot + 8, str('v16@0:8'));
      p64(slot + 16, entry.imp);
    });
  };

  p64(0x200, 0x1000);
  p64(0x1000, 0x1100);
  p64(0x1000 + 32, 0x1200);
  p64(0x1100 + 32, 0x1300);
  p32(0x1200 + 8, 32);
  p64(0x1200 + 24, str('Target'));
  p64(0x1200 + 32, 0x1400);
  p32(0x1300 + 8, 40);
  p64(0x1300 + 24, str('Target'));
  p64(0x1300 + 32, 0x1500);
  methodList(0x1400, [{ sel: 'shared', imp: 0x2000 }, { sel: 'targetOnly', imp: 0x2010 }]);
  methodList(0x1500, [{ sel: 'targetClassOnly', imp: 0x2020 }]);

  p64(0x300, 0x1600);
  p64(0x1600, str('Extras'));
  p64(0x1600 + 8, 0x1000);
  p64(0x1600 + 16, 0x1700);
  p64(0x1600 + 24, 0x1780);
  methodList(0x1700, [{ sel: 'shared', imp: 0x2030 }, { sel: 'extraInstance', imp: 0x2040 }]);
  methodList(0x1780, [{ sel: 'extraClass', imp: 0x2050 }]);

  const read = async (addr, len) => {
    const at = Number(addr);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
  return { read, p32, p64 };
}

function providerFor(read) {
  return new ObjcMetadataProvider({
    sections: [
      { name: '__objc_classlist', section: '__objc_classlist', vmAddr: 0x200n, size: 8n },
      { name: '__objc_catlist', section: '__objc_catlist', vmAddr: 0x300n, size: 8n },
    ],
    readAt: read,
    binaryIdentity: 'sha256:objc-category-runtime-model',
    options: {
      runtimeSections: {
        categoryList: { vmAddr: 0x300n, size: 8n },
        executableRanges: [{ vmAddr: 0x2000n, size: 0x100n }],
      },
    },
  });
}

{
  const { read } = image();
  const provider = providerFor(read);
  const result = await provider.probe();
  const page = provider.methods();
  const selectors = page.records.map((r) => r.descriptor.selector).sort();

  assert.equal(result.identity.verdict, 'matched-authoritative', JSON.stringify(result.identity));
  assert.equal(result.completeness.complete, true);
  assert.deepEqual(selectors, ['extraClass', 'extraInstance', 'shared', 'shared', 'targetClassOnly', 'targetOnly']);
  assert.equal(result.counts.methods, page.records.length, 'counts.methods must match the published method collection');
  assert.ok(
    page.records.some((r) => r.descriptor.selector === 'extraInstance' && /Extras/.test(r.entityId)),
    'category instance methods must be attributed to their category owner',
  );
  assert.equal(new Set(page.records.map((r) => r.entityId)).size, page.records.length);
}

// 4. An incomplete category parse stays explicit even though its recovered
//    category methods are now published.
{
  const fixture = image();
  fixture.p32(0x1704, 3);
  const provider = providerFor(fixture.read);
  const result = await provider.probe();
  const page = provider.methods();
  assert.equal(result.completeness.complete, false, 'a truncated category method list must not claim completeness');
  assert.equal(result.identity.verdict, 'matched-partial');
  assert.equal(result.counts.methods, page.records.length);
}

console.log('issue-5092 objc category metadata methods: PASS');
