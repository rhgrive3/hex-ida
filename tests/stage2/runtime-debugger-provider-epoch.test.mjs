import assert from 'node:assert/strict';
import { RemoteDebugAdapter } from '../../js/adapters/index.js';
import { DEBUG_PROTOCOL_VERSION } from '../../js/debug/adapter.js';
import { encodeWireValue } from '../../js/debug/remote-protocol.js';
import { DebuggerProvider } from '../../js/runtime/debugger-provider.js';

class EpochTransport {
  constructor() { this.listener = null; }
  onMessage(fn) { this.listener = fn; return () => { if (this.listener === fn) this.listener = null; }; }
  async send(packet) {
    if (packet.type !== 'request') return;
    const result = packet.method === 'connect' ? { capabilities:{} } : {};
    queueMicrotask(() => this.listener?.(encodeWireValue({
      version:DEBUG_PROTOCOL_VERSION, type:'response', id:packet.id, epoch:packet.epoch, result,
    })));
  }
  emit(event, epoch) {
    this.listener?.(encodeWireValue({
      version:DEBUG_PROTOCOL_VERSION, type:'event', epoch, event, data:{},
    }));
  }
}

const transport = new EpochTransport();
const adapter = new RemoteDebugAdapter(transport);
const provider = new DebuggerProvider(adapter, { id:'epoch-alignment-provider' });
let priorSessionEpoch = null;

for (let index = 1; index <= 3; index++) {
  const session = await provider.openSession({
    binaryId:'binary:epoch-alignment', processKey:`process:${index}`, sessionNonce:`session:${index}`,
  });
  assert.equal(adapter.epoch, session.epoch, `session ${index} must establish the adapter protocol epoch`);
  if (priorSessionEpoch != null) {
    assert.ok(session.epoch > priorSessionEpoch, `session ${index} must advance beyond the prior session epoch`);
  }
  transport.emit('paused', session.epoch);
  assert.equal(session.state, 'paused', `current event for session ${index} must be accepted`);
  transport.emit('resumed', session.epoch + 1);
  assert.equal(session.state, 'paused', `wrong-epoch event for session ${index} must be rejected`);
  if (priorSessionEpoch != null) {
    transport.emit('resumed', priorSessionEpoch);
    assert.equal(session.state, 'paused', `prior-session event for session ${index} must be rejected`);
  }
  priorSessionEpoch = session.epoch;
  await session.close();
}
