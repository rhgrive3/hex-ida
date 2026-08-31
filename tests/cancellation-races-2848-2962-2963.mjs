import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RemoteProtocolClient } from '../js/debug/remote-protocol.js';

const investigation = fs.readFileSync(new URL('../js/analysis/investigation-service.js', import.meta.url), 'utf8');
assert.ok((investigation.match(/if \(signal\?\.aborted\) onAbort\(\);/g) || []).length >= 3);
const adapters = fs.readFileSync(new URL('../js/adapters/index.js', import.meta.url), 'utf8');
assert.match(adapters, /addEventListener\('abort', onAbort, \{ once:true \}\);\s*if \(options\.signal\.aborted\) onAbort\(\);/);

const sent=[];
const transport={ send:async (packet)=>{ sent.push(packet); } };
const client=new RemoteProtocolClient(transport, { timeoutMs:1000 });
let aborted=false;
let reason='cancelled-in-registration-window';
const signal={
  get aborted(){ return aborted; },
  get reason(){ return reason; },
  addEventListener(type, listener){
    assert.equal(type,'abort');
    aborted=true;
    listener();
  },
  removeEventListener(){},
};
await assert.rejects(client.request('readMemory', {}, { signal }), /cancelled/);
await Promise.resolve();
assert.equal(sent.some((packet)=>packet?.type === 'request'), false, 'cancelled request must not be sent');
assert.equal(client.pending.size, 0, 'cancelled request must not remain pending');

console.log('cancellation races 2848/2962/2963: PASS');
