import test from 'node:test';
import assert from 'node:assert/strict';
import { markMission, missionSteps, missionFunction } from '../js/ui/mission.js';

function fakeApp() {
  let info = { name: 'a.bin' };
  const names = [];
  const comments = new Map();
  return {
    store: { get: (k) => (k === 'fileInfo' ? info : null) },
    notes: { nameEntries: () => names.slice(), comments },
    bookmarks: { list: () => [] },
    setFile(next) { info = next; },
    names, comments,
  };
}
const done = (app) => missionSteps(app).filter((s) => s.done).map((s) => s.id);

test('steps are checked from real state in order', () => {
  const app = fakeApp();
  assert.deepEqual(done(app), []);
  app.lastGoal = { id: 'money' };
  app.lastGoalContext = { targetAddr: 0x2000n };
  assert.equal(missionFunction(app), 0x2000n);
  markMission(app, 'open-function', 0x1000n);
  assert.equal(missionFunction(app), 0x1000n, 'the opened function wins');
  markMission(app, 'read-pseudo');
  app.names.push({ addr: 0x1000n, name: 'addCoins' });
  app.comments.set('4096', 'memo');
  markMission(app, 'report');
  assert.deepEqual(done(app), ['goal', 'open', 'pseudo', 'name', 'note', 'report']);
});

test('session marks reset when another file is opened', () => {
  const app = fakeApp();
  markMission(app, 'open-function', 0x10n);
  markMission(app, 'read-pseudo');
  app.setFile({ name: 'b.bin' });
  assert.deepEqual(done(app), []);
  assert.equal(missionFunction(app), null);
});
