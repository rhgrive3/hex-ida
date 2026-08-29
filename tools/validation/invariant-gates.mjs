import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRED = Object.freeze([
  'INV-002','INV-003','INV-004','INV-005','INV-007','INV-008',
  'INV-010','INV-011','INV-012','INV-014','INV-015',
]);

const gates = Object.freeze([
  { name:'core-contracts', invariants:['INV-004','INV-007','INV-008','INV-010','INV-012','INV-015'], file:'tests/invariant-contracts.mjs' },
  { name:'unknown-semantics', invariants:['INV-002','INV-003'], file:'tests/ir.mjs' },
  { name:'alias-safety', invariants:['INV-003','INV-015'], file:'tests/ir-alias.mjs' },
  { name:'unknown-call-clobber', invariants:['INV-003'], file:'tests/issue-430-memory-escape.mjs' },
  { name:'provenance-regression', invariants:['INV-004'], file:'tests/issue-428-schema-provenance.mjs' },
  { name:'architecture-boundaries', invariants:['INV-005'], file:'tools/validation/import-boundaries.mjs' },
  { name:'runtime-static-separation', invariants:['INV-007'], file:'tests/runtime-evidence-fusion.mjs' },
  { name:'verified-evidence-discipline', invariants:['INV-008'], file:'tests/evidence-verdict.mjs' },
  { name:'capability-grading', invariants:['INV-010'], file:'tests/capstone-capability.mjs' },
  { name:'large-input-source-backed', invariants:['INV-011','INV-012','INV-015'], file:'tests/universal-binary-source.mjs' },
  { name:'analysis-budget-fail-closed', invariants:['INV-010','INV-011','INV-012','INV-015'], file:'tests/ai-analysis-boundary.mjs' },
  { name:'machine-effects-contract', invariants:['INV-002','INV-003','INV-004','INV-005','INV-012','INV-014','INV-015'], file:'tests/machine-effects/run.mjs' },
  { name:'arm64-compiler-truth', invariants:['INV-014'], file:'tests/compiler-truth/run.mjs' },
]);

const covered = new Set(gates.flatMap((gate) => gate.invariants));
for (const invariant of REQUIRED) {
  if (!covered.has(invariant)) throw new Error(`invariant gate coverage missing: ${invariant}`);
}

function boundedConcurrency() {
  const raw = process.env.HEX_INVARIANT_CONCURRENCY;
  if (raw != null && raw !== '') {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4) {
      throw new TypeError('HEX_INVARIANT_CONCURRENCY must be an integer in [1,4]');
    }
    return parsed;
  }
  return Math.min(3, Math.max(1, os.availableParallelism()));
}

function runGate(gate) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, gate.file)], {
      cwd: root,
      env: { ...process.env, HEX_INVARIANT_GATE:'1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let error = null;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (value) => { error = value; });
    child.once('close', (code, signal) => resolve({
      gate, code: error ? 1 : code, signal, error,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

const concurrency = boundedConcurrency();
const results = new Array(gates.length);
let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= gates.length) return;
    results[index] = await runGate(gates[index]);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, gates.length) }, () => worker()));

const failures = [];
for (const result of results) {
  const { gate } = result;
  process.stdout.write(`\n[invariant-gate] ${gate.name} (${gate.invariants.join(', ')})\n`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) process.stderr.write(`${result.error.stack || result.error.message || result.error}\n`);
  if (result.code !== 0 || result.signal) {
    failures.push(result);
    process.stderr.write(`[invariant-gate] FAIL ${gate.name}: ${gate.file} (${result.signal || `exit ${result.code}`})\n`);
  }
}

if (failures.length) {
  throw new Error(`invariant gates failed: ${failures.map(({ gate }) => gate.name).join(', ')}`);
}
process.stdout.write(`\nInvariant gates PASS: ${REQUIRED.length} invariants covered by ${gates.length} executable gates (concurrency=${concurrency}).\n`);
