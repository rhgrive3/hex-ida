import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { FLAG_TRANSFER_CASES, evaluateFlagTransfer, verifyFlagTransferValues } from '../../machine-effects/helpers/lahf-sahf-oracle.mjs';

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
const X87_CASES = [
  ['fsqrt', [0xd9, 0xfa], 'fpu-flags'],
  ['fsin', [0xd9, 0xfe], 'fpu-flags'],
  ['fsincos', [0xd9, 0xfb], 'fpu-flags'],
  ['fscale', [0xd9, 0xfd], 'fpu-flags'],
  ['fstp', [0xdd, 0xd8], 'fpu-flags'],
  ['fxam', [0xd9, 0xe5], 'fpu-flags'],
  ['fxch', [0xd9, 0xc9], 'fpu-flags'],
  ['fxtract', [0xd9, 0xf4], 'fpu-flags'],
  ['fucompi', [0xdf, 0xe9], 'eflags'],
  ['fcompi', [0xdf, 0xf1], 'eflags'],
  ['fucomi', [0xdb, 0xe9], 'eflags'],
  ['fcmovbe', [0xda, 0xd1], 'eflags'],
  ['fcomi', [0xdb, 0xf1], 'eflags'],
];
const SYSTEM_CASES = [
  ['iret', [0x66, 0xcf]], ['iretd', [0xcf]], ['iretq', [0x48, 0xcf]],
  ['saveprevssp', [0xf3, 0x0f, 0x01, 0xea]],
  ['rdmsr', [0x0f, 0x32]], ['wrmsr', [0x0f, 0x30]], ['sgdt', [0x0f, 0x01, 0x00]],
];

