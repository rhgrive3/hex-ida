import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DiscoveryProducerRegistry,
  fuseFunctionCandidates,
} from '../../../js/analysis/discovery/fusion.js';
import { createDebugEvidenceProducer } from '../../../js/analysis/discovery/producers.js';
import { BinaryImage } from '../../../js/binary/model.js';

function segment({ base, size, fileSize = size, execute = true }) {
  return {
    address: base,
    size,
    fileOffset: 0n,
    fileSize,
    perms: { read: true, write: false, execute },
  };
}

function targetImage(segments) {
  return {
    segments,
    segmentAt(address) {
      const value = BigInt(address);
      return segments.find((entry) => value >= entry.address && value < entry.address + entry.size) ?? null;
    },
    resolveVirtualMapping(address) {
      const value = BigInt(address);
      const owner = segments.find((entry) => value >= entry.address && value < entry.address + entry.size);
      if (!owner) return null;
      const delta = value - owner.address;
      const fileBacked = delta < owner.fileSize;
      const minBigInt = (a, b) => (a < b ? a : b);
      return {
        kind: fileBacked ? 'file' : 'zero',
        mapping: owner,
        offset: fileBacked ? owner.fileOffset + delta : null,
        available: fileBacked ? minBigInt(owner.fileSize - delta, owner.size - delta) : owner.size - delta,
      };
    },
  };
}

function row({ address = '0x1000', sizeBytes = null, name = 'fn' } = {}) {
  return {
    kind: 'debug-symbol',
    address,
    sizeBytes,
    name,
    confidence: 'exact',
    providerId: 'pdb',
    providerVersion: '1',
    buildIdentity: 'build-A',
    evidenceIds: [`debug:${name}`],
  };
}

function produceDebug(rows, input) {
  const registry = new DiscoveryProducerRegistry();
  registry.register(createDebugEvidenceProducer(rows));
  const collected = registry.collect(input, 'arm64');
  return {
    evidence: collected.evidence,
    fused: fuseFunctionCandidates(collected.evidence, {
      architectureId: 'arm64',
      snapshotId: 'snapshot-8833',
    }),
  };
}

const CODE = () => [segment({ base: 0x1000n, size: 0x40n })];

test('#8833 exact debug start inside an executable file-backed mapping retains authoritative exact', () => {
  const { evidence, fused } = produceDebug([row({})], { image: targetImage(CODE()) });
  assert.equal(evidence[0].kind, 'debug-symbol');
  assert.equal(evidence[0].authority, 'authoritative');
  assert.equal(fused.candidates[0].startState, 'exact');
});

test('#8833 exact debug start at a non-executable section is downgraded, never authoritative', () => {
  const image = targetImage([
    segment({ base: 0x1000n, size: 0x40n, execute: false }),
  ]);
  const { evidence, fused } = produceDebug([row({})], { image });
  assert.equal(evidence.length, 1, 'rejected record remains available as diagnostic evidence');
  assert.equal(evidence[0].kind, 'debug-symbol-heuristic');
  assert.equal(evidence[0].authority, 'heuristic');
  assert.equal(fused.candidates[0].startState, 'heuristic');
});

test('#8833 exact debug start at an unmapped address is downgraded', () => {
  const { evidence, fused } = produceDebug([row({ address: '0x9000' })], { image: targetImage(CODE()) });
  assert.equal(evidence[0].kind, 'debug-symbol-heuristic');
  assert.equal(fused.candidates[0].startState, 'heuristic');
});

test('#8833 fixed-width start with only 1/2/3 bytes file-backed gets no exact start', () => {
  for (const tailSize of [1n, 2n, 3n]) {
    const image = targetImage([segment({ base: 0x1000n, size: 0x40n, fileSize: tailSize })]);
    const { evidence, fused } = produceDebug([row({})], { image });
    assert.equal(evidence[0].kind, 'debug-symbol-heuristic', `tailSize ${tailSize}`);
    assert.equal(fused.candidates[0].startState, 'heuristic');
  }
});

test('#8833 extent crossing a zero-fill tail never becomes an exact extent', () => {
  const image = targetImage([segment({ base: 0x1000n, size: 0x40n, fileSize: 0x10n })]);
  const { evidence, fused } = produceDebug([row({ sizeBytes: 0x20 })], { image });
  assert.equal(evidence[0].kind, 'debug-symbol-heuristic');
  assert.equal(fused.candidates[0].extentState, 'heuristic');
});

test('#8833 exact-fit extent ending at the proving executable mapping boundary remains exact', () => {
  const image = targetImage([
    segment({ base: 0x1000n, size: 0x40n }),
    segment({ base: 0x1040n, size: 0x40n, execute: false }),
  ]);
  const { evidence, fused } = produceDebug([row({ sizeBytes: 0x40 })], { image });
  assert.equal(evidence[0].kind, 'debug-symbol');
  assert.equal(evidence[0].authority, 'authoritative');
  assert.equal(fused.candidates[0].extentState, 'exact');
});

