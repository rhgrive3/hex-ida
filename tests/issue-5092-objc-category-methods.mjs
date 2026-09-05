import assert from 'node:assert/strict';
import { ObjcMetadataProvider } from '../js/metadata/objc.js';

function categoryMethod(selector) {
  return {
    sel: selector,
    selector,
    addr: 0x1000n,
    imp: 0x1000n,
    classMethod: false,
    implementationProven: true,
  };
}

// 1. category instance methodがmethods()に現れる
{
  const provider = new ObjcMetadataProvider();
  provider.cachedModel = {
    classes: [],
    categories: [{
      name: 'Extras',
      className: 'Target',
      instanceMethods: [categoryMethod('extraMethod')],
      classMethods: [],
    }],
  };
  const page = provider.methods();
  assert.equal(page.records.length, 1);
  assert.match(page.records[0].name, /extraMethod/);
  assert.match(page.records[0].entityId, /Target/);
}

// 2. category class methodも現れる + 通常class methodを維持
{
  const provider = new ObjcMetadataProvider();
  provider.cachedModel = {
    classes: [{
      name: 'Target',
      methods: [{ sel: 'base', selector: 'base', addr: 0x2000n, imp: 0x2000n }],
      classMethods: [],
    }],
    categories: [{
      name: 'Extras',
      className: 'Target',
      instanceMethods: [],
      classMethods: [{ sel: 'cFactory', selector: 'cFactory', addr: 0x3000n, imp: 0x3000n, classMethod: true }],
    }],
  };
  const page = provider.methods();
  assert.equal(page.records.length, 2);
}

// 3. 同selectorがclass本体とcategory双方にある場合もidentityが衝突しない
{
  const provider = new ObjcMetadataProvider();
  provider.cachedModel = {
    classes: [{
      name: 'Target',
      methods: [{ sel: 'dup', selector: 'dup', addr: 0x2000n, imp: 0x2000n }],
      classMethods: [],
    }],
    categories: [{
      name: 'Extras',
      className: 'Target',
      instanceMethods: [categoryMethod('dup')],
      classMethods: [],
    }],
  };
  const page = provider.methods();
  assert.equal(page.records.length, 2);
  const ids = page.records.map((r) => r.entityId);
  assert.equal(new Set(ids).size, 2, 'entityIds must not collide');
}

// 4. methodsフィールド別名 (methods) でも列挙される
{
  const provider = new ObjcMetadataProvider();
  provider.cachedModel = {
    classes: [],
    categories: [{
      name: 'Legacy',
      className: 'Target',
      methods: [categoryMethod('legacyMethod')],
    }],
  };
  const page = provider.methods();
  assert.equal(page.records.length, 1);
}

// 5. categoryなしの既存挙動を維持 (空model)
{
  const provider = new ObjcMetadataProvider();
  provider.cachedModel = { classes: [], categories: [] };
  assert.equal(provider.methods().records.length, 0);
  const fresh = new ObjcMetadataProvider();
  assert.equal(fresh.methods().records.length, 0);
}

console.log('issue #5092 objc category methods in metadata provider: PASS');