// Optional stronger hardware differential. When explicitly requested it fails
// closed on a missing/failed oracle, partial inventory, or unsupported host.
// Normal browser proof stays independent of native compiler availability.
let nativeFlagOracle = null;
const nativeReportPath = process.env.HEX_X86_FLAG_ORACLE_REPORT;
const nativeProofs = [];
const git = args => execFileSync('git', args, { cwd:root, encoding:'utf8' }).trim();
let nativeProductHead = null;
if (nativeReportPath) {
  assert.ok(process.env.HEX_X86_FLAG_ORACLE, 'native report requires an explicitly selected executable');
  assert.equal(git(['status', '--porcelain']), '', 'native report requires a clean product tree');
  assert.equal(fs.existsSync(path.resolve(nativeReportPath)), false, 'native report must not overwrite an existing artifact');
  nativeProductHead = git(['rev-parse', 'HEAD']);
}
if (process.env.HEX_X86_FLAG_ORACLE) {
  const binary = path.resolve(process.env.HEX_X86_FLAG_ORACLE);
  const run = spawnSync(binary, [], { encoding:'utf8', maxBuffer:64 * 1024 * 1024, timeout:30_000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const [identity, ...rows] = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(identity.schema, 'x86-lahf-sahf-native/v2');
  assert.equal(identity.extendedEcx & 1, 1);
  assert.equal(rows.length, 91392, 'full native prefix/state inventory');
  const keys = new Set();
  for (const row of rows) {
    assert.ok(['lahf', 'sahf'].includes(row.family));
    assert.ok([0, 0x26, 0x2e, 0x36, 0x3e].includes(row.prefix) || (row.prefix >= 0x40 && row.prefix <= 0x4f));
    const key = `${row.family}:${row.prefix}:${row.initial}:${row.before}`;
    assert.ok(!keys.has(key), `duplicate native observation: ${key}`);
    keys.add(key);
  }
  const baseline = BigInt(rows[0].before) & ~0xcd5n;
  const seeds = [0x0123456789abcdefn, 0xfedcba9876543210n];
  const hex = value => `0x${value.toString(16).padStart(16, '0')}`;
  for (const { family, prefix } of FLAG_TRANSFER_CASES) {
    for (const seed of seeds) {
      for (let byte = 0n; byte < (family === 'sahf' ? 256n : 32n); byte++) {
        for (let extra = 0n; extra < 4n; extra++) {
          const flagBits = (byte & 1n) | ((byte & 2n) << 1n) | ((byte & 4n) << 2n)
            | ((byte & 8n) << 3n) | ((byte & 16n) << 3n);
          for (const prior of family === 'sahf' ? [0n, 0xd5n] : [flagBits]) {
            const initial = family === 'sahf' ? (seed & ~0xff00n) | (byte << 8n) : seed;
            const before = baseline | prior | (extra << 10n);
            const key = `${family}:${prefix ?? 0}:${hex(initial)}:${hex(before)}`;
            assert.ok(keys.delete(key), `missing native input: ${key}`);
          }
        }
      }
    }
  }
  assert.equal(keys.size, 0, 'no substituted native input rows');
  nativeFlagOracle = {
    identity, rows, binary, binarySha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    observationSha256:createHash('sha256').update(run.stdout).digest('hex'),
  };
}

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

const { chromium, webkit } = await playwright();
const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
async function verifyBrowser(browserType, engine) {
const browser = await browserType.launch();
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(`${origin}/phase6-test`);

  const result = await page.evaluate(async ({ x87Cases, systemCases, flagCases }) => {
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
    // mov rax,[rbx] | ret now has dedicated exact memory semantics. Keep this
    // production path covered; x87 below separately requires terminalization.
    const x86 = await requestWorker(decoderWorker, {
      id: 3, architecture: 'x86_64', address: 0x2000n,
      bytes: new Uint8Array([0x48, 0x8b, 0x03, 0xc3]),
    });
    const x87Rows = [];
    for (const [index, [, bytes]] of x87Cases.entries()) {
      x87Rows.push(await requestWorker(decoderWorker, {
        id: 100 + index, architecture: 'x86_64', address: 0x3000n,
        bytes: new Uint8Array(bytes),
      }));
    }
    const systemRows = [];
    for (const [index, [, bytes]] of systemCases.entries()) {
      systemRows.push(await requestWorker(decoderWorker, {
        id: 300 + index, architecture: 'x86_64', address: 0x4000n,
        bytes: new Uint8Array(bytes),
      }));
    }
    const flagRows = [];
    for (const [index, { bytes }] of flagCases.entries()) {
      flagRows.push(await requestWorker(decoderWorker, {
        id:500 + index, architecture:'x86_64', address:0x5000n, bytes:new Uint8Array(bytes),
      }));
    }
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
    const firstMachineEffects = semantic?.result?.pipeline?.machineEffects?.[0] ?? null;
    const x87 = [];
    for (const [index, decoded] of x87Rows.entries()) {
      const analyzed = await requestWorker(semanticWorker, {
        t: 'semanticFunction', id: 200 + index,
        input: {
          architecture: 'x86_64', platform: 'linux',
          binaryId: 'binary:phase6-browser-x87', sliceId: 'slice:phase6-browser-x87',
          decoderSemanticVersion: 'capstone-5-x86-structured-v2',
          instructions: decoded.instructions ?? [],
        },
      });
      const bundle = analyzed?.result?.pipeline?.machineEffects?.[0];
      const summary = bundle?.operations?.find((op) => op.kind === 'intrinsic')?.effectSummary;
      x87.push({
        decodeOk: decoded.ok === true,
        count: decoded.instructions?.length,
        family: decoded.instructions?.[0]?.instructionFamily,
        flagsKind: decoded.instructions?.[0]?.detail?.flagsKind,
        semanticOk: analyzed.ok === true,
        semanticError: analyzed.error ?? null,
        completeness: bundle?.completeness,
        terminalizedBy: bundle?.metadata?.terminalizedBy,
        reads: summary?.registersRead ?? [],
        writes: summary?.registersWritten ?? [],
      });
    }
    const system = [];
    for (const [index, decoded] of systemRows.entries()) {
      for (const closureMatrixTerminal of [false, true]) {
        const analyzed = await requestWorker(semanticWorker, {
          t: 'semanticFunction', id: 400 + index * 2 + Number(closureMatrixTerminal),
          input: {
            architecture: 'x86_64', platform: 'linux',
            binaryId: 'binary:phase6-browser-system', sliceId: 'slice:phase6-browser-system',
            decoderSemanticVersion: 'capstone-5-x86-structured-v2',
            instructions: decoded.instructions ?? [],
            machineEffectsContext: { closureMatrixTerminal },
          },
        });
        const bundle = analyzed?.result?.pipeline?.machineEffects?.[0];
        const summary = bundle?.operations?.find((op) => op.kind === 'intrinsic')?.effectSummary;
        system.push({
          family: decoded.instructions?.[0]?.instructionFamily,
          decodeOk: decoded.ok === true, count: decoded.instructions?.length,
          semanticOk: analyzed.ok === true, semanticError: analyzed.error ?? null,
          closureMatrixTerminal, completeness: bundle?.completeness,
          terminalizedBy: bundle?.metadata?.terminalizedBy ?? null,
          reason: bundle?.unknownEffects?.reason ?? null,
          controlKind: bundle?.controlEffect?.kind,
          memoryRead: summary?.memoryRead ?? null, memoryWrite: summary?.memoryWrite ?? null,
        });
      }
    }
    const flagTransfers = [];
    for (const [index, decoded] of flagRows.entries()) {
      const analyzed = await requestWorker(semanticWorker, {
        t:'semanticFunction', id:600 + index,
        input:{
          architecture:'x86_64', platform:'linux', binaryId:'binary:phase6-browser-flags',
          sliceId:'slice:phase6-browser-flags', decoderSemanticVersion:'capstone-5-x86-structured-v2',
          instructions:decoded.instructions ?? [],
        },
      });
      flagTransfers.push({
        decodeOk:decoded.ok === true, count:decoded.instructions?.length,
        family:decoded.instructions?.[0]?.instructionFamily,
        bytes:[...(decoded.instructions?.[0]?.rawBytes ?? [])],
        semanticOk:analyzed.ok === true, semanticError:analyzed.error ?? null,
        bundle:analyzed?.result?.pipeline?.machineEffects?.[0],
      });
    }
    semanticWorker.terminate();

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
      x87, system, flagTransfers,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    };
  }, { x87Cases: X87_CASES, systemCases: SYSTEM_CASES, flagCases:FLAG_TRANSFER_CASES });

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
  assert.equal(result.x86.firstCompleteness, 'exact',
    'real memory-MOV must retain its dedicated exact semantics after receiver byte revalidation');
  assert.equal(result.x86.firstTerminalizedBy, null,
    'dedicated memory semantics must not be replaced by a summary-only terminal');
  assert.equal(result.x87.length, X87_CASES.length);
  for (const [index, [family, , domain]] of X87_CASES.entries()) {
    const row = result.x87[index];
    assert.equal(row.decodeOk, true, `${engine}:${family}: decoder success`);
    assert.equal(row.count, 1, `${engine}:${family}: complete fixture decode`);
    assert.equal(row.family, family);
    assert.equal(row.flagsKind, domain);
    assert.equal(row.semanticOk, true, `${engine}:${family}: ${row.semanticError}`);
    assert.equal(row.completeness, 'exact-with-intrinsic', `${engine}:${family}`);
    assert.equal(row.terminalizedBy, 'trusted-capstone-structured-intrinsic', `${engine}:${family}`);
    assert.ok(row.reads.includes('x86.x87.environment'), `${family}: environment read`);
    assert.ok(row.writes.includes('x86.x87.environment'), `${family}: environment write`);
    if (domain === 'fpu-flags') {
      assert.ok(![...row.reads, ...row.writes].some((value) => value === 'rflags' || value.startsWith('rflags.')),
        `${family}: x87 status must not become RFLAGS`);
    } else if (family === 'fcmovbe') {
      assert.ok(![...row.reads, ...row.writes].some((value) => value.startsWith('fpsw.')),
        `${family}: RFLAGS must not become FPSW condition flags`);
      assert.ok(row.reads.some((value) => value === 'rflags' || value.startsWith('rflags.')),
        `${family}: RFLAGS dependency`);
    } else {
      // The native oracle preserves x87 C flags while writing arithmetic flags.
      for (const flag of ['cf', 'pf', 'zf', 'of', 'sf', 'af']) {
        assert.ok(row.writes.includes(`rflags.${flag}`), `${family}: ${flag} output`);
      }
      assert.ok(!row.reads.some((value) => value === 'rflags' || value.startsWith('rflags.')),
        `${family}: no prior arithmetic-flag dependency`);
      for (const flag of ['c0', 'c1', 'c2', 'c3']) assert.ok(!row.writes.includes(`fpsw.${flag}`));
    }
    if (family === 'fsqrt') {
      for (const flag of ['c0', 'c1', 'c2', 'c3']) assert.ok(row.writes.includes(`fpsw.${flag}`));
    }
  }
  assert.equal(result.system.length, SYSTEM_CASES.length * 2);
  for (const [index, row] of result.system.entries()) {
    assert.equal(row.family, SYSTEM_CASES[Math.floor(index / 2)][0]);
    assert.equal(row.decodeOk, true);
    assert.equal(row.count, 1);
    assert.equal(row.semanticOk, true, `${engine}:${row.family}:${row.semanticError}`);
    assert.equal(row.closureMatrixTerminal, index % 2 === 1);
    if (row.family === 'sgdt' && row.closureMatrixTerminal) {
      assert.equal(row.completeness, 'exact-with-intrinsic');
      assert.equal(row.memoryWrite?.scope, 'accesses', 'retain the explicit SGDT memory evidence');
      assert.ok(row.memoryWrite.accesses.some((access) => access.widthBits === 80));
    } else {
      assert.equal(row.completeness, 'partial', `${engine}:${row.family}: unproven system state`);
      assert.equal(row.controlKind, 'unknown', `${row.family}: no invented trap/fallthrough`);
      assert.equal(row.terminalizedBy, null);
      assert.equal(row.reason, 'x86-extended-system-family-requires-dedicated-semantics');
      assert.notEqual(row.memoryRead?.scope, 'none', `${row.family}: no invented memory absence`);
      assert.notEqual(row.memoryWrite?.scope, 'none', `${row.family}: no invented memory absence`);
    }
  }
  assert.equal(result.flagTransfers.length, FLAG_TRANSFER_CASES.length);
  let flagValueCases = 0;
  const bundles = new Map();
  for (const [index, row] of result.flagTransfers.entries()) {
    const candidate = FLAG_TRANSFER_CASES[index];
    assert.equal(row.decodeOk, true);
    assert.equal(row.count, 1);
    assert.equal(row.family, candidate.family);
    assert.deepEqual(row.bytes, candidate.bytes, 'every prefix byte must reach the receiver');
    assert.equal(row.semanticOk, true, row.semanticError);
    flagValueCases += verifyFlagTransferValues(row.bundle, candidate.family);
    bundles.set(`${candidate.family}:${candidate.prefix ?? 0}`, row.bundle);
  }
  if (nativeFlagOracle) {
    for (const row of nativeFlagOracle.rows) {
      const actual = evaluateFlagTransfer(bundles.get(`${row.family}:${row.prefix}`), BigInt(row.initial), BigInt(row.before));
      assert.deepEqual(actual, { rax:BigInt(row.rax), rflags:BigInt(row.after) }, `native:${engine}:${JSON.stringify(row)}`);
    }
    const { rows, ...identity } = nativeFlagOracle;
    nativeProofs.push({ engine, browserVersion:browser.version(), cases:rows.length, encodings:FLAG_TRANSFER_CASES.length });
    console.log(`LAHF_SAHF_NATIVE=${JSON.stringify({ engine, ...identity, cases:rows.length })}`);
  }
  // Keep successful logs bounded; complete bundles are checked above.
  result.flagTransfers = { encodings:FLAG_TRANSFER_CASES.length, valueCases:flagValueCases };
  // Phase 6 must not have introduced a cross-origin-isolation requirement.
  assert.equal(result.crossOriginIsolated, false, 'browser decode must not require cross-origin isolation');

  console.log(`PHASE6_BROWSER=${JSON.stringify({ engine, ...result })}`);
  console.log(`phase6 ${engine} deployed-WASM decode/revalidation: PASS`);
} finally {
  await browser.close();
}
}
try {
  await verifyBrowser(chromium, 'chromium');
  await verifyBrowser(webkit, 'webkit');
} finally {
  server.close();
}

