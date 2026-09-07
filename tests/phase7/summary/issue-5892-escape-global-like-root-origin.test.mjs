import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { classifyRootOrigin, analyzeEscape } from '../../../js/analysis/summary/escape.js';
import { createPointsToTarget, exactRange } from '../../../js/analysis/pointsto/lattice.js';
import { buildFixture } from '../corpus/fixtures.mjs';

/* A canonical root descriptor's storage class is producer-held evidence
 * (issue #5892): `global-like` normalizes to a `rooted` proof, but escape must
 * not demote it to an incoming argument. Only descriptor-backed authority
 * (`separationAuthority:'root-descriptor'`) counts. */

test('classifyRootOrigin: descriptor-backed global-like rooted target is global', () => {
  const target = createPointsToTarget({
    addressSpace:'memory',
    rootKind:'rooted',
    rootEntityId:'global:G',
    separationClass:'global-like',
    separationAuthority:'root-descriptor',
    offsetRange:exactRange(0n),
    widthBits:64,
    evidenceIds:['addr'],
  });
  assert.equal(classifyRootOrigin(target), 'global');
});

test('classifyRootOrigin: unproven rooted targets stay incoming', () => {
  const target = createPointsToTarget({
    addressSpace:'memory',
    rootKind:'rooted',
    rootEntityId:'arg:A',
    offsetRange:exactRange(0n),
    widthBits:64,
    evidenceIds:['addr'],
  });
  assert.equal(classifyRootOrigin(target), 'incoming');
});

test('classifyRootOrigin: a bare separationClass without authority cannot mint a global', () => {
  const manual = createPointsToTarget({
    addressSpace:'memory',
    rootKind:'rooted',
    rootEntityId:'arg:A',
    separationClass:'global-like',
    offsetRange:exactRange(0n),
    widthBits:64,
    evidenceIds:['addr'],
  });
  assert.equal(classifyRootOrigin(manual), 'incoming');
});

test('classifyRootOrigin: absolute targets stay global; stack/allocation paths unchanged', () => {
  const absolute = createPointsToTarget({
    addressSpace:'memory', rootKind:'absolute', offsetRange:exactRange(0n), widthBits:64,
  });
  assert.equal(classifyRootOrigin(absolute), 'global');
  const stack = createPointsToTarget({
    addressSpace:'memory', rootKind:'stack-like', offsetRange:exactRange(0n), widthBits:64,
  });
  assert.equal(classifyRootOrigin(stack), 'local-frame');
  assert.equal(classifyRootOrigin({ rootKey:'k', rootKind:'rooted' }, { allocationRootKeys:new Set(['k']) }), 'local-allocation');
  assert.equal(classifyRootOrigin(null), 'unknown');
});

test('full pipeline: global-identical fixture keeps the descriptor storage class as global origin', () => {
  const built = buildFixture('global-identical');
  const pointsTo = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    canonicalOptions:{ rootDescriptors:built.rootDescriptors },
  });
  const escape = analyzeEscape(built.ir, built.cfg, built.ssa, pointsTo, {});
  const origins = [...escape.rootOrigins.values()];
  assert.ok(origins.includes('global'),
    'the descriptor-backed global root must classify as global, not incoming');
  assert.ok(origins.every((origin) => origin !== 'incoming' || false),
    'no descriptor-backed global root may be recorded as incoming');
  assert.ok([...escape.rootOrigins.keys()].every((key) => {
    const parsed = JSON.parse(key);
    return parsed.separationClass !== 'global-like' || parsed.separationAuthority !== 'root-descriptor'
      || escape.rootOrigins.get(key) === 'global';
  }), 'every descriptor-backed global-like root must be classified global');
});