test('#8833 extent leaving the proving executable segment is downgraded', () => {
  const image = targetImage([
    segment({ base: 0x1000n, size: 0x40n }),
    segment({ base: 0x1040n, size: 0x40n, execute: false }),
  ]);
  const { evidence, fused } = produceDebug([row({ sizeBytes: 0x41 })], { image });
  assert.equal(evidence[0].kind, 'debug-symbol-heuristic');
  assert.equal(fused.candidates[0].extentState, 'heuristic');
});

test('#8833 start inside one segment crossing into the next segment is not provable contiguity', () => {
  const image = targetImage([
    segment({ base: 0x1000n, size: 0x4n }),
    segment({ base: 0x1004n, size: 0x40n }),
  ]);
  const { evidence } = produceDebug([row({ sizeBytes: 0x8 })], { image });
  assert.equal(evidence[0].kind, 'debug-symbol-heuristic');
});

test('#8833 ISA-aware minimum span relaxes the fixed-width default only when proven', () => {
  const thin = targetImage([segment({ base: 0x1000n, size: 0x40n, fileSize: 1n })]);
  const narrowed = produceDebug([row({})], { image: thin, minimumInstructionBytes: 1 });
  assert.equal(narrowed.evidence[0].kind, 'debug-symbol');
  assert.equal(narrowed.fused.candidates[0].startState, 'exact');
});

test('#8833 invalid minimum span claims fail closed instead of laundering exactness', () => {
  for (const bad of ['4', 0, 65, 1.5, {}, []]) {
    const { evidence } = produceDebug([row({})], {
      image: targetImage(CODE()),
      minimumInstructionBytes: bad,
    });
    assert.equal(evidence[0].kind, 'debug-symbol-heuristic', `input ${JSON.stringify(String(bad))}`);
  }
});

test('#8833 missing or malformed target authority never mints an exact debug start', () => {
  for (const input of [undefined, {}, { image: null }, { image: { segments: [] } }, { image: targetImage([]) }]) {
    const { evidence } = produceDebug([row({})], input);
    assert.equal(evidence[0].kind, 'debug-symbol-heuristic');
  }
});

test('#8833 heuristic rows are unaffected by the mapping gate', () => {
  const weak = { ...row({ address: '0x9000' }), confidence: 'heuristic' };
  const { evidence } = produceDebug([weak], { image: targetImage(CODE()) });
  assert.equal(evidence[0].kind, 'debug-symbol-heuristic');
  assert.equal(evidence[0].confidence, 'heuristic');
});

function overlappingImage(sectionName, sectionExecute) {
  const image = new BinaryImage(new Uint8Array(0x1200), { format: 'elf', arch: 'aarch64' });
  image.addSegment({
    name: 'RX-code',
    address: 0x1000n,
    size: 0x100n,
    fileOffset: 0x1000n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: true },
  });
  image.addSection({
    name: sectionName,
    segment: 'RX-code',
    address: 0x1040n,
    size: 0x20n,
    fileOffset: 0x1040n,
    fileSize: 0x20n,
    perms: { read: true, write: false, execute: sectionExecute },
    flags: 0x2n | (sectionExecute ? 0x4n : 0n),
    source: 'section-header',
  });
  return image;
}

test('#8833 real BinaryImage overlap: executable segment, non-executable canonical owner, stays heuristic', () => {
  const image = overlappingImage('.rodata', false);
  assert.equal(image.segmentAt(0x1040n).perms.execute, true);
  const canonical = image.resolveVirtualMapping(0x1040n);
  assert.equal(canonical.kind, 'file');
  assert.equal(canonical.mapping.perms.execute, false);
  assert.equal(canonical.available, 32n);
  const { evidence, fused } = produceDebug([row({ address: '0x1040', sizeBytes: 0 })], { image });
  assert.equal(evidence[0].kind, 'debug-symbol-heuristic');
  assert.equal(evidence[0].authority, 'heuristic');
  assert.equal(fused.candidates[0].startState, 'heuristic');
});

test('#8833 real BinaryImage overlap positive control: executable canonical owner retains exact authority', () => {
  const image = overlappingImage('.text', true);
  const canonical = image.resolveVirtualMapping(0x1040n);
  assert.equal(canonical.kind, 'file');
  assert.equal(canonical.mapping.perms.execute, true);
  assert.equal(canonical.available, 32n);
  const { evidence, fused } = produceDebug([row({ address: '0x1040', sizeBytes: 0 })], { image });
  assert.equal(evidence[0].kind, 'debug-symbol');
  assert.equal(evidence[0].authority, 'authoritative');
  assert.equal(fused.candidates[0].startState, 'exact');
});
