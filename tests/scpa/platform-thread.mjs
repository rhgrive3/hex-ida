// Transport adapter for a REAL Node thread, not a browser compatibility claim.
// Parsing, message dispatch and analysis execute the shipped platform handler.
import { parentPort } from 'node:worker_threads';
if (!parentPort) throw new TypeError('platform-test-parent-required');
globalThis.self = { postMessage:(message,transfer)=>parentPort.postMessage(message,transfer) };
await import('../../js/platform/worker.js');
parentPort.on('message',data=>{void self.onmessage({data}).catch(error=>parentPort.postMessage({t:'err',id:data.id,epoch:data.epoch,error:error.message}));});
parentPort.postMessage({t:'test-ready'});
