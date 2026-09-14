import assert from 'node:assert/strict';
import {
  DebugAdapter,
  DebugAdapterError,
} from '../../../js/debug/adapter.js';

const baseStubs = [
  ['attach', 'attach'],
  ['launch', 'launch'],
  ['pause', 'pause'],
  ['resume', 'resume'],
  ['stepInto', 'stepInto'],
  ['stepOver', 'stepOver'],
  ['stepOut', 'stepOut'],
  ['removeBreakpoint', 'removeBreakpoint'],
  ['listBreakpoints', 'listBreakpoints'],
  ['readRegisters', 'readRegisters'],
  ['writeRegister', 'writeRegister'],
  ['readMemory', 'readMemory'],
  ['writeMemory', 'writeMemory'],
  ['threads', 'getThreads'],
  ['modules', 'getModules'],
  ['backtrace', 'getBacktrace'],
  ['evaluate', 'evaluate'],
  ['watchpointMemory', 'watchMemory'],
  ['objcRuntime', 'getObjCRuntimeInfo'],
  ['swiftRuntime', 'getSwiftRuntimeInfo'],
  ['cancel', 'cancel'],
  ['replay', 'replay'],
];

for (const [capability, method] of baseStubs) {
  const adapter = new DebugAdapter({ capabilities:{ [capability]:true } });
  assert.equal(adapter.negotiate([capability])[capability], false, `${capability} must not negotiate from a base placeholder`);
  assert.equal(adapter.negotiate()[capability], false, `${capability} must not appear supported in the default negotiation`);
  await assert.rejects(
    adapter[method](),
    (error) => error instanceof DebugAdapterError
      && error.code === 'not-implemented',
    `${method} must fail closed when the base placeholder is advertised`,
  );
}

{
  const adapter = new DebugAdapter();
  await assert.rejects(
    adapter.readRegisters(),
    (error) => error instanceof DebugAdapterError && error.code === 'unsupported',
  );
}

class RegisterAdapter extends DebugAdapter {
  constructor() { super({ capabilities:{ readRegisters:true } }); }
  async readRegisters() { return { x0:1n }; }
}

{
  const adapter = new RegisterAdapter();
  assert.equal(adapter.negotiate(['readRegisters']).readRegisters, true);
  assert.equal(adapter.negotiate().readRegisters, true);
  assert.deepEqual(await adapter.readRegisters(), { x0:1n });
}

class TraceAdapter extends DebugAdapter {
  constructor() {
    super({ capabilities:{ traceFunction:true, traceCall:true, traceReturn:true } });
  }
  async trace(options = {}) { return options; }
}

{
  const adapter = new TraceAdapter();
  assert.deepEqual(
    adapter.negotiate(['traceFunction', 'traceCall', 'traceReturn']),
    { traceFunction:true, traceCall:true, traceReturn:true },
  );
  assert.deepEqual(await adapter.traceCall('callee'), {
    capability:'traceCall',
    args:['callee'],
  });
}

{
  const adapter = new DebugAdapter({ capabilities:{ traceFunction:true, traceCall:true } });
  assert.equal(adapter.negotiate(['traceFunction']).traceFunction, false);
  assert.equal(adapter.negotiate(['traceCall']).traceCall, false);
  await assert.rejects(
    adapter.trace(),
    (error) => error instanceof DebugAdapterError && error.code === 'not-implemented',
  );
}

{
  const adapter = new DebugAdapter({ capabilities:{ breakpointAddress:true } });
  assert.equal(adapter.negotiate(['breakpointAddress']).breakpointAddress, true);
  assert.deepEqual(await adapter.setBreakpoint({ address:0x1000n }), {
    id:'bp:address:4096',
    kind:'address',
    address:0x1000n,
    enabled:true,
  });
}

console.log('debug adapter base stub contract #4619: ok');
