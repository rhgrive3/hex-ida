import assert from 'node:assert/strict';
import { RemoteDebugAdapter } from '../../js/adapters/index.js';
import { DebugAdapterRuntimeProvider } from '../../js/runtime/provider.js';
import { DEBUG_PROTOCOL_VERSION } from '../../js/debug/adapter.js';
import { encodeWireValue } from '../../js/debug/remote-protocol.js';

class LoopbackTransport {
  constructor() { this.listener = null; this.connectCount = 0; this.closeCount = 0; }
  onMessage(fn) {
    this.listener = fn;
    return () => { if (this.listener === fn) this.listener = null; };
  }
  async send(packet) {
    if (packet.type !== 'request') return;
    let result = {};
    if (packet.method === 'connect') {
      this.connectCount++;
      result = { capabilities:{ readMemory:true } };
    } else if (packet.method === 'disconnect') {
      result = { disconnected:true };
    } else if (packet.method === 'readMemory') {
      result = { bytes:new Uint8Array([0x12, 0x34]) };
    }
    const response = encodeWireValue({
      version:DEBUG_PROTOCOL_VERSION,
      type:'response',
      id:packet.id,
      epoch:packet.epoch,
      result,
    });
    queueMicrotask(() => this.listener?.(response));
  }
  close() { this.closeCount++; }
  emit(event, epoch = 0) {
    const packet = encodeWireValue({
      version:DEBUG_PROTOCOL_VERSION,
      type:'event',
      epoch,
      event,
      data:{},
    });
    this.listener?.(packet);
  }
}

const lifecycleTransport = new LoopbackTransport();
const lifecycleAdapter = new RemoteDebugAdapter(lifecycleTransport, { capabilities:{ readMemory:true } });
const provider = new DebugAdapterRuntimeProvider(lifecycleAdapter);
const first = await provider.openSession({ processKey:'first' });
await first.close();
assert.equal(lifecycleTransport.closeCount, 0, 'closing one runtime session must not permanently destroy a reusable transport');
const second = await provider.openSession({ processKey:'second' });
assert.equal(lifecycleTransport.connectCount, 2, 'the same remote adapter must support a second sequential runtime session');
const bytes = await lifecycleAdapter.readMemory(0x1000n, 2);
assert.deepEqual([...bytes], [0x12, 0x34], 'nested protocol-native Uint8Array memory results must be accepted');
await second.close();
assert.equal(lifecycleTransport.closeCount, 0, 'ordinary sequential session shutdown must preserve the transport lifecycle');

const eventTransport = new LoopbackTransport();
const eventAdapter = new RemoteDebugAdapter(eventTransport);
let secondCalled = false;
eventAdapter.onEvent(() => { throw new Error('subscriber failure'); });
eventAdapter.onEvent(() => { secondCalled = true; });
eventTransport.emit('paused', eventAdapter.epoch);
assert.equal(secondCalled, true, 'one throwing subscriber must not suppress later event subscribers');
