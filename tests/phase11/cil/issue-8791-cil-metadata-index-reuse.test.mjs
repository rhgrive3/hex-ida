import assert from 'node:assert/strict';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { createCilMethodSignatureResolver, cilCallMetadataIndexBuilds } from '../../../js/managed/cil/call-signatures.js';

console.log('[phase11] running CIL per-method metadata index reuse regression (#8791)...');

const align4 = n => Math.ceil(n / 4) * 4;
const utf8 = text => new TextEncoder().encode(text);
const VOID_SIGNATURE = [0x00, 0x00, 0x01];
const INT_VOID_SIGNATURE = [0x00, 0x01, 0x01, 0x08];
const METHOD_ACCESS = 0x0016; // Public | Static | HideBySig
const TYPE_ACCESS = 0x00000001; // Public

// Byte-level fixture: one TypeDef owns N MethodDef rows, every method has its own
// RVA and a one-byte `ret` body, and the image is padded to the reported 512 KiB
// size class. Nothing here reuses production layout code, so the production
// readers have to do their own indexing (#8791).
function buildMethodImage({ methods = 4_000, padTo = 524_288, signature = VOID_SIGNATURE, body = [0x2a] } = {}) {
  const TYPE_NAME = 1, METHOD_NAME = 3;
  const blobBytes = new Uint8Array(align4(2 + signature.length));
  blobBytes[1] = signature.length; blobBytes.set(signature, 2); // #Blob index 1
  const stringBytes = new Uint8Array(align4(utf8('\0T\0M\0').length));
  stringBytes.set(utf8('\0T\0M\0'));

  const tables = new Uint8Array(align4(24 + 2 * 4 + 14 * (methods + 1)));
  const tv = new DataView(tables.buffer);
  tv.setUint8(4, 2); tv.setUint8(6, 0); tv.setUint8(7, 1);
  tv.setBigUint64(8, (1n << 0x02n) | (1n << 0x06n), true);
  tv.setUint32(24, 1, true); // TypeDef rows
  tv.setUint32(28, methods, true); // MethodDef rows
  tv.setUint32(32, TYPE_ACCESS, true);
  tv.setUint16(36, TYPE_NAME, true);
  tv.setUint16(42, 1, true); // FieldList
  tv.setUint16(44, 1, true); // MethodList
  const methodRowsInTables = 46;

  const base = 0x300, dataStart = base + 0x400;
  const tableLength = align4(tables.length + stringBytes.length + blobBytes.length);
  const bodiesStart = align4(dataStart + tableLength);
  const bodyLength = align4(body.length + 1);
  const length = Math.max(padTo, bodiesStart + (methods + 1) * bodyLength);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);

  bytes.set(tables, dataStart);
  bytes.set(stringBytes, dataStart + tables.length);
  bytes.set(blobBytes, dataStart + tables.length + stringBytes.length);
  const methodRows = dataStart + methodRowsInTables;
  for (let row = 0; row < methods; row++) {
    const bodyOffset = bodiesStart + row * bodyLength;
    view.setUint32(methodRows + row * 14, 0x2000 + (bodyOffset - 0x200), true); // RVA
    view.setUint16(methodRows + row * 14 + 4, 0, true); // ImplFlags
    view.setUint16(methodRows + row * 14 + 6, METHOD_ACCESS, true);
    view.setUint16(methodRows + row * 14 + 8, METHOD_NAME, true);
    view.setUint16(methodRows + row * 14 + 10, 1, true); // signature -> #Blob index 1
    view.setUint16(methodRows + row * 14 + 12, 1, true); // ParamList
    view.setUint8(bodyOffset, (body.length << 2) | 0x02); // tiny header
    bytes.set(body, bodyOffset + 1);
  }

  bytes[0] = 0x4d; bytes[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  bytes.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x84, 0x014c, true); view.setUint16(0x86, 1, true); view.setUint16(0x94, 0xe0, true);
  const opt = 0x98;
  view.setUint16(opt, 0x10b, true); view.setUint32(opt + 92, 16, true);
  view.setUint32(opt + 96 + 14 * 8, 0x2000, true); view.setUint32(opt + 100 + 14 * 8, 72, true);
  const section = opt + 0xe0;
  view.setUint32(section + 8, bytes.length - 0x200, true); view.setUint32(section + 12, 0x2000, true);
  view.setUint32(section + 16, bytes.length - 0x200, true); view.setUint32(section + 20, 0x200, true);
  view.setUint32(0x200, 72, true); view.setUint16(0x204, 2, true); view.setUint16(0x206, 5, true);
  const metadataSize = dataStart - base + tableLength;
  view.setUint32(0x208, 0x2100, true); view.setUint32(0x20c, metadataSize, true); view.setUint32(0x210, 1, true);
  view.setUint32(base, 0x424a5342, true);
  view.setUint16(base + 4, 1, true); view.setUint16(base + 6, 1, true);
  view.setUint32(base + 12, 12, true);
  bytes.set([...utf8('v4.0.30319'), 0], base + 16);
  const flags = base + 16 + 12;
  const streams = [
    { name: '#~', offset: dataStart - base, bytes: tables },
    { name: '#Strings', offset: dataStart - base + tables.length, bytes: stringBytes },
    { name: '#Blob', offset: dataStart - base + tables.length + stringBytes.length, bytes: blobBytes },
  ];
  view.setUint16(flags + 2, streams.length, true);
  let header = flags + 4;
  for (const stream of streams) {
    const name = utf8(stream.name);
    view.setUint32(header, stream.offset, true);
    view.setUint32(header + 4, stream.bytes.length, true);
    bytes.set(name, header + 8);
    header += 8 + align4(name.length + 1);
  }
  return { bytes, methodRows, bodiesStart, bodyLength };
}

