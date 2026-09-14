import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { STAGE2_PROFILE_EVIDENCE_IDS, validateStage2DenominatorLock } from '../../js/platform/stage2-profile-evidence.js';
import { buildStage2ProfileDenominatorInventory } from '../../tools/validation/stage2/build-profile-denominator-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.join(root, 'tools/validation/stage2/profile-denominator-inventory.json');
const tracked = JSON.parse(fs.readFileSync(file, 'utf8'));
const generated = buildStage2ProfileDenominatorInventory();

assert.deepEqual(tracked, generated, 'tracked profile denominator inventory must equal deterministic generation');
assert.deepEqual(Object.keys(tracked.items).sort(), [...STAGE2_PROFILE_EVIDENCE_IDS].sort());
for (const [itemId, item] of Object.entries(tracked.items)) {
  assert.ok(item.profiles.length > 0, `${itemId}: profiles required`);
  assert.ok(item.unitIds.length > 0, `${itemId}: units required`);
  assert.equal(new Set(item.unitIds).size, item.unitIds.length, `${itemId}: units unique`);
  assert.ok(item.inventoryRefs.includes('tools/validation/stage2/build-profile-denominator-inventory.mjs'), `${itemId}: generator identity required`);
  for (const profile of item.profiles) assert.ok(item.unitIds.some((unitId) => unitId.startsWith(`${profile}:`)), `${itemId}:${profile}: profile unit required`);
  for (const ref of item.inventoryRefs) assert.ok(fs.statSync(path.join(root, ref)).isFile(), `${itemId}:${ref}: inventory source exists`);
}

assert.ok(tracked.items['S1-A2-NATIVE'].unitIds.length >= 70, 'A2 must retain architecture families, PAC mnemonics, and explicit decoder gaps');
assert.equal(tracked.items['S2-A7-NATIVE'].unitIds.length, 56, 'A7 denominator is 14 operations across four native profiles');
assert.equal(tracked.items['S2-F6-PE'].unitIds.length, 24, 'PE and PE+ must retain separate F6 cells');

const scope = JSON.parse(fs.readFileSync(path.join(root, 'tools/validation/stage2/completion-scope.lock.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'tools/validation/stage2/profile-denominators.lock.json'), 'utf8'));
const resolveInventoryIdentity = (ref, itemId) => {
  if (!tracked.items[itemId]?.inventoryRefs.includes(ref)) return null;
  const result = spawnSync('git', ['rev-parse', `HEAD:${ref}`], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};
const resolveDenominatorUnitIds = (itemId, refs) => {
  const item = tracked.items[itemId];
  const actual = [...new Set((refs || []).map(String))].sort();
  return item && actual.length === item.inventoryRefs.length && actual.every((value, index) => value === item.inventoryRefs[index]) ? item.unitIds : [];
};
const lockValidation = validateStage2DenominatorLock(lock, { scope, resolveInventoryIdentity, resolveDenominatorUnitIds });
assert.equal(lockValidation.ok, true, JSON.stringify(lockValidation.failures));
console.log('[stage2] canonical profile denominator inventory passed');
