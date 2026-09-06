import assert from 'node:assert/strict';
import { ContextBroker } from '../js/ai/context/broker.js';

// #6147: initialAutoScope must not treat address 0/0n as absent.
{
  const broker = new ContextBroker({});
  assert.equal(
    broker.initialAutoScope({ binaryId: 'bin-1', currentFunction: { address: 0n, name: 'entry' } }),
    'function',
  );
  assert.equal(
    broker.initialAutoScope({ binaryId: 'bin-1', currentFunction: { address: 0 } }),
    'function',
  );
  assert.equal(
    broker.initialAutoScope({ binaryId: 'bin-1', currentFunction: { address: '0' } }),
    'function',
  );
}

{
  const broker = new ContextBroker({});
  assert.equal(
    broker.initialAutoScope({ binaryId: 'bin-1', currentFunction: { address: 0x1000n } }),
    'function',
  );
  assert.equal(
    broker.initialAutoScope({
      binaryId: 'bin-1',
      selection: { start: 0n },
      currentFunction: { address: 0n },
    }),
    'selection',
  );
  assert.equal(broker.initialAutoScope({ binaryId: 'bin-1' }), 'binary');
  assert.equal(broker.initialAutoScope({}), 'function');
  assert.equal(
    broker.initialAutoScope({ binaryId: 'bin-1', currentFunction: { address: null } }),
    'binary',
  );
}

{
  const broker = new ContextBroker({ currentAddress: 0n });
  assert.equal(broker.initialAutoScope({ binaryId: 'bin-1' }), 'function');
}

console.log('issue-6147: PASS');
