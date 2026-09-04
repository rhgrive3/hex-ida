import assert from 'node:assert/strict';
import { ObjcMetadataProvider } from '../js/metadata/objc.js';

console.log('Testing issue #6211: ObjcMetadataProvider distinguishes class and instance methods in entityId...');

// 1. Same selector on class and instance methods must not collide in entityId
{
  const provider = new ObjcMetadataProvider({
    binaryIdentity: 'sha256:objc-test-binary',
  });

  provider.cachedModel = {
    classes: [
      {
        name: 'MyController',
        address: 0x1000n,
        methods: [
          { sel: 'init', addr: 0x1100n },
          { sel: 'refresh', addr: 0x1120n },
        ],
        classMethods: [
          { sel: 'refresh', addr: 0x1140n },
          { sel: 'defaultController', addr: 0x1160n },
        ],
      },
      {
        name: 'Helper',
        address: 0x2000n,
        methods: [
          { selector: 'run', imp: 0x2100n },
        ],
        classMethods: [
          { selector: 'run', imp: 0x2200n },
        ],
      },
    ],
  };

  const page = provider.methods();
  assert.ok(page && Array.isArray(page.records), 'Page should contain records array');
  assert.equal(page.records.length, 6, 'Should have 6 method records in total');

  const entityIds = page.records.map((r) => r.entityId);
  const uniqueEntityIds = new Set(entityIds);
  assert.equal(uniqueEntityIds.size, 6, 'All entityIds must be unique even when selectors are identical');

  const instanceRefresh = page.records.find((r) => r.entityId === 'method@MyController:-:refresh');
  assert.ok(instanceRefresh, 'Must have instance method record for MyController refresh');
  assert.equal(instanceRefresh.name, '-[MyController refresh]');
  assert.equal(instanceRefresh.address, '0x1120');
  assert.equal(instanceRefresh.descriptor.classMethod, false);
  assert.equal(instanceRefresh.descriptor.selector, 'refresh');
  assert.equal(instanceRefresh.descriptor.className, 'MyController');

  const classRefresh = page.records.find((r) => r.entityId === 'method@MyController:+:refresh');
  assert.ok(classRefresh, 'Must have class method record for MyController refresh');
  assert.equal(classRefresh.name, '+[MyController refresh]');
  assert.equal(classRefresh.address, '0x1140');
  assert.equal(classRefresh.descriptor.classMethod, true);
  assert.equal(classRefresh.descriptor.selector, 'refresh');
  assert.equal(classRefresh.descriptor.className, 'MyController');

  // Test selector fallback when m.sel is undefined but m.selector is present
  const instanceRun = page.records.find((r) => r.entityId === 'method@Helper:-:run');
  assert.ok(instanceRun, 'Must support selector fallback for instance method');
  assert.equal(instanceRun.name, '-[Helper run]');
  assert.equal(instanceRun.address, '0x2100');
  assert.equal(instanceRun.descriptor.classMethod, false);

  const classRun = page.records.find((r) => r.entityId === 'method@Helper:+:run');
  assert.ok(classRun, 'Must support selector fallback for class method');
  assert.equal(classRun.name, '+[Helper run]');
  assert.equal(classRun.address, '0x2200');
  assert.equal(classRun.descriptor.classMethod, true);
}

// 2. Custom m.name preserved if provided
{
  const provider = new ObjcMetadataProvider({
    binaryIdentity: 'sha256:objc-test-custom-name',
  });

  provider.cachedModel = {
    classes: [
      {
        name: 'CustomClass',
        methods: [
          { sel: 'customSel', name: 'CustomDisplayName', addr: 0x3000n },
        ],
        classMethods: [
          { sel: 'customSel', name: '+[CustomClass customSelOverride]', addr: 0x3010n },
        ],
      },
    ],
  };

  const page = provider.methods();
  const inst = page.records.find((r) => r.entityId === 'method@CustomClass:-:customSel');
  assert.ok(inst);
  assert.equal(inst.name, 'CustomDisplayName', 'Custom name should be preserved if explicitly set');

  const cls = page.records.find((r) => r.entityId === 'method@CustomClass:+:customSel');
  assert.ok(cls);
  assert.equal(cls.name, '+[CustomClass customSelOverride]', 'Custom name should be preserved for class method');
}

// 3. Determinism: multiple invocations produce identical results
{
  const provider = new ObjcMetadataProvider();
  provider.cachedModel = {
    classes: [
      {
        name: 'A',
        methods: [{ sel: 'foo', addr: 0x1n }],
        classMethods: [{ sel: 'foo', addr: 0x2n }],
      },
    ],
  };

  const page1 = provider.methods();
  const page2 = provider.methods();
  assert.deepEqual(page1, page2, 'methods() calls must be idempotent and deterministic');
}

console.log('issue #6211 test passed.');
