// Regression for #5272: launch input recorded as evidence must describe the
// concrete state actually executed. Structured scalar coercion fails closed;
// accepted scalars are width-canonicalized once and the same snapshot drives
// execution and evidence/replay identity.
import assert from 'node:assert/strict';
import { FunctionSandbox } from '../js/symbolic/function-sandbox.js';

const io = { fetch: async () => null };
const rejectionOf = async (fn) => {
  try { await fn(); } catch (e) { return e; }
  return null;
};

// Canonical primitive forms still work and publish the executed state.
{
  const s = new FunctionSandbox(io);
  const state = await s.setup(0x1000n, {
    args: [1n, 2, '0x10'],
    registers: { x4: '0xff' },
    objectMemory: [{ offset: 0x20, size: 4, value: 7 }],
    watch: [{ name: 'w', offset: 0x20, size: 4 }],
    breakpoints: [0x1008n],
  });
  assert.equal(s.getRegister('x0'), 1n);
  assert.equal(s.getRegister('x1'), 2n);
  assert.equal(s.getRegister('x2'), 0x10n);
  assert.equal(s.getRegister('x4'), 0xffn);
  assert.equal(s.emulator.breakpoints.has('4104'), true);
  assert.ok(s.canonicalInput, 'setup publishes canonical launch state');
  assert.deepEqual(s.canonicalInput.args, ['1', '2', '16']);
  assert.deepEqual(s.canonicalInput.registers, { x4: '255' });
  assert.deepEqual(s.canonicalInput.objectMemory, [{ offset: '32', size: 4, value: '7' }]);
  assert.deepEqual(s.canonicalInput.breakpoints, ['4104']);
  assert.equal(s.canonicalInput.args[0], state.registers.x0.toString());
  assert.equal(BigInt(s.canonicalInput.registers.x4), s.emulator.get('x4'));
}

// Current-main's stricter direct sandbox boundary rejects explicit null while
// the historical empty-args objectAsArg0 substitution remains unchanged.
{
  const s = new FunctionSandbox(io);
  await assert.rejects(() => s.setup(0x1000n, { args: [null] }), TypeError);
  const e = new FunctionSandbox(io);
  await e.setup(0x1000n, {});
  assert.equal(e.getRegister('x0'), e.objectBase);
}

// Schema-foreign scalars must not coerce into machine state.
for (const [label, spec] of [
  ['args:[true]', { args: [true] }],
  ["args:['']", { args: [''] }],
  ['args:[1.5]', { args: [1.5] }],
  ['args:[[16]]', { args: [[16]] }],
  ['registers boolean', { registers: { x1: false } }],
  ['objectMemory offset array', { objectMemory: [{ offset: ['16'], size: 8, value: 1n }] }],
  ['objectMemory value boolean', { objectMemory: [{ offset: 0x10, size: 8, value: false }] }],
  ['objectMemory size string', { objectMemory: [{ offset: 0x10, size: '8', value: 1n }] }],
  ['stackMemory offset boolean', { stackMemory: [{ offset: true, size: 8, value: 1n }] }],
  ['watch offset boolean', { watch: [{ offset: true, size: 8 }] }],
  ['watch size string', { watch: [{ offset: 0x20, size: '8' }] }],
  ['breakpoints array element', { breakpoints: [['0x1000']] }],
]) {
  const s = new FunctionSandbox(io);
  const error = await rejectionOf(() => s.setup(0x1000n, spec));
  assert.ok(error instanceof TypeError || error instanceof RangeError, `${label} must be rejected`);
}

// Primitive integer text is strict: whitespace cannot be laundered by trim().
for (const bad of [' 16', '16 ', ' 0x10 ', '']) {
  const s = new FunctionSandbox(io);
  await assert.rejects(() => s.setup(0x1000n, { args: [bad] }), TypeError);
}

// Public/manual experiment scalar validation preserves primitive canonical forms
// and rejects coercible/structured forms before launch.
const { validateCanonicalArguments } = await import('../js/dynamic/experiments.js');
assert.deepEqual(validateCanonicalArguments([1n, 2, '0x10', null]), [1n, 2n, 0x10n, 0n]);
for (const bad of [true, ['16'], 1.5, { valueOf: () => 1 }, ' 16', '']) {
  assert.throws(
    () => validateCanonicalArguments([bad]),
    (error) => error instanceof Error && error.code === 'invalid-experiment',
    `manual case argument ${String(bad)} must fail closed`,
  );
}

