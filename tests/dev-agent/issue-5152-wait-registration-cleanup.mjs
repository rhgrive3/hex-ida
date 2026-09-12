import assert from 'node:assert/strict';
import { DevRunEventHost, createDevEvent } from '../../js/ai/dev/events/dev-events.js';

const WAIT_EVENTS = ['worker.completed'];

function supervisorWith({ waitEvent, resumeCalls = [] } = {}) {
  return {
    applyDecision(run) {
      return {
        run: { ...run, status: 'WAITING_EVENT' },
        decision: { type: 'wait', events: [...WAIT_EVENTS] },
      };
    },
    resume(run) {
      resumeCalls.push(run.runId);
      return { ...run, status: 'ACTIVE' };
    },
    workerTools: { waitEvent },
  };
}

function deferredWaitEvent() {
  let rejectPending;
  let resolvePending;
  const calls = [];
  const pending = [];
  const waitEvent = (events, options) => {
    calls.push({ events, options });
    return new Promise((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
      pending.push({ resolve, reject });
    });
  };
  return {
    waitEvent,
    calls,
    settle: (value) => resolvePending(value),
    fail: (error) => rejectPending(error),
  };
}

const run = { runId: 'r1', status: 'ACTIVE' };

// 1. waitEvent success → matching event resumes as before (unchanged contract).
{
  const transport = deferredWaitEvent();
  const resumeCalls = [];
  const host = new DevRunEventHost({ supervisor: supervisorWith({ waitEvent: transport.waitEvent, resumeCalls }) });
  const pending = host.waitForWorkerDecision(run, {});
  transport.settle({ type: 'worker.completed', data: {}, observedAt: '2026-09-11T00:00:00.000Z' });
  const result = await pending;
  assert.equal(result.resumed, true);
  assert.equal(result.run.status, 'ACTIVE');
  assert.equal(result.decision.type, 'wait');
  assert.equal(host.waitingFor('r1'), null);
  assert.deepEqual(resumeCalls, ['r1']);
}

// 2. waitEvent AbortError → the failed wait leaves no registration behind.
{
  const transport = deferredWaitEvent();
  const host = new DevRunEventHost({ supervisor: supervisorWith({ waitEvent: transport.waitEvent }) });
  const pending = host.waitForWorkerDecision(run, {});
  transport.fail(new DOMException('aborted', 'AbortError'));
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(host.waitingFor('r1'), null);
}

// 3. waitEvent transport rejection → registration not retained.
{
  const transport = deferredWaitEvent();
  const host = new DevRunEventHost({ supervisor: supervisorWith({ waitEvent: transport.waitEvent }) });
  const pending = host.waitForWorkerDecision(run, {});
  transport.fail(new TypeError('transport destroyed'));
  await assert.rejects(pending, TypeError);
  assert.equal(host.waitingFor('r1'), null);
}

// 4. workerTools unavailable → registration not retained (fail path after yield).
{
  const supervisor = supervisorWith();
  delete supervisor.workerTools;
  const host = new DevRunEventHost({ supervisor });
  await assert.rejects(host.waitForWorkerDecision(run, {}), TypeError);
  assert.equal(host.waitingFor('r1'), null);
}

// 5. A late matching event after a failed wait must not resume the stale run.
{
  const transport = deferredWaitEvent();
  const resumeCalls = [];
  const host = new DevRunEventHost({ supervisor: supervisorWith({ waitEvent: transport.waitEvent, resumeCalls }) });
  const pending = host.waitForWorkerDecision(run, {});
  transport.fail(new DOMException('aborted', 'AbortError'));
  await assert.rejects(pending, () => true);
  const late = host.acceptEvent(
    { ...run, status: 'WAITING_EVENT' },
    createDevEvent('worker.completed', {}),
  );
  assert.equal(late.resumed, false, 'late event must not resume a failed wait');
  assert.deepEqual(resumeCalls, []);
}

// 6. Generation guard: the failed wait's cleanup must not delete a newer
//    registration created by a subsequent wait on the same runId.
{
  const transports = [deferredWaitEvent(), deferredWaitEvent()];
  let call = 0;
  const waitEvent = (...args) => transports[call++]?.waitEvent(...args);
  const host = new DevRunEventHost({ supervisor: supervisorWith({ waitEvent }) });

  const first = host.waitForWorkerDecision(run, {});
  const second = host.waitForWorkerDecision(run, {}); // re-registers over the first

  transports[0].fail(new DOMException('aborted', 'AbortError'));
  await assert.rejects(first, () => true);

  const retained = host.waitingFor('r1');
  assert.ok(retained, 'the newer registration must survive the older wait cleanup');
  assert.deepEqual(retained.events, WAIT_EVENTS);

  transports[1].settle({ type: 'worker.completed', data: {}, observedAt: '2026-09-11T00:00:00.000Z' });
  const resumed = await second;
  assert.equal(resumed.resumed, true);
  assert.equal(host.waitingFor('r1'), null);
}

console.log('issue #5152 wait-registration cleanup regressions PASS');
