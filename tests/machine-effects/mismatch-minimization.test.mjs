import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createCorpusCase } from '../../tools/validation/machine-effects/oracle-schema.mjs';
import { runIndependentComparison } from '../../tools/validation/machine-effects/oracle-runner.mjs';
import { observeRv64CorpusCase, observeRv64RegisterPrefix } from '../../tools/validation/machine-effects/production-subject.mjs';
import { minimizeMachineEffectsMismatch } from '../../tools/validation/machine-effects/minimize-mismatch.mjs';
import { INDEPENDENT_ORACLE_CASE_FIXTURES } from './fixtures/independent-oracle-cases.mjs';

const corpusCase = createCorpusCase(INDEPENDENT_ORACLE_CASE_FIXTURES.find(row => row.architecture === 'riscv64'));
const instruction = [{ address: '0x1000', rawBytes: [0xb3, 0x82, 0x20, 0] }];

test('entry-state RV64 subject computes the independent fixture without reading expected state', async () => {
  const input = structuredClone(corpusCase);
  Object.defineProperty(input, 'expectedState', { get() { throw new Error('subject-read-expected-state'); } });
  Object.defineProperty(input, 'operation', { get() { throw new Error('subject-read-oracle-operation'); } });
  const actual = observeRv64CorpusCase({ caseValue: input });
  assert.equal(actual.state.registers.x5, '0x8000000000000000');
  assert.equal(actual.state.registers.x1, corpusCase.initialState.registers.x1);
  assert.equal((await runIndependentComparison({ corpusCase, subject: observeRv64CorpusCase })).status, 'exact/equivalent');
});

test('entry-register identity binds values and rejects aliases, accessors and overflow', () => {
  const left = observeRv64RegisterPrefix(instruction, { initialRegisters: { x1: '0x5', x2: '0x3' } });
  const right = observeRv64RegisterPrefix(instruction, { initialRegisters: { x1: '0x1', x2: '0x3' } });
  assert.equal(left.observables['register:x5'], '0x0000000000000008');
  assert.equal(right.observables['register:x5'], '0x0000000000000004');
  assert.notEqual(left.inputDigest, right.inputDigest);
  assert.equal(left.inputDigest, observeRv64RegisterPrefix(instruction, { initialRegisters: { x2: '0x03', x1: '0x05' } }).inputDigest);
  for (const initialRegisters of [{ x1: '0x10000000000000000' }, { x0: '0x0' }, { a0: '0x1' },
    { x1: 1n }, { get x1() { throw new Error('must-not-run'); } }]) {
    const observed = observeRv64RegisterPrefix(instruction, { initialRegisters });
    assert.notEqual(observed.status, 'observed');
    assert.deepEqual(observed.observables, {});
  }
  assert.notEqual(observeRv64RegisterPrefix(instruction, { initialRegisters: { x1: '0x5' } }).status, 'observed');
});

test('a correct subject produces no counterexample and no minimization claim', async () => {
  const result = await minimizeMachineEffectsMismatch({ corpusCase, subject: observeRv64CorpusCase });
  assert.equal(result.status, 'not-mismatch');
  assert.equal(result.caseValue, null);
  assert.equal(result.minimality, 'not-established');
  assert.equal(result.comparisons, 1);
  assert.equal(result.passContribution, 0);
});

test('pre-cancelled and stalled subjects cannot publish a minimum', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const cancelled = await minimizeMachineEffectsMismatch({ corpusCase, signal: controller.signal,
    subject: () => { calls++; throw new Error('must-not-call'); } });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(calls, 0);
  const timed = await minimizeMachineEffectsMismatch({ corpusCase, timeoutMs: 10,
    subject: () => new Promise(() => {}) });
  assert.equal(timed.status, 'resource-limited');
  assert.equal(timed.caseValue, null);
  assert.equal(timed.minimality, 'not-established');
});

test('invalid resource limits and stale case identity are rejected', async () => {
  for (const options of [{ maxComparisons: 0 }, { maxComparisons: 4097 }, { timeoutMs: 0 }]) {
    await assert.rejects(minimizeMachineEffectsMismatch({ corpusCase, subject: observeRv64CorpusCase, ...options }), /invalid-budget/);
  }
  const stale = structuredClone(corpusCase); stale.initialState.registers.x1 = '0x0';
  await assert.rejects(minimizeMachineEffectsMismatch({ corpusCase: stale, subject: observeRv64CorpusCase }), /stale-identity/);
});

test('unsupported production effects cannot be classified as absence of a mismatch', async () => {
  const input = structuredClone(corpusCase);
  delete input.caseId;
  input.instructionBytes = '83b20000'; // LD x5,0(x1): memory is outside this subject.
  const changed = createCorpusCase(input);
  const observation = observeRv64CorpusCase({ caseValue: changed });
  assert.equal(observation.outcome.kind, 'unsupported');
  assert.equal(observation.state, null);
  const compared = await runIndependentComparison({ corpusCase: changed, subject: observeRv64CorpusCase });
  assert.equal(compared.status, 'partial', 'existing runner requires a state before classifying an outcome');
  const minimized = await minimizeMachineEffectsMismatch({ corpusCase: changed, subject: observeRv64CorpusCase });
  assert.equal(minimized.status, 'inconclusive');
  assert.equal(minimized.caseValue, null);
  assert.equal(minimized.minimality, 'not-established');
});

