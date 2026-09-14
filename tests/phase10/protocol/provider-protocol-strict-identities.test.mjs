import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  validateProviderPacket,
} from '../../../js/runtime/provider-protocol.js';

function packet(type, extra = {}) {
  return {
    protocol:RUNTIME_PROVIDER_PROTOCOL,
    version:RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type,
    ...extra,
  };
}

test('provider facet and method identities reject coercible non-strings', () => {
  for (const value of [['debugger'], { value:'debugger' }, 1, true]) {
    assert.throws(
      () => validateProviderPacket(packet('request', {
        id:1,
        epoch:1,
        facet:value,
        method:'debugger.readMemory',
      })),
      (error) => error?.code === 'malformed-provider-data',
    );
  }

  for (const value of [['debugger.readMemory'], { value:'debugger.readMemory' }, 1, true]) {
    assert.throws(
      () => validateProviderPacket(packet('request', {
        id:1,
        epoch:1,
        facet:'debugger',
        method:value,
      })),
      (error) => error?.code === 'malformed-provider-data',
    );
  }
});

test('provider hello facets reject coercible non-string members', () => {
  assert.throws(
    () => validateProviderPacket(packet('hello', {
      providerId:'provider',
      providerVersion:'1',
      facets:[['debugger']],
    })),
    (error) => error?.code === 'malformed-provider-data',
  );

  const valid = validateProviderPacket(packet('hello', {
    providerId:'provider',
    providerVersion:'1',
    facets:['trace', 'debugger', 'trace'],
  }));
  assert.deepEqual(valid.facets, ['debugger', 'trace']);
});

test('normal string request identities keep existing namespace semantics', () => {
  const valid = validateProviderPacket(packet('request', {
    id:1,
    epoch:1,
    facet:'debugger',
    method:'debugger.readMemory',
  }));
  assert.equal(valid.facet, 'debugger');
  assert.equal(valid.method, 'debugger.readMemory');
  assert.throws(
    () => validateProviderPacket(packet('request', {
      id:1,
      epoch:1,
      facet:'trace',
      method:'debugger.readMemory',
    })),
    (error) => error?.code === 'protocol-mismatch',
  );
});
