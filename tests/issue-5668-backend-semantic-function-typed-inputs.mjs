import assert from 'node:assert/strict';
import { Backend } from '../js/backend.js';

/* #5668: Backend.analyzeSemanticFunction() laundered structured
   length/architecture/abiId/sliceIndex through Number()/String() before any
   schema validation, so ['4096'] became a decode budget, ['riscv64'] routed to
   the real RISC-V engine, ['lp64'] became the calling-convention authority and
   ['1'] selected another slice. Control/identity fields now require canonical
   primitives and fail closed. */

let captured = null;
const fakeAbiIds = ['sysv-amd64', 'microsoft-x64', 'lp64', 'lp64f', 'lp64d'];
const orchestrator = {
  async request(call) {
    captured = call;
    const base = { route: 'phase5-shadow-v2', pipeline: { instrumentation: { v2Executed: true } } };
    const payload = { ...base, abiId: fakeAbiIds.find((a) => call.validate?.({ ...base, abiId: a })) ?? null };
    return { payload, reused: false };
  },
  store: { async delete() {} },
};

const backend = new Backend({ artifactOrchestrator: orchestrator });
backend.formatId = 'elf';
const BID = 'bin_sha256_' + 'ab'.repeat(32);

const control = await backend.analyzeSemanticFunction({
  address: 0x1000n, length: 16, architecture: 'x86_64', abiId: 'sysv-amd64', binaryId: BID, sliceIndex: 0,
});
assert.equal(control.abiId, 'sysv-amd64', 'canonical x86_64 input still analyzes');
assert.equal(control.route, 'phase5-shadow-v2');
assert.equal(captured.creation.length, 16);

captured = null;
const control2 = await backend.analyzeSemanticFunction({
  address: 0x1000n, length: 16, abiId: 'sysv-amd64', binaryId: BID,
});
assert.equal(control2.artifactId, control.artifactId, 'defaults keep the canonical artifact identity');
assert.equal(captured.creation.length, 16);

const rejects = [
  ['length array', { length: ['4096'] }, 'semantic-function-bounded-length-required'],
  ['length true', { length: true }, 'semantic-function-bounded-length-required'],
  ['length bigint', { length: 16n }, 'semantic-function-bounded-length-required'],
  ['length fraction', { length: 4.5 }, 'semantic-function-bounded-length-required'],
  ['architecture array', { architecture: ['riscv64'] }, 'semantic-function-architecture-required'],
  ['architecture number', { architecture: 0 }, 'semantic-function-architecture-required'],
  ['architecture boolean', { architecture: false }, 'semantic-function-architecture-required'],
  ['architecture object', { architecture: { toString: () => 'riscv64' } }, 'semantic-function-architecture-required'],
  ['abiId array', { abiId: ['lp64'] }, 'semantic-function-abi-id-required'],
  ['abiId boolean', { abiId: true }, 'semantic-function-abi-id-required'],
  ['sliceIndex array', { sliceIndex: ['1'] }, 'semantic-function-slice-index-required'],
  ['sliceIndex string', { sliceIndex: '1' }, 'semantic-function-slice-index-required'],
  ['sliceIndex boolean', { sliceIndex: true }, 'semantic-function-slice-index-required'],
  ['sliceIndex bigint', { sliceIndex: 1n }, 'semantic-function-slice-index-required'],
  ['sliceIndex negative', { sliceIndex: -1 }, 'semantic-function-slice-index-required'],
];
for (const [label, patch, code] of rejects) {
  await assert.rejects(
    () => backend.analyzeSemanticFunction({
      address: 0x1000n, length: 16, architecture: 'x86_64', abiId: 'sysv-amd64', binaryId: BID, ...patch,
    }),
    (error) => error instanceof TypeError && error.message === code,
    `${label} must fail closed with ${code}`,
  );
}

await assert.rejects(
  () => backend.analyzeSemanticFunction({
    address: 0x1000n, length: 16, architecture: 'riscv64', abiId: ['lp64'], binaryId: BID,
  }),
  /semantic-function-abi-id-required/,
  'structured abiId is rejected before the route is selected',
);

console.log('issue-5668 backend semantic-function typed inputs: ok');