test('real producer ADD-to-SUB mutation is minimized through independent re-execution', () => {
  const target = new URL('../../js/targets/architecture/riscv64/effects/integer.js', import.meta.url).href;
  const moduleUrl = new URL('../../tools/validation/machine-effects/', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    let mutated = false;
    registerHooks({ load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== ${JSON.stringify(target)}) return result;
      const before = "  add: 'add', sub: 'sub', and: 'and', or: 'or', xor: 'xor',";
      const source = String(result.source);
      assert.equal(source.split(before).length, 2);
      mutated = true;
      return { ...result, source: source.replace(before, before.replace("add: 'add'", "add: 'sub'")) };
    } });
    const { minimizeMachineEffectsMismatch } = await import(${JSON.stringify(moduleUrl + 'minimize-mismatch.mjs')});
    const { observeRv64CorpusCase } = await import(${JSON.stringify(moduleUrl + 'production-subject.mjs')});
    const { createCorpusCase, validateCorpusCase } = await import(${JSON.stringify(moduleUrl + 'oracle-schema.mjs')});
    const { runIndependentComparison, createReferenceOracle, productionSubjectObservation } = await import(${JSON.stringify(moduleUrl + 'oracle-runner.mjs')});
    const input = ${JSON.stringify(corpusCase)};
    delete input.caseId;
    input.initialState.registers.x2 = '0x0000000000000007';
    const oracle = createReferenceOracle({identity:input.oracleIdentity, version:input.oracleVersion,
      provenance:input.provenance, toolchainIdentity:input.provenance.toolchainIdentity});
    input.expectedState = (await oracle.evaluate(input)).state;
    const original = createCorpusCase(input);
    const result = await minimizeMachineEffectsMismatch({corpusCase:original, subject:observeRv64CorpusCase});
    assert.equal(mutated,true);
    assert.equal(result.status,'minimized');
    assert.equal(result.minimality,'single-bit-clearing-fixed-point');
    assert.equal(result.caseValue.initialState.registers.x1,'0x0000000000000000');
    assert.equal(result.caseValue.initialState.registers.x2,'0x0000000000000001');
    assert.equal(result.caseValue.expectedState.registers.x5,'0x0000000000000001');
    assert.equal(result.comparison.observedState.registers.x5,'0xffffffffffffffff');
    assert.ok(result.steps.length >= 3);
    assert.notEqual(result.caseValue.caseId,original.caseId);
    assert.deepEqual(validateCorpusCase(result.caseValue),result.caseValue);
    for(const key of ['instructionBytes','operation','definedMask','undefinedMask','unobservedMask','provenance'])
      assert.deepEqual(result.caseValue[key],original[key]);
    assert.equal((await runIndependentComparison({corpusCase:result.caseValue,subject:observeRv64CorpusCase})).status,'mismatch');
    const again = await minimizeMachineEffectsMismatch({corpusCase:original,subject:observeRv64CorpusCase});
    assert.deepEqual(again,result);
    const limited = await minimizeMachineEffectsMismatch({corpusCase:original,subject:observeRv64CorpusCase,maxComparisons:1});
    assert.equal(limited.status,'resource-limited');
    assert.equal(limited.caseValue.caseId,original.caseId);
    assert.equal(limited.minimality,'not-established');
    let count = 0;
    const unknown = await minimizeMachineEffectsMismatch({corpusCase:original,subject:context=>{
      if(++count===1)return observeRv64CorpusCase(context);
      return productionSubjectObservation({state:context.caseValue.initialState,outcome:{kind:'unsupported',code:'probe-unsupported'}});
    }});
    assert.equal(unknown.status,'inconclusive');
    assert.equal(unknown.caseValue.caseId,original.caseId);
    assert.equal(unknown.minimality,'not-established');
    const controller = new AbortController(); count = 0;
    const cancelled = await minimizeMachineEffectsMismatch({corpusCase:original,signal:controller.signal,subject:context=>{
      const observed=observeRv64CorpusCase(context);
      if(++count===2)controller.abort();
      return observed;
    }});
    assert.equal(cancelled.status,'cancelled');
    assert.equal(cancelled.caseValue.caseId,original.caseId);
    assert.equal(cancelled.steps.length,0);
    count = 0;
    const lost = await minimizeMachineEffectsMismatch({corpusCase:original,subject:context=>{
      if(++count===result.comparisons)return null;
      return observeRv64CorpusCase(context);
    }});
    assert.equal(lost.status,'inconclusive');
    assert.equal(lost.reason,'final-counterexample-not-reproduced');
    assert.equal(lost.minimality,'not-established');
    console.log('actual RV64 producer mismatch reduced to x1=0, x2=1; reference ADD=1, subject SUB=ffffffffffffffff');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});
