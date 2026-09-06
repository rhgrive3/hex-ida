import test from 'node:test';
import assert from 'node:assert/strict';

import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../../js/analysis/schema-recovery-task.js';

function fixture() {
  const strings = [{ addr:1n, text:'a.csv' }];
  Object.defineProperty(strings, 'complete', { value:true, configurable:true });
  const program = {
    complete:true,
    unsupported:false,
    completeness:{ complete:true },
    graphCompleteness:{ callsComplete:true, refsComplete:true },
    functionsReferencing() { return [{ addr:0x1000n }]; },
    functionRange(address) { return { start:address, end:address + 32n }; },
  };
  return {
    backend:{ gen:1, readAt:async () => ({ found:false }) },
    ensureStrings:async ({ onProgress }) => {
      onProgress({ observed:'strings' });
      return strings;
    },
    ensureProgram:async ({ onProgress }) => {
      onProgress({ observed:'program' });
      return program;
    },
    store:{ get:(key) => key === 'architecture' ? 'arm64' : null },
    currentSlice:() => null,
  };
}

for (const [label, onProgress] of [
  ['true', true],
  ['false', false],
  ['object', {}],
  ['array', []],
  ['number', 1],
  ['string', 'progress'],
]) {
  test(`#3669 non-callable onProgress (${label}) is a no-op across schema producers`, async () => {
    const app = fixture();
    await assert.doesNotReject(() => recoverSchemasForUi(app, { onProgress }));
    clearSchemaRecoveryTasks(app);
  });
}

test('#3669 nullish onProgress remains a no-op', async () => {
  for (const onProgress of [null, undefined]) {
    const app = fixture();
    await assert.doesNotReject(() => recoverSchemasForUi(app, { onProgress }));
    clearSchemaRecoveryTasks(app);
  }
});

test('#3669 callable onProgress preserves dependency and recovery payloads', async () => {
  const app = fixture();
  const events = [];
  await recoverSchemasForUi(app, { onProgress:(event) => events.push(event) });

  assert.ok(events.some((event) => event.phase === 'strings' && event.observed === 'strings'));
  assert.ok(events.some((event) => event.phase === 'program' && event.observed === 'program'));
  assert.ok(events.some((event) => event.phase === 'schema' && Number.isInteger(event.done)));
  clearSchemaRecoveryTasks(app);
});
