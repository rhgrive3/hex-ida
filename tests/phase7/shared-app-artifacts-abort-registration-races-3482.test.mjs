import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../js/analysis/shared-app-artifacts.js', import.meta.url), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end > start, `missing ${endMarker}`);
  return source.slice(start, end);
}

const attach = section('function attach(entry, options)', 'function requestWithSignal');
assert.ok(attach.includes(
  "options.signal?.addEventListener?.('abort', onAbort, { once:true });\n"
  + '    if (options.signal?.aborted) { onAbort(); return; }\n'
  + '    entry.promise.then',
), 'attach must recheck cancellation after listener registration');

const requestWithSignal = section('function requestWithSignal(request, signal)', 'function yieldMainRealm');
assert.ok(requestWithSignal.includes(
  "signal?.addEventListener?.('abort', onAbort, { once:true });\n"
  + '    if (signal?.aborted) { onAbort(); return; }\n'
  + '    Promise.resolve(request).then',
), 'requestWithSignal must recheck cancellation after listener registration');

const yieldMainRealm = section('function yieldMainRealm(signal)', 'function epochOf');
assert.ok(yieldMainRealm.includes(
  "signal?.addEventListener?.('abort', onAbort, { once:true });\n"
  + '    if (signal?.aborted) { onAbort(); return; }\n'
  + '    setTimeout(() => finish(resolve), 0);',
), 'yieldMainRealm must recheck cancellation after listener registration');

// Model the precise registration edge from #3482: the signal becomes aborted
// during addEventListener(), but the past abort event is not delivered to the
// newly registered listener. The mandatory post-registration check observes it.
let abortCalls = 0;
const signal = {
  aborted:false,
  addEventListener() { this.aborted = true; },
  removeEventListener() {},
};
const onAbort = () => { abortCalls++ ; };
signal.addEventListener('abort', onAbort, { once:true });
if (signal.aborted) onAbort();
assert.equal(abortCalls, 1);

console.log('shared-app-artifacts abort registration race tests passed');
