import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverPhase8Tests } from '../run.mjs';
import * as requiredMatrix from './hex-c3-02-required-profile-matrix.mjs';

import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { recoverFunctionPrototype } from '../../../js/decompiler/types/prototype.js';
import { AAPCS64_ABI, RISCV_LP64_ABI, UNKNOWN_ABI } from '../../../js/targets/abi/index.js';

function prototypeFor(abi, args, types = {}) {
  return recoverFunctionPrototype(
    { args:new Map(args), instructions:[] },
    { values:new Map(), ...types },
    { abiAdapter:semanticAbiAdapter(abi) },
  );
}

test('HEX-C3-02: prototype recovery follows the selected RISC-V profile', () => {
  const a0 = { id:1, reg:'x10', uses:[{}] };
  const prototype = prototypeFor(RISCV_LP64_ABI, [['x10', a0]]);

  assert.equal(prototype.convention, 'lp64');
  assert.ok(prototype.arguments.some((argument) => argument.reg === 'x10'));
});

test('HEX-C3-02: unsupported ABI evidence stays explicitly unknown', () => {
  const x0 = { id:2, reg:'x0', uses:[{}] };
  const prototype = prototypeFor(UNKNOWN_ABI, [['x0', x0]]);

  assert.equal(prototype.conventionKnown, false);
  assert.equal(prototype.arguments.length, 0);
  assert.equal(prototype.returnLocationKnown, false);
});

test('HEX-C3-02: stale ABI semantic identity cannot publish a supported prototype', () => {
  const staleAdapter = Object.freeze({
    id:'aapcs64', semanticVersion:'1', semanticIdentity:'aapcs64@1', architectureId:'arm64',
  });
  const x0 = { id:3, reg:'x0', uses:[{}] };
  const prototype = recoverFunctionPrototype(
    { args:new Map([['x0',x0]]), instructions:[] },
    { values:new Map() },
    { abiAdapter:staleAdapter },
  );

  assert.equal(AAPCS64_ABI.semanticIdentity, 'aapcs64@2');
  assert.equal(prototype.conventionKnown, false);
  assert.deepEqual(prototype.arguments, []);
});

test('HEX-C3-02: canonical aggregate pieces remain one prototype argument', () => {
  const parameter = { type:'struct Pair', aggregate:true, bits:128,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] };
  const canonical = AAPCS64_ABI.classifyArguments(
    { callPrototype:{ parameters:[parameter] } },
    { callPrototype:{ parameters:[parameter] } },
  );
  const x0 = { id:4, reg:'x0', uses:[{}] };
  const x1 = { id:5, reg:'x1', uses:[{}] };
  const prototype = recoverFunctionPrototype(
    { args:new Map([['x0',x0],['x1',x1]]), instructions:[] },
    { values:new Map() },
    { abiAdapter:semanticAbiAdapter(AAPCS64_ABI), functionPrototype:{ parameters:[parameter] } },
  );

  assert.equal(canonical.partial, false);
  assert.deepEqual(canonical.arguments[0].regs, ['x0','x1']);
  assert.equal(prototype.arguments.length, 1);
  assert.deepEqual(prototype.arguments[0].regs, ['x0','x1']);
});

test('FR-C3-02 required profile matrix runs under canonical ABI test discovery', () => {
  assert.ok(discoverPhase8Tests().includes(fileURLToPath(import.meta.url)));
  assert.equal(typeof requiredMatrix.runRequiredProfileMatrix, 'function', 'required matrix must have a reusable canonical invocation');
  const report = requiredMatrix.runRequiredProfileMatrix();
  assert.equal(report.denominator, 99, 'all existing atomic examples plus the missing-alignment negative are required');
  requiredMatrix.assertRequiredProfileMatrix(report);
  assert.equal(report.rows.filter(row => row.status === 'PASS').length, 99);
});

test('FR-C3-02 missing, duplicate, unknown, skipped and malformed matrix rows fail closed', () => {
  assert.equal(typeof requiredMatrix.runRequiredProfileMatrix, 'function');
  const original = requiredMatrix.runRequiredProfileMatrix();
  for (const mutate of [
    report => { report.rows.pop(); },
    report => { report.rows[1] = report.rows[0]; },
    report => { report.rows[0].name = 'invented-profile'; },
    report => { report.rows[0].status = 'SKIP'; },
    report => { report.rows[0].status = 'FAIL'; },
    report => { delete report.rows[0]; },
    report => { report.denominator = 98; },
    report => { report.version = 999; },
  ]) {
    const invalid = structuredClone(original); mutate(invalid);
    assert.throws(() => requiredMatrix.assertRequiredProfileMatrix(invalid));
  }
  const reversed = structuredClone(original); reversed.rows.reverse();
  requiredMatrix.assertRequiredProfileMatrix(reversed);
});

test('FR-C3-02 one aggregate failure does not suppress later HFA or other profile cases', () => {
  assert.equal(typeof requiredMatrix.runRequiredProfileMatrix, 'function');
  const report = requiredMatrix.runRequiredProfileMatrix({ beforeCase(name) {
    if (name === 'Darwin aggregate arguments') throw new Error('injected-first-aggregate-failure');
  } });
  assert.equal(report.rows.length, 99);
  assert.deepEqual(report.rows.filter(row => row.status === 'FAIL').map(row => row.name), ['Darwin aggregate arguments']);
  assert.equal(report.rows.find(row => row.name === 'Darwin HFA arguments').status, 'PASS');
  assert.equal(report.rows.find(row => row.name === 'consumer projects SysV aggregate return pieces').status, 'PASS');
  assert.throws(() => requiredMatrix.assertRequiredProfileMatrix(report));
  requiredMatrix.assertRequiredProfileMatrix(requiredMatrix.runRequiredProfileMatrix());
});
