import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// #8725 — the shared maxOperations ceiling must be admitted WHILE the managed
// lifters materialize instruction bundles, not only after the whole bundle
// graph is built. The three DEX/CIL/JVM lifters now create the same
// createVMEffectBudgetTracker the Wasm lifter has always used and charge one
// operation per bundle before construction, so an over-budget method fails
// closed with a deterministic resource-limit error instead of first allocating
// its entire (hostile) graph.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function jvmClass(count, tailOpcode = 0xb1) {
  const bytecode = new Uint8Array(count + 1);
  for (let i = 0; i < count; i++) bytecode[i] = 0x00; // nop
  bytecode[count] = tailOpcode; // return (void)
  return {
    moduleId: 'managed-mod:budget-8725', vmSpecEdition: 'java-se-17', thisClassName: 'pkg/Test',
    constantPool: [null], fields: [],
    methods: [{ accessFlags: 0x0009, name: 'm', descriptor: '()V', code: {
      maxStack: 0, maxLocals: 0, offset: 0, exceptionTable: [], bytecode,
    } }],
  };
}

test('JVM/CIL lifters reject an over-budget method before materializing the full graph', async () => {
  const { liftJvmMethod } = await import(pathToFileURL(path.join(repo, 'js/managed/jvm/lifter.js')).href);
  const { buildCil } = await import(pathToFileURL(path.join(repo, 'tests/phase11/fixtures/medium-cil.mjs')).href);
  const { CilFrontend } = await import(pathToFileURL(path.join(repo, 'js/managed/cil/frontend.js')).href);

  // JVM: a method at the default ceiling lifts; one over the ceiling fails closed.
  assert.equal(liftJvmMethod(0, jvmClass(16383), { budget: { maxOperations: 16384 } }).bundles.length, 16384);
  assert.throws(
    () => liftJvmMethod(0, jvmClass(20000), { budget: { maxOperations: 4 } }),
    /vm-effect-resource-limit-operations/,
  );

  // CIL: a tiny method lifts; the same over-budget admission fails closed.
  const N = 200000;
  const body = new Uint8Array(N + 1); body[N] = 0x2a; // nops + ret
  const bytes = buildCil({ imageSize: 0x1800 + N + 64, methods: [{ name: 'F', signature: [0, 0, 1], fat: true, body }] }).bytes;
  const fe = new CilFrontend();
  const image = await fe.open(bytes, { binaryId: 'cil-budget' });
  let method = null; for await (const m of fe.enumerateMethods(image)) method = m;
  await assert.rejects(() => fe.decodeMethod(method, { image, budget: { maxOperations: 16 } }), /vm-effect-resource-limit-operations/);
});

test('over-budget managed method terminates with a resource-limit error, not OOM (allocation-order guard)', () => {
  // A constrained heap cannot hold 200k materialized bundles (~3.5 kB each). If
  // admission ever regresses to post-materialization only, this child is killed
  // by the OOM killer before it can report the deterministic resource-limit
  // error. With pre-materialization admission the lifters stop at 16,384 bundles
  // and exit cleanly.
  const childSrc = `
import { liftJvmMethod } from ${JSON.stringify(pathToFileURL(path.join(repo, 'js/managed/jvm/lifter.js')).href)};
import { buildCil } from ${JSON.stringify(pathToFileURL(path.join(repo, 'tests/phase11/fixtures/medium-cil.mjs')).href)};
import { CilFrontend } from ${JSON.stringify(pathToFileURL(path.join(repo, 'js/managed/cil/frontend.js')).href)};
const N = 200000;
const bc = new Uint8Array(N + 1); bc[N] = 0xb1;
const cls = { moduleId:'m', vmSpecEdition:'java-se-17', thisClassName:'T', constantPool:[null], fields:[],
  methods:[{ accessFlags:9, name:'m', descriptor:'()V', code:{ maxStack:0, maxLocals:0, offset:0, exceptionTable:[], bytecode:bc } }] };
function report(name, e) { console.log(name + ':' + (/resource-limit-operations/.test(e.message) ? 'RESOURCE_LIMIT' : 'BAD:' + e.message)); }
function check(name, fn) { try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => {}, (e) => report(name, e)); } catch (e) { return report(name, e); } }
check('JVM', () => liftJvmMethod(0, cls));
const body = new Uint8Array(N + 1); body[N] = 0x2a;
const bytes = buildCil({ imageSize: 0x1800 + N + 64, methods: [{ name:'F', signature:[0,0,1], fat:true, body }] }).bytes;
const fe = new CilFrontend();
const image = await fe.open(bytes, { binaryId:'cil' });
let m = null; for await (const x of fe.enumerateMethods(image)) m = x;
await check('CIL', () => fe.decodeMethod(m, { image }));
`;
  const dir = mkdtempSync(path.join(tmpdir(), 'issue-8725-'));
  const file = path.join(dir, 'child.mjs');
  writeFileSync(file, childSrc);
  const res = spawnSync(process.execPath, ['--max-old-space-size=128', file], { encoding: 'utf8', timeout: 60000 });
  const stderr = res.stderr || '';
  assert.doesNotMatch(stderr, /out of memory|heap OOM|JavaScript heap/i, `child OOMed (allocation-order regression): ${stderr.slice(0, 200)}`);
  assert.equal(res.status, 0, `child exited ${res.status}: ${stderr.slice(0, 200)}`);
  assert.match(res.stdout, /JVM:RESOURCE_LIMIT/);
  assert.match(res.stdout, /CIL:RESOURCE_LIMIT/);
});
