from pathlib import Path
import re


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace(path, old, new, count=1):
    text = read(path)
    if old not in text:
        raise SystemExit(f'missing pattern in {path}: {old[:160]!r}')
    write(path, text.replace(old, new, count))


# #2602 — ordinary file/slice open must not unconditionally start full ObjC recovery.
replace('js/app.js',
"""        return Promise.allSettled([
          this.ensureObjc(sliceIndex),
          this.ensureSwift(),
          this.ensureRecognition({ maxFunctions: 350000 }),
        ]);""",
"""        // ObjC recovery is intentionally demand-driven. It can traverse large
        // runtime metadata and must not be a hidden prerequisite of opening a file.
        // Swift/recognition keep their existing background warmup behavior.
        return Promise.allSettled([
          this.ensureSwift(),
          this.ensureRecognition({ maxFunctions: 350000 }),
        ]);""")

# #2566 — every paged Swift metadata read is explicitly background priority.
# The worker defers each background read while foreground work is active, so
# interactive viewer/query requests can cut in between metadata pages.
replace('js/app.js',
"""      const read = (addr, len) => this.backend.readAt(addr, len).then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
      try {
        const model=await buildSwiftMetadataModel""",
"""      const read = (addr, len) => this.backend.readAt(addr, len, false, { priority:'background' })
        .then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
      try {
        const model=await buildSwiftMetadataModel""", 1)

replace('js/backend.js',
"""  readAt(addr, len, text) { return this.call('readAt', { addr, len, text }); }""",
"""  readAt(addr, len, text, options = {}) {
    const priority = options?.priority === 'background' ? 'background' : 'current';
    return this.call('readAt', { addr, len, text, priority });
  }""")

replace('js/platform/worker.js',
"""const active = new Map();

self.onmessage = async (event) => {""",
"""const active = new Map();

function cooperativeYield() { return new Promise((resolve) => setTimeout(resolve, 0)); }
async function waitForForegroundDrain(epoch) {
  // Background metadata performs many small paged reads. Do not enqueue the
  // next page while any interactive request for the same binary epoch is live.
  // A currently executing page is bounded, so foreground work is never held
  // behind an unbounded metadata scan.
  while ([...active.values()].some((entry) => entry.epoch === epoch && entry.priority !== 'background')) {
    await cooperativeYield();
  }
}

self.onmessage = async (event) => {""")

replace('js/platform/worker.js',
"""  const execute = async () => {
    if (msg.epoch !== currentEpoch) throw new Error('Stale platform request.');
    const controller = new AbortController();""",
"""  const execute = async () => {
    if (msg.epoch !== currentEpoch) throw new Error('Stale platform request.');
    const priority = msg.priority === 'background' ? 'background' : 'current';
    if (priority === 'background') await waitForForegroundDrain(msg.epoch);
    if (msg.epoch !== currentEpoch) throw new Error('Stale platform request.');
    const controller = new AbortController();""")

replace('js/platform/worker.js',
"""    if (requestKey != null) active.set(requestKey, { id: msg.id, epoch: msg.epoch, controller });""",
"""    if (requestKey != null) active.set(requestKey, { id: msg.id, epoch: msg.epoch, controller, priority });""")

# #2619 — materialize the selected global-metadata.dat inside a dedicated
# worker. The File itself is structured-cloned to the worker; the main realm
# never creates a second full-file ArrayBuffer.
Path('js/il2cpp-worker.js').write_text(r'''import { parseMetadataAutoAsync } from './il2cpp.js';

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.t !== 'parse' || message.id == null) return;
  try {
    const file = message.file;
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('IL2CPP metadata file is unavailable.');
    const buffer = await file.arrayBuffer();
    const result = await parseMetadataAutoAsync(buffer, { yield:true });
    self.postMessage({ id:message.id, ok:true, result });
  } catch (error) {
    self.postMessage({
      id:message.id,
      ok:false,
      error:{ name:error?.name || 'Error', code:error?.code || null, message:error?.message || String(error) },
    });
  }
};
''')

Path('js/il2cpp-runtime.js').write_text(r'''let sequence = 1;

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason == null ? 'IL2CPP metadata parsing was cancelled.' : String(signal.reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

export function parseMetadataFileInWorker(file, options = {}) {
  const signal = options.signal ?? null;
  const workerFactory = options.workerFactory || (() => new Worker(new URL('./il2cpp-worker.js', import.meta.url), { type:'module' }));
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const id = sequence++;
  const worker = workerFactory();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try { worker.terminate(); } catch { /* worker may already be gone */ }
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener('abort', onAbort, { once:true });
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.id !== id) return;
      if (message.ok) finish(resolve, message.result);
      else {
        const error = new Error(message.error?.message || 'IL2CPP metadata worker failed.');
        error.name = message.error?.name || 'Error';
        if (message.error?.code) error.code = message.error.code;
        finish(reject, error);
      }
    };
    const fail = (event) => finish(reject, event?.error || new Error(event?.message || 'IL2CPP metadata worker failed.'));
    worker.onerror = fail;
    worker.onmessageerror = fail;
    try {
      // File/Blob is structured-cloneable. Do not call file.arrayBuffer() here.
      worker.postMessage({ t:'parse', id, file });
    } catch (error) {
      finish(reject, error);
    }
  });
}
''')

replace('js/tools-base.js',
"""import { parseMetadataAuto, parseMetadataAutoAsync, looksLikeUnity, bindMethodAddresses, MAX_IL2CPP_METADATA_BYTES } from './il2cpp.js';""",
"""import { parseMetadataAuto, looksLikeUnity, bindMethodAddresses, MAX_IL2CPP_METADATA_BYTES } from './il2cpp.js';
import { parseMetadataFileInWorker } from './il2cpp-runtime.js';""")

replace('js/tools-base.js',
"""        const buf = await f.arrayBuffer();
        if (controller.signal.aborted || !sheet.root.isConnected) return;
        const meta = await parseMetadataAutoAsync(buf, { signal: controller.signal });""",
"""        const meta = await parseMetadataFileInWorker(f, { signal:controller.signal });""")

# Focused regressions protect the three first divergences, including that the
# main realm never calls File.arrayBuffer for IL2CPP parsing.
Path('tests/reopened-metadata-runtime-contracts.mjs').write_text(r'''import assert from 'node:assert/strict';
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
''')
