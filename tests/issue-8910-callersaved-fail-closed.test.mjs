// Issue #8910 regression: a throwing or malformed callerSaved() provider
// hook must never be laundered into a complete empty-clobber result.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ABIPlugin, registerABIPlugin } from '../js/targets/abi/registry.js';
import { AAPCS64_ABI } from '../js/targets/abi/aapcs64-core.js';
import { semanticAbiAdapter } from '../js/analysis/semantic-function-base.js';

function brokenPlugin(id, callerSaved) {
  return registerABIPlugin(new ABIPlugin({
    id,
    semanticVersion: '1',
    semanticIdentity: `${id}@1`,
    architectureId: 'arm64',
    platformPredicate: () => true,
    callingConventions: () => [id],
    classifyArguments: AAPCS64_ABI.classifyArguments,
    classifyCallReturn: AAPCS64_ABI.classifyCallReturn,
    classifyFunctionReturn: AAPCS64_ABI.classifyFunctionReturn,
    classifyEntryRegister: AAPCS64_ABI.classifyEntryRegister,
    callerSaved,
    calleeSaved: AAPCS64_ABI.calleeSaved,
    stackRules: AAPCS64_ABI.stackRules,
    unwindRules: AAPCS64_ABI.unwindRules,
    defaultUnknownCallEffects: () => Object.freeze({
      registerEffects: 'unknown', memoryEffects: 'unknown', mayThrow: true,
    }),
  }));
}

function classify(adapter) {
  return adapter.classifyCall({
    call: {
      target: '0x1000',
      callPrototype: { returnType: 'void', returnsValue: false, parameters: [] },
    },
  });
}

test('#8910 throwing callerSaved fails closed instead of complete', () => {
  const adapter = semanticAbiAdapter(
    brokenPlugin('audit-8910-throw', () => { throw new Error('provider failure'); }),
    { architecture: 'arm64', platform: 'linux' },
  );
  const result = classify(adapter);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.partial, true);
  assert.deepEqual(result.clobbers, []);
  assert.equal(result.clobberEvidence, 'unavailable');
  assert.throws(() => adapter.callerSaved(), /abi-callerSaved-unavailable/);
});

test('#8910 malformed non-array callerSaved fails closed', () => {
  const adapter = semanticAbiAdapter(
    brokenPlugin('audit-8910-malformed', () => ({ x0: true })),
    { architecture: 'arm64', platform: 'linux' },
  );
  const result = classify(adapter);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.partial, true);
  assert.deepEqual(result.clobbers, []);
});

test('#8910 malformed member callerSaved fails closed', () => {
  const adapter = semanticAbiAdapter(
    brokenPlugin('audit-8910-member', () => ['x0', 42]),
    { architecture: 'arm64', platform: 'linux' },
  );
  const result = classify(adapter);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.partial, true);
});

test('#8910 canonical callerSaved still publishes proven clobbers', () => {
  const adapter = semanticAbiAdapter(AAPCS64_ABI, { architecture: 'arm64', platform: 'linux' });
  assert.ok(adapter.callerSaved().includes('x0'));
  const result = classify(adapter);
  assert.ok(result.clobbers.length > 0);
  assert.equal(result.clobberEvidence, 'abi-aapcs64');
});
