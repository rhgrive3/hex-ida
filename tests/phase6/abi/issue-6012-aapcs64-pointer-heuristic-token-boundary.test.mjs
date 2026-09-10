import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyAAPCS64Arguments } from '../../../js/targets/abi/aapcs64-core.js';
import { classifyDarwinArm64Arguments } from '../../../js/targets/abi/darwin-arm64.js';
import { classifySysVAMD64Arguments } from '../../../js/targets/abi/sysv-amd64.js';
import { classifyMicrosoftX64Arguments } from '../../../js/targets/abi/microsoft-x64.js';

/* Issue #6012: the pointer heuristic matched `class`/`ptr`/`object`/`block`/
 * `closure` anywhere inside the type text, so an opaque identifier such as
 * `classification_t` was classified as a pointer. Because AAPCS64 gates the
 * aggregate path on `!pointer`, that substring alone changed the physical
 * allocation of a fully-described by-value aggregate (x0+x1 became x0). The
 * heuristic now requires token boundaries, so only real pointer spellings
 * match. */
const AGGREGATE = {
  aggregate:true,
  bits:128,
  bytes:16,
  members:[
    { bits:64, bytes:8, byteOffset:0 },
    { bits:64, bytes:8, byteOffset:8 },
  ],
};

function aapcs64(type, extra = {}) {
  return classifyAAPCS64Arguments({ callPrototype:{ args:[{ type, ...AGGREGATE, ...extra }] } }).arguments[0];
}

function darwin(type, extra = {}) {
  return classifyDarwinArm64Arguments({ callPrototype:{ args:[{ type, ...AGGREGATE, alignmentBytes:8, ...extra }] } }).arguments[0];
}

test('#6012: identifier substrings must not turn an explicit aggregate into a pointer (AAPCS64)', () => {
  const reference = aapcs64('value_t');
  assert.equal(reference.location, 'registers');
  assert.deepEqual(reference.regs, ['x0','x1']);
  assert.equal(reference.aggregate, true);
  assert.equal(reference.pointer, false);
  for (const type of ['classification_t','descriptor_t','blocksize_t','object_count_t']) {
    const arg = aapcs64(type);
    assert.deepEqual(
      { location:arg.location, regs:arg.regs, aggregate:arg.aggregate, pointer:arg.pointer },
      { location:reference.location, regs:reference.regs, aggregate:reference.aggregate, pointer:reference.pointer },
      `${type} must classify identically to value_t`,
    );
  }
});

test('#6012: same substring discipline holds for the Darwin arm64 classifier', () => {
  const reference = darwin('value_t');
  assert.deepEqual(reference.regs, ['x0','x1']);
  assert.equal(reference.aggregate, true);
  for (const type of ['classification_t','descriptor_t','blocksize_t','object_count_t']) {
    const arg = darwin(type);
    assert.deepEqual(arg.regs, reference.regs, `${type} must classify identically to value_t`);
    assert.equal(arg.aggregate, true);
    assert.equal(arg.pointer, false);
  }
});

test('#6012: real pointer spellings still classify as pointers', () => {
  for (const classify of [aapcs64, darwin]) {
    const starred = classify('Foo *');
    assert.equal(starred.pointer, true);
    assert.ok(!starred.aggregate, 'pointer declarator wins over the aggregate path');
    const token = classify('class');
    assert.equal(token.pointer, true);
  }
});

test('#6012: explicit pointer metadata keeps priority over type text', () => {
  for (const classify of [aapcs64, darwin]) {
    const explicit = classify('value_t');
    assert.equal(explicit.aggregate, true);
    const flagged = classify('value_t', { pointer:true });
    assert.equal(flagged.pointer, true);
    assert.equal(flagged.aggregate ?? false, false);
  }
});

test('#6012: large aggregates keep the indirect path and >16-byte layout rules', () => {
  const wide = classifyAAPCS64Arguments({ callPrototype:{ args:[{
    type:'struct Wide',
    aggregate:true,
    bits:192,
    bytes:24,
    members:[
      { bits:64, bytes:8, byteOffset:0 },
      { bits:64, bytes:8, byteOffset:8 },
      { bits:64, bytes:8, byteOffset:16 },
    ],
  }] } }).arguments[0];
  assert.equal(wide.pointer, true, '>16-byte aggregates remain an indirect copy');
  for (const [label, classify] of [
    ['sysv-amd64', classifySysVAMD64Arguments],
    ['microsoft-x64', classifyMicrosoftX64Arguments],
  ]) {
    const opaque = classify({ callPrototype:{ args:[{ type:'classification_t' }] } }).arguments[0];
    assert.equal(opaque.pointer, false, `${label}: opaque identifier must not match the pointer heuristic`);
    const pointer = classify({ callPrototype:{ args:[{ type:'classification_t *' }] } }).arguments[0];
    assert.equal(pointer.pointer, true, `${label}: a real pointer declarator must still match`);
  }
});
