import assert from 'node:assert/strict';

export function machoBytes(payload) {
  const bytes = new Uint8Array(104 + payload.length), view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true); view.setInt32(4, 0x0100000c, true);
  view.setUint32(12, 2, true); view.setUint32(16, 1, true); view.setUint32(20, 72, true);
  view.setUint32(32, 0x19, true); view.setUint32(36, 72, true);
  bytes.set(new TextEncoder().encode('__DATA'), 40);
  view.setBigUint64(64, BigInt(bytes.length), true); view.setBigUint64(80, BigInt(bytes.length), true);
  view.setUint32(88, 7, true); view.setUint32(92, 7, true); bytes.set(payload, 104);
  return bytes;
}

export async function workerClient(workerUrl = new URL('../../js/platform/worker.js', import.meta.url)) {
  const prior = globalThis.self, posts = [];
  const scope = { postMessage(message) { posts.push(message); } };
  globalThis.self = scope;
  await import(workerUrl);
  let nextId = 1;
  async function request(message) {
    posts.length = 0;
    const id = nextId++;
    await scope.onmessage({ data: { epoch: 1, id, ...message } });
    const response = posts.findLast((entry) => entry.t === 'ok' && entry.id === id);
    assert.ok(response, JSON.stringify(posts, (_, value) => typeof value === 'bigint' ? String(value) : value));
    return response.result;
  }
  return {
    request,
    async open(bytes) {
      await request({ t: 'open', file: { size: bytes.length,
        read: async (offset, length) => bytes.subarray(Number(offset), Number(offset) + length) } });
      await request({ t: 'setRegions', regions: [{ id: 'raw', fileOffset: 104, vmAddr: 0x700000n, size: bytes.length - 104 }] });
    },
    close() { if (prior === undefined) delete globalThis.self; else globalThis.self = prior; },
  };
}
