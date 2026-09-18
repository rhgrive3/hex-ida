import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { assessProductionFormalEvidence, observeRv64RegisterPrefix, RV64_FORMAL_ADD_PREFIX } from '../../tools/validation/machine-effects/production-subject.mjs';
import { assessArchitecturalEvidence, createArchitecturalEvidenceFromArtifactRecord } from '../../tools/validation/machine-effects/oracle-evidence-v2.mjs';
import { validateFormalEvidenceArtifacts } from '../../tools/validation/machine-effects/generate-formal-evidence.mjs';

const manifest = validateFormalEvidenceArtifacts(JSON.parse(fs.readFileSync(
  new URL('../../tools/validation/machine-effects/generated/formal-evidence-artifacts.json', import.meta.url), 'utf8')));
const record = manifest.records.find(item => item.id === RV64_FORMAL_ADD_PREFIX.recordId);
const prefix = () => structuredClone(RV64_FORMAL_ADD_PREFIX.instructions);

test('production RV64 subject uses exactly the retained three-instruction prefix and source identity', () => {
  const trace = [...record.artifact.toolOutput.matchAll(/^\[[0-2]\] \[M\]: (0x[0-9a-fA-F]+) \((0x[0-9a-fA-F]+)\)/gm)];
  assert.equal(trace.length, 3);
  for (const [index, instruction] of prefix().entries()) {
    assert.equal(BigInt(instruction.address), BigInt(trace[index][1]));
    const word = instruction.rawBytes.reduce((value, byte, offset) => value | (BigInt(byte) << BigInt(8 * offset)), 0n);
    assert.equal(word, BigInt(trace[index][2]));
  }
  const source = fs.readFileSync(new URL(`../../${record.source.path}`, import.meta.url));
  assert.equal(`sha256:${createHash('sha256').update(source).digest('hex')}`, RV64_FORMAL_ADD_PREFIX.source.digest);
  const result = assessProductionFormalEvidence(record);
  assert.equal(result.assessment.status, 'exact/equivalent');
  assert.equal(result.observation.instructionCount, 3);
  assert.equal(result.observation.assignments.length, 3);
  assert.equal(result.observation.inputDigest, result.referenceInputDigest);
  assert.deepEqual(result.observation.observables, record.expectedObservables);
  for (const assignment of result.observation.assignments) {
    assert.match(assignment.semanticNodeId, /^semantic_node_/);
    assert.match(assignment.stateSsaDefinitionId, /^ssa_def_/);
    assert.match(assignment.sourceEffectId, /:effect:/);
  }
});

test('changing oracle expected values cannot change the production subject', () => {
  const changed = structuredClone(record);
  changed.expectedObservables['register:x5'] = '0x0000000000000009';
  const result = assessProductionFormalEvidence(changed);
  assert.equal(result.observation.observables['register:x5'], '0x0000000000000008');
  assert.equal(result.assessment.status, 'mismatch');
  assert.equal(result.assessment.reason, 'reference-output-disagreement:register:x5');
  assert.equal(result.assessment.exactAuthorized, false);
});

test('a real SUB encoding changes the computed state and disagrees with the independent ADD artifact', () => {
  const changed = prefix();
  changed[2].rawBytes[3] = 0x40;
  const observed = observeRv64RegisterPrefix(changed);
  assert.equal(observed.status, 'observed');
  assert.equal(observed.observables['register:x5'], '0x0000000000000002');
  assert.notEqual(observed.inputDigest, observeRv64RegisterPrefix(prefix()).inputDigest);
  const result = assessArchitecturalEvidence({ evidence: createArchitecturalEvidenceFromArtifactRecord(record),
    subject: { profileId: record.profileId, effect: record.effect, observables: observed.observables } });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.reason, 'observable-disagreement:register:x5');
});

test('canonical SSA supplies the last write and wraps arithmetic at the native 64-bit width', () => {
  const instructions = prefix();
  // c.li x1, -1; c.li x2, 3; add x5, x1, x2.
  instructions[0].rawBytes = [0xfd, 0x50];
  const result = observeRv64RegisterPrefix(instructions);
  assert.equal(result.status, 'observed');
  assert.equal(result.observables['register:x1'], '0xffffffffffffffff');
  assert.equal(result.observables['register:x5'], '0x0000000000000002');
  const repeated = [
    ...prefix().slice(0, 2),
    { address: '0x80000004', rawBytes: [0x8d, 0x40] }, // c.li x1, 3
    { address: '0x80000006', rawBytes: prefix()[2].rawBytes },
  ];
  const latest = observeRv64RegisterPrefix(repeated);
  assert.equal(latest.status, 'observed');
  assert.equal(latest.observables['register:x1'], '0x0000000000000003');
  assert.equal(latest.observables['register:x5'], '0x0000000000000006');
});

