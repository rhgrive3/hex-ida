import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { classifyRootOrigin, analyzeEscape } from '../../../js/analysis/summary/escape.js';
import { createPointsToTarget, createRootDescriptorSeparatedTarget, exactRange } from '../../../js/analysis/pointsto/lattice.js';
import { fixture } from '../helpers/fixtures.mjs';
import { buildFixture } from '../corpus/fixtures.mjs';

/* A canonical root descriptor's storage class is producer-held evidence
 * (issue #5892): `global-like` normalizes to a `rooted` proof, but escape must
 * not demote it to an incoming argument. Only descriptor-backed authority
 * (`separationAuthority:'root-descriptor'`) counts. */

test('classifyRootOrigin: descriptor-backed global-like rooted target is global', () => {
  // The authority must cross the proof boundary (#6066); a plain string input
  // no longer mints descriptor-backed separation.
  const target = createRootDescriptorSeparatedTarget({
    addressSpace:'memory',
    rootKind:'rooted',
    rootEntityId:'global:G',
    offsetRange:exactRange(0n),
    widthBits:64,
    evidenceIds:['addr'],
  }, { separationClass:'global-like', separationAuthority:'root-descriptor' });
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

test('full pipeline: storing through a descriptor-backed global emits global provenance', () => {
  const descriptor = {
    kind:'global-like', rootEntityId:'global:G', baseOffset:0, addressSpace:'memory', linearOffsets:true,
  };
  const f = fixture('issue_5892_stored_to_global');
  f.block('entry', []);
  const globalAddress = f.stateRead('globalAddress', 'state:g_root');
  const storedValue = f.stateRead('storedValue', 'state:x0');
  f.store('publish', globalAddress, storedValue, { widthBits:64 });
  const built = f.build({ rootDescriptors:{ 'variable:state:g_root': descriptor } });
  const pointsTo = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    canonicalOptions:{ rootDescriptors:built.rootDescriptors },
  });
  assert.equal(pointsTo.status.completeness, 'complete');
  const globalTarget = pointsTo.pointsTo.get('globalAddress')?.targets?.[0];
  assert.equal(globalTarget?.separationClass, 'global-like');
  assert.equal(globalTarget?.separationAuthority, 'root-descriptor');

  const escape = analyzeEscape(built.ir, built.cfg, built.ssa, pointsTo, {});
  const records = escape.escapes.filter((record) => record.siteId === 'node_publish');
  assert.ok(records.some((record) => record.reason === 'stored-to-global' && record.boundary === 'global'),
    'the externally visible store result must identify global publication');
  assert.equal(records.some((record) => record.reason === 'stored-through-argument' && record.boundary === 'argument'), false,
    'a descriptor-backed global destination must not be reported as argument publication');
});

/* `rootDescriptorProvider` authority attachment is a separate producer-side
 * contract tracked by #5323. This p7 consumer slice must not silently broaden
 * into that alias-wrapper fix; the table path above is the available
 * descriptor-backed producer proof for #5892. */
