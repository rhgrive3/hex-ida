import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createCorpusCase } from '../../tools/validation/machine-effects/oracle-schema.mjs';
import { createReferenceOracle } from '../../tools/validation/machine-effects/oracle-runner.mjs';
import { observeRv64RegisterPrefix } from '../../tools/validation/machine-effects/production-subject.mjs';
import { minimizeRv64SequenceMismatch } from '../../tools/validation/machine-effects/minimize-sequence-mismatch.mjs';
import { INDEPENDENT_ORACLE_CASE_FIXTURES } from './fixtures/independent-oracle-cases.mjs';

async function sequence() {
  const fixture = INDEPENDENT_ORACLE_CASE_FIXTURES.find(row => row.architecture === 'riscv64');
  const oracle = createReferenceOracle({ identity: fixture.oracleIdentity, version: fixture.oracleVersion,
    provenance: fixture.provenance, toolchainIdentity: fixture.provenance.toolchainIdentity });
  const out = [];
  for (const [destination, lhs, rhs] of [['x6', 'x1', 'x1'], ['x5', 'x1', 'x2'],
    ['x7', 'x1', 'x1'], ['x6', 'x1', 'x1']]) {
    const row = structuredClone(fixture);
    row.initialState.registers = { x1: '0x5', x2: '0x3', x5: '0x0', x6: '0x0', x7: '0x0' };
    row.definedMask.registers = { x5: '0xffffffffffffffff' };
    row.operation = { ...row.operation, destination, lhs, rhs };
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE((Number(rhs.slice(1)) << 20) | (Number(lhs.slice(1)) << 15)
      | (Number(destination.slice(1)) << 7) | 0x33);
    row.instructionBytes = bytes.toString('hex');
    row.expectedState = (await oracle.evaluate(row)).state;
    out.push(createCorpusCase(row));
  }
  return out;
}

