import assert from 'node:assert/strict';
import { AIRuntime } from '../../js/ai/runtime.js';
import { EvidenceStore } from '../../js/ai/evidence.js';
import { HypothesisStore } from '../../js/ai/hypothesis.js';
import { createCapabilityCatalog } from '../../js/ai/capabilities/catalog.js';
import { createCapabilityExecutor } from '../../js/ai/capabilities/executor.js';
import { initialScope } from '../../js/ai/control/scope.js';
import { analyzeFunction } from '../../js/analyze.js';
import { CHUNK_ROWS } from '../../js/backend.js';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

// #1701/#1702 — a fresh AIRuntime must hydrate its first resumed namespace,
// while ordinary evidence ingestion still cannot manufacture verified authority.
{
  const savedEvidence = {
    id: 'ev_saved',
    kind: 'observation',
    status: 'verified',
    title: 'saved deterministic finding',
    sourceTool: 'deterministic-test',
  };
  const session = {
    id: 'persisted-1',
    confirmedFindings: [savedEvidence],
    hypotheses: [{
      id: 'hyp_saved',
      claim: 'saved hypothesis',
      confidence: 0.8,
      status: 'verified',
      supportEvidenceIds: ['ev_saved'],
      contradictionEvidenceIds: [],
      missingEvidence: [],
    }],
  };

  assert.equal(new EvidenceStore([savedEvidence]).get('ev_saved')?.status, 'supported');
  assert.equal(EvidenceStore.fromPersistedConfirmed([savedEvidence]).get('ev_saved')?.status, 'verified');

  const runtime = new AIRuntime({ planner: false });
  const restored = runtime.storesFor(session, 'bin-1');
  assert.equal(restored.evidenceStore.get('ev_saved')?.status, 'verified');
  assert.equal(restored.hypothesisStore.get('hyp_saved')?.status, 'verified');

  const injectedEvidence = new EvidenceStore();
  const injectedHypotheses = new HypothesisStore(injectedEvidence);
  const injectedRuntime = new AIRuntime({
    evidenceStore: injectedEvidence,
    hypothesisStore: injectedHypotheses,
    planner: false,
  });
  const injected = injectedRuntime.storesFor(session, 'bin-1');
  assert.equal(injected.evidenceStore, injectedEvidence);
  assert.equal(injected.hypothesisStore, injectedHypotheses);
}

// #1727 — declared capability schemas are enforced before execution, including
// the string|integer union used by navigation addresses.
{
  const calls = [];
  const executor = createCapabilityExecutor({
    catalog: createCapabilityCatalog(),
    actionRunner: async (action) => calls.push(action),
  });
  await assert.rejects(
    executor.execute('navigation.open-function', { address: { not: 'an-address' } }),
    (error) => error?.type === 'invalid_tool_call',
  );
  assert.equal(calls.length, 0);
  await executor.execute('navigation.open-function', { address: '0x1000' });
  await executor.execute('navigation.open-function', { address: 4096 });
  assert.equal(calls.length, 2);
}

// #1728 — address zero is a valid selection/function anchor, not absence.
{
  assert.equal(initialScope({ selection: { start: 0n, end: 4n }, binaryId: 'bin-zero' }), 'selection');
  assert.equal(initialScope({ selection: { start: 0, end: 4 }, binaryId: 'bin-zero' }), 'selection');
  assert.equal(initialScope({ currentFunction: { address: 0n }, binaryId: 'bin-zero' }), 'function');
  assert.equal(initialScope({ currentFunction: { address: 0 }, binaryId: 'bin-zero' }), 'function');
}

function analysisBackend(lines) {
  const mn = [];
  const ops = [];
  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i]).trim();
    const split = text.indexOf(' ');
    mn[i] = split < 0 ? text : text.slice(0, split);
    ops[i] = split < 0 ? '' : text.slice(split + 1);
  }
  return {
    fetchChunk: async (_regionId, chunk) => chunk === 0 ? { mn, ops } : { mn: [], ops: [] },
    readAt: async () => ({ found: false, bytes: new Uint8Array() }),
  };
}

async function analyzeLines(lines) {
  const region = {
    id: 'issue-1707',
    vmAddr: 0x100000000n,
    size: BigInt(CHUNK_ROWS * 4),
  };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}

// #1707 — call-clobbered ADRP provenance dies at BL/BLR; callee-saved x19-x29 survives.
{
  const blCallerSaved = await analyzeLines([
    'adrp x8, #0x200000000',
    'bl #0x100001000',
    'add x0, x8, #0x20',
    'ret',
  ]);
  assert.equal(blCallerSaved.stringRefs.length, 0);

  const blrCallerSaved = await analyzeLines([
    'adrp x8, #0x200000000',
    'blr x9',
    'add x0, x8, #0x20',
    'ret',
  ]);
  assert.equal(blrCallerSaved.stringRefs.length, 0);

  const linkRegister = await analyzeLines([
    'adrp x30, #0x200000000',
    'bl #0x100001000',
    'add x0, x30, #0x20',
    'ret',
  ]);
  assert.equal(linkRegister.stringRefs.length, 0);

  const calleeSaved = await analyzeLines([
    'adrp x19, #0x200000000',
    'bl #0x100001000',
    'add x0, x19, #0x20',
    'ret',
  ]);
  assert.equal(calleeSaved.stringRefs.some((ref) => ref.addr === 0x200000020n), true);
}

function program(entries) {
  const table = new Map(entries.map(([address, mnemonic, operands = '']) => [
    BigInt(address).toString(),
    { mn: mnemonic, ops: operands },
  ]));
  return {
    fetch: async (address) => table.get(BigInt(address).toString()) || null,
    read: async () => null,
    isExecutable: (address) => table.has(BigInt(address).toString()),
    symbolFor: () => null,
  };
}

// #1730 — pause is a resumable paused stop and never aliases cancellation.
{
  const adapter = new LocalFunctionSandboxAdapter(program([
    [0x1720, 'add', 'x0, x0, #1'],
    [0x1724, 'b', '#0x1720'],
  ]));
  await adapter.connect();
  await adapter.launch({ address: 0x1720n, arguments: [0n], objectAsArg0: false });

  let requested = false;
  const paused = await adapter.resume({
    maxSteps: 5000,
    onProgress: (steps) => {
      if (!requested && steps >= 500) {
        requested = true;
        void adapter.pause();
      }
    },
  });
  assert.equal(paused.stop.kind, 'paused');
  assert.equal(adapter.cancelled, false);

  const before = (await adapter.readRegisters()).x0;
  const resumed = await adapter.resume({ maxSteps: 2 });
  const after = (await adapter.readRegisters()).x0;
  assert.notEqual(after, before);
  assert.notEqual(resumed.stop.kind, 'cancelled');

  await adapter.launch({ address: 0x1720n, arguments: [0n], objectAsArg0: false });
  let cancelRequested = false;
  const cancelled = await adapter.resume({
    maxSteps: 5000,
    onProgress: (steps) => {
      if (!cancelRequested && steps >= 500) {
        cancelRequested = true;
        void adapter.cancel();
      }
    },
  });
  assert.equal(cancelled.stop.kind, 'cancelled');
  await adapter.disconnect();
}
