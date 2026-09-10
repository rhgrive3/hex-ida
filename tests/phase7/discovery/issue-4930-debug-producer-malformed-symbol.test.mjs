import assert from 'node:assert/strict';
import test from 'node:test';

import { createDebugRecord } from '../../../js/analysis/debug/provider.js';
import { createDebugEvidenceProducer } from '../../../js/analysis/discovery/producers.js';

const base = { kind: 'symbol', providerId: 'provider', providerVersion: '1' };

function record(input) {
  return createDebugRecord({ ...base, ...input });
}

test('#4930 a malformed address symbol cannot abort the debug evidence producer', () => {
  const malformed = record({ entityId: 'sym-bad', address: 'not-an-address', sizeBytes: 16, name: 'badSymbol' });
  const good = record({ entityId: 'sym-good', address: '0x1000', sizeBytes: 32, name: 'goodSymbol' });

  const producer = createDebugEvidenceProducer([malformed, good]);
  const produced = producer.produce();

  assert.equal(produced.length, 1, 'only the usable symbol is produced');
  assert.equal(produced[0].start, '4096');
  assert.equal(produced[0].name, 'goodSymbol');
  assert.equal(produced[0].regions.length, 1, 'the valid symbol keeps its extent region');
});

test('#4930 a malformed size degrades to a region-less row instead of throwing', () => {
  const good = record({ entityId: 'sym-good', address: '0x1000', sizeBytes: 32, name: 'goodSymbol' });
  const badSize = { address: '0x2000', sizeBytes: 'not-a-size', name: 'sizeSymbol' };

  const produced = createDebugEvidenceProducer([good, badSize]).produce();
  assert.equal(produced.length, 2);
  assert.equal(produced[1].start, '8192');
  assert.deepEqual(produced[1].regions, [], 'garbage size yields no region');
});

test('#4930 valid debug evidence keeps producing identical rows', () => {
  const a = record({ entityId: 'sym-a', address: '0x1000', sizeBytes: 16, name: 'a' });
  const b = record({ entityId: 'sym-b', address: '0x2000', name: 'b' });

  const produced = createDebugEvidenceProducer([a, b]).produce();
  assert.deepEqual(produced.map((row) => row.start), ['4096', '8192']);
  assert.equal(produced[0].regions.length, 1);
  assert.deepEqual(produced[1].regions, []);
});
