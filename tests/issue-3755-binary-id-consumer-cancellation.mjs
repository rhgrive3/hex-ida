import assert from 'node:assert/strict';
import { Backend } from '../js/backend.js';

function slowBlob(bytes, delayMs = 4) {
  let reads = 0;
  return {
    size:bytes.length,
    get reads(){ return reads; },
    slice(start,end) {
      const chunk = bytes.slice(start,end);
      return { async arrayBuffer() { reads++; await new Promise(r => setTimeout(r, delayMs)); return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength); } };
    },
  };
}
function backendWith(file) {
  const backend = Object.create(Backend.prototype);
  backend.file = file;
  backend.binaryId = null;
  backend._binaryIdPromise = null;
  backend._binaryIdFlight = null;
  return backend;
}
{
  const file = slowBlob(Uint8Array.from({length:64}, (_,i)=>i));
  const backend = backendWith(file);
  const a = new AbortController();
  const aProgress = [], bProgress = [];
  const pa = backend.ensureBinaryId({ chunkBytes:8, signal:a.signal, onProgress:p => { aProgress.push(p); if (aProgress.length === 1) a.abort('caller-a-left'); } });
  const pb = backend.ensureBinaryId({ chunkBytes:8, onProgress:p => bProgress.push(p) });
  await assert.rejects(pa, e => e?.name === 'AbortError');
  const id = await pb;
  assert.match(id, /^bin_sha256_/);
  assert.equal(file.reads, 8, 'one shared producer must hash each chunk exactly once');
  assert.ok(bProgress.length > 0, 'surviving consumer receives shared progress');
  assert.equal(backend.binaryId, id);
}
{
  const file = slowBlob(Uint8Array.from({length:128}, (_,i)=>i), 8);
  const backend = backendWith(file);
  const a = new AbortController(), b = new AbortController();
  const pa = backend.ensureBinaryId({ chunkBytes:8, signal:a.signal });
  const pb = backend.ensureBinaryId({ chunkBytes:8, signal:b.signal });
  setTimeout(() => { a.abort(); b.abort(); }, 3);
  await Promise.all([assert.rejects(pa, e => e?.name === 'AbortError'), assert.rejects(pb, e => e?.name === 'AbortError')]);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(file.reads < 16, 'producer must be cancelled once all consumers leave');
  assert.equal(backend.binaryId, null);
}
{
  const file = slowBlob(Uint8Array.from({length:96}, (_,i)=>i), 8);
  const backend = backendWith(file);
  const a = new AbortController();
  const first = backend.ensureBinaryId({ chunkBytes:8, signal:a.signal });
  a.abort('first-consumer-left');
  await assert.rejects(first, e => e?.name === 'AbortError');
  const id = await backend.ensureBinaryId({ chunkBytes:8 });
  assert.match(id, /^bin_sha256_/);
  assert.equal(backend.binaryId, id);
}
console.log('issue #3755 binary-id single-flight cancellation: PASS');
