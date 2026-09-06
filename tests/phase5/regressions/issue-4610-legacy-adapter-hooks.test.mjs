import assert from 'node:assert/strict';
import test from 'node:test';

import {
  architectureAdapter,
  registerArchitectureAdapter,
} from '../../../js/architecture/index.js';
import {
  registerArchitecturePlugin,
} from '../../../js/targets/architecture/index.js';

function uniqueId(label) {
  return `issue-4610-${label}-${process.pid}`;
}

test('legacy adapter registration preserves custom behavioral hooks', () => {
  const id = uniqueId('preserve');
  const region = { vmAddr:0x1000n, size:0x100n };
  const definition = {
    id,
    instructionAlignment:4,
    fixedInstructionSize:4,
    viewerCompatible:true,
    controlFlow:() => 'branch',
    callKind:() => 'custom-call',
    returnKind:() => 'custom-return',
    rowForAddress:() => 123,
    addressForRow:() => 0xfeedn,
    validateInstructionPlacement:() => ({ ok:false, code:'custom-placement' }),
  };

  const registered = registerArchitectureAdapter(definition);
  const resolved = architectureAdapter(id);

  assert.strictEqual(resolved, registered, 'registered legacy adapter must remain the canonical projection for its plugin object');
  for (const adapter of [registered, resolved]) {
    assert.equal(adapter.controlFlow({}), 'branch');
    assert.equal(adapter.callKind({}), 'custom-call');
    assert.equal(adapter.returnKind({}), 'custom-return');
    assert.equal(adapter.rowForAddress(region, 0x1000n), 123);
    assert.equal(adapter.addressForRow(region, 0), 0xfeedn);
    assert.deepEqual(
      adapter.validateInstructionPlacement(region, 0x1000n, 4),
      { ok:false, code:'custom-placement' },
    );
  }
});

test('legacy adapter replacement replaces cached hook semantics by plugin identity', () => {
  const id = uniqueId('replace');
  const first = registerArchitectureAdapter({
    id,
    instructionAlignment:4,
    fixedInstructionSize:4,
    rowForAddress:() => 1,
    callKind:() => 'first-call',
  });
  const second = registerArchitectureAdapter({
    id,
    instructionAlignment:4,
    fixedInstructionSize:4,
    rowForAddress:() => 2,
    callKind:() => 'second-call',
  }, { replace:true });

  assert.notStrictEqual(second, first, 'replacement must not reuse the previous adapter identity');
  assert.strictEqual(architectureAdapter(id), second);
  assert.equal(second.rowForAddress({}, 0n), 2);
  assert.equal(second.callKind({}), 'second-call');
});

test('native ArchitecturePluginV2 projection remains plugin-derived', () => {
  const id = uniqueId('native');
  const plugin = registerArchitecturePlugin({
    id,
    instructionAlignment:2,
    fixedInstructionSize:2,
    classifyControlFlow:(instruction) => instruction?.mnemonic === 'jal' ? 'call' : 'fallthrough',
  });
  const adapter = architectureAdapter(id);

  assert.equal(adapter.id, plugin.id);
  assert.equal(adapter.fixedInstructionSize, 2);
  assert.equal(adapter.controlFlow({ mnemonic:'jal' }), 'call');
  assert.equal(adapter.callKind({ mnemonic:'jal' }), 'call');
  assert.equal(adapter.returnKind({ mnemonic:'jal' }), null);
  assert.strictEqual(architectureAdapter(id), adapter, 'native projection must retain existing WeakMap memoization');
});

test('legacy adapters without custom hooks retain default fixed-width behavior', () => {
  const id = uniqueId('default');
  const adapter = registerArchitectureAdapter({
    id,
    instructionAlignment:4,
    fixedInstructionSize:4,
  });
  const region = { vmAddr:0x2000n, size:0x20n };

  assert.equal(adapter.rowForAddress(region, 0x2004n), 1);
  assert.equal(adapter.addressForRow(region, 1), 0x2004n);
  assert.deepEqual(adapter.validateInstructionPlacement(region, 0x2004n, 4), { ok:true });
  assert.equal(adapter.callKind({}), null);
  assert.equal(adapter.returnKind({}), null);
});
