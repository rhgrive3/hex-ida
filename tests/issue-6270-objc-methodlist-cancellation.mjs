import assert from 'node:assert/strict';
import { methodList, protocolRefs, parseProtocol, parseCategory, parseObjcExtendedMetadata } from '../js/apple/objc-metadata.js';

console.log('Testing Issue #6270 ObjC methodList and protocolRefs cancellation...');

function createMockBuffer(size = 0x80000) {
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  let readCount = 0;

  const setU32 = (addr, val) => dv.setUint32(Number(addr), Number(val) >>> 0, true);
  const setU64 = (addr, val) => dv.setBigUint64(Number(addr), BigInt(val), true);
  const setString = (addr, str) => {
    const at = Number(addr);
    const b = Buffer.from(str + '\0', 'utf-8');
    buf.set(b, at);
  };

  const read = async (addr, len, soft) => {
    readCount++;
    const at = Number(addr);
    if (at < 0 || at >= buf.length) return null;
    const available = buf.length - at;
    if (available >= len) return buf.subarray(at, at + len);
    if (soft) return buf.subarray(at);
    return null;
  };

  return { setU32, setU64, setString, read, getReadCount: () => readCount, resetReadCount: () => { readCount = 0; } };
}

// 1. methodList cancellation
{
  const { setU32, setU64, setString, read, getReadCount } = createMockBuffer();
  const listAddr = 0x2000n;
  const count = 10000;
  // entsize = 24 (direct 64-bit), count = 10000
  setU32(listAddr, 24);
  setU32(listAddr + 4n, count);

  for (let i = 0; i < count; i++) {
    const entryAddr = listAddr + 8n + BigInt(i * 24);
    const selAddr = 0x40000n + BigInt((i % 100) * 16);
    const typeAddr = 0x50000n + BigInt((i % 100) * 16);
    setU64(entryAddr, selAddr);
    setU64(entryAddr + 8n, typeAddr);
    setU64(entryAddr + 16n, 0x1000n);
    setString(selAddr, `sel_${i}`);
    setString(typeAddr, 'v@:');
  }

  const controller = new AbortController();
  // Abort after 10 reads
  let readTrigger = 0;
  const abortingRead = async (addr, len, soft) => {
    readTrigger++;
    if (readTrigger >= 10) {
      controller.abort();
    }
    return read(addr, len, soft);
  };

  const res = await methodList(abortingRead, listAddr, 'TestClass', false, 'class', { signal: controller.signal });
  assert.equal(res.completeness.complete, false, 'Aborted methodList must have complete: false');
  assert.ok(res.completeness.scanned < count, `Scanned (${res.completeness.scanned}) should be much less than total ${count}`);
  assert.ok(getReadCount() < count, `Read count (${getReadCount()}) should be bounded when aborted`);
}

// 2. protocolRefs cancellation
{
  const { setU64, setString, read, getReadCount } = createMockBuffer();
  const listAddr = 0x3000n;
  const count = 1000;
  setU64(listAddr, BigInt(count));

  for (let i = 0; i < count; i++) {
    const slot = listAddr + 8n + BigInt(i * 8);
    const protoAddr = 0x60000n + BigInt((i % 50) * 64);
    const nameAddr = 0x70000n + BigInt((i % 50) * 32);
    setU64(slot, protoAddr);
    setU64(protoAddr + 8n, nameAddr);
    setString(nameAddr, `Proto_${i}`);
  }

  const controller = new AbortController();
  let readTrigger = 0;
  const abortingRead = async (addr, len, soft) => {
    readTrigger++;
    if (readTrigger >= 15) {
      controller.abort();
    }
    return read(addr, len, soft);
  };

  const res = await protocolRefs(abortingRead, listAddr, { signal: controller.signal });
  assert.equal(res.completeness.complete, false, 'Aborted protocolRefs must have complete: false');
  assert.ok(res.completeness.scanned < count, 'Should not scan all protocol refs after abort');
}

// 3. parseProtocol cancellation inside nested method list
{
  const { setU32, setU64, setString, read } = createMockBuffer();
  const protoAddr = 0x10000n;
  const nameAddr = 0x11000n;
  const methodListAddr = 0x12000n;
  setString(nameAddr, 'MyProtocol');

  // Protocol struct
  setU64(protoAddr + 8n, nameAddr);       // name
  setU64(protoAddr + 16n, 0n);            // inherited protocols
  setU64(protoAddr + 24n, methodListAddr); // instance methods
  setU64(protoAddr + 32n, 0n);            // class methods
  setU64(protoAddr + 40n, 0n);            // optional instance
  setU64(protoAddr + 48n, 0n);            // optional class

  // 1000 methods
  const count = 1000;
  setU32(methodListAddr, 24);
  setU32(methodListAddr + 4n, count);
  for (let i = 0; i < count; i++) {
    const entryAddr = methodListAddr + 8n + BigInt(i * 24);
    const selAddr = 0x20000n + BigInt((i % 50) * 16);
    setU64(entryAddr, selAddr);
    setU64(entryAddr + 8n, 0n);
    setU64(entryAddr + 16n, 0n);
    setString(selAddr, `proto_m_${i}`);
  }

  const controller = new AbortController();
  let reads = 0;
  const abortingRead = async (addr, len, soft) => {
    reads++;
    if (reads === 12) controller.abort();
    return read(addr, len, soft);
  };

  const proto = await parseProtocol(abortingRead, protoAddr, { signal: controller.signal });
  assert.ok(proto != null);
  assert.equal(proto.completeness.complete, false, 'Protocol completeness must be false when aborted inside method list');
  assert.equal(proto.completeness.methods.instanceMethods.complete, false);
}

