from pathlib import Path

# InvestigationService: close check->listen races without changing shared-producer ownership.
p=Path('js/analysis/investigation-service.js')
s=p.read_text()
repls=[
("""      signal?.addEventListener('abort', onAbort, { once:true });
      requestIdleCallback(() => finish(resolve), { timeout:250 });""",
 """      signal?.addEventListener('abort', onAbort, { once:true });
      if (signal?.aborted) onAbort();
      requestIdleCallback(() => finish(resolve), { timeout:250 });"""),
("""    signal?.addEventListener('abort', onAbort, { once:true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));""",
 """    signal?.addEventListener('abort', onAbort, { once:true });
    if (signal?.aborted) onAbort();
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));"""),
("""    signal?.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(request).then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));""",
 """    signal?.addEventListener('abort', onAbort, { once:true });
    if (signal?.aborted) onAbort();
    Promise.resolve(request).then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));"""),
]
for old,new in repls:
    if old not in s: raise SystemExit('investigation cancellation anchor drift')
    s=s.replace(old,new,1)
p.write_text(s)

# Local sandbox: recheck immediately after listener registration.
p=Path('js/adapters/index.js')
s=p.read_text()
old="""    if (options.signal && !options.signal.aborted) options.signal.addEventListener('abort', onAbort, { once:true });
    if (run.cancelled) sandbox.emulator.stopped = 'cancelled';"""
new="""    if (options.signal && !options.signal.aborted) {
      options.signal.addEventListener('abort', onAbort, { once:true });
      if (options.signal.aborted) onAbort();
    }
    if (run.cancelled) sandbox.emulator.stopped = 'cancelled';"""
if old not in s: raise SystemExit('local sandbox cancellation anchor drift')
s=s.replace(old,new,1)
p.write_text(s)

# Remote protocol: publish pending before subscribing, recheck after subscribe,
# and never send a request packet once the abort path removed the pending entry.
p=Path('js/debug/remote-protocol.js')
s=p.read_text()
old="""      if (pending.signal) {
        pending.abortHandler = () => this.cancel(id, String(pending.signal.reason ?? 'cancelled'));
        pending.signal.addEventListener('abort', pending.abortHandler, { once:true });
      }
      this.pending.set(id, pending);
      this.sendPacket(packet).catch((err) => {"""
new="""      this.pending.set(id, pending);
      if (pending.signal) {
        pending.abortHandler = () => this.cancel(id, String(pending.signal.reason ?? 'cancelled'));
        pending.signal.addEventListener('abort', pending.abortHandler, { once:true });
        if (pending.signal.aborted) pending.abortHandler();
      }
      if (!this.pending.has(id)) return;
      this.sendPacket(packet).catch((err) => {"""
if old not in s: raise SystemExit('remote protocol cancellation anchor drift')
s=s.replace(old,new,1)
p.write_text(s)

Path('tests/cancellation-races-2848-2962-2963.mjs').write_text(r'''import assert from 'node:assert/strict';
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
''')

p=Path('tests/integrated-issues-hardening.mjs')
s=p.read_text()
line="await import('./cancellation-races-2848-2962-2963.mjs');\n"
if line not in s:
    s=line+s
p.write_text(s)
