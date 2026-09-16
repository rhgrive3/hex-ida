import assert from 'node:assert/strict';
import test from 'node:test';

import { methodList, parseObjcExtendedMetadata } from '../../../js/apple/objc-metadata.js';

const LP64 = { pointerBytes: 8 };

function makeImage(count, opts = {}) {
  const mem = new Uint8Array(0x200000);
  const dv = new DataView(mem.buffer);
  const setU32 = (at, v) => dv.setUint32(Number(at), Number(v) >>> 0, true);
  const setU64 = (at, v) => dv.setBigUint64(Number(at), BigInt(v), true);
  const str = (at, s) => {
    const bytes = Buffer.from(s, 'utf-8');
    mem.set(bytes.subarray(0, 8192), Number(at));
    mem[Number(at) + Math.min(bytes.length, 8191)] = 0;
  };
  const selector = opts.selector ?? 'sharedSelectorName';
  const type = opts.type ?? 'v16@0:8';
  const TABLE = 0x100, PROTOCOL = 0x200, LIST = 0x1000;
  const SEL = 0x180000, TYPE = 0x181200;
  str(SEL, selector);
  str(TYPE, type);
  str(0x190000, 'P'); // protocol name
  // __objc_protolist -> one protocol_t.
  setU64(TABLE, PROTOCOL);
  setU64(PROTOCOL + 8, 0x190000); // name
  setU64(PROTOCOL + 16, 0); // inherited protocol list
  setU64(PROTOCOL + 24, LIST); // instance methods
  setU64(PROTOCOL + 32, opts.allFour ? LIST : 0);
  setU64(PROTOCOL + 40, opts.allFour ? LIST : 0);
  setU64(PROTOCOL + 48, opts.allFour ? LIST : 0);
  setU64(PROTOCOL + 56, 0);
  setU32(PROTOCOL + 64, 72); // size
  setU32(PROTOCOL + 68, 0); // flags
  // method_list_t (entsize 24, direct LP64 entries) all referencing shared strings.
  setU32(LIST, 24);
  setU32(LIST + 4, count);
  for (let i = 0; i < count; i += 1) {
    const at = BigInt(LIST) + 8n + BigInt(i * 24);
    setU64(at, SEL);
    setU64(at + 8n, TYPE);
    setU64(at + 16n, 0); // protocol requirement: no concrete IMP
  }
  const read = async (addr, len) => {
    const at = Number(addr);
    if (at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
  const sections = { protocolList: { vmAddr: BigInt(TABLE), size: 8n } };
  return { read, sections, SEL, TYPE, LIST };
}

test('#8691 A valid-sized protocol method list cannot amplify shared selector/type bytes past the parse-wide budget', async () => {
  const { read, sections } = makeImage(30000, { selector: 'x'.repeat(4095), type: 'y'.repeat(4095) });
  const before = process.memoryUsage().heapUsed;
  const parsed = await parseObjcExtendedMetadata(read, sections, LP64);
  const methodCompleteness = parsed.protocols[0].completeness.methods.instanceMethods;

  assert.equal(methodCompleteness.declared, 30000, 'declared count stays under the per-list MAX_METHODS cap');
  assert.equal(methodCompleteness.complete, false, 'the shared aggregate budget must not report a truncated run complete');
  assert.equal(methodCompleteness.budgetExhausted, true, 'the incomplete result must be attributed to budget exhaustion');
  assert.match(String(methodCompleteness.reason), /objc-extended-metadata/);
  assert.ok(parsed.protocols[0].methods.length <= 20000, 'retained records stay under the aggregate ceiling');
  assert.ok(parsed.protocols[0].methods.length < 30000, 'parsing stops before materializing every record');
  assert.ok(parsed.protocols[0].methods.length > 0, 'a bounded partial result is still returned');
  assert.equal(parsed.protocols[0].methods[0].sel.length, 4095, 'records processed before exhaustion keep full fidelity');
  assert.equal(parsed.completeness.complete, false, 'whole extended-metadata result is not complete on exhaustion');
  assert.match(String(parsed.completeness.budgetReason), /objc-extended-metadata/);
  assert.ok(process.memoryUsage().heapUsed - before < 192 * 1024 * 1024, 'peak heap stays substantially below the 256 MiB limit');
});

test('#8691 four individually sub-cap protocol method lists share one aggregate budget', async () => {
  const { read, sections } = makeImage(6000, { allFour: true });
  const parsed = await parseObjcExtendedMetadata(read, sections, {
    ...LP64,
    maxObjcExtendedRecords: 10000,
  });
  const protocol = parsed.protocols[0];
  const retained = protocol.methods.length + protocol.classMethods.length
    + protocol.optionalInstanceMethods.length + protocol.optionalClassMethods.length;
  assert.equal(retained, 10000, 'four 6000-entry lists cannot multiply the shared 10000 allowance');
  assert.equal(protocol.completeness.complete, false);
  assert.equal(parsed.completeness.complete, false);
});

test('#8691 multiple protocols and categories share the same top-level budget (no sharding bypass)', async () => {
  // Two protocols, each a 6000-entry list under the aggregate ceiling of 9000.
  const mem = new Uint8Array(0x400000);
  const dv = new DataView(mem.buffer);
  const setU32 = (at, v) => dv.setUint32(Number(at), Number(v) >>> 0, true);
  const setU64 = (at, v) => dv.setBigUint64(Number(at), BigInt(v), true);
  const str = (at, s) => { mem.set(Buffer.from(s + '\0', 'utf-8'), Number(at)); };
  str(0x300000, 'sel');
  str(0x300100, 'v@:');
  str(0x310000, 'ProtoA');
  str(0x310100, 'ProtoB');
  const build = (protocol, list, name, tableSlot) => {
    setU64(tableSlot, protocol);
    setU64(protocol + 8, name);
    setU64(protocol + 24, list);
    setU32(protocol + 64, 72);
    setU32(list, 24); setU32(list + 4, 6000);
    for (let i = 0; i < 6000; i += 1) {
      const at = BigInt(list) + 8n + BigInt(i * 24);
      setU64(at, 0x300000); setU64(at + 8n, 0x300100); setU64(at + 16n, 0);
    }
  };
  build(0x200, 0x10000, 0x310000, 0x100);
  build(0x280, 0x60000, 0x310100, 0x108);
  const read = async (addr, len) => {
    const at = Number(addr);
    if (at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
  const parsed = await parseObjcExtendedMetadata(read, {
    protocolList: { vmAddr: 0x100n, size: 16n },
  }, { ...LP64, maxObjcExtendedRecords: 9000 });
  const total = parsed.protocols.reduce((sum, p) => sum + p.methods.length, 0);
  assert.equal(total, 9000, 'per-list caps cannot be bypassed by sharding records across protocols');
  assert.equal(parsed.completeness.complete, false);
});

test('#8691 a normal small protocol fixture remains complete and byte-for-byte faithful under the budget', async () => {
  const { read, sections } = makeImage(3);
  const parsed = await parseObjcExtendedMetadata(read, sections, LP64);
  const protocol = parsed.protocols[0];
  assert.equal(protocol.name, 'P');
  assert.equal(protocol.methods.length, 3);
  assert.equal(protocol.methods[0].sel, 'sharedSelectorName');
  assert.equal(protocol.methods[0].types, 'v16@0:8');
  assert.equal(protocol.methods[0].name, '-[P sharedSelectorName]');
  assert.equal(protocol.completeness.complete, true);
  assert.equal(protocol.completeness.methods.instanceMethods.budgetExhausted, undefined);
  assert.equal(parsed.completeness.complete, true);
});

test('#8691 repeated selector/type addresses decode once per parse (canonical C-string interning)', async () => {
  const selector = 'internedSelector';
  const mem = new Uint8Array(0x20000);
  const dv = new DataView(mem.buffer);
  const LIST = 0x1000, SEL = 0x18000, TYPE = 0x18100;
  const str = (at, s) => { mem.set(Buffer.from(s + '\0', 'utf-8'), at); };
  str(SEL, selector); str(TYPE, 'v@:');
  dv.setUint32(LIST, 24, true); dv.setUint32(LIST + 4, 100, true);
  for (let i = 0; i < 100; i += 1) {
    const at = LIST + 8 + i * 24;
    dv.setBigUint64(at, BigInt(SEL), true);
    dv.setBigUint64(at + 8, BigInt(TYPE), true);
    dv.setBigUint64(at + 16, 0n, true);
  }
  let selDecodes = 0;
  const get = async (addr, len) => {
    if (BigInt(addr) === BigInt(SEL)) selDecodes += 1;
    const at = Number(addr);
    return at >= 0 && at < mem.length ? mem.subarray(at, Math.min(mem.length, at + len)) : null;
  };
  get.pointerBytes = 8;
  get.__objcExtended = {
    budget: { exhausted: false, reason: null, chargeRecords: () => true, chargeStringBytes: () => true },
    strings: new Map(), names: new Map(),
  };
  const res = await methodList(get, BigInt(LIST), 'Klass', false, 'class', {});
  assert.equal(res.items.length, 100);
  assert.equal(selDecodes, 1, 'the shared selector address is scanned/decoded once, not once per record');
  assert.ok(res.items.every((item) => item.sel === selector), 'all valid references still resolve correctly');
});
