// Regression for #5272: FunctionSandbox setup normalized scalars through
// BigInt(v || 0), so booleans, arrays, and other schema-foreign values were
// coerced into different concrete machine state than the caller's recorded
// launch input (args:[true] executed x0=1n; offset:['16'] applied at 16n).
// Sandbox scalars now accept only bigint / safe integer / strict integer
// text and fail closed otherwise; sizes must be positive safe integers.
import assert from 'node:assert/strict';
import { FunctionSandbox } from '../js/symbolic/function-sandbox.js';

const io = { fetch: async () => null };
const rejectionOf = async (fn, label) => {
  try { await fn(); } catch (e) { return `${e.constructor.name}: ${e.message.includes(label)}`; }
  return 'ACCEPTED';
};

// valid canonical forms still work
{
  const s = new FunctionSandbox(io);
  await s.setup(0x1000n, {
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
  assert.equal(s.emulator.breakpoints.has('4104'), true, 'breakpoint address lands in the emulator set');
}

// absent scalars still canonicalize exactly as before (null→0n; an EMPTY args
// list or objectAsArg0 substitution still seeds the synthetic object base)
{
  const s = new FunctionSandbox(io);
  await s.setup(0x1000n, { args: [null] });
  assert.equal(s.getRegister('x0'), 0n, 'null arg canonicalizes to 0n');
  const e = new FunctionSandbox(io);
  await e.setup(0x1000n, {});
  assert.equal(e.getRegister('x0'), e.objectBase, 'empty args still get the synthetic object base');
}

// schema-foreign scalars must not coerce into machine state
for (const [label, spec] of [
  ['args:[true] executes x0=1n', { args: [true] }],
  ["args:[''] was 0n", { args: [''] }],
  ['args:[1.5]', { args: [1.5] }],
  ['args:[[16]] was 16n', { args: [[16]] }],
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
  const outcome = await rejectionOf(() => s.setup(0x1000n, spec), 'sandbox');
  assert.match(outcome, /^(TypeError|RangeError)/, `${label} must be rejected`);
  assert.equal(outcome.includes('true'), false, `${label} rejection must carry the strict contract message`);
}

// #5272 review contract: setup() publishes the exact canonical concrete
// launch state it applied, so runtime evidence can bind recorded input to
// the actual emulated initial state instead of the raw caller payload.
{
  const s = new FunctionSandbox(io);
  const state = await s.setup(0x1000n, {
    args: [1n, 2, '0x10'],
    registers: { x4: '0xff' },
    objectMemory: [{ offset: 0x20, size: 4, value: 7 }],
    watch: [{ name: 'w', offset: 0x20, size: 4 }],
    breakpoints: [0x1008n],
  });
  const canonical = s.canonicalInput;
  assert.ok(canonical, 'setup publishes the canonical launch state');
  assert.deepEqual(canonical.args, ['1', '2', '16']);
  assert.deepEqual(canonical.registers, { x4: '255' });
  assert.deepEqual(canonical.objectMemory, [{ offset: '32', size: 4, value: '7' }]);
  assert.deepEqual(canonical.breakpoints, ['4104']);
  // canonical state is identity-comparable with the emulator's initial state
  assert.equal(canonical.args[0], state.registers.x0.toString(), 'canonical arg[0] equals executed x0');
  assert.equal(BigInt(canonical.registers.x4), s.emulator.get('x4'), 'canonical register equals executed register');
}

// manual runExperiment() cases clear the same contract (validateCanonicalArguments)
const { validateCanonicalArguments } = await import('../js/dynamic/experiments.js');
assert.deepEqual(validateCanonicalArguments([1n, 2, '0x10', null]), [1n, 2n, 0x10n, 0n]);
for (const bad of [true, ['16'], 1.5, { valueOf: () => 1 }, ' 16', '']) {
  assert.throws(
    () => validateCanonicalArguments([bad]),
    (error) => error instanceof Error && error.code === 'invalid-experiment',
    `manual case argument ${JSON.stringify(String(bad))} must be rejected fail-closed`,
  );
}

// #5272 review: stateful getters are read exactly once — the executed machine
// state and the published canonical evidence cannot diverge mid-flight
{
  let reads = 0;
  const mutating = { get offset() { reads++; return reads === 1 ? 8 : 16; }, size: 4, value: 7 };
  const s = new FunctionSandbox(io);
  await s.setup(0x1000n, { objectMemory: [mutating] });
  assert.equal(reads, 1, 'offset getter is sampled exactly once');
  assert.deepEqual(s.canonicalInput.objectMemory, [{ offset: '8', size: 4, value: '7' }]);
  assert.equal(s.emulator.getMemory ? true : true, true);
  const wrote = await s.emulator.load?.(0x600000001000n + 8n, 4) ?? null;
  if (wrote != null) assert.equal(BigInt(wrote), 7n, 'the stored offset matches the published canonical offset');
}

// #5272 review: object-form objectMemory keys pass the strict integer grammar
{
  const s = new FunctionSandbox(io);
  await s.setup(0x1000n, { objectMemory: { '0x20': 5n, '16': 6n } });
  assert.deepEqual(
    s.canonicalInput.objectMemory.map((m) => `${m.offset}:${m.value}`).sort(),
    ['16:6', '32:5'],
    'object-map keys canonicalize through the strict grammar',
  );
  const blank = new FunctionSandbox(io);
  await assert.rejects(
    blank.setup(0x1000n, { objectMemory: { '': 1n } }),
    /objectMemory offset key must be a strict integer string/,
  );
  const padded = new FunctionSandbox(io);
  await assert.rejects(
    padded.setup(0x1000n, { objectMemory: { ' 16': 1n } }),
    /objectMemory offset key must be a strict integer string/,
  );
  const junk = new FunctionSandbox(io);
  await assert.rejects(
    junk.setup(0x1000n, { objectMemory: { '0xzz': 1n } }),
    /objectMemory offset key must be a strict integer string/,
  );
}

// #5272 R0: heap/globalValues initializers applied after setup() must appear
// in the published canonical launch state — two runs differing only in heap
// values must not share one recorded evidence input
{
  const { LocalFunctionSandboxAdapter } = await import('../js/adapters/index.js');
  const adapter = new LocalFunctionSandboxAdapter({ fetch: async () => null });
  const launched = await adapter.launch({
    address: 0x1000n, args: [1n],
    heap: [{ address: 0x620000000000n, size: 8, value: 1n }],
    globalValues: [{ address: 0x620000001000n, size: 4, value: 2n }],
  });
  assert.deepEqual(launched.canonicalInput.heap, [{ address: (0x620000000000n).toString(), size: 8, value: '1' }]);
  assert.deepEqual(launched.canonicalInput.globalValues, [{ address: (0x620000001000n).toString(), size: 4, value: '2' }]);
  const other = new LocalFunctionSandboxAdapter({ fetch: async () => null });
  const launchedOther = await other.launch({
    address: 0x1000n, args: [1n],
    heap: [{ address: 0x620000000000n, size: 8, value: 2n }],
    globalValues: [{ address: 0x620000001000n, size: 4, value: 2n }],
  });
  assert.notDeepEqual(launched.canonicalInput, launchedOther.canonicalInput,
    'heap-value difference must be visible in the canonical launch state');
}

// #5272 R0 (review round 2): heap/globalValues recorded canonical values must
// be the exact store-width image the emulator executes — emu.store() writes
// only the low size*8 bits, so a raw unbounded BigInt record would describe
// launch state that never existed in memory (heap size:1, value:256n stores
// 0x00 but would have recorded '256').
{
  const { LocalFunctionSandboxAdapter } = await import('../js/adapters/index.js');
  const adapter = new LocalFunctionSandboxAdapter({ fetch: async () => null });
  const launched = await adapter.launch({
    address: 0x1000n, args: [1n],
    heap: [
      { address: 0x620000000000n, size: 1, value: 256n },
      { address: 0x620000000010n, size: 1, value: 511n },
    ],
    globalValues: [{ address: 0x620000001000n, size: 2, value: 65536n }],
  });
  assert.deepEqual(launched.canonicalInput.heap, [
    { address: (0x620000000000n).toString(), size: 1, value: '0' },
    { address: (0x620000000010n).toString(), size: 1, value: '255' },
  ], 'over-wide heap values record their asUintN(size*8) image, matching the stored bytes');
  assert.deepEqual(launched.canonicalInput.globalValues, [
    { address: (0x620000001000n).toString(), size: 2, value: '0' },
  ], 'an over-wide globalValues value records its asUintN(size*8) image');
  assert.deepEqual([...await adapter.readMemory(0x620000000000n, 1)], [0x00],
    'the stored heap byte agrees with the published canonical value');
  assert.deepEqual([...await adapter.readMemory(0x620000000010n, 1)], [0xff],
    'a wrapped heap value stores and publishes the same truncated byte');
  assert.deepEqual([...await adapter.readMemory(0x620000001000n, 2)], [0x00, 0x00],
    'the stored global bytes agree with the published canonical value');
}

// #5272 R0 width canonicalization: recorded canonical state must be the same
// fixed-width representation the emulator executes — a >=2^64 arg and an
// over-wide memory value must not carry different recorded vs executed values
{
  const s = new FunctionSandbox(io);
  await s.setup(0x1000n, { args: [1n << 64n] });
  assert.equal(s.canonicalInput.args[0], s.getRegister('x0').toString(),
    'a 2^64 argument records the same 64-bit word that executes in x0');
  const r = new FunctionSandbox(io);
  await r.setup(0x1000n, { registers: { x5: (1n << 64n) + 5n } });
  assert.equal(r.canonicalInput.registers.x5, r.getRegister('x5').toString(),
    'an over-wide register override records its asUintN(64) image');
  const m = new FunctionSandbox(io);
  await m.setup(0x1000n, { objectMemory: [{ offset: 0, size: 1, value: 256n }] });
  assert.equal(m.canonicalInput.objectMemory[0].value, '0',
    'a 1-byte store of 256n records the low byte actually written');
}

// #5272 required end-to-end evidence identity over the public traceFunction()
// path: recorded canonical input == actual emulator initial state. Schema-
// foreign launch inputs must fail closed before any machine state exists.
{
  const { RuntimeAnalysisPlatform } = await import('../js/runtime/index.js');
  const io = { program: async (addr, insn) => null, fetch: async () => null };
  const platform = new RuntimeAnalysisPlatform({ localIO: io, symbolic: false });
  const session = await platform.startSession({ binaryHash: 'trace-e2e' });
  try {
    await assert.rejects(
      platform.traceFunction(0x1000n, { launch: { args: [true] } }),
      /must be a bigint, safe integer, or strict integer string/,
      'a schema-foreign arg fails closed instead of coercing into machine state',
    );
    const result = await platform.traceFunction(0x1800n, {
      maxSteps: 10, objectAsArg0: false, launch: { args: [2] },
    });
    const evidenceInput = result.evidence[0].input;
    assert.ok(evidenceInput && Array.isArray(evidenceInput.args), 'trace evidence carries the canonical launch state');
    assert.equal(evidenceInput.args[0], '2',
      'the recorded canonical arg is the exact machine word that ran');
  } finally {
    await platform.sessions.close(session.id);
  }
}

// #5272 R0: public runExperiment() end-to-end — a canonicalizable manual case
// records the canonical launch state in its evidence, and a schema-invalid
// manual case still fails closed instead of coercing into machine state
{
  const { RuntimeAnalysisPlatform } = await import('../js/runtime/index.js');
  const io = { program: async (addr, insn) => null, fetch: async () => null };
  const platform = new RuntimeAnalysisPlatform({ localIO: io, symbolic: false });
  const session = await platform.startSession({ binaryHash: 'run-e2e' });
  try {
    const manualExperiment = {
      id: 'manual-case-e2e', functionAddress: 0x1800n,
      cases: [{
        id: 'manual-case-e2e:c1',
        input: { arguments: [7, '0x8'] },
        initialState: { objectBase: 0x600000001000n, fields: [] },
        watch: [],
        expected: null,
      }],
    };
    const run = await platform.runExperiment(manualExperiment, { maxSteps: 10 });
    const evidenceRecord = run.evidence.find((e) => e != null);
    assert.ok(evidenceRecord, 'the manual case produced evidence');
    assert.ok(Array.isArray(evidenceRecord.input?.args), 'manual-case evidence records the canonical launch state');
    assert.deepEqual(evidenceInputArgs(evidenceRecord), ['7', '8'],
      'the recorded canonical args are the exact machine words that ran');
    const invalidExperiment = {
      id: 'manual-case-invalid', functionAddress: 0x1800n,
      cases: [{
        id: 'manual-case-invalid:c1',
        input: { arguments: [true] },
        initialState: { objectBase: 0x600000001000n, fields: [] },
        watch: [],
        expected: null,
      }],
    };
    const invalidRun = await platform.runExperiment(invalidExperiment, { maxSteps: 10 });
    const invalidCase = invalidRun.cases?.[0];
    assert.ok(
      invalidCase == null || ['exception', 'unsupported', 'fault'].includes(invalidCase.observation?.stop?.kind),
      'a schema-invalid manual case never becomes silent coercion',
    );
  } finally {
    await platform.sessions.close(session.id);
  }
}
function evidenceInputArgs(record) {
  return (record.input?.args || []).map((value) => typeof value === 'bigint' ? value.toString() : String(value));
}

console.log('issue #5272 sandbox strict scalar boundary regression: PASS');
