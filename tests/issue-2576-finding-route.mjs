import assert from 'node:assert/strict';
import { findFindingById, findingAddress, findingIdentity } from '../js/ui/finding-route.js';

const addressless = { id: 'finding-addressless', title: 'No address yet', evidence: [] };
const goalBacked = { goal: { id: 'goal-stable', text: 'Goal finding' }, address: 0x1234n };
const legacy = { title: 'Legacy without stable id', address: 0x5678n };
const findings = [addressless, goalBacked, legacy];

assert.equal(findingIdentity(addressless), 'finding-addressless');
assert.equal(findingIdentity(goalBacked), 'goal-stable');
assert.equal(findingIdentity(legacy), null, 'must not invent an array-index route identity');
assert.equal(findFindingById(findings, 'finding-addressless'), addressless, 'addressless findings remain routable by stable id');
assert.equal(findFindingById(findings, 'goal-stable'), goalBacked);
assert.equal(findFindingById(findings, '0'), null, 'array positions are not accepted as finding ids');
assert.equal(findFindingById(findings, 'missing'), null, 'unknown ids must not fall back to the results list');
assert.equal(findingAddress(addressless), null);
assert.equal(findingAddress(goalBacked), 0x1234n);

console.log('issue-2576 finding route regression: ok');
