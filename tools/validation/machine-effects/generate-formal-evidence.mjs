import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalStringify } from './oracle-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_DIR = path.join(ROOT, 'tests/machine-effects/fixtures/formal-source');
const OUTPUT = path.join(ROOT, 'tools/validation/machine-effects/generated/formal-evidence-artifacts.json');
const SCHEMA = 'machine-effects-formal-evidence-artifacts/v1';
const GENERATOR = 'hex-machine-effects-formal-evidence-generator/v1';
const HERD_COMMIT = '1ca343e16a2038e406d1ac674e7e3a1b722b36c7';
const ISLA_COMMIT = 'f189d5cbf6d732839879024c74ab0a8478bc1e28';
const ISLA_SNAPSHOT_COMMIT = 'd8b31014643035a3b11071e56ef30001de3f52ab';
const SAIL_RISCV_COMMIT = '27224ccb2290f022e46213c05b3e72e8a9ea635e';
const EXPECTED_RECORD_IDS = Object.freeze([
  'arm64-a64-adds-symbolic-footprint',
  'riscv64-rv64imc-add-concrete-trace',
  'arm64-a64-relaxed-outcome',
  'arm64-a64-acquire-outcome',
  'arm64-a64-release-outcome',
  'arm64-a64-acq-rel-outcome',
  'arm64-a64-seq-cst-outcome',
]);

