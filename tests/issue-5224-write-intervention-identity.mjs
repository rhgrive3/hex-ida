// Regression for #5224: DebuggerProvider writeRegister()/writeMemory() minted
// intervention ids from an identity that includes `sequence` — but never set
// one. Two identical writes therefore produced the SAME interventionId, and
// InterventionLedger.add() returned the first record (with its stale
// acknowledgedResult) for the second, freshly executed write.
// Contract now: each provider write intervention carries a distinct monotonic
// per-session sequence, so identical writes get distinct ids and each record
// carries its own acknowledgedResult.
import assert from 'node:assert/strict';
import { DebugAdapter } from '../js/debug/adapter.js';
import { DebuggerProvider } from '../js/runtime/debugger-provider.js';

const binaryId = 'bin_sha256_' + 'aa'.repeat(32);

class WriteAdapter extends DebugAdapter {
  constructor() {
    super({ id: 'fixture-write-id', kind: 'lldb', capabilities: { modules: true, threads: true, readMemory: true, writeMemory: true, readRegisters: true, writeRegister: true } });
    this.registerWrites = 0;
    this.memoryWrites = 0;
  }
  onEvent() { return () => {}; }
  async getModules() { return []; }
  async getThreads() { return [{ id: 't1' }]; }
  async readMemory(_address, size) { return new Uint8Array(size); }
  async writeMemory(_address, bytes) { return { written: bytes.length, call: ++this.memoryWrites }; }
  async readRegisters() { return { pc: 0x7000n }; }
  async writeRegister(name, value) { return { name, value, call: ++this.registerWrites }; }
}

// 1. The issue's scenario: two identical register writes must execute twice
//    and return two distinct interventions, each holding its own ack.
{
  const adapter = new WriteAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'write-id-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: { process: 'w:1' }, sessionNonce: 'w:nonce' });
  const dbg = session.facets.debugger;

  const first = await dbg.writeRegister('pc', 0x1000n);
  const second = await dbg.writeRegister('pc', 0x1000n);

  assert.equal(adapter.registerWrites, 2, 'the adapter executed both writes');
  assert.notEqual(first.intervention.interventionId, second.intervention.interventionId,
    'identical writes must not share an intervention id');
  assert.deepEqual(first.intervention.acknowledgedResult, { name: 'pc', value: 0x1000n, call: 1 });
  assert.deepEqual(second.intervention.acknowledgedResult, { name: 'pc', value: 0x1000n, call: 2 },
    'the second intervention must carry its own acknowledged result');
  assert.equal(typeof first.intervention.sequence, 'number');
  assert.equal(typeof second.intervention.sequence, 'number');
  assert.notEqual(first.intervention.sequence, second.intervention.sequence);

  // The ledger holds both records.
  assert.notEqual(dbg.interventions.get(first.intervention.interventionId), undefined);
  assert.notEqual(dbg.interventions.get(second.intervention.interventionId), undefined);
  await session.close();
}

// 2. Same contract for memory writes.
{
  const adapter = new WriteAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'write-id-provider-mem' });
  const session = await provider.openSession({ binaryId, targetIdentity: { process: 'w:2' }, sessionNonce: 'w:nonce-2' });
  const dbg = session.facets.debugger;

  const bytes = new Uint8Array([1, 2, 3]);
  const first = await dbg.writeMemory(0x7000n, bytes);
  const second = await dbg.writeMemory(0x7000n, bytes);

  assert.equal(adapter.memoryWrites, 2, 'the adapter executed both memory writes');
  assert.notEqual(first.intervention.interventionId, second.intervention.interventionId);
  assert.equal(first.intervention.acknowledgedResult.call, 1);
  assert.equal(second.intervention.acknowledgedResult.call, 2);
  await session.close();
}

// 3. Different writes were never colliding — keep that guarantee explicit.
{
  const adapter = new WriteAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'write-id-provider-mixed' });
  const session = await provider.openSession({ binaryId, targetIdentity: { process: 'w:3' }, sessionNonce: 'w:nonce-3' });
  const dbg = session.facets.debugger;

  const a = await dbg.writeRegister('pc', 0x1000n);
  const b = await dbg.writeRegister('pc', 0x2000n);
  const c = await dbg.writeMemory(0x7000n, new Uint8Array([9]));
  const ids = new Set([a.intervention.interventionId, b.intervention.interventionId, c.intervention.interventionId]);
  assert.equal(ids.size, 3, 'all write interventions keep distinct identities');
  await session.close();
}

console.log('issue-5224 write intervention identity per-execution: ok');
