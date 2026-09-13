// Regression test for #5666: Backend._disassembleBytes AbortSignal lifecycle
// 1. Check-then-subscribe race window must not miss abort.
// 2. Normal completion must remove abort listener (preventing listener leak).
// 3. Worker error, cancellation, and releaseDisassembly must remove abort listener.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

class MockDisasmWorker {
  constructor() {
    this.sent = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
  }
  postMessage(m) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
}

globalThis.Worker = MockDisasmWorker;
const { Backend } = await import("../js/backend.js");

// Helper to count abort listeners on standard AbortSignal
function countAbortListeners(signal) {
  return getEventListeners(signal, "abort").length;
}

// 1. Normal resolution removes abort listener
{
  const b = new Backend();
  const controller = new AbortController();

  for (let i = 0; i < 20; i++) {
    const promise = b._disassembleBytes(new Uint8Array([0, 0, 0, 0]), 0x1000n, "arm64", b.gen, {
      signal: controller.signal,
    });
    assert.equal(countAbortListeners(controller.signal), 1, "listener must be registered while in flight");
    const lastSent = b._disasmWorker.sent[b._disasmWorker.sent.length - 1];
    b._disasmWorker.onmessage({ data: { id: lastSent.id, ok: true, instructions: [] } });
    await promise;
    assert.equal(countAbortListeners(controller.signal), 0, "listener must be removed after normal resolve");
  }
}

// 2. Normal rejection removes abort listener
{
  const b = new Backend();
  const controller = new AbortController();

  const promise = b._disassembleBytes(new Uint8Array([0, 0, 0, 0]), 0x1000n, "arm64", b.gen, {
    signal: controller.signal,
  });
  assert.equal(countAbortListeners(controller.signal), 1);
  const lastSent = b._disasmWorker.sent[b._disasmWorker.sent.length - 1];
  b._disasmWorker.onmessage({ data: { id: lastSent.id, ok: false, error: "decode error" } });
  await assert.rejects(promise, /decode error/);
  assert.equal(countAbortListeners(controller.signal), 0, "listener must be removed after rejection");
}

// 3. Pre-aborted signal cancels immediately and does not retain listener
{
  const b = new Backend();
  const controller = new AbortController();
  controller.abort();

  const promise = b._disassembleBytes(new Uint8Array([0, 0, 0, 0]), 0x1000n, "arm64", b.gen, {
    signal: controller.signal,
  });
  await assert.rejects(promise, (err) => err?.name === "AbortError");
  assert.equal(countAbortListeners(controller.signal), 0, "pre-aborted signal must not retain listener");
  assert.equal(b._disasmPending.size, 0, "pre-aborted signal must not leave pending entry");
}

// 4. In-flight abort cancels and cleans up listener
{
  const b = new Backend();
  const controller = new AbortController();

  const promise = b._disassembleBytes(new Uint8Array([0, 0, 0, 0]), 0x1000n, "arm64", b.gen, {
    signal: controller.signal,
  });
  assert.equal(countAbortListeners(controller.signal), 1);
  controller.abort();
  await assert.rejects(promise, (err) => err?.name === "AbortError");
  assert.equal(countAbortListeners(controller.signal), 0, "aborted signal must remove listener");
  assert.equal(b._disasmPending.size, 0);
}

// 5. Check-then-subscribe race window: abort occurring during registration must cancel
{
  const b = new Backend();
  let aborted = false;
  let listenerCount = 0;
  const raceSignal = {
    get aborted() { return aborted; },
    addEventListener(type, fn) {
      if (type === "abort") {
        aborted = true; // Abort transition occurs inside registration window
        listenerCount++;
      }
    },
    removeEventListener(type, fn) {
      if (type === "abort") listenerCount--;
    },
  };

  const promise = b._disassembleBytes(new Uint8Array([0, 0, 0, 0]), 0x1000n, "arm64", b.gen, {
    signal: raceSignal,
  });
  await assert.rejects(promise, (err) => err?.name === "AbortError", "must cancel when aborted during registration window");
  assert.equal(listenerCount, 0, "raceSignal listener must be cleaned up");
  assert.equal(b._disasmPending.size, 0);
}

// 6. _releaseDisassembly cleans up listeners
{
  const b = new Backend();
  const controller = new AbortController();

  const promise = b._disassembleBytes(new Uint8Array([0, 0, 0, 0]), 0x1000n, "arm64", b.gen, {
    signal: controller.signal,
  });
  assert.equal(countAbortListeners(controller.signal), 1);
  b._releaseDisassembly(new Error("worker reset"));
  await assert.rejects(promise, /worker reset/);
  assert.equal(countAbortListeners(controller.signal), 0, "releaseDisassembly must remove listener");
}

console.log("issue #5666 disassembleBytes signal lifecycle regressions PASS");
