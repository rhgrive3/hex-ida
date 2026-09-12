import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryRegionId } from '../js/core/identity/index.js';
import { createMemoryRegionRef } from '../js/semantics/memoryssa/contract.js';
import { aliasMemoryRegions } from '../js/analysis/alias/legacy-safety-floor.js';
import { deriveMemoryRegion } from '../js/analysis/alias/regions-v2.js';

const LOSSY_VALUES = [
  ['undefined', () => ({ source: undefined })],
  ['function', () => ({ source: () => 1 })],
  ['symbol', () => ({ source: Symbol.for('root') })],
];

function canonicalIdentity(rootIdentity) {
  return { addressSpace: 'io-space-0', rootIdentity, widthBits: 32 };
}

function regionId(rootIdentity) {
  return createMemoryRegionId({
    binaryId: 'bin-A',
    regionKind: 'io',
    canonicalRegionIdentity: canonicalIdentity(rootIdentity),
  });
}

function region(rootIdentity, instructionId = 'insn-A') {
  return createMemoryRegionRef({
    id: `region-${instructionId}`,
    kind: 'io',
    binaryId: 'bin-A',
    addressSpace: 'io-space-0',
    rootIdentity,
    widthBits: 32,
    origin: { instructionIds: [instructionId] },
  });
}

function derived(rootIdentity) {
  return deriveMemoryRegion({
    functionId: 'fn-A',
    binaryId: 'bin-A',
    widthBits: 32,
    origin: { byteRanges: [{ binaryId: 'bin-A', start: 0, end: 4 }] },
    regionEvidence: { kind: 'physical-space', addressSpace: 'phys-0', rootIdentity },
  });
}

test('#5164 undefined-valued root identity does not collapse onto an empty root identity', () => {
  assert.notEqual(regionId({ source: undefined }), regionId({}));
  assert.notDeepEqual(region({ source: undefined }).rootIdentity, region({}).rootIdentity);
});

test('#5164 lossy-typed root identities stay type-distinguished on the public region', () => {
  const empty = region({});
  for (const [label, make] of LOSSY_VALUES) {
    const value = make();
    assert.notDeepEqual(region(value).rootIdentity, empty.rootIdentity, `${label} must not erase into {}`);
    assert.notEqual(regionId(value), regionId({}), `${label} must not collide with the empty root id`);
  }
});

test('#5164 lossy root identity collisions cannot mint a must alias', () => {
  for (const [, make] of LOSSY_VALUES) {
    const a = region(make(), 'insn-A');
    const b = region({}, 'insn-B');
    assert.notEqual(aliasMemoryRegions(a, b), 'must');
    assert.notEqual(aliasMemoryRegions(b, a), 'must');
  }
  const fn = region({ source: () => 1 }, 'insn-A');
  const sym = region({ source: Symbol.for('root') }, 'insn-B');
  assert.notEqual(aliasMemoryRegions(fn, sym), 'must');
});

test('#5164 malformed root identities never prove same storage through the floor', () => {
  const bare = { kind: 'io', binaryId: 'bin-A', addressSpace: 'io-space-0', widthBits: 32, origin: { instructionIds: ['i'] } };
  assert.notEqual(aliasMemoryRegions({ ...bare, id: 'r-a', rootIdentity: { source: undefined } }, { ...bare, id: 'r-b', rootIdentity: {} }), 'must');
  assert.notEqual(aliasMemoryRegions({ ...bare, id: 'r-a', rootIdentity: { at: new Date(0) } }, { ...bare, id: 'r-b', rootIdentity: '1970-01-01T00:00:00.000Z' }), 'must');
  assert.notEqual(aliasMemoryRegions({ ...bare, id: 'r-a', rootIdentity: { n: 1n } }, { ...bare, id: 'r-b', rootIdentity: { n: '1' } }), 'must');
});

test('#5164 canonical plain-data root identities still prove must alias', () => {
  assert.equal(aliasMemoryRegions(region({ port: 'x' }), region({ port: 'x' }, 'insn-B')), 'must');
  assert.equal(
    aliasMemoryRegions(region({ alpha: 1, beta: [2, 3] }, 'insn-A'), region({ beta: [2, 3], alpha: 1 }, 'insn-B')),
    'must',
  );
  assert.notEqual(aliasMemoryRegions(region({ port: 'x' }), region({ port: 'y' })), 'must');
});

test('#5164 region id and region ref share one canonical root identity semantics', () => {
  assert.throws(() => regionId({ source: NaN }), TypeError);
  assert.throws(() => region({ source: NaN }), (err) => err.message === 'memory-ssa-invalid-region-root-identity');
  assert.throws(() => region({ source: Infinity }), (err) => err.message === 'memory-ssa-invalid-region-root-identity');
  assert.throws(() => region({ source: 2 ** 53 }), (err) => err.message === 'memory-ssa-invalid-region-root-identity');
  assert.deepEqual(region({ port: 'x' }).rootIdentity, { port: 'x' });
});

test('#5164 derived physical regions keep distinct roots distinct', () => {
  const undefinedRoot = derived({ source: undefined });
  const emptyRoot = derived({});
  assert.equal(undefinedRoot.kind, 'physical-space');
  assert.equal(emptyRoot.kind, 'physical-space');
  assert.notEqual(undefinedRoot.id, emptyRoot.id);
  assert.notEqual(aliasMemoryRegions(undefinedRoot, emptyRoot), 'must');
});

test('#5164 stack, global, and rooted-offset alias rules stay non-regressive', () => {
  const stack = (offset) => createMemoryRegionRef({
    id: `stack-${offset}`,
    kind: 'stack-fixed',
    functionId: 'fn-A',
    offset,
    widthBits: 32,
    origin: { instructionIds: ['insn-A'] },
  });
  assert.equal(aliasMemoryRegions(stack('16'), stack('16')), 'must');
  assert.equal(aliasMemoryRegions(stack('0'), stack('64')), 'no');
  assert.equal(aliasMemoryRegions(stack('0'), stack('2')), 'may');

  const global = (address) => createMemoryRegionRef({
    id: `global-${address}`,
    kind: 'global-absolute',
    binaryId: 'bin-A',
    address,
    widthBits: 32,
    origin: { instructionIds: ['insn-A'] },
  });
  assert.equal(aliasMemoryRegions(global('4096'), global('4096')), 'must');
  assert.equal(aliasMemoryRegions(global('4096'), global('8192')), 'no');

  const rooted = (offset, addressSpace) => createMemoryRegionRef({
    id: `rooted-${offset}-${addressSpace ?? 'memory'}`,
    kind: 'rooted-offset',
    functionId: 'fn-A',
    rootEntityId: 'entity-A',
    offset,
    ...(addressSpace == null ? {} : { addressSpace }),
    widthBits: 32,
    origin: { instructionIds: ['insn-A'] },
  });
  assert.equal(aliasMemoryRegions(rooted('8'), rooted('8')), 'must');
  assert.equal(aliasMemoryRegions(rooted('8'), rooted('8', 'tls')), 'no');
});
