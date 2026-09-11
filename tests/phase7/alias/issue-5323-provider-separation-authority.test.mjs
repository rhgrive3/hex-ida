import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCanonicalAddressProof as deriveCore } from '../../../js/analysis/alias/canonical-address-v2-core.js';
import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';

const KINDS = ['global-like', 'heap-like', 'tls-like'];

function entryIr(variableKeys = ['ptr']) {
  return {
    functionId: 'fn-5323',
    values: variableKeys.map((variableKey) => ({
      id: 'v-' + variableKey,
      kind: 'entry',
      variableKey,
      machineType: { kind: 'address', widthBits: 64 },
    })),
    nodes: [],
    blocks: [],
  };
}

function descriptor(kind, rootEntityId) {
  return {
    kind,
    rootEntityId,
    baseOffset: 0,
    addressSpace: kind === 'tls-like' ? 'tls' : 'memory',
  };
}

function proofShape(proof) {
  return {
    kind: proof?.kind,
    addressSpace: proof?.addressSpace,
    rootIdentity: proof?.rootIdentity,
    rootEntityId: proof?.rootEntityId ?? null,
    offset: proof?.offset ?? null,
    separationClass: proof?.separationClass ?? null,
    separationAuthority: proof?.separationAuthority ?? null,
  };
}

test('table and provider preserve identical validated separation provenance', () => {
  for (const kind of KINDS) {
    const ir = entryIr();
    const supplied = descriptor(kind, 'alloc:' + kind);
    const addressSpace = kind === 'tls-like' ? 'tls' : undefined;
    const tableProof = deriveCanonicalAddressProof(ir, 'v-ptr', {
      ...(addressSpace == null ? {} : { addressSpace }),
      rootDescriptors: new Map([['variable:ptr', supplied]]),
    });
    let providerCalls = 0;
    const providerProof = deriveCanonicalAddressProof(ir, 'v-ptr', {
      ...(addressSpace == null ? {} : { addressSpace }),
      rootDescriptorProvider(request) {
        providerCalls += 1;
        assert.equal(request.variable?.key, 'ptr', 'provider receives canonical variable identity');
        return supplied;
      },
    });

    assert.deepEqual(proofShape(providerProof), proofShape(tableProof), kind);
    assert.equal(providerProof.separationClass, kind);
    assert.equal(providerProof.separationAuthority, 'root-descriptor');
    assert.equal(providerCalls, 1, 'authority attachment must not re-invoke provider');

    const coreProof = deriveCore(ir, 'v-ptr', {
      ...(addressSpace == null ? {} : { addressSpace }),
      rootDescriptorProvider: () => supplied,
    });
    assert.equal(coreProof.separationClass, kind, 'core retains the validated source kind');
    assert.equal(coreProof.separationAuthority, 'root-descriptor');
  }
});

test('malformed provider data and spoofed metadata fail closed', () => {
  let calls = 0;
  const malformed = deriveCanonicalAddressProof(entryIr(), 'v-ptr', {
    rootDescriptorProvider() {
      calls += 1;
      return {
        kind: 'heap-like',
        rootEntityId: { toString: () => 'alloc:spoof' },
        baseOffset: 0,
        addressSpace: 'memory',
      };
    },
  });
  assert.equal(malformed.kind, 'unknown');
  assert.equal(malformed.reason, 'canonical-root-descriptor-invalid');
  assert.equal(malformed.separationClass, undefined);
  assert.equal(malformed.separationAuthority, undefined);
  assert.equal(calls, 1);

  calls = 0;
  const spoofed = deriveCanonicalAddressProof(entryIr(), 'v-ptr', {
    rootDescriptorProvider() {
      calls += 1;
      return {
        kind: 'rooted-object',
        rootEntityId: 'alloc:spoof',
        separationClass: 'heap-like',
        separationAuthority: 'root-descriptor',
        baseOffset: 0,
        addressSpace: 'memory',
      };
    },
  });
  assert.equal(spoofed.kind, 'rooted');
  assert.equal(spoofed.separationClass, undefined);
  assert.equal(spoofed.separationAuthority, undefined);
  assert.equal(calls, 1);
});

test('no descriptor keeps the default root unauthorized and calls a null provider once', () => {
  let calls = 0;
  const absent = deriveCanonicalAddressProof(entryIr(), 'v-ptr', {
    rootDescriptorProvider() {
      calls += 1;
      return null;
    },
  });
  assert.equal(absent.kind, 'rooted');
  assert.equal(absent.separationClass, undefined);
  assert.equal(absent.separationAuthority, undefined);
  assert.equal(absent.separationSafe, false);
  assert.equal(calls, 1, 'a missing descriptor must not cause a second provider call');

  const defaultRoot = deriveCanonicalAddressProof(entryIr(), 'v-ptr');
  assert.equal(defaultRoot.kind, 'rooted');
  assert.equal(defaultRoot.separationClass, undefined);
  assert.equal(defaultRoot.separationAuthority, undefined);
});

test('provider-backed targets retain provenance and prove descriptor-backed NoAlias', () => {
  const ir = entryIr(['left', 'right']);
  const table = new Map([
    ['variable:left', descriptor('heap-like', 'alloc:left')],
    ['variable:right', descriptor('heap-like', 'alloc:right')],
  ]);
  const tableRun = analyzeLocalPointsTo(ir, null, undefined, {
    canonicalOptions: { rootDescriptors: table },
  });
  let providerCalls = 0;
  const providerRun = analyzeLocalPointsTo(ir, null, undefined, {
    canonicalOptions: {
      rootDescriptorProvider(request) {
        providerCalls += 1;
        return descriptor('heap-like', 'alloc:' + request.variable?.key);
      },
    },
  });

  assert.equal(tableRun.status.completeness, 'complete');
  assert.equal(providerRun.status.completeness, 'complete');
  assert.equal(providerCalls, 2, 'each entry root is resolved once');

  const tableLeft = tableRun.pointsTo.get('v-left')?.targets?.[0];
  const tableRight = tableRun.pointsTo.get('v-right')?.targets?.[0];
  const providerLeft = providerRun.pointsTo.get('v-left')?.targets?.[0];
  const providerRight = providerRun.pointsTo.get('v-right')?.targets?.[0];
  for (const target of [tableLeft, tableRight, providerLeft, providerRight]) {
    assert.equal(target?.separationClass, 'heap-like');
    assert.equal(target?.separationAuthority, 'root-descriptor');
  }
  assert.deepEqual(
    [providerLeft.separationClass, providerLeft.separationAuthority],
    [tableLeft.separationClass, tableLeft.separationAuthority],
  );
  assert.deepEqual(
    [providerRight.separationClass, providerRight.separationAuthority],
    [tableRight.separationClass, tableRight.separationAuthority],
  );

  for (const [left, right] of [
    [tableLeft, tableRight],
    [providerLeft, providerRight],
  ]) {
    const result = pointsToAlias(
      { top: false, lossReasons: [], targets: [left] },
      { top: false, lossReasons: [], targets: [right] },
      {
        status: tableRun.status,
        widthBitsLeft: 64,
        widthBitsRight: 64,
      },
    );
    assert.equal(result.relation, 'no');
    assert.ok(result.reasonCodes.includes('distinct-proven-root'));
  }
});
