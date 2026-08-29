import assert from 'node:assert/strict';
import { buildObjcModel } from '../js/objc.js';
import { objcIvarRangeWithinInstance } from '../js/objc-ivar-layout.js';
import { FieldIndex } from '../js/fields.js';
import { buildSampleBinary } from '../js/sample.js';

assert.equal(objcIvarRangeWithinInstance(0x20, 4, 0x40), true);
assert.equal(objcIvarRangeWithinInstance(0x40, 4, 0x40), false, 'offset == instanceSize is outside the instance');
assert.equal(objcIvarRangeWithinInstance(0x41, 4, 0x40), false, 'offset beyond instanceSize is outside the instance');
assert.equal(objcIvarRangeWithinInstance(0x3e, 4, 0x40), false, 'known ivar width may not cross instanceSize');
assert.equal(objcIvarRangeWithinInstance(0x3f, null, 0x40), true, 'unknown width still permits a strictly in-bounds offset');
assert.equal(objcIvarRangeWithinInstance(null, 4, 0x40), false, 'unresolved offsets are never exact layout evidence');

const direct = new FieldIndex({ classes: [
  {
    name:'Base', instanceSize:0x20, superName:null,
    ivars:[{ name:'_base', offset:0x10, size:4, offsetVar:0x9000n }], properties:[], methods:[], classMethods:[],
  },
  {
    name:'Child', instanceSize:0x40, superName:'Base',
    ivars:[
      { name:'_valid', offset:0x20, size:4, offsetVar:0x9010n },
      { name:'_atEnd', offset:0x40, size:4, offsetVar:0x9020n },
      { name:'_crossing', offset:0x3e, size:4, offsetVar:0x9030n },
      { name:'_unresolved', offset:null, size:4, offsetVar:0x9040n },
    ], properties:[], methods:[], classMethods:[],
  },
] });
assert.equal(direct.fieldCount, 2, 'only layout-bounded ivars enter the semantic field index');
assert.equal(direct.fieldAt('Child', 0x20)?.field.name, '_valid');
assert.equal(direct.fieldAt('Child', 0x10)?.field.name, '_base', 'legal inherited superclass ivars remain resolvable');
assert.equal(direct.fieldAt('Child', 0x40), null);
assert.equal(direct.fieldAt('Child', 0x3e), null);
assert.equal(direct.fieldAtOffsetVar(0x9020n), null, 'out-of-bounds ivar offset variables are not exact field identities');
assert.equal(direct.fieldAtOffsetVar(0x9040n), null, 'unresolved ivar offsets are not exact through offset-variable lookup');
assert.equal(direct.resolveAccess({ self:true, base:'x0', disp:0x40n }, 'Child'), null);

const VM_BASE = 0x100000000n;
const CLASSLIST = { vmAddr:0x100004100n, size:8n };
function readerFor(bytes) {
  return async (addr, len) => {
    const off = Number(addr - VM_BASE);
    if (!Number.isSafeInteger(off) || off < 0 || off >= bytes.length) return null;
    return bytes.subarray(off, Math.min(bytes.length, off + len));
  };
}

{
  const bytes = buildSampleBinary().slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0x41c8, 0x20, true); // class_ro_t.instanceSize
  const model = await buildObjcModel(readerFor(bytes), CLASSLIST);
  const cls = model.classes.find((x) => x.name === 'BattleManager');
  assert.ok(cls);
  assert.equal(cls.ivars.length, 0, 'offsets at/beyond instanceSize must not survive parsing');
  assert.equal(model.completeness.classes.complete, false);
  assert.ok(model.completeness.classes.reasons.includes('ivar-layout-out-of-bounds'));
  assert.equal(model.completeness.classes.invalidIvars, 2);
  assert.equal(new FieldIndex(model).resolveAccess({ self:true, base:'x0', disp:0x20n }, 'BattleManager'), null);
}

{
  const bytes = buildSampleBinary().slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0x4324, 0x10, true); // first ivar_t size: 0x20 + 0x10 > 0x28
  const model = await buildObjcModel(readerFor(bytes), CLASSLIST);
  const cls = model.classes.find((x) => x.name === 'BattleManager');
  assert.ok(cls);
  assert.deepEqual(cls.ivars.map((x) => x.name), ['_attack'], 'a partially crossing ivar is rejected while a valid sibling remains');
  assert.ok(model.completeness.classes.reasons.includes('ivar-layout-out-of-bounds'));
}

{
  const bytes = buildSampleBinary().slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setBigUint64(0x4308, 0n, true); // first ivar_t offset pointer unresolved
  const model = await buildObjcModel(readerFor(bytes), CLASSLIST);
  const cls = model.classes.find((x) => x.name === 'BattleManager');
  assert.ok(cls);
  const hp = cls.ivars.find((x) => x.name === '_hp');
  assert.equal(hp?.offset, null, 'unresolved metadata may remain descriptive but cannot claim an exact offset');
  assert.ok(model.completeness.classes.reasons.includes('ivar-offset-unresolved'));
  const fields = new FieldIndex(model);
  assert.equal(fields.fieldAt('BattleManager', 0x20), null);
  assert.equal(fields.fieldAtOffsetVar(0n), null);
}

console.log('issue #2399 Objective-C ivar layout bounds: PASS');