// Stateful object-memory getters are sampled exactly once before any await;
// execution and canonical evidence cannot diverge mid-flight.
{
  const reads = { offset: 0, size: 0, value: 0 };
  const mutating = {
    get offset() { reads.offset++; return reads.offset === 1 ? 8 : 16; },
    get size() { reads.size++; return reads.size === 1 ? 4 : 8; },
    get value() { reads.value++; return reads.value === 1 ? 7 : 9; },
  };
  const s = new FunctionSandbox(io);
  await s.setup(0x1000n, { objectMemory: [mutating] });
  assert.deepEqual(reads, { offset: 1, size: 1, value: 1 });
  assert.deepEqual(s.canonicalInput.objectMemory, [{ offset: '8', size: 4, value: '7' }]);
  assert.equal(await s.emulator.load(s.objectBase + 8n, 4), 7n);
}

// Object-form keys pass the same explicit integer grammar, including rejecting
// blank/whitespace keys that BigInt('') would otherwise turn into zero.
{
  const s = new FunctionSandbox(io);
  await s.setup(0x1000n, { objectMemory: { '0x20': 5n, '16': 6n } });
  assert.deepEqual(
    s.canonicalInput.objectMemory.map((m) => `${m.offset}:${m.value}`).sort(),
    ['16:6', '32:5'],
  );
  for (const badKey of ['', ' 16', '16 ', '0xzz']) {
    const bad = new FunctionSandbox(io);
    await assert.rejects(() => bad.setup(0x1000n, { objectMemory: { [badKey]: 1n } }), TypeError);
  }
}

// Stack-memory inputs are also a single width-canonicalized snapshot.
{
  let offsetReads = 0, sizeReads = 0, valueReads = 0;
  const item = {
    get offset() { offsetReads++; return 8; },
    get size() { sizeReads++; return 1; },
    get value() { valueReads++; return 256n; },
  };
  const s = new FunctionSandbox(io);
  await s.setup(0x1000n, { stackMemory: [item] });
  assert.equal(offsetReads, 1); assert.equal(sizeReads, 1); assert.equal(valueReads, 1);
  assert.deepEqual(s.canonicalInput.stackMemory, [{ offset: '8', size: 1, value: '0' }]);
  assert.equal(await s.emulator.load(s.emulator.sp + 8n, 1), 0n);
}

// Register/argument and memory evidence uses the same fixed-width image that
// Emulator executes.
{
  const s = new FunctionSandbox(io);
  await s.setup(0x1000n, { args: [1n << 64n] });
  assert.equal(s.canonicalInput.args[0], s.getRegister('x0').toString());
  assert.equal(s.canonicalInput.args[0], '0');

  const r = new FunctionSandbox(io);
  await r.setup(0x1000n, { registers: { x5: (1n << 64n) + 5n } });
  assert.equal(r.canonicalInput.registers.x5, r.getRegister('x5').toString());
  assert.equal(r.canonicalInput.registers.x5, '5');

  const m = new FunctionSandbox(io);
  await m.setup(0x1000n, { objectMemory: [{ offset: 0, size: 1, value: 256n }] });
  assert.equal(m.canonicalInput.objectMemory[0].value, '0');
  assert.equal(await m.emulator.load(m.objectBase, 1), 0n);
}

// Heap/global initializers applied by the adapter after sandbox.setup() are part
// of canonical launch identity and are width-canonicalized before both store
// and publication.
{
  const { LocalFunctionSandboxAdapter } = await import('../js/adapters/index.js');
  const adapter = new LocalFunctionSandboxAdapter({ fetch: async () => null });
  await adapter.launch({
    address: 0x1000n, args: [1n],
    heap: [
      { address: 0x620000000000n, size: 1, value: 256n },
      { address: 0x620000000010n, size: 1, value: 511n },
    ],
    globalValues: [{ address: 0x620000001000n, size: 2, value: 65536n }],
  });
  const canonicalInput = adapter.sandbox.canonicalInput;
  assert.deepEqual(canonicalInput.heap, [
    { address: (0x620000000000n).toString(), size: 1, value: '0' },
    { address: (0x620000000010n).toString(), size: 1, value: '255' },
  ]);
  assert.deepEqual(canonicalInput.globalValues, [
    { address: (0x620000001000n).toString(), size: 2, value: '0' },
  ]);
  assert.deepEqual([...await adapter.readMemory(0x620000000000n, 1)], [0x00]);
  assert.deepEqual([...await adapter.readMemory(0x620000000010n, 1)], [0xff]);
  assert.deepEqual([...await adapter.readMemory(0x620000001000n, 2)], [0x00, 0x00]);

  const other = new LocalFunctionSandboxAdapter({ fetch: async () => null });
  await other.launch({
    address: 0x1000n, args: [1n],
    heap: [{ address: 0x620000000000n, size: 8, value: 2n }],
    globalValues: [{ address: 0x620000001000n, size: 4, value: 2n }],
  });
  assert.notDeepEqual(canonicalInput, other.sandbox.canonicalInput,
    'machine-state differences remain visible in evidence identity');
}

