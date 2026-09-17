// Node transport for the shipped browser Worker entry points, not a browser oracle.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const target = new URL(workerData.url);
const require = createRequire(import.meta.url);
globalThis.self = globalThis;
globalThis.location = { href: target.href };
globalThis.postMessage = (message, transfer) => parentPort.postMessage({ kind:'message', message }, transfer);
const listeners = new Set();
globalThis.addEventListener = (event, callback) => { if (event === 'message') listeners.add(callback); };
globalThis.removeEventListener = (event, callback) => { if (event === 'message') listeners.delete(callback); };
globalThis.fetch = async () => { throw new Error('public-benchmark-network-disabled'); };
globalThis.importScripts = (...urls) => {
  for (const url of urls) {
    const file = fileURLToPath(new URL(url, target));
    const source = fs.readFileSync(file, 'utf8');
    if (path.basename(file) === 'capstone.js') {
      const factory = vm.runInThisContext(`(function(require,__dirname,__filename,module,exports){${source}\nreturn MCapstone;})`, {filename:file});
      const module = {exports:{}};
      globalThis.MCapstone = factory(require,path.dirname(file),file,module,module.exports);
    } else vm.runInThisContext(source, {filename:file});
  }
};
if (workerData.type === 'module') await import(target.href);
else globalThis.importScripts(target.href);
parentPort.on('message', message => {
  const event = {data:message};
  Promise.resolve().then(async () => {
    if (typeof globalThis.onmessage === 'function') await globalThis.onmessage(event);
    for (const listener of listeners) await listener(event);
  }).catch(error => parentPort.postMessage({kind:'error',message:String(error?.stack ?? error)}));
});
parentPort.postMessage({kind:'ready'});
