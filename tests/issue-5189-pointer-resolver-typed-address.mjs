import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMachOPointer } from '../js/binary/macho-dyld.js';

// #5189 — resolveMachOPointer is a pointer-authority boundary: rawValue and
// options.address must be pointer primitives, not BigInt()-coercible shapes.
const image = {
  sectionAt: (address) => (address === 4096n ? { address: 4096n } : null),
  segmentAt: () => null,
};

test('#5189 resolveMachOPointer rejects structured rawValue coercion', () => {
  // Canonical inputs keep resolving.
  assert.equal(resolveMachOPointer(image, 4096n), 4096n);
  assert.equal(resolveMachOPointer(image, 4096), 4096n);
  assert.equal(resolveMachOPointer(image, '4096'), 4096n);
  assert.equal(resolveMachOPointer(image, '0x1000'), 4096n);

  // Structured/boolean laundering must fail closed.
  assert.equal(resolveMachOPointer(image, ['4096']), null, 'array rawValue must not become an address');
  assert.equal(resolveMachOPointer(image, { toString: () => '4096' }), null, 'object rawValue must not become an address');
  assert.equal(resolveMachOPointer(image, true), null, 'boolean rawValue must not become an address');
  assert.equal(resolveMachOPointer(image, () => 4096), null, 'function rawValue must not become an address');
  assert.equal(resolveMachOPointer(image, '  4096  '), null, 'untrimmed numeric string must not canonicalize');
  assert.equal(resolveMachOPointer(image, Number.NaN), null);
  assert.equal(resolveMachOPointer(image, 4096.5), null);
});

test('#5189 chained site address accepts only pointer primitives', () => {
  const chained = {
    sectionAt: image.sectionAt,
    segmentAt: image.segmentAt,
    __chainedSiteAt: new Map([[4096n, { raw: 4097n, decoded: { bind: false, target: 4096n } }]]),
  };
  // Non-standard image shape: the site map is internal, so drive it through
  // the public boundary by resolving a raw value at a structured address.
  assert.equal(resolveMachOPointer(image, '4096', { address: ['4096'] }), null, 'structured options.address must not alias a site');
  assert.equal(resolveMachOPointer(image, '4096', { address: true }), null);
  assert.equal(resolveMachOPointer(image, '4096', { address: { valueOf: () => 4096 } }), null);
  assert.equal(resolveMachOPointer(image, '4096', { address: 4096n }), 4096n, 'canonical bigint address keeps resolving');
});
