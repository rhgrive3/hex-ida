import assert from 'node:assert/strict';
import test from 'node:test';
import { symbolicExecute } from '../../../js/symbolic/executor.js';
import { evaluateExpr } from '../../../js/symbolic/expr/index.js';
import { isExecutionResult, isExecutionSnapshot } from '../../../js/symbolic/memory/execution-snapshot.js';
import { queryMemoryEquivalence } from '../../../js/symbolic/query/memory-equivalence.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { ARM64_ARCHITECTURE } from '../../../js/targets/architecture/index.js';
import { parseOperands } from '../../../js/arm64.js';
import { machineIR, partialStoreFixture, identity } from './main-fixtures.mjs';

const run = (ir, options = {}) => symbolicExecute(ir, { captureValues:true, timeoutMs:5000,
  byteMemory:{ identity, timeoutMs:5000 }, ...options });
const retOf = ir => ir.instructions.find(inst => inst.op === 'ret');
function mutableFaultIR(lines = ['mov x30, #4096', 'ret']) {
  const ir = machineIR(lines);
  retOf(ir).extra.attributes = structuredClone(retOf(ir).extra.attributes);
  return ir;
}
function attachTarget(ir, value = 0x1000n) {
  const ret = retOf(ir);
  ret.returnTargetValue = { id:'terminal-target', kind:'const', const:value, bits:64 };
  ret.extra = { ...ret.extra, returnControlTargetValueId:'original-target',
    returnControlTarget:{ schema:'semantic-return-control-target/v1', state:'resolved', valueId:'original-target' } };
  return ir;
}

test('canonical byte execution retains a separate ABI return and control target', () => {
  const ir = attachTarget(partialStoreFixture());
  const result = run(ir);
  assert.equal(result.status, 'complete', result.reason);
  const path = result.paths[0], control = path.terminalControl;
  assert.equal(path.returnValue.value, 0x1122aa44n);
  assert.equal(control.schemaVersion, 'hex-terminal-control/v1');
  assert.equal(control.scope, 'terminal-control-observation');
  assert.equal(control.sourceValueId, 'original-target', 'original semantic identity survives aliases');
  assert.equal(control.target.value, 0x1000n);
  assert.deepEqual(control.faults, []);
  assert.equal(control.normalCompletionCondition.value, true);
  assert.ok(Object.isFrozen(control) && Object.isFrozen(control.faults));
  assert.ok(path.snapshot.values.some(value => value.valueId === 'terminal-target' && value.expression === control.target));
  assert.ok(isExecutionResult(result, identity, ir));
});

test('actual A64 MOVZ/RET instruction words produce exact aligned and misaligned terminal predicates', () => {
  for (const address of [0x1000, 0x1001, 0x1002, 0x1003]) {
    const records = [
      { mnemonic:'movz', operands:`x30, #${address}`, instructionCode:(0xd2800000 | (address << 5) | 30) >>> 0 },
      { mnemonic:'ret', operands:'x30', instructionCode:0xd65f03c0 },
    ].map((record, index) => ({ ...record, address:0x4000n + BigInt(index * 4), size:4, length:4,
      mode:'a64', opStr:record.operands, ops:parseOperands(record.operands),
      rawBytes:Uint8Array.from([0, 8, 16, 24], shift => record.instructionCode >>> shift & 255) }));
    const result = buildSemanticV2CompatibilityPipeline({ architecturePlugin:ARM64_ARCHITECTURE,
      decoderSemanticVersion:'c4-terminal-a64-word-fixture', binaryId:'terminal-binary', sliceId:'terminal-slice',
      addressWidthBits:64, entryBlockKey:'entry', blocks:[{ key:'entry', startAddress:0x4000n,
        instructions:records.map(decoded => ({ decoded })), successors:[] }] });
    const ir = result.legacyV1;
    const execution = run(ir);
    assert.equal(execution.status, address % 4 === 0 ? 'complete' : 'partial', `${address}: ${execution.reason}`);
    assert.equal(execution.terminalControlCoverage, 'complete');
    const control = execution.terminalControlObservations[0].control;
    assert.equal(control.target.value, BigInt(address));
    assert.equal(control.faults.length, 1);
    assert.equal(control.faults[0].kind, 'pc-alignment-fault');
    assert.equal(control.faults[0].condition.value, address % 4 !== 0);
    assert.equal(control.normalCompletionCondition.value, address % 4 === 0);
    if (address % 4 === 0) assert.equal(execution.paths[0].returnValue, null, 'architectural target is not an ABI return');
    else assert.deepEqual(execution.paths, [], 'faulting return cannot issue a complete path');
  }
});

test('symbolic x30 retains both faulting and normal valuations without a guessed alignment', () => {
  const result = run(machineIR(['ret']));
  assert.equal(result.status, 'partial', result.reason);
  assert.equal(result.reason, 'return-control-normal-completion-unproved');
  assert.equal(result.terminalControlCoverage, 'complete');
  assert.deepEqual(result.paths, []);
  const control = result.terminalControlObservations[0].control;
  assert.equal(control.target.kind, 'fresh_symbol');
  assert.equal(result.terminalControlObservations[0].constraints.length, 0, 'normal return must not be assumed as a path condition');
  for (let value = 0n; value < 16n; value++) {
    const model = { [control.target.symbolId]:value };
    assert.equal(evaluateExpr(control.faults[0].condition, model).value, value % 4n !== 0n);
    assert.equal(evaluateExpr(control.normalCompletionCondition, model).value, value % 4n === 0n);
  }
});

