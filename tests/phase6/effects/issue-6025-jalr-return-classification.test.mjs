import assert from 'node:assert/strict';
import test from 'node:test';

import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { evaluateBundle, liftBytes } from './helpers.mjs';

function jalr(rd, rs1, imm) {
  const word = ((((imm & 0xfff) >>> 0) << 20) | (rs1 << 15) | (rd << 7) | 0x67) >>> 0;
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
}

const plugin = architecturePluginV2('riscv64');

function liftJalr(rd, rs1, imm) {
  return liftBytes(jalr(rd, rs1, imm), 0x1000n);
}

test('6025: standard ret is the only RAS-pop JALR promoted to semantic return', () => {
  const standardRet = liftJalr(0, 1, 0);
  assert.equal(standardRet.bundle.controlEffect.kind, 'return');
  assert.equal(plugin.classifyControlFlow(standardRet.decoded), 'return');
  assert.equal(standardRet.bundle.metadata.returnAddressStackHint, 'x1');

  for (const imm of [4, -4]) {
    const offsetRa = liftJalr(0, 1, imm);
    assert.equal(offsetRa.bundle.controlEffect.kind, 'indirect', `jalr x0,x1,${imm} must not be a semantic return`);
    assert.equal(plugin.classifyControlFlow(offsetRa.decoded), 'branch', `jalr x0,x1,${imm} classifier must not terminate as return`);
    assert.equal(offsetRa.bundle.metadata.returnAddressStackHint, 'x1', 'RAS pop hint remains independent of semantic return classification');
  }
});

test('6025: alternate link register RAS hints are not ABI return evidence', () => {
  const x5Pop = liftJalr(0, 5, 0);
  assert.equal(x5Pop.bundle.controlEffect.kind, 'indirect');
  assert.equal(plugin.classifyControlFlow(x5Pop.decoded), 'branch');
  assert.equal(x5Pop.bundle.metadata.returnAddressStackHint, 'x5');
});

test('6025: call hints and ordinary indirect JALR behavior do not regress', () => {
  const call = liftJalr(1, 10, 8);
  assert.equal(call.bundle.controlEffect.kind, 'call');
  assert.equal(plugin.classifyControlFlow(call.decoded), 'call');
  assert.equal(call.bundle.metadata.linkRegister, 'x1');

  const alternateLinkCall = liftJalr(5, 10, 8);
  assert.equal(alternateLinkCall.bundle.controlEffect.kind, 'call');
  assert.equal(plugin.classifyControlFlow(alternateLinkCall.decoded), 'call');

  const ordinary = liftJalr(0, 10, 8);
  assert.equal(ordinary.bundle.controlEffect.kind, 'indirect');
  assert.equal(plugin.classifyControlFlow(ordinary.decoded), 'branch');
  assert.equal(ordinary.bundle.metadata.returnAddressStackHint, null);
});

test('6025: nonzero return-address displacement keeps exact JALR target semantics', () => {
  const offsetRa = liftJalr(0, 1, 5);
  const targetId = offsetRa.bundle.controlEffect.target.temporaryId;
  const { temporaries } = evaluateBundle(offsetRa.bundle, { x1: 0x2000n });
  assert.equal(temporaries.get(targetId), 0x2004n, '(ra + 5) has its low bit cleared after addition');
  assert.equal(offsetRa.bundle.controlEffect.kind, 'indirect');
});
