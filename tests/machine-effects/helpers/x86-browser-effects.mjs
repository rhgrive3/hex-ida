import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Integration positives need the real receiver's private provenance. Never
// emulate WorkerGlobalScope or mint trust in Node. This is only transport;
// decoding and MachineEffects both run in the existing production Workers.
export async function forEachX86BrowserSession(test) {
  const server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/machine-effects-test') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>MachineEffects receiver tests</title>');
        return;
      }
      const file = path.resolve(root, pathname.replace(/^\/+/, ''));
      if (!file.startsWith(`${root}${path.sep}`) || !fs.statSync(file).isFile()) throw new Error('not found');
      const type = { '.js':'text/javascript', '.mjs':'text/javascript', '.wasm':'application/wasm', '.json':'application/json' }[path.extname(file)];
      response.writeHead(200, { 'content-type':type || 'application/octet-stream', 'cache-control':'no-store' });
      const stream = fs.createReadStream(file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
      const browser = await browserType.launch();
      try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${server.address().port}/machine-effects-test`);
        await page.evaluate(() => {
          const decoder = new Worker('/js/platform/capstone-disasm-worker.js');
          const receiver = new Worker('/js/targets/architecture/x86_64/semantic-revalidation-worker.js');
          let nextId = 0;
          let busy = false;
          let failed = false;
          const stop = () => { failed = true; decoder.terminate(); receiver.terminate(); };
          const request = (worker, message) => new Promise((resolve, reject) => {
            const finish = (error, result) => {
              clearTimeout(timer);
              worker.onmessage = worker.onerror = worker.onmessageerror = null;
              if (error) { stop(); reject(error); } else resolve(result);
            };
            const timer = setTimeout(() => finish(new Error('x86 browser Worker timeout')), 60_000);
            worker.onmessage = ({ data }) => {
              if (data?.id !== message.id) return finish(new Error('x86 browser response ID mismatch'));
              if (!data.ok) return finish(new Error(data.error || 'x86 browser Worker failure'));
              finish(null, data);
            };
            worker.onerror = event => finish(new Error(event.message || 'x86 browser Worker error'));
            worker.onmessageerror = () => finish(new Error('x86 browser Worker message error'));
            try { worker.postMessage(message); } catch (error) { finish(error); }
          });
          globalThis.decodeAndLiftX86Fixture = async ({ bytes, address }) => {
            if (failed) throw new Error('x86 browser session failed');
            if (busy) throw new Error('x86 browser session is busy');
            busy = true;
            try {
              const decoded = await request(decoder, {
                id:++nextId, architecture:'x86_64', address, bytes:new Uint8Array(bytes),
              });
              const semantic = await request(receiver, {
                t:'semanticFunction', id:++nextId,
                input:{ architecture:'x86_64', platform:'linux',
                  binaryId:'binary:machine-effects-browser', sliceId:'slice:machine-effects-browser',
                  decoderSemanticVersion:'capstone-5-x86-structured-v2', instructions:decoded.instructions },
              });
              return { decoded:decoded.instructions, effects:semantic.result?.pipeline?.machineEffects };
            } finally { busy = false; }
          };
        });
        await test({
          engine,
          browserVersion:browser.version(),
          async decodeAndLift(bytes, address = 0x1000n, expectedInstructionCount = 1) {
            assert.ok((Array.isArray(bytes) || bytes instanceof Uint8Array) && bytes.length > 0
              && Array.from(bytes).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255),
            `${engine}: nonempty byte-exact fixture required`);
            assert.ok(typeof address === 'bigint' && address >= 0n, `${engine}: exact nonnegative address required`);
            const result = await page.evaluate(input => globalThis.decodeAndLiftX86Fixture(input), { bytes:Array.from(bytes), address });
            assert.equal(result.decoded?.length, expectedInstructionCount, `${engine}: exact fixture instruction count`);
            assert.equal(result.effects?.length, result.decoded.length, `${engine}: every instruction needs effects`);
            let offset = 0;
            const rows = result.decoded.map((decoded, index) => {
              const raw = Array.from(decoded.rawBytes);
              assert.equal(BigInt(decoded.address), address + BigInt(offset), `${engine}: contiguous address`);
              assert.equal(decoded.length, raw.length, `${engine}: exact instruction length`);
              assert.deepEqual(raw, Array.from(bytes).slice(offset, offset + raw.length), `${engine}: exact input bytes`);
              offset += raw.length;
              return { decoded, effects:result.effects[index] };
            });
            assert.equal(offset, bytes.length, `${engine}: no ignored suffix`);
            return rows;
          },
        });
        assert.deepEqual(errors, [], `${engine}: no browser errors`);
        console.log(`x86 production receiver: ${engine} ${browser.version()}: PASS`);
      } finally { await browser.close(); }
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
