import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { parseMachO } from '../../js/binary/macho-core.js';
import { machoSymbolTruth } from '../../js/platform/analysis-result.js';

function minimalMachO64() {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  view.setInt32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  view.setInt32(8, 0, true);
  view.setUint32(12, 2, true); // MH_EXECUTE
  view.setUint32(16, 0, true); // ncmds
  view.setUint32(20, 0, true); // sizeofcmds
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  return bytes;
}

const complete = { complete: true };
const completeDyld = { complete: true, streams: {} };

for (const [name, metadata] of [
  ['metadata budget only', { machoMetadata: complete }],
  ['chained fixups only', { chainedFixups: complete }],
  ['export trie only', { exportTrie: complete }],
  ['dyld bindings only', { dyldBindings: completeDyld }],
]) {
  test(`${name} cannot prove parser-wide symbol completeness`, () => {
    const truth = machoSymbolTruth({ format: 'macho', metadata });
    assert.equal(truth.complete, false);
    assert.ok(truth.reasons.includes('symbol-metadata-unavailable'));
  });
}

test('all required components need explicit complete/not-present evidence', () => {
  const truth = machoSymbolTruth({
    format: 'macho',
    metadata: {
      machoMetadata: { complete: true },
      chainedFixups: { complete: true, notPresent: true },
      exportTrie: { complete: true, notPresent: true },
      dyldBindings: { complete: true, notPresent: true, streams: {} },
    },
  });
  assert.equal(truth.complete, true);
  assert.deepEqual(truth.reasons, []);
});

test('notPresent without complete authority fails closed', () => {
  const truth = machoSymbolTruth({
    format: 'macho',
    metadata: {
      machoMetadata: { complete: true },
      chainedFixups: { notPresent: true },
      exportTrie: { complete: true, notPresent: true },
      dyldBindings: { complete: true, notPresent: true, streams: {} },
    },
  });
  assert.equal(truth.complete, false);
  assert.ok(truth.reasons.includes('symbol-metadata-unavailable'));
});

test('real loader records explicit absence after a complete load-command scan', () => {
  const image = parseMachO(minimalMachO64());
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.metadata.chainedFixups, undefined);
  assert.equal(image.metadata.exportTrie, undefined);
  assert.equal(image.metadata.dyldBindings, undefined);
  const truth = machoSymbolTruth(image);
  assert.equal(truth.complete, true);
  assert.deepEqual(truth.components.chainedFixups, { complete: true, notPresent: true });
  assert.deepEqual(truth.components.exportTrie, { complete: true, notPresent: true });
  assert.deepEqual(truth.components.dyldBindings, { complete: true, notPresent: true, streams: {} });
});


test('parser-scan authority is primitive-safe and never coerces loadCommands', () => {
  let coercions = 0;
  const hostile = {
    valueOf() { coercions++; return 0; },
    toString() { coercions++; return '0'; },
  };
  for (const loadCommands of ['0', [], new Number(0), hostile, NaN, Infinity, -1, 0.5]) {
    const truth = machoSymbolTruth({
      format: 'macho',
      metadata: { loadCommands, machoMetadata: { complete: true } },
    });
    assert.equal(truth.complete, false);
    assert.ok(truth.reasons.includes('symbol-metadata-unavailable'));
  }
  assert.equal(coercions, 0);
});

test('loadCommands authority is sampled once before normalization', () => {
  let reads = 0;
  const metadata = {
    machoMetadata: { complete: true },
    get loadCommands() { reads++; return 0; },
  };
  const truth = machoSymbolTruth({ format: 'macho', metadata });
  assert.equal(truth.complete, true);
  assert.equal(reads, 1);
  assert.equal(truth.components.chainedFixups.notPresent, true);
});

test('cross-realm component records keep capability-based completeness', () => {
  const foreign = vm.runInNewContext(`({
    machoMetadata: { complete: true },
    chainedFixups: { complete: true, notPresent: true },
    exportTrie: { complete: true, notPresent: true },
    dyldBindings: { complete: true, notPresent: true, streams: {} }
  })`);
  const truth = machoSymbolTruth({ format: 'macho', metadata: foreign });
  assert.equal(truth.complete, true);
  assert.deepEqual(truth.reasons, []);
});

test('non-Mach-O remains outside this truth contract', () => {
  assert.equal(machoSymbolTruth({ format: 'elf', metadata: {} }), null);
});