test('unbound entry registers, memory, control and malformed prefixes never publish an observation', () => {
  const unbound = [prefix()[2]];
  const memory = prefix(); memory[2].rawBytes = [0x83, 0xb2, 0x00, 0x00]; // ld x5, 0(x1)
  const control = [{ address: '0x80000000', rawBytes: [0x01, 0xa0] }]; // c.j 0
  const gap = prefix(); gap[1].address = '0x80000008';
  const malformed = prefix(); malformed[2].rawBytes[0] = 256;
  for (const instructions of [unbound, memory, control, gap, malformed, []]) {
    const result = observeRv64RegisterPrefix(instructions);
    assert.notEqual(result.status, 'observed');
    assert.deepEqual(result.observables, {});
  }
});

test('cancellation and resource exhaustion keep formal comparison non-passing', () => {
  const controller = new AbortController(); controller.abort();
  for (const options of [{ signal: controller.signal }, { maxInstructions: 2 }, { maxWorkItems: 1 }, { maxInstructions: 33 }]) {
    const result = assessProductionFormalEvidence(record, options);
    assert.equal(result.assessment.exactAuthorized, false);
    assert.equal(result.assessment.passContribution, 0);
    assert.deepEqual(result.observation.observables, {});
  }
});

test('formal subject rejects scope shrinking, input identity drift and unsupported evidence families', () => {
  const shrunk = structuredClone(record);
  shrunk.observables.declared.pop(); shrunk.observables.known.pop(); delete shrunk.expectedObservables['register:x5'];
  assert.equal(assessProductionFormalEvidence(shrunk).assessment.reason, 'production-formal-observable-scope-mismatch');
  for (const change of [value => { value.source.digest = 'sha256:' + '0'.repeat(64); },
    value => { value.effect.caseId += '-other'; }, value => { value.artifactDigest = 'sha256:' + '0'.repeat(64); }]) {
    const changed = structuredClone(record); change(changed);
    assert.equal(assessProductionFormalEvidence(changed).assessment.status, 'mismatch');
  }
  for (const other of manifest.records.filter(item => item.id !== record.id)) {
    const result = assessProductionFormalEvidence(other);
    assert.equal(result.assessment.status, 'unsupported');
    assert.equal(result.assessment.exactAuthorized, false);
    assert.equal(result.observation, null);
  }
  const malformed = structuredClone(record); malformed.artifact.toolOutput = 'forged';
  assert.equal(assessProductionFormalEvidence(malformed).assessment.status, 'malformed');
  for (const key of ['source', 'effect', 'observables']) {
    const missing = structuredClone(record); delete missing[key];
    assert.equal(assessProductionFormalEvidence(missing).assessment.status, 'malformed');
  }
});

test('production subject replay retains identical values and producer identities', () => {
  assert.deepEqual(assessProductionFormalEvidence(record), assessProductionFormalEvidence(record));
});

test('odd-address RV64 prefixes cannot become observations', () => {
  const instructions = prefix().map(item => ({ ...item, address: String(BigInt(item.address) + 1n) }));
  const result = observeRv64RegisterPrefix(instructions);
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.observables, {});
});

test('forged expected values cannot authorize a real production ADD-to-SUB mismatch', () => {
  const target = new URL('../../js/targets/architecture/riscv64/effects/integer.js', import.meta.url).href;
  const moduleUrl = new URL('../../tools/validation/machine-effects/production-subject.mjs', import.meta.url).href;
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
    const { assessProductionFormalEvidence } = await import(${JSON.stringify(moduleUrl)});
    const record = ${JSON.stringify(record)};
    record.expectedObservables['register:x5'] = '0x0000000000000002';
    const result = assessProductionFormalEvidence(record);
    assert.equal(mutated, true);
    assert.equal(result.observation.observables['register:x5'], '0x0000000000000002');
    assert.equal(result.assessment.exactAuthorized, false, 'Sail still says 8; forged expectations must not bless the producer bug');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});

