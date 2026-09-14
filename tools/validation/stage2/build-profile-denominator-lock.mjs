import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStage2DenominatorLock } from '../../../js/platform/stage2-profile-evidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INVENTORY_PATH = path.join(ROOT, 'tools/validation/stage2/profile-denominator-inventory.json');
const SCOPE_PATH = path.join(ROOT, 'tools/validation/stage2/completion-scope.lock.json');
const OUTPUT_PATH = path.join(ROOT, 'tools/validation/stage2/profile-denominators.lock.json');

function gitBlobIdentity(ref) {
  const result = spawnSync('git', ['rev-parse', `HEAD:${ref}`], { cwd: ROOT, encoding: 'utf8' });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return /^[0-9a-f]{40}$/.test(value) ? value : null;
}

const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
const scope = JSON.parse(fs.readFileSync(SCOPE_PATH, 'utf8'));
const resolveInventoryIdentity = (ref, itemId) => inventory.items?.[itemId]?.inventoryRefs?.includes(ref) ? gitBlobIdentity(ref) : null;
const resolveDenominatorUnitIds = (itemId, refs) => {
  const item = inventory.items?.[itemId];
  if (!item) return [];
  const actual = [...new Set((refs || []).map(String))].sort();
  const expected = [...new Set(item.inventoryRefs.map(String))].sort();
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]) ? item.unitIds : [];
};

const lock = createStage2DenominatorLock({ items: inventory.items }, {
  scope,
  resolveInventoryIdentity,
  resolveDenominatorUnitIds,
});
fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(lock, null, 2)}\n`);
