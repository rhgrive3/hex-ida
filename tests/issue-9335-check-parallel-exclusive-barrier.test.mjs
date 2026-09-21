import assert from 'node:assert/strict';
import test from 'node:test';
import { runCheckParallel } from '../scripts/run-check-parallel.mjs';

function sink() { return { write() {} }; }
const result = () => ({ ok:true, status:0, signal:null, logPath:null, durationMs:1 });

test('#9335 interior phase7 exclusive step is a canonical-position barrier', async () => {
  const events = [];
  let active = 0;
  const runCommand = async (job) => {
    const name = job.rawCommand;
    events.push(`start:${name}`);
    active++;
    if (name === 'npm run phase7:test') {
      assert.equal(active, 1, 'phase7 must run alone');
      assert.ok(events.includes('end:npm run effects:test'));
      assert.equal(events.includes('start:npm run phase8:test'), false);
    }
    if (name === 'npm run phase8:test') assert.ok(events.includes('end:npm run phase7:test'));
    if (name === 'npm run benchmark:baseline') {
      assert.equal(active, 1, 'benchmark must run alone');
      assert.ok(events.includes('end:npm run phase8:test'));
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    events.push(`end:${name}`);
    return result();
  };
  const outcome = await runCheckParallel({
    checkScript:'npm run effects:test && npm run phase7:test && npm run phase8:test && npm run benchmark:baseline',
    runCommand, stdout:sink(), stderr:sink(),
  });
  assert.equal(outcome.failures.length, 0);
  assert.equal(events.indexOf('end:npm run effects:test') < events.indexOf('start:npm run phase7:test'), true);
  assert.equal(events.indexOf('end:npm run phase7:test') < events.indexOf('start:npm run phase8:test'), true);
  assert.equal(events.indexOf('end:npm run phase8:test') < events.indexOf('start:npm run benchmark:baseline'), true);
});