async function decodeAll(bytes) {
  const image = parseCil(bytes, { binaryId: 'repro' });
  const frontend = new CilFrontend();
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = [];
  for (const method of methods) decoded.push(await frontend.decodeMethod(method, { image }));
  return { image, methods, decoded, builds: cilCallMetadataIndexBuilds(image) };
}

// 1. The reported shape: 4,000 trivial methods all decode exactly, and the
// whole-image metadata index is built once for the image, not per method.
{
  const fixture = buildMethodImage({ methods: 4_000 });
  assert.equal(fixture.bytes.length, 524_288, 'fixture keeps the reported image size class');
  const started = Date.now();
  const run = await decodeAll(fixture.bytes);
  const elapsedMs = Date.now() - started;
  assert.equal(run.methods.length, 4_000);
  assert.equal(run.decoded.length, 4_000);
  assert.equal(run.decoded.filter(fn => fn.aggregateCompleteness === 'exact').length, 4_000);
  assert.equal(run.builds, 1, 'one immutable image builds the metadata index once');
  // Doubling the method count must not multiply the index work.
  const half = await decodeAll(buildMethodImage({ methods: 2_000 }).bytes);
  assert.equal(half.builds, 1, '2,000 methods: still one index build');
  assert.equal(half.decoded.filter(fn => fn.aggregateCompleteness === 'exact').length, 2_000);
  assert.ok(elapsedMs < 5_000, `decode stayed bounded, took ${elapsedMs}ms`);
}