test('relocating the subject alone cannot reuse the pinned trace identity', () => {
  const moduleUrl = new URL('../../tools/validation/machine-effects/production-subject.mjs', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== ${JSON.stringify(moduleUrl)}) return result;
      let source = String(result.source);
      for (const [before, after] of [['0x80000004', '0x80000006'], ['0x80000002', '0x80000004'], ['0x80000000', '0x80000002']]) {
        const marker = "address: '" + before + "'";
        assert.equal(source.split(marker).length, 2);
        source = source.replace(marker, "address: '" + after + "'");
      }
      return { ...result, source };
    } });
    const { assessProductionFormalEvidence } = await import(${JSON.stringify(moduleUrl)});
    const result = assessProductionFormalEvidence(${JSON.stringify(record)});
    assert.equal(result.assessment.exactAuthorized, false);
    assert.equal(result.assessment.reason, 'production-formal-trace-input-mismatch');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});

test('source bytes are checked during assessment without modifying the source fixture', () => {
  const sourceUrl = new URL(`../../${record.source.path}`, import.meta.url);
  const read = fs.readFileSync, original = read(sourceUrl);
  try {
    fs.readFileSync = (file, ...args) => String(file) === sourceUrl.href
      ? Buffer.concat([original, Buffer.from('\n# source drift\n')]) : read(file, ...args);
    const result = assessProductionFormalEvidence(record);
    assert.equal(result.assessment.exactAuthorized, false);
    assert.equal(result.assessment.reason, 'production-formal-source-drift');
    assert.equal(result.observation, null);
  } finally { fs.readFileSync = read; }
  assert.deepEqual(read(sourceUrl), original);
});

test('subject scalar work is shared across every write in the prefix', () => {
  const instructions = Array.from({ length: 8 }, (_, index) => ({
    address: String(0x1000 + index * 2), rawBytes: [0x85, 0x40], // c.li x1, 1
  }));
  const result = observeRv64RegisterPrefix(instructions, { maxWorkItems: 300 });
  assert.equal(result.status, 'budget', 'eight separately affordable translations must not reset one prefix budget');
  assert.equal(result.reason, 'subject-work-budget');
  assert.deepEqual(result.observables, {}, 'earlier completed writes cannot leak from an incomplete prefix');
  assert.ok(result.resources.accountedWorkItems <= 300);
});

test('subject work receipts support exact N-1/N/N+1 replay without changing input identity', () => {
  const baseline = observeRv64RegisterPrefix(prefix());
  assert.equal(baseline.status, 'observed');
  const resources = baseline.resources;
  assert.ok(resources.translationWorkItems > 0);
  assert.ok(resources.evaluationPreflightWorkItems > 0);
  assert.ok(resources.evaluationUpperBound > 0);
  assert.equal(resources.accountedWorkItems, resources.translationWorkItems
    + resources.evaluationPreflightWorkItems + resources.evaluationUpperBound);
  assert.ok(Object.isFrozen(resources));
  const required = resources.accountedWorkItems;
  const short = observeRv64RegisterPrefix(prefix(), { maxWorkItems: required - 1 });
  assert.equal(short.status, 'budget');
  assert.equal(short.reason, 'subject-work-budget');
  assert.deepEqual(short.observables, {});
  for (const maxWorkItems of [required, required + 1]) {
    const result = observeRv64RegisterPrefix(prefix(), { maxWorkItems });
    assert.equal(result.status, 'observed');
    assert.deepEqual(result.resources, resources);
    assert.deepEqual(result.observables, baseline.observables);
    assert.equal(result.inputDigest, baseline.inputDigest);
  }
  const refused = assessProductionFormalEvidence(record, { maxWorkItems: required - 1 });
  assert.equal(refused.assessment.exactAuthorized, false);
  assert.equal(refused.assessment.passContribution, 0);
});

