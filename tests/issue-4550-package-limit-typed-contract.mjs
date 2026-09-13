/* #4550: package input/provider output resource limits are a typed contract.
 * Structured or non-number values must fail closed as invalid limits, never be
 * promoted through Number() coercion into a real parser/validation budget. */
import assert from 'node:assert/strict';
import {
  parseBoundedPackageInput,
  validateProviderOutput,
} from '../js/phase12/package-envelope.js';

const INPUT = JSON.stringify({ value: '0123456789' });

const STRUCTURED = [
  ['numeric string', '8'],
  ['single-element array', ['8']],
  ['boolean', true],
  ['object', { valueOf: () => 8 }],
  ['bigint', 8n],
];

for (const [label, value] of STRUCTURED) {
  assert.throws(
    () => parseBoundedPackageInput(INPUT, { maxBytes: value }),
    (error) => error?.code === 'package-resource-limit-invalid' && error?.detail?.name === 'maxBytes',
    `maxBytes must reject ${label} as an invalid typed limit`,
  );
  assert.throws(
    () => parseBoundedPackageInput(INPUT, { maxDepth: value }),
    (error) => error?.code === 'package-resource-limit-invalid' && error?.detail?.name === 'maxDepth',
    `maxDepth must reject ${label} as an invalid typed limit`,
  );
  assert.throws(
    () => parseBoundedPackageInput(INPUT, { maxEntries: value }),
    (error) => error?.code === 'package-resource-limit-invalid' && error?.detail?.name === 'maxEntries',
    `maxEntries must reject ${label} as an invalid typed limit`,
  );
  assert.throws(
    () => parseBoundedPackageInput(INPUT, { maxTokens: value }),
    (error) => error?.code === 'package-resource-limit-invalid' && error?.detail?.name === 'maxTokens',
    `maxTokens must reject ${label} as an invalid typed limit`,
  );
  assert.throws(
    () => parseBoundedPackageInput(INPUT, { maxStrings: value }),
    (error) => error?.code === 'package-resource-limit-invalid' && error?.detail?.name === 'maxStrings',
    `maxStrings must reject ${label} as an invalid typed limit`,
  );
}

{
  const result = validateProviderOutput(
    { schemaVersion: 'provider-v1', targetIdentity: 'binary-a', provenance: {}, completeness: 'complete', items: [] },
    { maxBytes: ['8'] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'provider-output-resource-limit-invalid');
  const entriesResult = validateProviderOutput(
    { schemaVersion: 'provider-v1', targetIdentity: 'binary-a', provenance: {}, completeness: 'complete', items: [] },
    { maxEntries: true },
  );
  assert.equal(entriesResult.ok, false);
  assert.equal(entriesResult.code, 'provider-output-resource-limit-invalid');
}

/* A malformed option must never be observed as a data budget exhaustion. */
assert.throws(
  () => parseBoundedPackageInput(INPUT, { maxBytes: ['8'] }),
  (error) => error?.code !== 'package-input-too-large' && error?.code === 'package-resource-limit-invalid',
  'array maxBytes must not be promoted to budget 8 and reported as too-large',
);

/* Primitive positive safe integers keep their existing budgets. */
assert.throws(
  () => parseBoundedPackageInput(INPUT, { maxBytes: 8 }),
  (error) => error?.code === 'package-input-too-large',
  'number maxBytes below input size must still reject with the data-budget code',
);
{
  const parsed = parseBoundedPackageInput(INPUT, { maxBytes: 4096, maxDepth: 8, maxTokens: 4096, maxEntries: 4096, maxStrings: 64, maxStringBytes: 1024 });
  assert.equal(parsed.value.value, '0123456789');
}

/* Nullish options keep existing defaults. */
{
  const parsed = parseBoundedPackageInput(INPUT, { maxBytes: null, maxDepth: undefined });
  assert.equal(parsed.value.value, '0123456789');
}

process.stdout.write('issue-4550: all assertions passed\n');
