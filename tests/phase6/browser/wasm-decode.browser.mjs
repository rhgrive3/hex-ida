import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Real-browser proof for the Phase 6 decoder.
 *
 * Hex is browser/iPad-first, so deployed WASM/Worker authority is only
 * believable once observed through the production browser transport. Besides
 * the existing cross-architecture decode proof this test now verifies #5082:
 * an x86 row crosses the real decoder Worker boundary, is independently
 * re-decoded by the dedicated receiver Worker, and only then may MachineEffects
 * publish terminal exactness.
 *
 * It is a `.browser.mjs`, not a `.test.mjs`, so the canonical Phase 6 Node
 * denominator stays browser-toolchain independent; `npm run phase6:browser`
 * runs this stronger deployed-WASM proof and fails closed without Playwright.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mime = { '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json' };

async function playwright() {
  const unwrap = (module) => (module?.chromium ? module : module?.default?.chromium ? module.default : null);
  try { const loaded = unwrap(await import('playwright')); if (loaded) return loaded; } catch { /* inspect npx cache */ }
  const cache = path.join(process.env.HOME || '', '.npm', '_npx');
  if (fs.existsSync(cache)) {
    for (const directory of fs.readdirSync(cache)) {
      const candidate = path.join(cache, directory, 'node_modules/playwright/index.js');
      if (!fs.existsSync(candidate)) continue;
      try { const loaded = unwrap(await import(pathToFileURL(candidate).href)); if (loaded) return loaded; } catch { /* continue */ }
    }
  }
  throw new Error('phase6-browser-playwright-required');
}

function serve() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/phase6-test') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>Phase 6 browser decode</title>');
      return;
    }
    const file = path.resolve(root, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404); response.end('not found'); return;
    }
    response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const { chromium } = await playwright();
const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(`${origin}/phase6-test`);

  const result = await page.evaluate(async () => {
    const requestWorker = (worker, message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timeout')), 60_000);
      worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
      worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.postMessage(message);
    });

    // Production classic decoder Worker, loaded exactly as the product loads it.
    const decoderWorker = new Worker('/js/platform/capstone-disasm-worker.js');
    // c.li a0,7 | addi a1,a1,1 | c.add a0,a1 | ld a2,0(a0) | ret
    const riscv = await requestWorker(decoderWorker, {
      id: 1, architecture: 'riscv64', address: 0x1000n,
      bytes: new Uint8Array([0x1d, 0x45, 0x93, 0x85, 0x15, 0x00, 0x2e, 0x95, 0x03, 0x36, 0x05, 0x00, 0x67, 0x80, 0x00, 0x00]),
    });
    const arm64 = await requestWorker(decoderWorker, {
      id: 2, architecture: 'arm64', address: 0x1000n,
      bytes: new Uint8Array([0x00, 0x00, 0x80, 0xd2]),
    });
    // mov rax,[rbx] | ret. The memory-form MOV is intentionally a family result
    // that needs the trusted decoder terminal summary to become exact.
    const x86 = await requestWorker(decoderWorker, {
      id: 3, architecture: 'x86_64', address: 0x2000n,
      bytes: new Uint8Array([0x48, 0x8b, 0x03, 0xc3]),
    });
    decoderWorker.terminate();

    const semanticWorker = new Worker('/js/targets/architecture/x86_64/semantic-revalidation-worker.js');
    const semantic = await requestWorker(semanticWorker, {
      t:'semanticFunction',
      id:4,
      input:{
        architecture:'x86_64',
        platform:'linux',
        binaryId:'binary:phase6-browser-x86',
        sliceId:'slice:phase6-browser-x86',
        decoderSemanticVersion:'capstone-5-x86-structured-v2',
        instructions:x86.instructions ?? [],
      },
    });
    semanticWorker.terminate();
    const firstMachineEffects = semantic?.result?.pipeline?.machineEffects?.[0] ?? null;

    return {
      riscv: {
        ok: riscv.ok, error: riscv.error ?? null, bytesConsumed: riscv.bytesConsumed,
        sizes: (riscv.instructions ?? []).map((instruction) => Number(instruction.size)),
        addresses: (riscv.instructions ?? []).map((instruction) => Number(instruction.address)),
        architectures: [...new Set((riscv.instructions ?? []).map((instruction) => instruction.architecture))],
        hasStructuredDetail: (riscv.instructions ?? []).every((instruction) => Array.isArray(instruction.capstoneOperands)),
      },
      arm64: { ok: arm64.ok, count: (arm64.instructions ?? []).length },
      x86: {
        ok:x86.ok,
        count:(x86.instructions ?? []).length,
        semanticOk:semantic?.ok === true,
        semanticError:semantic?.error ?? null,
        firstCompleteness:firstMachineEffects?.completeness ?? null,
        firstTerminalizedBy:firstMachineEffects?.metadata?.terminalizedBy ?? null,
      },
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    };
  });

  assert.deepEqual(consoleErrors, [], 'the page must not raise errors');
  assert.equal(result.riscv.ok, true, `RISC-V decode failed in the browser: ${result.riscv.error}`);
  assert.equal(result.riscv.bytesConsumed, 16);
  assert.deepEqual(result.riscv.sizes, [2, 4, 2, 4, 4], 'mixed compressed/uncompressed widths must decode in the browser');
  assert.deepEqual(result.riscv.addresses, [0x1000, 0x1002, 0x1006, 0x1008, 0x100c]);
  assert.deepEqual(result.riscv.architectures, ['riscv64']);
  assert.equal(result.riscv.hasStructuredDetail, true, 'structured detail must cross the browser worker boundary');
  assert.equal(result.arm64.ok, true, 'ARM64 must still decode in the browser');
  assert.equal(result.arm64.count, 1);
  assert.equal(result.x86.ok, true, 'x86-64 must still decode in the browser');
  assert.equal(result.x86.count, 2);
  assert.equal(result.x86.semanticOk, true, `x86 receiver revalidation failed: ${result.x86.semanticError}`);
  assert.equal(result.x86.firstCompleteness, 'exact-with-intrinsic',
    'real Capstone memory-MOV must regain terminal exactness only after receiver byte revalidation');
  assert.equal(result.x86.firstTerminalizedBy, 'trusted-capstone-structured-intrinsic',
    'positive exact authority must come from the deployed receiver revalidation path');
  // Phase 6 must not have introduced a cross-origin-isolation requirement.
  assert.equal(result.crossOriginIsolated, false, 'browser decode must not require cross-origin isolation');

  console.log(`PHASE6_BROWSER=${JSON.stringify(result)}`);
  console.log('phase6 browser deployed-WASM decode/revalidation: PASS');
} finally {
  await browser.close();
  server.close();
}
