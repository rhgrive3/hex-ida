import assert from 'node:assert/strict';
import { parseSwiftFieldDescriptor, readSwiftMangledName } from '../js/swift.js';

function readerFor(mem) {
  return async (addr, len) => {
    const at = Number(addr);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
}
function putI32(mem, at, value) { new DataView(mem.buffer).setInt32(at, Number(value), true); }
function putU16(mem, at, value) { new DataView(mem.buffer).setUint16(at, Number(value), true); }
function putU32(mem, at, value) { new DataView(mem.buffer).setUint32(at, Number(value), true); }
function putU64(mem, at, value) { new DataView(mem.buffer).setBigUint64(at, BigInt(value), true); }
function putAscii(mem, at, text) { for (let i = 0; i < text.length; i++) mem[at + i] = text.charCodeAt(i); mem[at + text.length] = 0; }

{
  const mem = new Uint8Array(64);
  putAscii(mem, 4, '$sSi');
  const info = await readSwiftMangledName(readerFor(mem), 4n);
  assert.equal(info.complete, true);
  assert.equal(info.text, '$sSi');
  assert.deepEqual(info.symbolicReferences, []);
}

{
  const mem = new Uint8Array(0x400);
  const start = 0x100;
  const prefix = '$s4App';
  for (let i = 0; i < prefix.length; i++) mem[start + i] = prefix.charCodeAt(i);
  const controlAt = start + prefix.length;
  mem[controlAt] = 0x01;
  const target = 0x180;
  putI32(mem, controlAt + 1, target - controlAt); // contains zero bytes in the payload
  mem[controlAt + 5] = 'V'.charCodeAt(0);
  mem[controlAt + 6] = 0;

  const denied = await readSwiftMangledName(readerFor(mem), BigInt(start));
  assert.equal(denied.complete, false);
  assert.equal(denied.reason, 'symbolic-reference-not-authorized', 'generic/untrusted mangled-name reads must not interpret symbolic references');

  const info = await readSwiftMangledName(readerFor(mem), BigInt(start), {
    compilerMetadata: true,
    resolveSwiftSymbolicReference(ref) { return ref.candidateTarget === BigInt(target) ? ref.candidateTarget : null; },
  });
  assert.equal(info.complete, true);
  assert.equal(info.text, null, 'symbolic manglings must not be laundered into a plain string');
  assert.deepEqual(info.fragments, ['$s4App', 'V']);
  assert.equal(info.symbolicReferences.length, 1);
  assert.equal(info.symbolicReferences[0].candidateTarget, BigInt(target));
  assert.equal(info.symbolicReferences[0].resolvedTarget, BigInt(target));
  assert.equal(info.referencesResolved, true);
  assert.deepEqual(info.rawBytes.slice(prefix.length, prefix.length + 5), [0x01, target - controlAt, 0, 0, 0], 'NUL bytes inside the symbolic payload are preserved instead of terminating the name');
}

{
  const mem = new Uint8Array(0x100);
  const start = 0x20;
  mem[start] = 0x18;
  putU64(mem, start + 1, 0x1234000000005678n);
  mem[start + 9] = 'y'.charCodeAt(0);
  mem[start + 10] = 0;
  const info = await readSwiftMangledName(readerFor(mem), BigInt(start), {
    compilerMetadata: true,
    resolvePointer(raw, meta) {
      assert.equal(raw, 0x1234000000005678n);
      assert.equal(meta.swiftSymbolicReferenceKind, 0x18);
      return 0x9000n;
    },
  });
  assert.equal(info.complete, true);
  assert.equal(info.symbolicReferences[0].rawTarget, 0x1234000000005678n);
  assert.equal(info.symbolicReferences[0].resolvedTarget, 0x9000n);
}

{
  const truncatedRead = async () => Uint8Array.from([0x01, 0x20, 0x00]);
  const info = await readSwiftMangledName(truncatedRead, 0n, { compilerMetadata:true });
  assert.equal(info.complete, false);
  assert.equal(info.reason, 'symbolic-reference-truncated');
}

{
  const mem = new Uint8Array(0x800);
  const descriptor = 0x200, record = descriptor + 16, typeAt = 0x300, nameAt = 0x380;
  putI32(mem, descriptor + 0, 0);
  putI32(mem, descriptor + 4, 0);
  putU16(mem, descriptor + 8, 0);
  putU16(mem, descriptor + 10, 12);
  putU32(mem, descriptor + 12, 1);
  putU32(mem, record + 0, 2);
  putI32(mem, record + 4, typeAt - (record + 4));
  putI32(mem, record + 8, nameAt - (record + 8));
  putAscii(mem, nameAt, 'value');

  mem[typeAt] = 'A'.charCodeAt(0);
  const controlAt = typeAt + 1;
  mem[controlAt] = 0x01;
  const target = 0x420;
  putI32(mem, controlAt + 1, target - controlAt);
  mem[controlAt + 5] = 'V'.charCodeAt(0);
  mem[controlAt + 6] = 0;
  mem[target] = 0x11; // mapped descriptor evidence for the fixture

  const fields = await parseSwiftFieldDescriptor(readerFor(mem), BigInt(descriptor), {
    resolveSwiftSymbolicReference(ref) { return ref.candidateTarget === BigInt(target) ? ref.candidateTarget : null; },
  });
  assert.equal(fields.length, 1);
  assert.equal(fields[0].name, 'value');
  assert.equal(fields[0].mangledType, null);
  assert.equal(fields[0].mangledTypeEncoding.complete, true);
  assert.equal(fields[0].mangledTypeEncoding.referencesResolved, true);
  assert.deepEqual(fields[0].mangledTypeEncoding.fragments, ['A', 'V']);
  assert.equal(fields[0].mangledTypeEncoding.symbolicReferences[0].resolvedTarget, BigInt(target));
}

console.log('issue-2396 Swift symbolic mangled-name: ok');