// 2. Body-offset resolution is indexed but keeps its fail-closed taxonomy.
{
  const image = parseCil(buildMethodImage({ methods: 3 }).bytes, { binaryId: 'repro' });
  const resolve = createCilMethodSignatureResolver(image);
  const first = resolve(image.methodBodies[0]);
  assert.equal(first.complete, true);
  assert.equal(first.methodToken, 0x06000001);
  assert.equal(first.bodyOffset, image.methodBodies[0].headerOffset);
  assert.equal(first.signature.returnValue, null);
  // An offset no MethodDef claims stays unresolved.
  assert.equal(resolve({ headerOffset: 1 << 20 }).reason, 'cil-return-methoddef-unresolved');
  assert.equal(resolve({}).reason, 'cil-return-method-body-identity-unavailable');
  // Two MethodDef rows sharing one body offset remain ambiguous, exactly as when
  // the resolver scanned the table.
  const shared = buildMethodImage({ methods: 2 });
  const view = new DataView(shared.bytes.buffer);
  view.setUint32(shared.methodRows + 14, view.getUint32(shared.methodRows, true), true);
  const ambiguous = parseCil(shared.bytes, { binaryId: 'repro' });
  const resolution = createCilMethodSignatureResolver(ambiguous)(ambiguous.methodBodies[0]);
  assert.equal(resolution.complete, false);
  assert.equal(resolution.reason, 'cil-return-methoddef-ambiguous');
}

// 3. A supplied MethodDef authority is consumed, not discarded, and a stale one
// is never trusted for a different body (#8791 requirement 8).
{
  const image = parseCil(buildMethodImage({ methods: 1, body: [0x2a] }).bytes, { binaryId: 'repro' });
  const authority = createCilMethodSignatureResolver(image)(image.methodBodies[0]);
  assert.equal(authority.complete, true);
  const lifted = liftCilMethod(0, image, {}, authority);
  assert.equal(lifted.bundles.at(-1).mnemonic, 'ret');
  assert.equal(lifted.aggregateCompleteness, 'exact');
  assert.equal(cilCallMetadataIndexBuilds(image), 1, 'the shared index is reused, not rebuilt');

  // A void-returning authority applied to the same body is used verbatim, so a
  // lifted function reflects the caller-provided signature authority.
  const claimed = Object.freeze({
    ...authority,
    signature: Object.freeze({ ...authority.signature, returnValue: null }),
  });
  assert.equal(liftCilMethod(0, image, {}, claimed).entryState.returnStackSlots, 0);
  // The same authority with a body offset that is not this body must be ignored
  // and re-resolved rather than laundered into this method.
  const mismatched = Object.freeze({ ...claimed, bodyOffset: authority.bodyOffset + 4 });
  const reResolved = liftCilMethod(0, image, {}, mismatched);
  assert.equal(reResolved.bundles.at(-1).mnemonic, 'ret');
  assert.equal(reResolved.aggregateCompleteness, 'exact');
}

// 4. Argument and return typing are unchanged by the index reuse.
{
  const image = parseCil(buildMethodImage({ methods: 1, signature: INT_VOID_SIGNATURE, body: [0x02, 0x26, 0x2a] }).bytes, { binaryId: 'repro' });
  const fn = liftCilMethod(0, image);
  const ldarg = fn.bundles.find(bundle => bundle.mnemonic === 'ldarg.0');
  assert.ok(ldarg, 'ldarg.0 lifted');
  assert.equal(ldarg.producedValues[0].bits, 32, 'MethodDef signature still types arguments');
  assert.equal(ldarg.producedValues[0].stackType, 'int32');
}

// 5. Call resolution shares the same image index, so a method with a call does
// not rebuild whole-image metadata either.
{
  // call MethodDef rid 1 then ret
  const run = await decodeAll(buildMethodImage({ methods: 2, body: [0x28, 0x01, 0x00, 0x00, 0x06, 0x2a] }).bytes);
  const caller = run.decoded[1] ?? run.decoded[0];
  const callBundle = caller.bundles.find(bundle => bundle.mnemonic === 'call');
  assert.ok(callBundle, 'call lifted');
  assert.equal(callBundle.signatureResolved ?? callBundle.callEffects?.[0]?.signatureResolved, true);
  assert.equal(run.builds, 1, 'calls reuse the image index');
}

console.log('  ok CIL per-method metadata index reuse regression passed');