test('correct production sequence is compared without exposing expected values to the subject', async () => {
  const corpusCases = await sequence();
  let calls = 0;
  const result = await minimizeRv64SequenceMismatch({ corpusCases, subject(instructions, options) {
    calls++;
    assert.deepEqual(Object.keys(options).sort(), ['initialRegisters', 'signal']);
    for (const instruction of instructions) assert.deepEqual(Object.keys(instruction).sort(), ['address', 'rawBytes']);
    return observeRv64RegisterPrefix(instructions, options);
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'not-mismatch');
  assert.equal(result.minimality, 'not-established');
  assert.equal(result.corpusCases, null);
  assert.equal(result.passContribution, 0);
});

test('sequence schema, model identity, masks and RV64 instruction binding cannot drift', async () => {
  const corpusCases = await sequence();
  for (const count of [0, 33]) await assert.rejects(minimizeRv64SequenceMismatch({
    corpusCases: Array.from({ length: count }, () => corpusCases[0]),
  }), /instruction-budget/);
  for (const key of ['instructionBytes', 'initialState', 'oracleVersion', 'generatorVersion', 'expectedOutcome']) {
    const changed = structuredClone(corpusCases);
    if (key === 'instructionBytes') changed[0][key] = '33831040'; // SUB cannot use the ADD reference.
    if (key === 'initialState') changed[0][key].registers.x1 = '0x0';
    if (key === 'oracleVersion') changed[0][key] = 'different';
    if (key === 'generatorVersion') changed[0][key] = 'different';
    if (key === 'expectedOutcome') changed[0][key].code = 'different';
    await assert.rejects(minimizeRv64SequenceMismatch({ corpusCases: changed }), /stale-identity/);
    delete changed[0].caseId; changed[0] = createCorpusCase(changed[0]);
    await assert.rejects(minimizeRv64SequenceMismatch({ corpusCases: changed }), /bytes-model-mismatch|contract-drift/);
  }
  for (const change of [{ widthBits: 32 }, { carryIn: 1 }, { setsFlags: true }]) {
    const changed = structuredClone(corpusCases);
    delete changed[0].caseId; Object.assign(changed[0].operation, change);
    changed[0] = createCorpusCase(changed[0]);
    await assert.rejects(minimizeRv64SequenceMismatch({ corpusCases: changed }), /register-add-required/);
  }
});

test('a new case identity cannot bless a forged expected artifact', async () => {
  const corpusCases = structuredClone(await sequence());
  delete corpusCases[1].caseId;
  corpusCases[1].expectedState.registers.x5 = '0x2';
  corpusCases[1] = createCorpusCase(corpusCases[1]);
  let calls = 0;
  const result = await minimizeRv64SequenceMismatch({ corpusCases, subject() { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'reference-artifact-mismatch');
  assert.equal(result.corpusCases, null);
});

test('production observations must bind the actual bytes, entry state and current subject contract', async () => {
  const corpusCases = await sequence();
  for (const alteration of ['bytes', 'entry', 'digest', 'version', 'scope', 'assignments']) {
    const result = await minimizeRv64SequenceMismatch({ corpusCases, subject(instructions, options) {
      const changed = structuredClone(instructions), registers = { ...options.initialRegisters };
      if (alteration === 'bytes') changed[0].rawBytes[2] ^= 0x30;
      if (alteration === 'entry') registers.x1 = '0x1';
      const observed = observeRv64RegisterPrefix(changed, { ...options, initialRegisters: registers });
      assert.equal(observed.status, 'observed');
      if (alteration === 'digest') return { ...observed, inputDigest: `sha256:${'0'.repeat(64)}` };
      if (alteration === 'version') return { ...observed, subjectVersion: 'other' };
      if (alteration === 'scope') return { ...observed, scope: 'other' };
      if (alteration === 'assignments') return { ...observed, assignments: [] };
      return observed;
    } });
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.reason, 'subject-input-binding-mismatch', alteration);
    assert.equal(result.minimality, 'not-established');
  }
});

test('cancellation, deadline and comparison limits cannot publish a minimum', async () => {
  const corpusCases = await sequence(), controller = new AbortController(); controller.abort();
  const cancelled = await minimizeRv64SequenceMismatch({ corpusCases, signal: controller.signal,
    subject() { throw new Error('must-not-run'); } });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.comparisons, 0);
  const stalled = await minimizeRv64SequenceMismatch({ corpusCases, timeoutMs: 10, subject: () => new Promise(() => {}) });
  assert.equal(stalled.status, 'resource-limited');
  assert.equal(stalled.minimality, 'not-established');
  for (const options of [{ maxComparisons: 0 }, { maxComparisons: 4097 }, { timeoutMs: 0 }]) {
    await assert.rejects(minimizeRv64SequenceMismatch({ corpusCases, ...options }), /invalid-budget/);
  }
});

test('actual ADD-to-SUB producer mutation reduces an instruction sequence and replays its counterexample', async () => {
  const corpusCases = await sequence();
  const target = new URL('../../js/targets/architecture/riscv64/effects/integer.js', import.meta.url).href;
  const moduleUrl = new URL('../../tools/validation/machine-effects/', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    let mutated = false;
    registerHooks({load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if(url !== ${JSON.stringify(target)}) return result;
      const before = "  add: 'add', sub: 'sub', and: 'and', or: 'or', xor: 'xor',";
      const source = String(result.source); assert.equal(source.split(before).length, 2);
      mutated = true;
      return {...result,source:source.replace(before,before.replace("add: 'add'", "add: 'sub'"))};
    }});
    const {minimizeRv64SequenceMismatch} = await import(${JSON.stringify(moduleUrl + 'minimize-sequence-mismatch.mjs')});
    const {observeRv64RegisterPrefix} = await import(${JSON.stringify(moduleUrl + 'production-subject.mjs')});
    const {createCorpusCase} = await import(${JSON.stringify(moduleUrl + 'oracle-schema.mjs')});
    const {createReferenceOracle} = await import(${JSON.stringify(moduleUrl + 'oracle-runner.mjs')});
    const corpusCases = ${JSON.stringify(corpusCases)};
    let baselineSubjectCalls=0;
    const result = await minimizeRv64SequenceMismatch({corpusCases,subject(instructions,options) {
      baselineSubjectCalls++;return observeRv64RegisterPrefix(instructions,options);
    }});
    assert.equal(mutated,true);
    assert.equal(result.status,'minimized',JSON.stringify(result));
    assert.equal(result.minimality,'single-instruction-deletion-fixed-point');
    assert.deepEqual(result.retainedIndices,[1]);
    assert.equal(result.comparison.expectedState.registers.x5,'0x0000000000000008');
    assert.equal(result.comparison.observedState.registers.x5,'0x0000000000000002');
    assert.equal(result.passContribution,0);
    assert.ok(result.steps.length>0);
    assert.notEqual(result.sequenceId,result.originalSequenceId);
    assert.deepEqual(result.corpusCases[0],corpusCases[1]);
    assert.ok(Object.isFrozen(result.comparison.observedState.registers));
    assert.deepEqual(await minimizeRv64SequenceMismatch({corpusCases}),result);
    const replay=await minimizeRv64SequenceMismatch({corpusCases:result.corpusCases});
    assert.equal(replay.status,'minimized');
    assert.equal(replay.corpusCases.length,1);
    const limited=await minimizeRv64SequenceMismatch({corpusCases,maxComparisons:1});
    assert.equal(limited.status,'resource-limited');
    assert.deepEqual(limited.retainedIndices,[0,1,2,3]);
    assert.equal(limited.minimality,'not-established');
    for(const failure of ['unknown','missing','exception','different-observable']) {
      let calls=0;
      const stopped=await minimizeRv64SequenceMismatch({corpusCases,subject(instructions,options) {
        const observed=observeRv64RegisterPrefix(instructions,options);
        if(++calls===1)return observed;
        if(failure==='unknown')return {status:'unsupported'};
        if(failure==='exception')throw new Error('unavailable');
        if(failure==='missing')return {...observed,observables:{}};
        // Change only an unobserved register, and restore the compared x5.
        return {...observed,observables:{...observed.observables,'register:x5':'0x0000000000000008'}};
      }});
      assert.equal(stopped.minimality,'not-established');
      assert.notEqual(stopped.status,'minimized');
      assert.deepEqual(stopped.retainedIndices,[0,1,2,3]);
    }
    let calls=0;
    const lost=await minimizeRv64SequenceMismatch({corpusCases,subject(instructions,options) {
      if(++calls===baselineSubjectCalls)return {status:'unsupported'};
      return observeRv64RegisterPrefix(instructions,options);
    }});
    assert.equal(lost.status,'inconclusive');
    assert.equal(lost.reason,'final-counterexample-not-reproduced');
    assert.equal(lost.minimality,'not-established');
    // Both instructions are necessary: the first creates the corrupted x6,
    // and the second transfers it to the sole compared observable x5.
    const dependent=[];
    const template=corpusCases[0];
    const oracle=createReferenceOracle({identity:template.oracleIdentity,version:template.oracleVersion,
      provenance:template.provenance,toolchainIdentity:template.provenance.toolchainIdentity});
    for(const [destination,lhs,rhs] of [['x6','x1','x2'],['x5','x6','x1'],['x7','x1','x1']]) {
      const row=structuredClone(template);delete row.caseId;
      row.initialState.registers.x1='0x0000000000000000';
      Object.assign(row.operation,{destination,lhs,rhs});
      const bytes=Buffer.alloc(4);
      bytes.writeUInt32LE((Number(rhs.slice(1))<<20)|(Number(lhs.slice(1))<<15)|(Number(destination.slice(1))<<7)|0x33);
      row.instructionBytes=bytes.toString('hex');row.expectedState=(await oracle.evaluate(row)).state;
      dependent.push(createCorpusCase(row));
    }
    const chain=await minimizeRv64SequenceMismatch({corpusCases:dependent});
    assert.equal(chain.status,'minimized');assert.deepEqual(chain.retainedIndices,[0,1]);
    assert.equal(chain.comparison.expectedState.registers.x5,'0x0000000000000003');
    assert.equal(chain.comparison.observedState.registers.x5,'0xfffffffffffffffd');
    for(const row of chain.corpusCases) {
      const alone=await minimizeRv64SequenceMismatch({corpusCases:[row]});
      assert.equal(alone.status,'not-mismatch');
    }
    // The target and mask stay fixed, but deleting a write legitimately
    // changes both the fresh reference value and the reproduced wrong value.
    const changing=[];
    for(const [destination,lhs,rhs] of [['x5','x1','x2'],['x5','x5','x2']]) {
      const row=structuredClone(template);delete row.caseId;
      Object.assign(row.operation,{destination,lhs,rhs});
      const bytes=Buffer.alloc(4);
      bytes.writeUInt32LE((Number(rhs.slice(1))<<20)|(Number(lhs.slice(1))<<15)|(Number(destination.slice(1))<<7)|0x33);
      row.instructionBytes=bytes.toString('hex');row.expectedState=(await oracle.evaluate(row)).state;
      changing.push(createCorpusCase(row));
    }
    const values=await minimizeRv64SequenceMismatch({corpusCases:changing});
    assert.equal(values.status,'minimized');assert.deepEqual(values.retainedIndices,[1]);
    assert.equal(values.comparison.expectedState.registers.x5,'0x0000000000000003');
    assert.equal(values.comparison.observedState.registers.x5,'0xfffffffffffffffd');
    const controller=new AbortController();calls=0;
    const cancelled=await minimizeRv64SequenceMismatch({corpusCases,signal:controller.signal,subject(instructions,options) {
      const observation=observeRv64RegisterPrefix(instructions,options);
      if(++calls===2)controller.abort();return observation;
    }});
    assert.equal(cancelled.status,'cancelled');assert.deepEqual(cancelled.retainedIndices,[0,1,2,3]);
    assert.equal(cancelled.minimality,'not-established');
    const nowDescriptor=Object.getOwnPropertyDescriptor(performance,'now');let elapsed=0;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>elapsed});
    try {
      const timed=await minimizeRv64SequenceMismatch({corpusCases,timeoutMs:100,subject(instructions,options) {
        const observed=observeRv64RegisterPrefix(instructions,options);elapsed+=101;return observed;
      }});
      assert.equal(timed.status,'resource-limited');assert.equal(timed.minimality,'not-established');
    } finally { if(nowDescriptor)Object.defineProperty(performance,'now',nowDescriptor);else delete performance.now; }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, env: process.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
