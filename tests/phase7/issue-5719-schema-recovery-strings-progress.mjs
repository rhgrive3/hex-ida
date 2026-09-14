// Regression for #5719: the schema-recovery dependency producer hands App.ensureStrings
// an options object `{ signal, priority, budget, onProgress }` (the contract pinned by
// tests/issues-close-audit-2520-2545.mjs and tests/phase7/issue-3669-*). App.ensureStrings
// must extract the progress callback exactly like App.ensureProgram does; before the fix
// it registered the OBJECT itself as the backend progress callback, so the first real
// progress event threw `TypeError: onProgress is not a function` and rejected the whole
// schema task.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { App } from '../../js/app.js';
import { installSharedAppArtifacts } from '../../js/analysis/shared-app-artifacts.js';
import { clearSchemaRecoveryTasks, recoverSchemasForUi } from '../../js/analysis/schema-recovery-task.js';

test('#5719 App.ensureStrings normalizes a positional callback like ensureProgram', async () => {
  const source = await readFile(new URL('../../js/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async ensureStrings(');
  assert.ok(start > 0, 'App.ensureStrings must exist');
  const end = source.indexOf('\n  }', start);
  const body = source.slice(start, end);
  // The options-object header mirrors App.ensureProgram: a non-function first
  // argument must never be registered as the backend progress callback.
  assert.match(body, /typeof onProgress === 'function'/, 'must special-case the positional callback');
  assert.match(body, /onProgress\?\.onProgress/, 'must unwrap an options-object onProgress');
  assert.match(body, /progressFn && \(\(p\) => progressFn\(/, 'the backend call must use the normalized function');
  assert.doesNotMatch(body, /onProgress && \(\(p\) => onProgress\(/, 'the raw argument must not reach the backend call');
});

function backendFixture() {
  const requests = [];
  const backend = {
    gen: 1,
    strings(params, onProgress) {
      requests.push({ params, onProgress });
      queueMicrotask(() => onProgress?.({ done:4, all:4 }));
      return Promise.resolve({
        complete:true,
        scannedBytes:4,
        results:[{ addr:0x1000n, text:'normal.csv' }],
      });
    },
  };
  const app = {
    backend,
    stringIndex:null,
    stringsBusy:null,
    stringsBusyEpoch:-1,
    store:{
      get(key) {
        return key === 'regions'
          ? [{ id:'r1', size:16n, section:'__cstring' }]
          : null;
      },
    },
  };
  return { app, requests };
}

test('#5719 real App.ensureStrings accepts legacy, options, and omitted progress forms', async () => {
  for (const form of ['callback', 'options', 'omitted']) {
    const { app, requests } = backendFixture();
    const events = [];
    const arg = form === 'callback'
      ? (event) => events.push(event)
      : form === 'options'
        ? {
            signal:new AbortController().signal,
            priority:'interactive',
            budget:{ maxSchemas:5 },
            onProgress:(event) => events.push(event),
          }
        : undefined;

    const result = await App.prototype.ensureStrings.call(app, arg);
    assert.equal(result.complete, true);
    assert.equal(requests.length, 1);
    if (form === 'omitted') {
      assert.equal(requests[0].onProgress, null, 'omitted progress must not register a non-function');
    } else {
      assert.equal(typeof requests[0].onProgress, 'function');
      assert.equal(events.length, 1);
      assert.equal(events[0].phase, 'strings');
    }
  }
});

test('#5719 cold recoverSchemasForUi forwards one string progress event through installed artifacts', async () => {
  const { app, requests } = backendFixture();
  installSharedAppArtifacts(app);
  const events = [];
  const result = await recoverSchemasForUi(app, {
    signal:new AbortController().signal,
    priority:'interactive',
    budget:{ maxSchemas:5 },
    onProgress:(event) => events.push(event),
  });

  assert.equal(result.complete, false, 'no executable region is a conservative incomplete result');
  assert.equal(events.filter((event) => event.phase === 'strings').length, 1,
    'a cold schema task must forward exactly one string progress event');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.analysisPriority, 'interactive');
  assert.equal(typeof requests[0].onProgress, 'function');
  clearSchemaRecoveryTasks(app);
});
