import assert from 'node:assert/strict';
import test from 'node:test';

import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

const knownImplementationCapabilities = [
  'probes',
  'intercept',
  'replace',
  'memoryRead',
  'memoryWrite',
  'objcRuntime',
  'swiftRuntime',
];

test('#4915 caller metadata cannot mint backend-owned instrumentation capabilities', () => {
  const provider = new InstrumentationProvider(
    { id: 'minimal-backend' },
    {
      capabilities: {
        probes: true,
        intercept: true,
        replace: true,
        memoryRead: true,
        memoryWrite: true,
        objcRuntime: true,
        swiftRuntime: true,
        mutationRequiresAuthorization: false,
        vendorObservation: true,
      },
    },
  );

  const capabilities = provider.descriptor().capabilities;
  for (const capability of knownImplementationCapabilities) {
    assert.equal(capabilities[capability], false, `${capability} must be derived from backend support`);
  }
  assert.equal(capabilities.mutationRequiresAuthorization, true);
  assert.equal(capabilities.vendorObservation, true, 'provider-specific extension capabilities remain supported');
});

test('#4915 caller metadata cannot hide backend-owned instrumentation capabilities', () => {
  const backend = {
    id: 'complete-backend',
    installProbe() {},
    intercept() {},
    replace() {},
    readMemory() {},
    writeMemory() {},
    getObjCRuntimeInfo() {},
    getSwiftRuntimeInfo() {},
  };
  const provider = new InstrumentationProvider(backend, {
    capabilities: Object.fromEntries(knownImplementationCapabilities.map((key) => [key, false])),
  });

  const capabilities = provider.descriptor().capabilities;
  for (const capability of knownImplementationCapabilities) {
    assert.equal(capabilities[capability], true, `${capability} must remain true when the backend implements it`);
  }
  assert.equal(capabilities.mutationRequiresAuthorization, true);
});

test('#4915 advertised mutation support agrees with the runtime facet', async () => {
  const provider = new InstrumentationProvider(
    { id: 'no-mutation-backend' },
    {
      allowReplacement: true,
      allowMemoryWrite: true,
      capabilities: { replace: true, memoryWrite: true },
    },
  );

  assert.equal(provider.descriptor().capabilities.replace, false);
  assert.equal(provider.descriptor().capabilities.memoryWrite, false);

  const session = await provider.openSession({
    binaryId: 'bin:4915',
    targetIdentity: 'process:4915',
    sessionNonce: 'issue-4915',
  }, { connect: false });
  try {
    await assert.rejects(
      () => session.facets.instrumentation.replace('target', 'replacement'),
      { code: 'unsupported' },
    );
    await assert.rejects(
      () => session.facets.instrumentation.writeMemory(0x1000n, new Uint8Array([1])),
      { code: 'unsupported' },
    );
  } finally {
    await session.close();
  }
});

test('#4915 non-boolean protected metadata cannot become capability authority', () => {
  const provider = new InstrumentationProvider(
    { id: 'typed-boundary-backend' },
    {
      capabilities: {
        replace: { claimed: true },
        memoryWrite: 'true',
        objcRuntime: 1,
        mutationRequiresAuthorization: null,
        vendorObservation: false,
      },
    },
  );

  const capabilities = provider.descriptor().capabilities;
  assert.equal(capabilities.replace, false);
  assert.equal(capabilities.memoryWrite, false);
  assert.equal(capabilities.objcRuntime, false);
  assert.equal(capabilities.mutationRequiresAuthorization, true);
  assert.equal(capabilities.vendorObservation, false);
});
