import assert from 'node:assert/strict';
import test from 'node:test';
import { runInSandbox } from '../js/sandbox.js';

function setGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

function installSandboxDom() {
  const state = {
    appended: 0,
    created: 0,
    frameRemoved: 0,
    portClosed: 0,
    terminateMessages: 0,
  };
  const frame = {
    contentWindow: { postMessage() {} },
    hidden: false,
    referrerPolicy: '',
    setAttribute() {},
    remove() { state.frameRemoved++; },
  };
  const restoreDocument = setGlobal('document', {
    createElement(tag) {
      assert.equal(tag, 'iframe');
      state.created++;
      return frame;
    },
    body: {
      append() { state.appended++; },
    },
  });
  const restoreWindow = setGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
  });
  const restoreMessageChannel = setGlobal('MessageChannel', class {
    constructor() {
      this.port1 = {
        onmessage: null,
        postMessage(message) {
          if (message?.t === 'terminate') state.terminateMessages++;
        },
        close() { state.portClosed++; },
      };
      this.port2 = {};
    }
  });
  return {
    state,
    restore() {
      restoreMessageChannel();
      restoreWindow();
      restoreDocument();
    },
  };
}

test('malformed signal fails closed before sandbox resources are created', async () => {
  let created = 0;
  const restoreDocument = setGlobal('document', {
    createElement() {
      created++;
      throw new Error('must not create an iframe for an invalid signal');
    },
  });
  try {
    const result = await runInSandbox({
      source: '',
      api: {},
      out() {},
      signal: { aborted: false },
    });
    assert.match(result.error || '', /キャンセルシグナル/);
    assert.equal(created, 0);
  } finally {
    restoreDocument();
  }
});

test('abort between pre-check and listener registration is observed', async () => {
  const harness = installSandboxDom();
  let aborted = false;
  let adds = 0;
  let removes = 0;
  const signal = {
    get aborted() { return aborted; },
    addEventListener(type) {
      assert.equal(type, 'abort');
      adds++;
      aborted = true;
    },
    removeEventListener(type) {
      assert.equal(type, 'abort');
      removes++;
    },
  };

  try {
    const result = await runInSandbox({ source: '', api: {}, out() {}, signal });
    assert.equal(result.aborted, true);
    assert.equal(adds, 1);
    assert.equal(removes, 1);
    assert.equal(harness.state.appended, 0);
    assert.equal(harness.state.frameRemoved, 1);
    assert.equal(harness.state.portClosed, 1);
    assert.equal(harness.state.terminateMessages, 1);
  } finally {
    harness.restore();
  }
});

test('already-aborted valid signal preserves immediate cancellation', async () => {
  const harness = installSandboxDom();
  let adds = 0;
  const signal = {
    aborted: true,
    addEventListener() { adds++; },
    removeEventListener() {},
  };
  try {
    const result = await runInSandbox({ source: '', api: {}, out() {}, signal });
    assert.equal(result.aborted, true);
    assert.equal(adds, 0);
    assert.equal(harness.state.appended, 0);
  } finally {
    harness.restore();
  }
});
