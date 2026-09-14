import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeProviderDescriptor } from '../../../js/runtime/provider.js';

function descriptor(facets) {
  return createRuntimeProviderDescriptor({
    id: 'provider-4471',
    version: '1',
    kind: 'fixture',
    facets,
  });
}

test('#4471 rejects primitive facet containers instead of laundering them to []', () => {
  for (const facets of ['debugger', false, true, 0, 1, () => {}]) {
    assert.throws(
      () => descriptor(facets),
      (error) => error?.code === 'runtime-invalid-facet',
      `expected runtime-invalid-facet for ${typeof facets}`,
    );
  }
});

test('#4471 accepts only arrays or plain-object facet maps when explicitly supplied', () => {
  for (const facets of [new Date(0), new Map([['debugger', true]]), new Set(['debugger']), new String('debugger')]) {
    assert.throws(
      () => descriptor(facets),
      (error) => error?.code === 'runtime-invalid-facet',
    );
  }

  const nullPrototype = Object.create(null);
  nullPrototype.debugger = true;
  nullPrototype.trace = false;

  assert.deepEqual(descriptor(undefined).facets, []);
  assert.deepEqual(descriptor(null).facets, []);
  assert.deepEqual(descriptor(['trace', 'debugger', 'trace']).facets, ['debugger', 'trace']);
  assert.deepEqual(descriptor({ debugger: true, trace: true, emulator: false }).facets, ['debugger', 'trace']);
  assert.deepEqual(descriptor(nullPrototype).facets, ['debugger']);
});

test('#4471 keeps existing facet-name validation fail-closed', () => {
  assert.throws(
    () => descriptor(['debugger', 1]),
    (error) => error?.code === 'runtime-invalid-facet',
  );
  assert.throws(
    () => descriptor(['debugger', 'unknown']),
    (error) => error?.code === 'runtime-invalid-facet',
  );
});
