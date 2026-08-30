import assert from 'node:assert/strict';

import { AnalysisCache } from '../../js/cache/analysis-cache.js';
import { normalizeNavigation, ProjectFormatError } from '../../js/project/index.js';

const artifactId = 'artifact_0123456789abcdef0123456789abcdef';

for (const malformed of [[], {}, true, false, NaN, Infinity, -Infinity, 1.5, '7']) {
  assert.throws(
    () => normalizeNavigation({ cursorIndex: malformed }),
    ProjectFormatError,
    `cursorIndex must reject ${String(malformed)}`,
  );
}
assert.equal(normalizeNavigation({ cursorIndex: null }).cursorIndex, null);
assert.equal(normalizeNavigation({ cursorIndex: 0 }).cursorIndex, 0);
assert.equal(normalizeNavigation({ cursorIndex: 12 }).cursorIndex, 12);

{
  const memory = new Map();
  const writer = new AnalysisCache({ memory, analyzerVersion: '1', semanticOptions: { mode: 'a' } });
  await writer.put('hash-a', { imports: ['old'] }, { artifactId });

  const same = new AnalysisCache({ memory, analyzerVersion: '1', semanticOptions: { mode: 'a' } });
  assert.deepEqual(await same.get('hash-a', { artifactId }), { imports: ['old'] });

  const newer = new AnalysisCache({ memory, analyzerVersion: '2', semanticOptions: { mode: 'a' } });
  assert.equal(await newer.get('hash-a', { artifactId }), null, 'canonical artifact cache must not cross analyzer versions');
}

{
  const memory = new Map();
  const writer = new AnalysisCache({ memory, analyzerVersion: '1', semanticOptions: { mode: 'a' } });
  await writer.put('hash-a', { imports: ['old'] }, { artifactId });
  const changedSettings = new AnalysisCache({ memory, analyzerVersion: '1', semanticOptions: { mode: 'b' } });
  assert.equal(await changedSettings.invalidateStale(), 1, 'canonical artifact cache must invalidate changed semantic settings');
  assert.equal(memory.size, 0);
}

console.log('issues #197/#2742 cache + project boundary regressions PASS');
