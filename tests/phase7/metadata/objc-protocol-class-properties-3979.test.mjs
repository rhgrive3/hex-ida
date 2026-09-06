import assert from 'node:assert/strict';
import { parseProtocol } from '../../../js/apple/objc-metadata.js';

const PROTOCOL = 0x1000n;
const NAME = 0x2000n;
const INSTANCE_PROPERTIES = 0x2800n;
const CLASS_PROPERTIES = 0x3000n;
const METHOD_LIST = 0x4000n;
const SELECTOR = 0x5000n;

function fixture({ size = 96, classProperties = CLASS_PROPERTIES, shortClassProperties = false, rejectClassProperties = false, withMethod = false } = {}) {
  const bytes = new Uint8Array(0x8000);
  const view = new DataView(bytes.buffer);
  const reads = [];
  const setU32 = (address, value) => view.setUint32(Number(address), Number(value) >>> 0, true);
  const setU64 = (address, value) => view.setBigUint64(Number(address), BigInt(value), true);
  const setString = (address, value) => bytes.set(Buffer.from(`${value}\0`, 'utf8'), Number(address));

  setU64(PROTOCOL + 8n, NAME);
  setU64(PROTOCOL + 16n, 0n);
  setU64(PROTOCOL + 24n, withMethod ? METHOD_LIST : 0n);
  setU64(PROTOCOL + 32n, 0n);
  setU64(PROTOCOL + 40n, 0n);
  setU64(PROTOCOL + 48n, 0n);
  setU64(PROTOCOL + 56n, INSTANCE_PROPERTIES);
  setU32(PROTOCOL + 64n, size);
  setU32(PROTOCOL + 68n, 0x1234);
  setU64(PROTOCOL + 88n, classProperties);
  setString(NAME, 'SizedProtocol');

  if (withMethod) {
    setU32(METHOD_LIST, 24);
    setU32(METHOD_LIST + 4n, 1);
    setU64(METHOD_LIST + 8n, SELECTOR);
    setU64(METHOD_LIST + 16n, 0n);
    setU64(METHOD_LIST + 24n, 0n);
    setString(SELECTOR, 'requiredMethod');
  }

  const read = async (address, length, soft = false) => {
    const at = Number(address);
    reads.push({ address: BigInt(address), length, soft });
    if (shortClassProperties && BigInt(address) === PROTOCOL + 88n) {
      return bytes.subarray(at, at + 4);
    }
    if (at < 0 || at >= bytes.length) return null;
    const available = bytes.length - at;
    if (available < length && !soft) return null;
    return bytes.subarray(at, at + Math.min(length, available));
  };
  read.base = 0n;
  read.resolvePointer = async (raw) => {
    if (rejectClassProperties && raw === classProperties) return null;
    return raw;
  };
  return { read, reads };
}

// Current ABI: size includes _classProperties, so preserve the pointer and all legacy metadata.
{
  const { read, reads } = fixture({ withMethod: true });
  const protocol = await parseProtocol(read, PROTOCOL);
  assert.ok(protocol);
  assert.equal(protocol.size, 96);
  assert.equal(protocol.flags, 0x1234);
  assert.equal(protocol.instancePropertiesAddress, INSTANCE_PROPERTIES);
  assert.equal(protocol.classPropertiesAddress, CLASS_PROPERTIES);
  assert.equal(protocol.methods.length, 1);
  assert.equal(protocol.methods[0].sel, 'requiredMethod');
  assert.equal(protocol.completeness.complete, true);
  assert.ok(reads.some((entry) => entry.address === PROTOCOL + 88n), 'classProperties must be read when size declares the field');
}

// Older ABI: a size ending before _classProperties must not read past the declared structure.
{
  const { read, reads } = fixture({ size: 88 });
  const protocol = await parseProtocol(read, PROTOCOL);
  assert.ok(protocol);
  assert.equal(protocol.size, 88);
  assert.equal(protocol.classPropertiesAddress, null);
  assert.equal(protocol.completeness.complete, true);
  assert.equal(reads.some((entry) => entry.address === PROTOCOL + 88n), false, 'old protocol_t must not read _classProperties');
}

// Declared field but unreadable bytes must make protocol completeness non-authoritative.
{
  const { read } = fixture({ shortClassProperties: true });
  const protocol = await parseProtocol(read, PROTOCOL);
  assert.ok(protocol);
  assert.equal(protocol.classPropertiesAddress, null);
  assert.equal(protocol.completeness.complete, false);
}

// A non-null classProperties pointer that cannot be resolved is malformed, not a known-empty field.
{
  const { read } = fixture({ rejectClassProperties: true });
  const protocol = await parseProtocol(read, PROTOCOL);
  assert.ok(protocol);
  assert.equal(protocol.classPropertiesAddress, null);
  assert.equal(protocol.completeness.complete, false);
}

// The size/flags prefix is mandatory for authoritative modern protocol_t parsing.
{
  const { read } = fixture({ size: 68, classProperties: 0n });
  const protocol = await parseProtocol(read, PROTOCOL);
  assert.ok(protocol);
  assert.equal(protocol.size, 68);
  assert.equal(protocol.completeness.complete, false);
}

// A truncated fixed-prefix read (56..63 bytes) with separately readable size/flags
// must never publish authoritative completeness: the instance-properties pointer
// bytes at +56..63 were never observed.
{
  const { read } = fixture();
  const truncatedRead = async (address, length, soft = false) => {
    if (BigInt(address) === PROTOCOL) {
      return read(address, 56, soft);
    }
    return read(address, length, soft);
  };
  const protocol = await parseProtocol(truncatedRead, PROTOCOL);
  assert.ok(protocol, 'a truncated prefix still yields the parsed protocol structure');
  assert.equal(protocol.size, 96);
  assert.equal(protocol.instancePropertiesAddress, null, 'unobserved +56..63 bytes must not mint a pointer');
  assert.equal(protocol.completeness.complete, false, 'incomplete fixed prefix cannot be authoritative');
}

console.log('✔ #3979 ObjC protocol_t size/classProperties regression passed');
