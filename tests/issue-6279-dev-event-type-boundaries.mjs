import assert from "node:assert/strict";
import test from "node:test";
import {
  DEV_EVENT_TYPE,
  DevRunEventHost,
  createDevEvent,
} from "../js/ai/dev/events/dev-events.js";

function createMockSupervisor() {
  let resumed = false;
  return {
    applyDecision(run, input) {
      return { run, decision: input };
    },
    resume(run) {
      resumed = true;
      return { ...run, status: "ACTIVE" };
    },
    get wasResumed() {
      return resumed;
    },
  };
}

test("issue #6279 - valid event string type resumes waiting run", () => {
  const supervisor = createMockSupervisor();
  const host = new DevRunEventHost({ supervisor });
  const run = { runId: "r1" };

  host.yieldDecision(run, { type: "wait", events: [DEV_EVENT_TYPE.WORKER_COMPLETED] });
  assert.ok(host.waitingFor("r1"));

  const result = host.acceptEvent(run, {
    type: DEV_EVENT_TYPE.WORKER_COMPLETED,
    data: {},
  });

  assert.equal(result.resumed, true);
  assert.equal(supervisor.wasResumed, true);
  assert.equal(host.waitingFor("r1"), null);
});

test("issue #6279 - structured or non-string event.type is rejected and does not resume", () => {
  const invalidTypes = [
    ["worker.completed"],
    ["human.responded"],
    { toString: () => "worker.completed" },
    123,
    true,
    null,
    undefined,
  ];

  for (const t of invalidTypes) {
    const supervisor = createMockSupervisor();
    const host = new DevRunEventHost({ supervisor });
    const run = { runId: "r1" };

    host.yieldDecision(run, { type: "wait", events: [DEV_EVENT_TYPE.WORKER_COMPLETED] });

    assert.throws(
      () => host.acceptEvent(run, { type: t, data: {} }),
      TypeError,
      `Should reject event.type: ${String(t)}`
    );

    // Run must still be waiting
    assert.ok(host.waitingFor("r1"));
    assert.equal(supervisor.wasResumed, false);
  }
});

test("issue #6279 - event.type is read exactly once before validation and storage", () => {
  const cases = [
    {
      name: "later structured value",
      later() { return { bad: true }; },
    },
    {
      name: "later throwing accessor",
      later() { throw new Error("event.type read more than once"); },
    },
  ];

  for (const { name, later } of cases) {
    const supervisor = createMockSupervisor();
    const host = new DevRunEventHost({ supervisor });
    const run = { runId: `r-${name}` };
    let reads = 0;
    const event = {
      get type() {
        reads++;
        return reads === 1 ? DEV_EVENT_TYPE.WORKER_COMPLETED : later();
      },
      data: {},
    };

    host.yieldDecision(run, { type: "wait", events: [DEV_EVENT_TYPE.WORKER_COMPLETED] });
    const result = host.acceptEvent(run, event);

    assert.equal(reads, 1, `${name}: type accessor must be read once`);
    assert.equal(result.resumed, true, `${name}: validated event must resume`);
    assert.equal(result.event.type, DEV_EVENT_TYPE.WORKER_COMPLETED, `${name}: stored type must be the validated primitive`);
  }
});