function fail(code, detail = '') { throw new Error(detail ? `${code}:${detail}` : code); }
function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalStringify(actual) !== canonicalStringify(wanted)) fail(code, `${actual.join(',')}:${wanted.join(',')}`);
}
function digest(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : Buffer.from(typeof value === 'string' ? value : canonicalStringify(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function read(relativePath) { return fs.readFileSync(path.join(ROOT, relativePath)); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) fail('formal-evidence-command-failed', `${command}:${result.status}:${String(result.stderr || result.stdout).trim()}`);
  return `${result.stdout || ''}${result.stderr || ''}`.replace(/\r\n/g, '\n').trim();
}
function runExpectedStatus(command, args, expectedStatus) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.signal || result.status !== expectedStatus) {
    fail('formal-evidence-command-status', `${command}:${result.signal || result.status}:expected-${expectedStatus}:${String(result.stderr || result.stdout).trim()}`);
  }
  return `exit-status:${result.status}`;
}
function args(argv) {
  const out = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--check') out.check = true;
    else if (token.startsWith('--')) out[token.slice(2)] = argv[++index];
  }
  return out;
}
function artifact(format, inputDigest, command, toolOutput) {
  const value = { format, inputDigest, command, toolOutput };
  return { value, digest: digest(value) };
}
function sourceRecord(relativePath) {
  return { path: relativePath, digest: digest(read(relativePath)) };
}
function normalizeIsla(output) {
  const lines = output.split('\n').filter((line) => /\(read-reg \|R[12]\||\(write-reg \|R0\||\(write-reg \|PSTATE\| \(\(_ field \|(N|Z|C|V)\|\)|\(define-const [^ ]+ \(bvadd/.test(line));
  if (!lines.some((line) => line.includes('(bvadd ')) || !lines.some((line) => line.includes('(write-reg |R0|'))) fail('formal-evidence-isla-footprint-incomplete');
  return lines.map((line) => line.trim()).join('\n');
}
function normalizeSail(output) {
  const lines = output.split('\n').filter((line) => /^\[[0-2]\]|^x[125] <- /.test(line));
  if (!lines.some((line) => /^x5 <- 0x0000000000000008$/.test(line))) fail('formal-evidence-sail-result-missing');
  return lines.join('\n');
}
function normalizeHerd(output, name) {
  const lines = output.split('\n').filter((line) => /^(Test|States|Observation|Witnesses)/.test(line));
  const observation = lines.find((line) => line.startsWith(`Observation ${name} `));
  if (!observation || !/ (Sometimes|Never) /.test(observation)) fail('formal-evidence-herd-observation-missing', name);
  return { output: lines.join('\n'), permitted: observation.includes(' Sometimes ') };
}
function makeRecord({ id, kind, profileId, source, effect, observables, expectedObservables, completeness, artifactValue, memoryModel = null }) {
  return {
    id, kind, profileId, source, effect, observables, expectedObservables, completeness,
    artifact: artifactValue.value,
    artifactDigest: artifactValue.digest,
    ...(memoryModel == null ? {} : { memoryModel }),
  };
}

function generate(options) {
  for (const key of ['herd7', 'herd-libdir', 'isla-footprint', 'isla-model', 'isla-config', 'sail-riscv', 'riscv-as', 'riscv-ld', 'aarch64-as', 'aarch64-ld', 'qemu-aarch64', 'qemu-riscv64']) {
    if (!options[key]) fail('formal-evidence-option-required', key);
  }
  const herdVersion = run(options.herd7, ['-version']);
  if (!herdVersion.startsWith('7.58')) fail('formal-evidence-herd-version', herdVersion);
  const sailBuild = run(options['sail-riscv'], ['--build-info']);
  if (!sailBuild.includes('release: 0.13.1') || !sailBuild.includes('git: 27224cc')) fail('formal-evidence-sail-version');

  const qemuAarch64Version = run(options['qemu-aarch64'], ['--version']).split('\n')[0];
  const qemuRiscv64Version = run(options['qemu-riscv64'], ['--version']).split('\n')[0];
  const riscvSource = sourceRecord('tests/machine-effects/fixtures/formal-source/rv64-add.S');
  const armSource = sourceRecord('tests/machine-effects/fixtures/formal-source/a64-adds.S');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-me01-formal-'));
  const riscvObjectPath = path.join(temp, 'rv64-add.o');
  const riscvElfPath = path.join(temp, 'rv64-add.elf');
  run(options['riscv-as'], ['-march=rv64imc', '-mabi=lp64', path.join(ROOT, riscvSource.path), '-o', riscvObjectPath]);
  run(options['riscv-ld'], ['-m', 'elf64lriscv', '-Ttext=0x80000000', '-e', '_start', riscvObjectPath, '-o', riscvElfPath]);
  const sailOutput = normalizeSail(run(options['sail-riscv'], ['--inst-limit', '3', '--trace-instr', '--trace-gpr', riscvElfPath]));
  const riscvQemuOutput = runExpectedStatus(options['qemu-riscv64'], [riscvElfPath], 8);
  const sailInput = digest({ source: riscvSource.digest, elf: digest(fs.readFileSync(riscvElfPath)), model: SAIL_RISCV_COMMIT, qemu: { version: qemuRiscv64Version, result: riscvQemuOutput } });
  const sailArtifact = artifact('sail-riscv/v0.13.1', sailInput, 'sail_riscv_sim@0.13.1 --inst-limit 3 --trace-instr --trace-gpr rv64-add.elf && qemu-riscv64 rv64-add.elf', `${sailOutput}\nQEMU-RISCV64 ${riscvQemuOutput}`);

  const islaSource = { path: 'inline:adds x0, x1, x2', digest: digest('adds x0, x1, x2') };
  const islaOutput = normalizeIsla(run(options['isla-footprint'], ['-A', options['isla-model'], '-C', options['isla-config'], '-i', 'adds x0, x1, x2', '-s']));
  const armObjectPath = path.join(temp, 'a64-adds.o');
  const armElfPath = path.join(temp, 'a64-adds.elf');
  run(options['aarch64-as'], [path.join(ROOT, armSource.path), '-o', armObjectPath]);
  run(options['aarch64-ld'], ['-Ttext=0x400000', '-e', '_start', armObjectPath, '-o', armElfPath]);
  const armQemuOutput = runExpectedStatus(options['qemu-aarch64'], [armElfPath], 8);
  const islaInput = digest({ instruction: islaSource.digest, source: armSource.digest, elf: digest(fs.readFileSync(armElfPath)), model: digest(fs.readFileSync(options['isla-model'])), config: digest(fs.readFileSync(options['isla-config'])), snapshot: ISLA_SNAPSHOT_COMMIT, qemu: { version: qemuAarch64Version, result: armQemuOutput } });
  const islaArtifact = artifact('isla-footprint/v0.2.0', islaInput, 'isla-footprint@f189d5c -A armv8p5.ir -C armv8p5.toml -i "adds x0, x1, x2" -s && qemu-aarch64 a64-adds.elf', `${islaOutput}\nQEMU-AARCH64 ${armQemuOutput}`);

  const records = [
    makeRecord({
      id: 'arm64-a64-adds-symbolic-footprint', kind: 'instruction-footprint', profileId: 'arm64:a64', source: islaSource,
      effect: { instructionId: 'a64:adds:x0-x1-x2', effectId: 'register:x0+nzcv', caseId: 'formal:a64-adds', requiredFeatures: ['a64'] },
      observables: { declared: ['flag:C','flag:N','flag:V','flag:Z','register:x0'], known: ['flag:C','flag:N','flag:V','flag:Z','register:x0'], undefined: [], implementationDefined: [], unobserved: [] },
      expectedObservables: { 'flag:C':'unsigned-overflow(add64(R1,R2))', 'flag:N':'add64(R1,R2)[63]', 'flag:V':'signed-overflow(add64(R1,R2))', 'flag:Z':'add64(R1,R2)==0', 'register:x0':'add64(R1,R2)' },
      completeness: 'complete', artifactValue: islaArtifact,
    }),
    makeRecord({
      id: 'riscv64-rv64imc-add-concrete-trace', kind: 'instruction-footprint', profileId: 'riscv64:rv64imc', source: riscvSource,
      effect: { instructionId: 'rv64:add:x5-x1-x2', effectId: 'register:x5', caseId: 'formal:rv64-add', requiredFeatures: ['rv64imc'] },
      observables: { declared: ['register:x1','register:x2','register:x5'], known: ['register:x1','register:x2','register:x5'], undefined: [], implementationDefined: [], unobserved: [] },
      expectedObservables: { 'register:x1':'0x0000000000000005', 'register:x2':'0x0000000000000003', 'register:x5':'0x0000000000000008' },
      completeness: 'complete', artifactValue: sailArtifact,
    }),
  ];

  const memoryCases = [
    ['relaxed', 'aarch64-relaxed.litmus', 'ME01_relaxed_SB'],
    ['acquire', 'aarch64-acquire.litmus', 'ME01_acquire_SB'],
    ['release', 'aarch64-release.litmus', 'ME01_release_SB'],
    ['acq-rel', 'aarch64-acq-rel.litmus', 'ME01_acq_rel_MP'],
    ['seq-cst', 'aarch64-seq-cst.litmus', 'ME01_seq_cst_SB'],
  ];
  for (const [ordering, filename, testName] of memoryCases) {
    const relativePath = `tests/machine-effects/fixtures/formal-source/${filename}`;
    const input = sourceRecord(relativePath);
    const result = normalizeHerd(run(options.herd7, ['-set-libdir', options['herd-libdir'], path.join(ROOT, relativePath)]), testName);
    const inputDigest = digest({ litmus: input.digest, modelCommit: HERD_COMMIT, model: digest(fs.readFileSync(path.join(options['herd-libdir'], 'aarch64.cat'))) });
    const artifactValue = artifact('herd7/v7.58', inputDigest, `herd7@7.58 -model aarch64.cat ${filename}`, result.output);
    const outcome = `target:${testName}`;
    records.push(makeRecord({
      id: `arm64-a64-${ordering}-outcome`, kind: 'relaxed-memory-outcomes', profileId: 'arm64:a64', source: input,
      effect: { instructionId: `a64:litmus:${testName}`, effectId: `memory-order:${ordering}:${testName}`, caseId: `formal:memory:${ordering}`, requiredFeatures: ['a64','atomics'] },
      observables: { declared: [`outcome:${outcome}`], known: [`outcome:${outcome}`], undefined: [], implementationDefined: [], unobserved: [] },
      expectedObservables: { [`outcome:${outcome}`]: result.permitted ? 'permitted' : 'forbidden' }, completeness: 'complete', artifactValue,
      memoryModel: { ordering, atomic: true, outcomeUniverse: [outcome], permittedOutcomes: result.permitted ? [outcome] : [], forbiddenOutcomes: result.permitted ? [] : [outcome] },
    }));
  }

  const body = {
    schemaVersion: SCHEMA,
    generatorIdentity: GENERATOR,
    identities: {
      herdtools7: { version: '7.58', commit: HERD_COMMIT, binaryDigest: digest(fs.readFileSync(options.herd7)) },
      isla: { commit: ISLA_COMMIT, binaryDigest: digest(fs.readFileSync(options['isla-footprint'])), snapshotCommit: ISLA_SNAPSHOT_COMMIT, modelDigest: digest(fs.readFileSync(options['isla-model'])), configDigest: digest(fs.readFileSync(options['isla-config'])) },
      sailRiscv: { version: '0.13.1', commit: SAIL_RISCV_COMMIT, binaryDigest: digest(fs.readFileSync(options['sail-riscv'])) },
      qemuAarch64: { version: qemuAarch64Version, binaryDigest: digest(fs.readFileSync(options['qemu-aarch64'])), role: 'independent-concrete-execution' },
      qemuRiscv64: { version: qemuRiscv64Version, binaryDigest: digest(fs.readFileSync(options['qemu-riscv64'])), role: 'independent-concrete-execution' },
    },
    records,
  };
  return { ...body, manifestId: digest(body) };
}

export function validateFormalEvidenceArtifacts(value) {
  if (!value || value.schemaVersion !== SCHEMA || value.generatorIdentity !== GENERATOR || !Array.isArray(value.records)) fail('formal-evidence-manifest-invalid');
  exactKeys(value, ['schemaVersion', 'generatorIdentity', 'identities', 'records', 'manifestId'], 'formal-evidence-manifest-fields');
  exactKeys(value.identities, ['herdtools7', 'isla', 'sailRiscv', 'qemuAarch64', 'qemuRiscv64'], 'formal-evidence-identities-fields');
  if (canonicalStringify(value.records.map((record) => record.id)) !== canonicalStringify(EXPECTED_RECORD_IDS)) fail('formal-evidence-record-denominator');
  if (value.identities?.herdtools7?.version !== '7.58' || value.identities.herdtools7.commit !== HERD_COMMIT
    || value.identities?.isla?.commit !== ISLA_COMMIT || value.identities.isla.snapshotCommit !== ISLA_SNAPSHOT_COMMIT
    || value.identities?.sailRiscv?.version !== '0.13.1' || value.identities.sailRiscv.commit !== SAIL_RISCV_COMMIT
    || value.identities?.qemuAarch64?.role !== 'independent-concrete-execution' || !value.identities.qemuAarch64.version || !/^sha256:[0-9a-f]{64}$/.test(value.identities.qemuAarch64.binaryDigest)
    || value.identities?.qemuRiscv64?.role !== 'independent-concrete-execution' || !value.identities.qemuRiscv64.version || !/^sha256:[0-9a-f]{64}$/.test(value.identities.qemuRiscv64.binaryDigest)) fail('formal-evidence-identity-drift');
  const ids = new Set();
  for (const record of value.records) {
    const expectedRecordKeys = ['id', 'kind', 'profileId', 'source', 'effect', 'observables', 'expectedObservables', 'completeness', 'artifact', 'artifactDigest', ...(record.kind === 'relaxed-memory-outcomes' ? ['memoryModel'] : [])];
    exactKeys(record, expectedRecordKeys, 'formal-evidence-record-fields');
    if (!record?.id || ids.has(record.id)) fail('formal-evidence-record-id-invalid', record?.id);
    ids.add(record.id);
    if (record.artifactDigest !== digest(record.artifact)) fail('formal-evidence-record-artifact-digest', record.id);
    if (record.source?.path?.startsWith('tests/')) {
      if (record.source.digest !== digest(read(record.source.path))) fail('formal-evidence-record-source-digest', record.id);
    } else if (record.source?.path?.startsWith('inline:') && record.source.digest !== digest(record.source.path.slice('inline:'.length))) {
      fail('formal-evidence-record-inline-source-digest', record.id);
    }
  }
  const { manifestId, ...body } = value;
  if (manifestId !== digest(body)) fail('formal-evidence-manifest-digest');
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = args(process.argv.slice(2));
  if (options.check) {
    validateFormalEvidenceArtifacts(JSON.parse(fs.readFileSync(OUTPUT, 'utf8')));
    process.stdout.write(`formal evidence generated artifacts: PASS (${OUTPUT})\n`);
  } else {
    const result = validateFormalEvidenceArtifacts(generate(options));
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`formal evidence generated artifacts: WROTE ${OUTPUT}\n`);
  }
}
