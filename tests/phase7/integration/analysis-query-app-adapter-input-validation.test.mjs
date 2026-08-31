import assert from 'node:assert/strict';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';

let revision = ['7'];
let epoch = true;
const identityAdapter = createAppAnalysisQueryAdapter({
  store: {
    get(key) {
      if (key === 'project') return { revision };
      return null;
    },
  },
  backend: {
    binaryId: 'bin_strict_inputs',
    get gen() { return epoch; },
  },
});

let identity = await identityAdapter.currentIdentity();
assert.equal(identity.projectRevision, 0, 'array revision must not be coerced into snapshot identity');
assert.equal(identity.analysisEpoch, 0, 'boolean epoch must not be coerced into snapshot identity');

revision = 7;
epoch = 3;
identity = await identityAdapter.currentIdentity();
assert.equal(identity.projectRevision, 7);
assert.equal(identity.analysisEpoch, 3);

revision = -1;
epoch = 1.5;
identity = await identityAdapter.currentIdentity();
assert.equal(identity.projectRevision, 0, 'negative revision must fail closed');
assert.equal(identity.analysisEpoch, 0, 'fractional epoch must fail closed');

const names = new Map([
  [0x1000n, 'malloc'],
  [0x2000n, 'free'],
]);
const symbols = {
  funcs: [0x1000n, 0x2000n],
  functionStartsComplete: true,
  nameAt(address) { return names.get(address) ?? null; },
  functionAt(address) { return { start:address, end:address + 4n }; },
};
const functionAdapter = createAppAnalysisQueryAdapter({ symbols });

const malformedPage = await functionAdapter.functions(null, {}, { offset:['1'], limit:true });
assert.equal(malformedPage.page.offset, 0, 'array pagination offset must use the existing default');
assert.equal(malformedPage.page.limit, 200, 'boolean pagination limit must use the existing default');
assert.deepEqual(malformedPage.value.map((row) => row.address), [0x1000n, 0x2000n]);

const clampedPage = await functionAdapter.functions(null, {}, { offset:1, limit:10_000 });
assert.equal(clampedPage.page.offset, 1);
assert.equal(clampedPage.page.limit, 5_000, 'valid numeric limits must retain MAX_PAGE clamping');
assert.deepEqual(clampedPage.value.map((row) => row.address), [0x2000n]);

const malformedNeedle = await functionAdapter.functions(null, { text:['malloc'] });
assert.equal(malformedNeedle.status.completeness, 'unsupported');
assert.equal(malformedNeedle.status.reason, 'function-query-text-invalid');

const validNeedle = await functionAdapter.functions(null, { text:' MALLOC ' });
assert.deepEqual(validNeedle.value.map((row) => row.address), [0x1000n]);

const disassembleLengths = [];
const instructionAdapter = createAppAnalysisQueryAdapter({
  store: {
    get(key) {
      if (key === 'architecture') return 'x86_64';
      return null;
    },
  },
  backend: {
    async disassembleAt(_address, { length }) {
      disassembleLengths.push(length);
      return { supported:true, found:true, instructions:[] };
    },
  },
});

for (const length of [['16'], true, { valueOf:() => 16 }]) {
  const malformed = await instructionAdapter.instructions(null, { start:0x1000n, length });
  assert.equal(malformed.status.completeness, 'unsupported');
  assert.equal(malformed.status.reason, 'instruction-range-invalid');
}
assert.deepEqual(disassembleLengths, [], 'malformed length must not reach the decoder');

await instructionAdapter.instructions(null, { start:0x1000n, length:16 });
await instructionAdapter.instructions(null, { start:0x1000n, end:0x1010n });
assert.deepEqual(disassembleLengths, [16, 16], 'valid number and derived bigint length must be preserved');

console.log('phase7 AnalysisQuery app adapter strict input validation: PASS');