// Heap/global getters are sampled once before store/publication.
{
  const { LocalFunctionSandboxAdapter } = await import('../js/adapters/index.js');
  const reads = { address: 0, size: 0, value: 0 };
  const item = {
    get address() { reads.address++; return 0x620000000020n; },
    get size() { reads.size++; return 1; },
    get value() { reads.value++; return 257n; },
  };
  const adapter = new LocalFunctionSandboxAdapter({ fetch: async () => null });
  await adapter.launch({ address: 0x1000n, args: [1n], heap: [item] });
  const canonicalInput = adapter.sandbox.canonicalInput;
  assert.deepEqual(reads, { address: 1, size: 1, value: 1 });
  assert.deepEqual(canonicalInput.heap, [{ address: (0x620000000020n).toString(), size: 1, value: '1' }]);
  assert.deepEqual([...await adapter.readMemory(0x620000000020n, 1)], [1]);
}

// End-to-end public traceFunction(): evidence input is the canonical launch
// state, while schema-foreign raw launch input fails before execution.
{
  const { RuntimeAnalysisPlatform } = await import('../js/runtime/index.js');
  const localIO = { program: async () => null, fetch: async () => null };
  const platform = new RuntimeAnalysisPlatform({ localIO, symbolic: false });
  const session = await platform.startSession({ binaryHash: 'trace-e2e' });
  try {
    await assert.rejects(
      platform.traceFunction(0x1000n, { launch: { args: [true] } }),
      /bigint|safe integer|numeric string/,
    );
    const result = await platform.traceFunction(0x1800n, {
      maxSteps: 10, objectAsArg0: false, launch: { args: [2] },
    });
    const evidenceInput = result.evidence[0].input;
    assert.ok(evidenceInput && Array.isArray(evidenceInput.args));
    assert.equal(evidenceInput.args[0], '2');
  } finally {
    await platform.sessions.close(session.id);
  }
}

// End-to-end public runExperiment(): canonicalizable manual input publishes the
// executed canonical state, and invalid structured input remains fail-closed.
{
  const { RuntimeAnalysisPlatform } = await import('../js/runtime/index.js');
  const localIO = { program: async () => null, fetch: async () => null };
  const platform = new RuntimeAnalysisPlatform({ localIO, symbolic: false });
  const session = await platform.startSession({ binaryHash: 'run-e2e' });
  try {
    const manualExperiment = {
      id: 'manual-case-e2e', functionAddress: 0x1800n,
      cases: [{
        id: 'manual-case-e2e:c1', input: { arguments: [7, '0x8'] },
        initialState: { objectBase: 0x600000001000n, fields: [] }, watch: [], expected: null,
      }],
    };
    const run = await platform.runExperiment(manualExperiment, { maxSteps: 10 });
    const evidenceRecord = run.evidence.find((e) => e != null);
    assert.ok(evidenceRecord);
    assert.deepEqual((evidenceRecord.input?.args || []).map(String), ['7', '8']);

    const invalidExperiment = {
      id: 'manual-case-invalid', functionAddress: 0x1800n,
      cases: [{
        id: 'manual-case-invalid:c1', input: { arguments: [true] },
        initialState: { objectBase: 0x600000001000n, fields: [] }, watch: [], expected: null,
      }],
    };
    const invalidRun = await platform.runExperiment(invalidExperiment, { maxSteps: 10 });
    const invalidCase = invalidRun.cases?.[0];
    assert.ok(invalidCase == null || ['exception', 'unsupported', 'fault'].includes(invalidCase.observation?.stop?.kind));
  } finally {
    await platform.sessions.close(session.id);
  }
}

console.log('issue #5272 sandbox strict scalar boundary regression: PASS');
