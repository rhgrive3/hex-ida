import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimsConflict,
  createTypeClaim,
} from '../../../js/analysis/types/constraints.js';

function claim(layer, descriptor, entityId = 'entity_numeric') {
  return createTypeClaim({ layer, entityId, descriptor });
}

test('issue #3883: equivalent structural integer representations share identity and do not conflict', () => {
  const bigint = claim('structural', { kind:'struct', sizeBytes:4n, alignBytes:4n });
  const number = claim('structural', { kind:'struct', sizeBytes:4, alignBytes:4 });
  const string = claim('structural', { kind:'struct', sizeBytes:'4', alignBytes:'4' });

  assert.equal(bigint.key, number.key);
  assert.equal(number.key, string.key);
  assert.equal(claimsConflict(bigint, number), false);
  assert.equal(claimsConflict(number, string), false);
  assert.equal(claimsConflict(bigint, string), false);

  // Canonical identity must not silently rewrite the public descriptor shape.
  assert.equal(bigint.descriptor.sizeBytes, 4n);
  assert.equal(number.descriptor.sizeBytes, 4);
  assert.equal(string.descriptor.sizeBytes, '4');
});

test('issue #3883: real structural size and alignment differences remain hard conflicts', () => {
  assert.equal(claimsConflict(
    claim('structural', { kind:'struct', sizeBytes:4, alignBytes:4 }),
    claim('structural', { kind:'struct', sizeBytes:'8', alignBytes:'4' }),
  ), true);
  assert.equal(claimsConflict(
    claim('structural', { kind:'struct', sizeBytes:8, alignBytes:4 }),
    claim('structural', { kind:'struct', sizeBytes:'8', alignBytes:'8' }),
  ), true);
});

test('issue #3883: machine and ABI numeric claims compare by semantic integer value', () => {
  const machineNumber = claim('machine', { widthBits:64, class:'integer' }, 'machine');
  const machineBigint = claim('machine', { widthBits:64n, class:'integer' }, 'machine');
  const machineString = claim('machine', { widthBits:'64', class:'integer' }, 'machine');
  assert.equal(machineNumber.key, machineBigint.key);
  assert.equal(machineBigint.key, machineString.key);
  assert.equal(claimsConflict(machineNumber, machineString), false);
  assert.equal(claimsConflict(machineNumber, claim('machine', { widthBits:32, class:'integer' }, 'machine')), true);

  const abiNumber = claim('abi', { location:'stack', passingClass:'integer', sizeBytes:8, alignBytes:8 }, 'abi');
  const abiString = claim('abi', { location:'stack', passingClass:'integer', sizeBytes:'8', alignBytes:'8' }, 'abi');
  const abiBigint = claim('abi', { location:'stack', passingClass:'integer', sizeBytes:8n, alignBytes:8n }, 'abi');
  assert.equal(abiNumber.key, abiString.key);
  assert.equal(abiString.key, abiBigint.key);
  assert.equal(claimsConflict(abiNumber, abiBigint), false);
  assert.equal(claimsConflict(abiNumber, claim('abi', { location:'stack', passingClass:'integer', sizeBytes:16, alignBytes:8 }, 'abi')), true);
});

test('issue #3883: nested member numeric representations canonicalize without hiding real differences', () => {
  const number = claim('structural', {
    offset:0,
    sizeBytes:32,
    memberType:{
      kind:'array',
      strideBytes:8,
      length:4,
      elementType:{ kind:'integer', widthBits:64 },
    },
  }, 'nested');
  const string = claim('structural', {
    offset:'0',
    sizeBytes:'32',
    memberType:{
      kind:'array',
      strideBytes:'8',
      length:'4',
      elementType:{ kind:'integer', widthBits:'64' },
    },
  }, 'nested');
  const bigint = claim('structural', {
    offset:0n,
    sizeBytes:32n,
    memberType:{
      kind:'array',
      strideBytes:8n,
      length:4n,
      elementType:{ kind:'integer', widthBits:64n },
    },
  }, 'nested');

  assert.equal(number.key, string.key);
  assert.equal(string.key, bigint.key);
  assert.equal(claimsConflict(number, string), false);
  assert.equal(claimsConflict(string, bigint), false);

  const differentStride = claim('structural', {
    offset:'0',
    sizeBytes:'32',
    memberType:{
      kind:'array',
      strideBytes:'16',
      length:'4',
      elementType:{ kind:'integer', widthBits:'64' },
    },
  }, 'nested');
  assert.equal(claimsConflict(number, differentStride), true);
});

test('issue #3883: members-array identity uses the same numeric canonicalization', () => {
  const left = claim('structural', {
    kind:'struct',
    sizeBytes:16,
    alignBytes:8,
    members:[
      { offset:0, sizeBytes:8, memberType:{ kind:'integer', widthBits:64 } },
      { offset:8, sizeBytes:8, memberType:{ kind:'integer', widthBits:64 } },
    ],
  }, 'aggregate');
  const right = claim('structural', {
    kind:'struct',
    sizeBytes:'16',
    alignBytes:'8',
    members:[
      { offset:'0', sizeBytes:'8', memberType:{ kind:'integer', widthBits:'64' } },
      { offset:'8', sizeBytes:'8', memberType:{ kind:'integer', widthBits:'64' } },
    ],
  }, 'aggregate');

  assert.equal(left.key, right.key);
  assert.equal(claimsConflict(left, right), false);
});

test('issue #3883: existing invalid structural numeric inputs remain rejected', () => {
  assert.throws(() => claim('structural', { sizeBytes:4.5 }), /structural-size-invalid/);
  assert.throws(() => claim('structural', { sizeBytes:Number.MAX_SAFE_INTEGER + 1 }), /structural-size-invalid/);
  assert.throws(() => claim('structural', { sizeBytes:-1 }), /structural-size-invalid/);
  assert.throws(() => claim('structural', { alignBytes:0 }), /structural-align-invalid/);
  assert.throws(() => claim('structural', { offset:-1, sizeBytes:1 }), /structural-offset-invalid/);
});
