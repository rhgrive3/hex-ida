import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildObjcModel, pagedReader } from '../../../js/objc-legacy.js';
import { parseObjcExtendedMetadata } from '../../../js/apple/objc-metadata.js';
import { FieldIndex, EMPTY_FIELDS } from '../../../js/fields.js';
import { buildObjcRuntimeIndex } from '../../../js/objc.js';
import { appProducerAbortError, waitForAppProducer } from '../../../js/analysis/producer-wait.js';

function legacyFixture() {
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);
  const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i); mem[at + s.length] = 0; };
  const classAddr = 0x1000, metaAddr = 0x1100, classRo = 0x1200, metaRo = 0x1300, listAddr = 0x1400, classNameAddr = 0x1800;
  p64(0x200, classAddr);
  p64(classAddr + 0, metaAddr);
  p64(classAddr + 32, classRo);
  p64(metaAddr + 0, 0);
  p64(metaAddr + 32, metaRo);
  p64(classRo + 24, classNameAddr);
  p64(classRo + 32, listAddr);
  p64(metaRo + 24, classNameAddr);
  str(classNameAddr, 'Victim');
  p32(listAddr, 24); p32(listAddr + 4, 5);
  for (let i = 0; i < 5; i++) {
    const entry = listAddr + 8 + i * 24;
    const selAddr = 0x1900 + i * 0x20, typeAddr = 0x1a00 + i * 0x20, imp = 0x2100 + i * 0x10;
    str(selAddr, `m${i}:`);
    str(typeAddr, 'v16@0:8');
    p64(entry + 0, selAddr);
    p64(entry + 8, typeAddr);
    p64(entry + 16, imp);
  }
  const baseRead = async (addr, len) => {
    const at = Number(addr);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
  return { baseRead, classList: { vmAddr: 0x200n, size: 8n } };
}

{
  const controller = new AbortController();
  let reads = 0;
  const get = pagedReader(async () => {
    reads++;
    controller.abort();
    return new Uint8Array(16).fill(0x41);
  }, 16, 2, { signal: controller.signal });
  assert.equal(await get(0n, 4), null, 'a page completed after abort must not be published');
  assert.equal(await get(0n, 4), null, 'aborted page must not be cached for later reads');
  assert.equal(reads, 1);
}

{
  const { baseRead, classList } = legacyFixture();
  const full = await buildObjcModel(baseRead, classList, null, 0n);
  assert.equal(full.names.length, 5);
}

{
  const { baseRead, classList } = legacyFixture();
  let reads = 0;
  let firstPage = true;
  const controller = new AbortController();
  const read = async (addr, len) => {
    reads++;
    const result = await baseRead(addr, len);
    if (firstPage) { firstPage = false; controller.abort(); }
    return result;
  };
  const model = await buildObjcModel(read, classList, null, 0n, null, { signal: controller.signal });
  assert.ok(model.names.length < 5, `abort during method list must truncate legacy parse, got ${model.names.length}`);
  assert.equal(reads, 1);
}

function extendedFixture() {
  const mem = new Uint8Array(0x5000);
  const dv = new DataView(mem.buffer);
  const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i); mem[at + s.length] = 0; };
  p64(0x100, 0x1000);
  p64(0x1000 + 8, 0x1800); str(0x1800, 'P');
  p64(0x1000 + 24, 0x1100);
  p32(0x1100, 24); p32(0x1104, 5);
  for (let i = 0; i < 5; i++) {
    const entry = 0x1108 + i * 24;
    const sel = 0x1900 + i * 0x30, typ = 0x1a00 + i * 0x30;
    str(sel, `m${i}:`); str(typ, 'v16@0:8');
    p64(entry, sel); p64(entry + 8, typ); p64(entry + 16, 0);
  }
  const baseRead = async (addr, len) => {
    const at = Number(addr);
    if (at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
  return { baseRead };
}

{
  const { baseRead } = extendedFixture();
  const sections = { protocolList: { vmAddr: 0x100n, size: 8n }, categoryList: null };
  const full = await parseObjcExtendedMetadata(baseRead, sections, { pageBytes: 32 });
  assert.equal(full.protocols[0].methods.length, 5);
}

{
  const { baseRead } = extendedFixture();
  const sections = { protocolList: { vmAddr: 0x100n, size: 8n }, categoryList: null };
  let reads = 0, postAbort = 0;
  const controller = new AbortController();
  let doAbort = true;
  const read = async (addr, len) => {
    reads++;
    if (controller.signal.aborted) postAbort++;
    const result = await baseRead(addr, len);
    if (doAbort && reads === 2) { doAbort = false; controller.abort(); }
    return result;
  };
  await parseObjcExtendedMetadata(read, sections, { pageBytes: 32, signal: controller.signal });
  assert.equal(postAbort, 0, `no new reads after abort, got ${postAbort} post-abort reads of ${reads}`);
  assert.ok(reads < 10, `nested scan must stop early, got ${reads} reads`);
}

{
  const appSource = await readFile(new URL('../../../js/app.js', import.meta.url), 'utf8');
  const methodStart = appSource.indexOf('  async ensureObjc(sliceIndex, options = {}) {');
  const methodEnd = appSource.indexOf('\n  async ensureSwift(options = {}) {', methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'ensureObjc source must remain discoverable');
  const methodSource = appSource.slice(methodStart, methodEnd);
  let buildStarted;
  const buildStartedPromise = new Promise((resolve) => { buildStarted = resolve; });
  const Harness = new Function(
    'FieldIndex', 'EMPTY_FIELDS', 'buildObjcRuntimeModel', 'buildObjcRuntimeIndex',
    'appProducerAbortError', 'waitForAppProducer',
    `return class Harness {\n${methodSource}\n}`,
  )(FieldIndex, EMPTY_FIELDS, async (_read, _list, _sections, _progress, _imageBase, _pointerFormat, options) => {
    buildStarted();
    await options.release;
    return { classes: [], names: [{ addr: 0x2100n, name: '-[Partial run]' }], count: 1, runtimeIndex: null };
  }, buildObjcRuntimeIndex, appProducerAbortError, waitForAppProducer);

  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const fields = { sentinel: true };
  const app = new Harness();
  app.backend = { gen: 1 };
  app.store = { get(key) {
    if (key === 'regions') return [{ section: '__objc_classlist', vmAddr: 0x200n, size: 8n }];
    if (key === 'sliceIndex') return 0;
    if (key === 'fileInfo') return { slices: [{ info: { textVM: 0n } }] };
    return null;
  } };
  app.fields = fields;
  app.symbols = {
    addNames() { throw new Error('aborted model was published'); },
    addFunctions() { throw new Error('aborted model was published'); },
  };
  app.viewer = { setSymbols() { throw new Error('aborted model was published'); } };
  app.updateChrome = () => { throw new Error('aborted model was published'); };

  const caller = new AbortController();
  const pending = app.ensureObjc(0, { signal: caller.signal, release: released });
  await buildStartedPromise;
  const reason = new Error('objc-publication-aborted');
  caller.abort(reason);
  release();
  await assert.rejects(pending, (error) => error === reason, 'caller cancellation should preserve its reason');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.objcModel ?? null, null, 'partial model must not be published after in-flight abort');
  assert.equal(app.objcRuntime ?? null, null, 'partial runtime index must not be published after in-flight abort');
  assert.equal(app.fields, fields, 'aborted publication must leave the existing field index intact');
}

console.log('issue-6192: PASS');
