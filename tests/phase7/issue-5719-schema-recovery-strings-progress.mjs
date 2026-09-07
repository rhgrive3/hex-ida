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
