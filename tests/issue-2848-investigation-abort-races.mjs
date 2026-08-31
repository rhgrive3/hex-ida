import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../js/analysis/investigation-service.js',import.meta.url),'utf8');
const checks=[
  "signal?.addEventListener('abort', onAbort, { once:true });\n      if (signal?.aborted) { onAbort(); return; }\n      requestIdleCallback",
  "signal?.addEventListener('abort', onAbort, { once:true });\n    if (signal?.aborted) { onAbort(); return; }\n    entry.promise.then",
  "signal?.addEventListener('abort', onAbort, { once:true });\n    if (signal?.aborted) { onAbort(); signal?.removeEventListener('abort', onAbort); return; }\n    Promise.resolve(request)",
];
for(const check of checks) assert.ok(source.includes(check),`missing race-safe recheck: ${check}`);
console.log('issue-2848-investigation-abort-races: PASS');