test('shared Expr DAGs are costed before the recursive evaluator can expand them', () => {
  const translator = new URL('../../js/symbolic/translate/semantic-ir.js', import.meta.url).href;
  const evaluator = new URL('../../js/symbolic/expr/evaluate.js', import.meta.url).href;
  const subject = new URL('../../tools/validation/machine-effects/production-subject.mjs', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    globalThis.__expandedSubjectDag = false;
    globalThis.__unbudgetedSubjectEvaluations = 0;
    registerHooks({ load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      let source = String(loaded.source);
      if (url === ${JSON.stringify(translator)}) {
        const marker = 'export function translateSemanticIR(target, options = {}) {';
        assert.equal(source.split(marker).length, 2);
        source = "import { createBinary as stressBinary } from '../expr/index.js';\\n" + source.replace(marker,
          'export function translateSemanticIR(target, options = {}) {' +
          ' const result = originalTranslate(target, options);' +
          ' let expression = createBv(64, 1n);' +
          ' for (let i = 0; i < 20; i++) expression = stressBinary("add", expression, expression);' +
          ' globalThis.__expandedSubjectDag = true;' +
          ' return { ...result, expression }; }\\nfunction originalTranslate(target, options = {}) {');
      } else if (url === ${JSON.stringify(evaluator)}) {
        const marker = 'export function evaluateExpr(expr, env = null) {';
        assert.equal(source.split(marker).length, 2);
        source = source.replace(marker, marker +
          ' if (globalThis.__expandedSubjectDag) { globalThis.__unbudgetedSubjectEvaluations++;' +
          ' throw new Error("recursive-evaluation-without-budget"); }');
      }
      return { ...loaded, source };
    } });
    const { observeRv64RegisterPrefix } = await import(${JSON.stringify(subject)});
    const result = observeRv64RegisterPrefix([{ address: '0x1000', rawBytes: [0x85, 0x40] }]);
    assert.equal(globalThis.__expandedSubjectDag, true);
    assert.equal(result.status, 'budget');
    assert.equal(result.reason, 'subject-work-budget');
    assert.equal(globalThis.__unbudgetedSubjectEvaluations, 0, 'the evaluator must never expand an unaffordable DAG');
    assert.deepEqual(result.observables, {});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});

test('missing or malformed translation work cannot bypass the subject budget', () => {
  const translator = new URL('../../js/symbolic/translate/semantic-ir.js', import.meta.url).href;
  const subject = new URL('../../tools/validation/machine-effects/production-subject.mjs', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== ${JSON.stringify(translator)}) return loaded;
      const source = String(loaded.source);
      const marker = 'export function translateSemanticIR(target, options = {}) {';
      assert.equal(source.split(marker).length, 2);
      return { ...loaded, source: source.replace(marker,
        'export function translateSemanticIR(target, options = {}) {' +
        ' const result = originalTranslate(target, options);' +
        ' globalThis.__subjectCancel?.abort();' +
        ' return { ...result, metrics: { ...result.metrics, workItems: globalThis.__subjectWork } };' +
        ' }\\nfunction originalTranslate(target, options = {}) {') };
    } });
    const { observeRv64RegisterPrefix } = await import(${JSON.stringify(subject)});
    const prefix = [{ address: '0x1000', rawBytes: [0x85, 0x40] }];
    for (const work of [undefined, NaN, Infinity, -1, 0, 0.5, '1']) {
      globalThis.__subjectWork = work;
      const result = observeRv64RegisterPrefix(prefix);
      assert.equal(result.status, 'partial', 'invalid work=' + String(work));
      assert.equal(result.reason, 'subject-invalid-work-accounting');
      assert.deepEqual(result.observables, {});
    }
    globalThis.__subjectWork = 10001;
    assert.equal(observeRv64RegisterPrefix(prefix).status, 'budget');
    globalThis.__subjectCancel = new AbortController();
    const cancelled = observeRv64RegisterPrefix(prefix, { signal: globalThis.__subjectCancel.signal });
    assert.equal(cancelled.status, 'cancelled', 'late cancellation wins over exhausted work');
    assert.deepEqual(cancelled.observables, {});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});

test('native prefix limits keep affordable 32-write inputs and withhold dependent partial results', () => {
  const independent = Array.from({ length: 32 }, (_, index) => ({
    address: String(0x1000 + index * 2), rawBytes: [0x85, 0x40], // c.li x1, 1
  }));
  const accepted = observeRv64RegisterPrefix(independent);
  assert.equal(accepted.status, 'observed');
  assert.equal(accepted.instructionCount, 32);
  assert.equal(accepted.assignments.length, 32);
  assert.equal(accepted.observables['register:x1'], '0x0000000000000001');
  assert.ok(accepted.resources.accountedWorkItems <= 10000);
  const tooLong = [...independent, { address: String(0x1040), rawBytes: [0x85, 0x40] }];
  assert.equal(observeRv64RegisterPrefix(tooLong).reason, 'subject-instruction-budget');

  // Real native ADDs build shared SSA dependencies, without injected expressions.
  const dependent = [independent[0], ...Array.from({ length: 12 }, (_, index) => ({
    address: String(0x1002 + index * 4), rawBytes: [0xb3, 0x80, 0x10, 0x00], // add x1, x1, x1
  }))];
  const limited = observeRv64RegisterPrefix(dependent);
  assert.equal(limited.status, 'budget');
  assert.equal(limited.reason, 'subject-work-budget');
  assert.deepEqual(limited.observables, {});
  assert.ok(limited.resources.accountedWorkItems <= 10000);
});