test('a return target follows the selected predecessor and current SSA value', () => {
  // Parsed rows exercise production CFG/SSA/compat; these are not compiler evidence.
  const ir = machineIR(['cbz x0, #0x1010', 'mov x30, #4096', 'b #0x1014', 'nop', 'mov x30, #4097', 'ret']);
  const result = run(ir);
  assert.equal(result.status, 'partial', result.reason);
  assert.deepEqual(result.paths, []);
  assert.equal(result.terminalControlCoverage, 'complete');
  const observations = result.terminalControlObservations;
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map(item => item.control.target.value).sort(), [0x1000n, 0x1001n]);
  for (const observation of observations) {
    assert.equal(observation.constraints.length, 1);
    assert.equal(Object.hasOwn(observation, 'snapshot'), false);
    assert.equal(Object.hasOwn(observation, 'returnValue'), false);
    assert.equal(observation.control.normalCompletionCondition.value, observation.control.target.value === 0x1000n);
  }
});

test('missing, unavailable, contradictory and unknown explicit targets cannot issue complete paths', () => {
  for (const mutate of [
    ret => { delete ret.returnTargetValue; },
    ret => { delete ret.extra.returnControlTarget; },
    ret => { ret.extra.returnControlTarget.schema = 'future'; },
    ret => { ret.extra.returnControlTarget.state = 'unavailable'; },
    ret => { ret.extra.returnControlTargetValueId = 'foreign'; },
    ret => { ret.extra.returnControlTarget.extra = true; },
    ret => { ret.returnTargetValue = { id:'undefined', bits:64 }; },
    ret => { ret.returnTargetValue.machineType = { kind:'float', widthBits:64 }; },
    ret => { ret.extra.attributes = { machineControlEffect:{ kind:'fallthrough' } }; },
    ret => { ret.extra.attributes = { machineControlEffect:{ kind:'return' } }; },
    ret => { ret.extra.attributes = { machineControlEffect:{ kind:'return', target:{ kind:'other' } } }; },
  ]) {
    const ir = attachTarget(partialStoreFixture()); mutate(retOf(ir));
    const result = run(ir);
    assert.equal(result.status, 'partial');
    assert.equal(result.paths.length, 0);
  }
  const plain = run(partialStoreFixture());
  assert.equal(plain.status, 'complete');
  assert.equal(Object.hasOwn(plain.paths[0], 'terminalControl'), false);
});

test('unsupported faults and unbound fault channels stay explicit failures', () => {
  for (const mutate of [
    ret => { ret.extra.attributes.machineEffects.possibleFaults[0].kind = 'authentication-fault'; },
    ret => { ret.extra.attributes.machineEffects.possibleFaults[0].condition.alignmentBytes = 8; },
    ret => { ret.extra.attributes.machineEffects.possibleFaults[0].condition.guard = false; },
    ret => { ret.extra.attributes.machineEffects.possibleFaults[0].detail.instructionSet = 'other'; },
    ret => { ret.extra.attributes.machineEffects.mode = 'other'; },
    ret => { ret.extra.faults = ['trap']; },
    ret => { delete ret.extra.returnControlTarget; delete ret.returnTargetValue; delete ret.extra.returnControlTargetValueId; },
  ]) {
    const ir = mutableFaultIR(); mutate(retOf(ir));
    const result = run(ir);
    assert.equal(result.status, 'partial', result.reason);
    assert.equal(result.paths.length, 0);
  }
});

test('fault descriptor changes revoke both issued results and path snapshots', () => {
  for (const mutate of [
    machine => { machine.possibleFaults = []; },
    machine => { machine.possibleFaults[0].condition.alignmentBytes = 8; },
    machine => { machine.possibleFaults[0].condition.guard = true; },
    machine => { machine.possibleFaults[0].detail.architecture = 'other'; },
    machine => { machine.possibleFaults[0].kind = 'other'; },
    machine => { machine.mode = 'other'; },
    machine => { machine.possibleFaults.meta = 'changed'; },
  ]) {
    const ir = mutableFaultIR(), result = run(ir);
    assert.equal(result.status, 'complete', result.reason);
    const snapshot = result.paths[0].snapshot;
    mutate(retOf(ir).extra.attributes.machineEffects);
    assert.equal(isExecutionResult(result, identity, ir), false);
    assert.equal(isExecutionSnapshot(snapshot, identity, ir), false);
  }
});

test('incomplete exploration cannot claim complete terminal-control coverage', () => {
  const ir = machineIR(['cbz x0, #0x1010', 'mov x30, #4096', 'ret', 'nop', 'mov x30, #4097', 'ret']);
  const result = run(ir, { maxPaths:1 });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.paths, []);
  assert.notEqual(result.terminalControlCoverage, 'complete');
});

test('accessors, cancellation and budget exhaustion cannot publish terminal observations', () => {
  const ir = mutableFaultIR();
  Object.defineProperty(retOf(ir).extra.attributes.machineEffects.possibleFaults[0].condition, 'alignmentBytes', {
    get() { assert.fail('must not execute a fault accessor'); },
  });
  assert.equal(run(ir).status, 'partial');
  const limited = run(machineIR(['ret']), { byteMemory:{ identity, limits:{ workItems:1 } } });
  assert.equal(limited.status, 'partial');
  assert.equal(limited.paths.length, 0);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(run(machineIR(['ret']), { signal:cancelled.signal }).status, 'partial');
});

test('ABI/byte equivalence cannot ignore a different generic terminal PC', async () => {
  const result = await queryMemoryEquivalence({ identity, beforeIr:attachTarget(partialStoreFixture(), 0x1000n),
    afterIr:attachTarget(partialStoreFixture(), 0x2000n), backendTier:'tiered', memory:{ addressBits:64 }, timeoutMs:5000 });
  assert.equal(result.eligible, false);
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reason, 'terminal-control-outside-proof-scope');
});