// Publish only after both engines and every required row succeeded. The exact
// product and oracle identities must still match; a failed/interrupted run must
// never leave a final report that a later checkpoint could mistake for proof.
if (nativeReportPath) {
  assert.equal(git(['rev-parse', 'HEAD']), nativeProductHead);
  assert.equal(git(['status', '--porcelain']), '');
  assert.deepEqual(nativeProofs.map(proof => proof.engine), ['chromium', 'webkit']);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(fs.readFileSync(nativeFlagOracle.binary)), nativeFlagOracle.binarySha256);
  const report = {
    schema:'x86-lahf-sahf-browser-native-proof/v2', status:'PASS_NORMAL_EXECUTION_ONLY',
    productHead:nativeProductHead,
    verifierSha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),
    evaluatorSha256:digest(fs.readFileSync(path.join(root, 'tests/machine-effects/helpers/lahf-sahf-oracle.mjs'))),
    fixtureSha256:digest(fs.readFileSync(path.join(root, 'tools/validation/machine-effects/fixtures/lahf-sahf-oracle.c'))),
    binarySha256:nativeFlagOracle.binarySha256, observationSha256:nativeFlagOracle.observationSha256,
    nativeIdentity:nativeFlagOracle.identity, proofs:nativeProofs,
    unproven:['CPUID-disabled fault execution', 'other CPU implementations', 'physical iPad', 'complete MachineEffects denominator'],
  };
  const target = path.resolve(nativeReportPath), pending = `${target}.pending-${randomUUID()}`;
  let published = false;
  try {
    const descriptor = fs.openSync(pending, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    assert.deepEqual(JSON.parse(fs.readFileSync(pending, 'utf8')), report);
    fs.renameSync(pending, target);
    published = true;
    const directory = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), report);
  } catch (error) {
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
    if (published) fs.unlinkSync(target);
    throw error;
  }
  console.log(`native proof artifact: ${target}`);
}
