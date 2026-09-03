import assert from 'node:assert/strict';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { buildMinimalDex } from './dex-parser.test.mjs';

console.log('[phase11] running DEX verifier regression #1143...');

async function validate(mutator) {
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  mutator?.(bytes, view);
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes);
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  return { decoded, report: await frontend.validateMethod(decoded) };
}

function hasError(report, code) {
  return report.errors.some((entry) => entry?.code === code);
}

{
  const { report } = await validate();
  assert.equal(report.status, 'valid');
  assert.equal(report.completeness.specValidation, 'valid');
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint16(0x140, 1, true); // only v0 exists
    bytes.set([0x01, 0x01, 0x0e, 0x00], 0x150); // move v1, v0; return-void
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-register-out-of-range'));
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint16(0x140, 1, true);
    bytes.set([0x04, 0x00, 0x0e, 0x00], 0x150); // move-wide v0, v0; pair needs v1
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-wide-register-pair-out-of-range'));
}

{
  const { report } = await validate((bytes) => {
    bytes.set([0x28, 0x02, 0x0e, 0x00], 0x150); // goto +2 => code-end, outside instruction array
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-branch-target-out-of-range'));
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint32(0x14c, 4, true);
    bytes.set([
      0x28, 0x02, // pc0: goto pc2
      0x13, 0x00, // pc1: const/16 v0, ...
      0x01, 0x00, // pc2: payload, not an instruction boundary
      0x0e, 0x00, // pc3: return-void
    ], 0x150);
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-branch-target-not-instruction-boundary'));
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint32(0x14c, 7, true);
    bytes.set([
      0x28, 0x06, // pc0: goto pc6
      0x18, 0x00, // pc1: const-wide (currently unsupported by the verifier scan)
      0x00, 0x00,
      0x00, 0x00,
      0x00, 0x00,
      0x00, 0x00,
      0x0e, 0x00, // pc6: return-void, a real boundary beyond the scan stop
    ], 0x150);
  });
  assert.equal(report.status, 'partial');
  assert.equal(report.completeness.specValidation, 'partial');
  assert.equal(hasError(report, 'dex-branch-target-not-instruction-boundary'), false);
  assert.equal(hasError(report, 'dex-branch-target-out-of-range'), false);
}

{
  const { report } = await validate((bytes) => {
    bytes.set([0x0a, 0x00, 0x0e, 0x00], 0x150); // stray move-result v0
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-move-result-without-producer'));
}

{
  const { report } = await validate((bytes) => {
    bytes.set([0x00, 0x01, 0x0e, 0x00], 0x150); // packed-switch payload signature, not nop
  });
  assert.equal(report.status, 'partial');
  assert.equal(report.completeness.specValidation, 'partial');
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint32(0x14c, 1, true);
    bytes.set([0x13, 0x00], 0x150); // const/16 requires two code units
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-instruction-crosses-insns-size'));
  assert.equal(report.completeness.structural, 'failed');
}

{
  const { report } = await validate((bytes) => {
    bytes[0x126] = 0x00; // concrete encoded_method with code_off = 0
    bytes[0x127] = 0x00;
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-code-item-required-for-concrete-method'));
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint32(0x14c, 3, true);
    bytes.set([
      0x1a, 0x00, // const-string v0,
      0x03, 0x00, // string@3, but strings_size == 3
      0x0e, 0x00,
    ], 0x150);
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-reference-index-out-of-range'));
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint32(0x14c, 4, true);
    bytes.set([
      0x6e, 0x00, // invoke-virtual with encoded argCount=0
      0x00, 0x00, // method@0 (instance ()V requires receiver word)
      0x00, 0x00,
      0x0e, 0x00,
    ], 0x150);
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-invoke-argument-count-mismatch'));
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint16(0x146, 1, true); // tries_size
    view.setUint32(0x14c, 2, true); // throw; handler ignores caught exception and returns
    bytes.set([0x27, 0x00, 0x0e, 0x00], 0x150);
    view.setUint32(0x154, 0, true); // try start pc0
    view.setUint16(0x158, 1, true); // one code unit
    view.setUint16(0x15a, 1, true); // first handler starts one byte after list size
    bytes.set([0x01, 0x01, 0x01, 0x01], 0x15c); // list=1, typed=1, type@1, handler pc1
  });
  assert.equal(report.status, 'partial');
  assert.equal(report.completeness.specValidation, 'partial');
  assert.equal(hasError(report, 'dex-catch-handler-missing-move-exception'), false);
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint16(0x146, 1, true); // tries_size
    view.setUint32(0x14c, 3, true); // throw; move-exception; return
    bytes.set([0x27, 0x00, 0x0d, 0x00, 0x0e, 0x00], 0x150);
    bytes.set([0x00, 0x00], 0x156); // padding for odd insns_size
    view.setUint32(0x158, 0, true); // try start pc0
    view.setUint16(0x15c, 1, true); // one code unit
    view.setUint16(0x15e, 1, true); // first handler starts one byte after list size
    bytes.set([0x01, 0x01, 0x01, 0x01], 0x160); // list=1, typed=1, type@1, handler pc1
  });
  assert.equal(report.status, 'partial');
  assert.equal(report.completeness.specValidation, 'partial');
  assert.equal(hasError(report, 'dex-move-exception-not-handler-entry'), false);
}

{
  const { report } = await validate((bytes, view) => {
    view.setUint16(0x146, 1, true);
    view.setUint32(0x14c, 3, true);
    bytes.set([0x27, 0x00, 0x0d, 0x00, 0x0e, 0x00], 0x150);
    bytes.set([0x00, 0x00], 0x156);
    view.setUint32(0x158, 0, true);
    view.setUint16(0x15c, 1, true);
    view.setUint16(0x15e, 1, true);
    bytes.set([0x01, 0x01, 0x01, 0x02], 0x160); // handler pc2, move-exception remains at pc1
  });
  assert.equal(report.status, 'invalid');
  assert.ok(hasError(report, 'dex-move-exception-not-handler-entry'));
}

console.log('  ok DEX verifier regression #1143 passed');