// 4. parseCategory cancellation inside method list
{
  const { setU32, setU64, setString, read } = createMockBuffer();
  const catAddr = 0x30000n;
  const catNameAddr = 0x31000n;
  const classAddr = 0x32000n;
  const methodListAddr = 0x33000n;
  setString(catNameAddr, 'MyCategory');

  // Category struct
  setU64(catAddr, catNameAddr);           // category name
  setU64(catAddr + 8n, classAddr);        // class
  setU64(catAddr + 16n, methodListAddr);  // instance methods
  setU64(catAddr + 24n, 0n);              // class methods
  setU64(catAddr + 32n, 0n);              // protocols

  const count = 1000;
  setU32(methodListAddr, 24);
  setU32(methodListAddr + 4n, count);
  for (let i = 0; i < count; i++) {
    const entryAddr = methodListAddr + 8n + BigInt(i * 24);
    const selAddr = 0x25000n + BigInt((i % 50) * 16);
    setU64(entryAddr, selAddr);
    setU64(entryAddr + 8n, 0n);
    setU64(entryAddr + 16n, 0n);
    setString(selAddr, `cat_m_${i}`);
  }

  const controller = new AbortController();
  let reads = 0;
  const abortingRead = async (addr, len, soft) => {
    reads++;
    if (reads === 10) controller.abort();
    return read(addr, len, soft);
  };

  const classByAddress = new Map([[classAddr.toString(), { name: 'TargetClass' }]]);
  const cat = await parseCategory(abortingRead, catAddr, classByAddress, { signal: controller.signal });
  assert.ok(cat != null);
  assert.equal(cat.completeness.complete, false, 'Category completeness must be false when aborted inside method list');
  assert.equal(cat.completeness.methods.instanceMethods.complete, false);
}

// 5. Normal parse without abort succeeds with complete: true
{
  const { setU32, setU64, setString, read } = createMockBuffer();
  const protoAddr = 0x10000n;
  const nameAddr = 0x11000n;
  const methodListAddr = 0x12000n;
  setString(nameAddr, 'CleanProtocol');

  setU64(protoAddr + 8n, nameAddr);
  setU64(protoAddr + 16n, 0n);
  setU64(protoAddr + 24n, methodListAddr);
  setU64(protoAddr + 32n, 0n);
  setU64(protoAddr + 40n, 0n);
  setU64(protoAddr + 48n, 0n);

  setU32(methodListAddr, 24);
  setU32(methodListAddr + 4n, 2);
  for (let i = 0; i < 2; i++) {
    const entryAddr = methodListAddr + 8n + BigInt(i * 24);
    const selAddr = 0x20000n + BigInt(i * 16);
    setU64(entryAddr, selAddr);
    setU64(entryAddr + 8n, 0n);
    setU64(entryAddr + 16n, 0n);
    setString(selAddr, `clean_m_${i}`);
  }

  const proto = await parseProtocol(read, protoAddr);
  assert.ok(proto != null);
  assert.equal(proto.completeness.complete, true, 'Clean parse without signal must have complete: true');
  assert.equal(proto.methods.length, 2);
}

// 6. parseObjcExtendedMetadata abort during methodList in protocol
{
  const { setU32, setU64, setString, read } = createMockBuffer();
  const protoListAddr = 0x1000n;
  const protoAddr = 0x10000n;
  const nameAddr = 0x11000n;
  const methodListAddr = 0x12000n;

  setU64(protoListAddr, protoAddr);
  setString(nameAddr, 'TopProtocol');

  setU64(protoAddr + 8n, nameAddr);
  setU64(protoAddr + 16n, 0n);
  setU64(protoAddr + 24n, methodListAddr);

  setU32(methodListAddr, 24);
  setU32(methodListAddr + 4n, 1000);
  for (let i = 0; i < 1000; i++) {
    const entryAddr = methodListAddr + 8n + BigInt(i * 24);
    const selAddr = 0x20000n + BigInt((i % 50) * 16);
    setU64(entryAddr, selAddr);
    setString(selAddr, `ext_m_${i}`);
  }

  const sections = {
    protocolList: { vmAddr: protoListAddr, size: 8n },
    categoryList: null,
  };

  const controller = new AbortController();
  let reads = 0;
  const abortingRead = async (addr, len, soft) => {
    reads++;
    if (reads === 5) controller.abort();
    return read(addr, len, soft);
  };

  const ext = await parseObjcExtendedMetadata(abortingRead, sections, { signal: controller.signal, pageBytes: 256 });
  assert.equal(ext.completeness.complete, false, 'parseObjcExtendedMetadata completeness must be false when aborted');
}

console.log('Issue #6270 regressions PASS!');
