import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RAW_SCHEMA_VERSION = 'hex-final-closure-shadow-raw-observation/v1';
const CONTRACT_SCHEMA_VERSION = 'hex-final-closure-shadow-contract/v1';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function fail(message) {
  throw new Error(`shadow-product-provider:${message}`);
}

function project(root, descriptor) {
  if (descriptor?.kind !== 'process-exit-v1'
    || !Array.isArray(descriptor.argv)
    || descriptor.argv.length < 2
    || descriptor.argv.length > 16
    || descriptor.argv.some((value) => typeof value !== 'string' || value.length === 0)
    || descriptor.argv[0] !== 'node'
    || path.isAbsolute(descriptor.argv[1])
    || descriptor.argv[1].split('/').includes('..')
    || !Number.isSafeInteger(descriptor.timeoutMs)
    || descriptor.timeoutMs < 1
    || descriptor.timeoutMs > 120000) {
    fail('projection-invalid');
  }
  const child = spawnSync(descriptor.argv[0], descriptor.argv.slice(1), {
    cwd: root,
    env: process.env,
    shell: false,
    encoding: 'utf8',
    timeout: descriptor.timeoutMs,
    stdio: 'ignore',
  });
  return {
    state: 'OBSERVED',
    value: {
      exitCode: Number.isSafeInteger(child.status) ? child.status : null,
      signal: typeof child.signal === 'string' ? child.signal : null,
      errorCode: typeof child.error?.code === 'string' ? child.error.code : null,
    },
  };
}

const taskId = argument('--task');
const gateId = argument('--gate');
if (!/^T\d{3}$/.test(String(taskId || ''))
  || !/^[a-z0-9][a-z0-9-]*$/.test(String(gateId || ''))) {
  fail('arguments-invalid');
}

let contract;
try {
  const source = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > 64 * 1024) fail('contract-too-large');
  contract = JSON.parse(source);
} catch {
  fail('contract-encoding-invalid');
}
if (contract?.schemaVersion !== CONTRACT_SCHEMA_VERSION
  || contract.taskId !== taskId
  || contract.gateId !== gateId
  || contract.activationRequired !== false
  || !Array.isArray(contract.cases)
  || contract.cases.length === 0
  || contract.cases.length > 64) {
  fail('contract-invalid');
}

const root = process.cwd();
const observations = contract.cases.map((row) => {
  const expected = row?.oracleObservation;
  if (typeof row?.id !== 'string'
    || !expected
    || Object.keys(expected).sort().join(',') !== 'errorCode,exitCode,signal'
    || expected.exitCode !== 0
    || expected.signal !== null
    || expected.errorCode !== null) {
    fail('case-invalid');
  }
  return { caseId: row.id, ...project(root, row.projection) };
});

console.log(JSON.stringify({
  schemaVersion: RAW_SCHEMA_VERSION,
  taskId,
  gateId,
  observations,
}));
