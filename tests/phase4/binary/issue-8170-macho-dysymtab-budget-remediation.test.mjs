import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSampleBinary } from '../../../js/sample.js';
import { parseMachO } from '../../../js/binary/macho.js';

function hasReservedAuthority(section) {
  return Object.hasOwn(section ?? {}, 'reserved1') ||
    Object.hasOwn(section ?? {}, 'reserved2') ||
    Object.hasOwn(section ?? {}, 'reserved3');
}

test('#8170: pre-aborted parse publishes no second-pass indirect metadata', () => {
  const controller = new AbortController();
  controller.abort();
  const image = parseMachO(buildSampleBinary(), { signal: controller.signal });

  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.includes('budget:aborted'));
  assert.equal(image.metadata.indirectSymbols, undefined);
  assert.equal(image.metadata.dysymtab, undefined);
  assert.equal(image.sections.some(hasReservedAuthority), false);
});

test('#8170: an already-stopped shared budget cannot attach reserved fields or indirect metadata', () => {
  const image = parseMachO(buildSampleBinary(), { metadataLimits: { records: 2 } });
  const stubs = image.sections.find((section) => section.name === '__stubs');

  assert.ok(stubs, 'the early __TEXT segment must be admitted before record exhaustion');
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((reason) => reason.startsWith('budget:')));
  assert.equal(hasReservedAuthority(stubs), false, 'post-pass must not mutate admitted sections after stop');
  assert.equal(image.metadata.indirectSymbols, undefined);
  assert.equal(image.metadata.dysymtab, undefined);
});

test('#8170: ordinary parsing still attaches reserved fields and indirect import sites', () => {
  const image = parseMachO(buildSampleBinary());
  const stubs = image.sections.find((section) => section.name === '__stubs');
  const got = image.sections.find((section) => section.name === '__got');
  const puts = image.imports.find((entry) => entry.name === '_puts');

  assert.equal(stubs?.reserved1, 0);
  assert.equal(stubs?.reserved2, 12);
  assert.equal(got?.reserved1, 1);
  assert.deepEqual((puts?.sites ?? []).map((site) => site.kind).sort(), [
    'indirect-symbol-pointer',
    'indirect-symbol-stub',
  ]);
  assert.equal(image.metadata.indirectSymbols?.complete, true);
});
