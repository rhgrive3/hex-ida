import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseMetadataFileInWorker } from '../js/il2cpp-runtime.js';

let posted = null;
let terminated = 0;
class FakeWorker {
  postMessage(message) {
    posted = message;
    queueMicrotask(() => this.onmessage?.({ data:{ id:message.id, ok:true, result:{ version:29, classes:[], methods:[], literals:[], warnings:[] } } }));
  }
  terminate() { terminated++; }
}
const file = { size:1024, arrayBuffer(){ throw new Error('main-realm-arrayBuffer-called'); } };
const parsed = await parseMetadataFileInWorker(file, { workerFactory:() => new FakeWorker() });
assert.equal(parsed.version, 29);
assert.equal(posted.file, file);
assert.equal(terminated, 1);

let abortTerminated = 0;
class HangingWorker { postMessage() {} terminate(){ abortTerminated++; } }
const controller = new AbortController();
const pending = parseMetadataFileInWorker(file, { signal:controller.signal, workerFactory:() => new HangingWorker() });
controller.abort('sheet-closed');
await assert.rejects(pending, (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
assert.equal(abortTerminated, 1);

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const backend = fs.readFileSync(new URL('../js/backend.js', import.meta.url), 'utf8');
const platformWorker = fs.readFileSync(new URL('../js/platform/worker.js', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../js/tools-base.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('../js/il2cpp-worker.js', import.meta.url), 'utf8');

const warmup = app.match(/return Promise\.allSettled\(\[([\s\S]*?)\]\);/)?.[1] || '';
assert.doesNotMatch(warmup, /ensureObjc\(/, 'ordinary open must not eagerly start ObjC recovery');
assert.match(app, /readAt\(addr, len, false, \{ priority:'background' \}\)/, 'Swift metadata pages must be background priority');
assert.match(backend, /priority === 'background'/);
assert.match(platformWorker, /waitForForegroundDrain/);
assert.match(platformWorker, /entry\.priority !== 'background'/);

const il2cppBlock = tools.slice(tools.indexOf('export function showIl2cpp'), tools.indexOf('export function prettyName'));
assert.doesNotMatch(il2cppBlock, /\.arrayBuffer\(/, 'IL2CPP UI must not materialize the full file on main');
assert.match(il2cppBlock, /parseMetadataFileInWorker/);
assert.match(workerSource, /file\.arrayBuffer\(\)/, 'full materialization belongs to the dedicated worker');
console.log('reopened metadata/runtime contracts: ok');
