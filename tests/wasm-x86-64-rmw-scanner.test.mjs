import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BEHAVIOR_CATEGORY,
  scanX86_64RmwFields,
  classifyX86_64Behavior,
} from '../js/analysis/wasm-x86-64-rmw-scanner.js';

function loadStandaloneWasmExports() {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (!wasmPath) return undefined;

  const wasmBytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(wasmBytes);
  assert.strictEqual(
    WebAssembly.Module.imports(mod).length,
    0,
    'standalone x86-64 WASM module must have zero imports',
  );

  const inst = new WebAssembly.Instance(mod, {});
  const raw = inst.exports;
  assert.strictEqual(typeof raw.hex_scan_x86_64_rmw_fields, 'function');
  assert.strictEqual(typeof raw.hex_classify_x86_64_behavior, 'function');

  const heapBaseVal = typeof raw.__heap_base === 'object' && raw.__heap_base !== null
    ? raw.__heap_base.value
    : raw.__heap_base;
  const heapBase = (Number(heapBaseVal) + 7) & ~7;
  assert.ok(heapBase > 0, `expected positive __heap_base, got ${heapBase}`);

  let cursor = heapBase;
  const hex_engine_scratch_reset = () => {
    cursor = heapBase;
  };
  const hex_engine_scratch_alloc = (size) => {
    const n = size >>> 0;
    if (n === 0) return 0;
    const aligned = (cursor + 7) & ~7;
    const next = aligned + n;
    if (next > raw.memory.buffer.byteLength) return 0;
    cursor = next;
    return aligned;
  };

  return {
    memory: raw.memory,
    __heap_base: raw.__heap_base,
    hex_scan_x86_64_rmw_fields: raw.hex_scan_x86_64_rmw_fields,
    hex_classify_x86_64_behavior: raw.hex_classify_x86_64_behavior,
    hex_engine_scratch_alloc,
    hex_engine_scratch_reset,
  };
}

const STANDALONE_EXPORTS = loadStandaloneWasmExports();

function wasmOpts(extra = {}) {
  return STANDALONE_EXPORTS ? { ...extra, wasmExports: STANDALONE_EXPORTS } : { ...extra };
}

function stripEngine(res) {
  const { engine: _engine, ...rest } = res;
  return rest;
}

function assertRmwParity(bytes, opts = {}) {
  const wasmRes = scanX86_64RmwFields(bytes, wasmOpts(opts));
  const jsRes = scanX86_64RmwFields(bytes, { ...opts, engine: 'js' });
  if (STANDALONE_EXPORTS) {
    assert.strictEqual(wasmRes.engine, 'wasm');
  }
  assert.strictEqual(jsRes.engine, 'js');
  assert.deepStrictEqual(wasmRes.hits, jsRes.hits);
  assert.strictEqual(wasmRes.truncated, jsRes.truncated);
  assert.strictEqual(wasmRes.unsupportedArch, jsRes.unsupportedArch);
  return wasmRes;
}

function assertBehaviorParity(bytes, opts = {}) {
  const wasmRes = classifyX86_64Behavior(bytes, wasmOpts(opts));
  const jsRes = classifyX86_64Behavior(bytes, { ...opts, engine: 'js' });
  if (STANDALONE_EXPORTS) {
    assert.strictEqual(wasmRes.engine, 'wasm');
  }
  assert.strictEqual(jsRes.engine, 'js');
  assert.deepStrictEqual(stripEngine(wasmRes), stripEngine(jsRes));
  return wasmRes;
}

test('1. direct memory RMW (sub [rdi+0x10], eax + LOCK add [rdi+0x14], 1) matches WASM === JS', () => {
  // sub dword ptr [rdi+0x10], eax  -> 29 47 10
  // jns +2                         -> 79 02 (clamps previous direct RMW)
  // lock add dword ptr [rdi+0x14], 1 -> F0 83 47 14 01
  const code = new Uint8Array([
    0x29, 0x47, 0x10,
    0x79, 0x02,
    0xF0, 0x83, 0x47, 0x14, 0x01,
  ]);

  const res = assertRmwParity(code);
  assert.strictEqual(res.hits.length, 2);
  assert.deepStrictEqual(res.hits[0], {
    loadOff: 0,
    storeOff: 0,
    arithOff: 0,
    disp: 0x10,
    baseReg: 7, // RDI
    opKind: 1,  // sub
    clamped: true,
    isFloat: false,
    directRmw: true,
    locked: false,
    width: 4,
    flags: 5,   // clamped(1) | direct_rmw(4)
  });
  assert.deepStrictEqual(res.hits[1], {
    loadOff: 5,
    storeOff: 5,
    arithOff: 5,
    disp: 0x14,
    baseReg: 7, // RDI
    opKind: 2,  // add
    clamped: true, // within 3 insns after jns
    isFloat: false,
    directRmw: true,
    locked: true,
    width: 4,
    flags: 13,  // clamped(1) | direct_rmw(4) | locked(8)
  });
});

test('2. Load-Modify-Store GP RMW with cmov/jcc clamp matches WASM === JS', () => {
  // mov eax, [rdi+0x20]    -> 8B 47 20
  // sub eax, esi           -> 29 F0
  // xor edx, edx           -> 31 D2
  // test eax, eax          -> 85 C0
  // cmovs eax, edx         -> 0F 48 C2
  // mov [rdi+0x20], eax    -> 89 47 20
  // ret                    -> C3
  const code = new Uint8Array([
    0x8B, 0x47, 0x20,
    0x29, 0xF0,
    0x31, 0xD2,
    0x85, 0xC0,
    0x0F, 0x48, 0xC2,
    0x89, 0x47, 0x20,
    0xC3,
  ]);

  const res = assertRmwParity(code);
  assert.strictEqual(res.hits.length, 1);
  assert.deepStrictEqual(res.hits[0], {
    loadOff: 0,
    storeOff: 12,
    arithOff: 3,
    disp: 0x20,
    baseReg: 7,
    opKind: 1,
    clamped: true,
    isFloat: false,
    directRmw: false,
    locked: false,
    width: 4,
    flags: 1,
  });
});

test('3. Scalar FP movss/subss/maxss/movss RMW matches WASM === JS', () => {
  // movss xmm0, [rdi+0x30] -> F3 0F 10 47 30 (off 0)
  // subss xmm0, xmm1       -> F3 0F 5C C1    (off 5)
  // maxss xmm0, xmm2       -> F3 0F 5F C2    (off 9)
  // movss [rdi+0x30], xmm0 -> F3 0F 11 47 30 (off 13)
  const code = new Uint8Array([
    0xF3, 0x0F, 0x10, 0x47, 0x30,
    0xF3, 0x0F, 0x5C, 0xC1,
    0xF3, 0x0F, 0x5F, 0xC2,
    0xF3, 0x0F, 0x11, 0x47, 0x30,
  ]);

  const res = assertRmwParity(code);
  assert.strictEqual(res.hits.length, 1);
  assert.deepStrictEqual(res.hits[0], {
    loadOff: 0,
    storeOff: 13,
    arithOff: 5,
    disp: 0x30,
    baseReg: 7,
    opKind: 1,
    clamped: true,
    isFloat: true,
    directRmw: false,
    locked: false,
    width: 4,
    flags: 3, // clamped(1) | float(2)
  });
});

test('4. RSP/RBP are excluded while R12/R13 are detected accurately', () => {
  // sub dword ptr [rsp+0x10], eax -> 29 44 24 10       (RSP=4 -> excluded)
  // sub dword ptr [rbp+0x10], eax -> 29 45 10          (RBP=5 -> excluded)
  // sub dword ptr [r12+0x10], eax -> 41 29 44 24 10    (R12=12 -> detected, off 7)
  // add dword ptr [r13+0x18], eax -> 41 01 45 18       (R13=13 -> detected, off 12)
  const code = new Uint8Array([
    0x29, 0x44, 0x24, 0x10,
    0x29, 0x45, 0x10,
    0x41, 0x29, 0x44, 0x24, 0x10,
    0x41, 0x01, 0x45, 0x18,
  ]);

  const res = assertRmwParity(code);
  assert.strictEqual(res.hits.length, 2);
  assert.strictEqual(res.hits[0].baseReg, 12);
  assert.strictEqual(res.hits[0].disp, 0x10);
  assert.strictEqual(res.hits[0].opKind, 1);
  assert.strictEqual(res.hits[0].loadOff, 7);

  assert.strictEqual(res.hits[1].baseReg, 13);
  assert.strictEqual(res.hits[1].disp, 0x18);
  assert.strictEqual(res.hits[1].opKind, 2);
  assert.strictEqual(res.hits[1].loadOff, 12);
});

test('5. RIP-relative RMW disp is invariant across small chunkSize boundaries', () => {
  // 40 bytes of NOPs, then Load-Modify-Store RIP-relative RMW targeting 0x12E:
  // off 40: mov eax, [rip + 0x100]  -> 8B 05 00 01 00 00 (next=46, target=46+256=302=0x12E)
  // off 46: sub eax, 1              -> 83 E8 01          (next=49)
  // off 49: mov [rip + 0xF7], eax   -> 89 05 F7 00 00 00 (next=55, target=55+247=302=0x12E)
  // 15 bytes of NOPs (off 55..69), then direct RIP-relative RMW targeting 0x24D:
  // off 70: add dword ptr [rip + 0x200], 1 -> 83 05 00 02 00 00 01 (next=77, target=77+512=589=0x24D)
  // 20 bytes of NOPs
  const bytes = [];
  for (let i = 0; i < 40; i++) bytes.push(0x90);
  bytes.push(0x8B, 0x05, 0x00, 0x01, 0x00, 0x00);
  bytes.push(0x83, 0xE8, 0x01);
  bytes.push(0x89, 0x05, 0xF7, 0x00, 0x00, 0x00);
  for (let i = 0; i < 15; i++) bytes.push(0x90);
  bytes.push(0x83, 0x05, 0x00, 0x02, 0x00, 0x00, 0x01);
  for (let i = 0; i < 20; i++) bytes.push(0x90);
  const code = new Uint8Array(bytes);

  const baseline = assertRmwParity(code);
  assert.strictEqual(baseline.hits.length, 2);
  assert.strictEqual(baseline.hits[0].baseReg, 16);
  assert.strictEqual(baseline.hits[0].disp, 0x12E);
  assert.strictEqual(baseline.hits[0].loadOff, 40);
  assert.strictEqual(baseline.hits[0].storeOff, 49);
  assert.strictEqual(baseline.hits[1].baseReg, 16);
  assert.strictEqual(baseline.hits[1].disp, 0x24D);
  assert.strictEqual(baseline.hits[1].loadOff, 70);

  for (const chunkSize of [32, 48, 52, 64]) {
    const chunked = assertRmwParity(code, { chunkSize });
    assert.deepStrictEqual(
      chunked.hits,
      baseline.hits,
      `RIP-relative hits must be invariant for chunkSize=${chunkSize}`,
    );
  }
});

test('6. Behavior classification: drain / accum / crypto AES-NI / xor zero-idiom / accessor / 1B ret', () => {
  // 6a. DRAIN: clamped sub RMW + ret
  const drainCode = new Uint8Array([
    0x8B, 0x47, 0x10,       // mov eax, [rdi+0x10]
    0x29, 0xF0,             // sub eax, esi
    0x85, 0xC0,             // test eax, eax
    0x0F, 0x48, 0xC2,       // cmovs eax, edx
    0x89, 0x47, 0x10,       // mov [rdi+0x10], eax
    0xC3,                   // ret
  ]);
  const drainRes = assertBehaviorParity(drainCode);
  assert.strictEqual(drainRes.valid, true);
  assert.strictEqual(drainRes.topCategory, BEHAVIOR_CATEGORY.DRAIN);
  assert.strictEqual(drainRes.accessorScore, 0);
  assert.strictEqual(drainRes.insnCount, 6);
  assert.strictEqual((drainRes.flags & 1) !== 0, true);

  // 6b. ACCUM: add RMW + ret
  const accumCode = new Uint8Array([
    0x8B, 0x47, 0x18,       // mov eax, [rdi+0x18]
    0x01, 0xF0,             // add eax, esi
    0x89, 0x47, 0x18,       // mov [rdi+0x18], eax
    0xC3,                   // ret
  ]);
  const accumRes = assertBehaviorParity(accumCode);
  assert.strictEqual(accumRes.valid, true);
  assert.strictEqual(accumRes.topCategory, BEHAVIOR_CATEGORY.ACCUM);
  assert.strictEqual(accumRes.accumScore, 390); // 1*350 + 1*40
  assert.strictEqual(accumRes.accessorScore, 0);
  assert.strictEqual((accumRes.flags & 8) !== 0, true);

  // 6c. CRYPTO: AES-NI aesenc + non-zeroing xor + ret
  const cryptoCode = new Uint8Array([
    0x66, 0x0F, 0x38, 0xDC, 0xC1, // aesenc xmm0, xmm1
    0x31, 0xD8,                   // xor eax, ebx
    0xC3,                         // ret
  ]);
  const cryptoRes = assertBehaviorParity(cryptoCode);
  assert.strictEqual(cryptoRes.valid, true);
  assert.strictEqual(cryptoRes.topCategory, BEHAVIOR_CATEGORY.CRYPTO);
  assert.strictEqual(cryptoRes.cryptoScore, 580); // 1*500 + 1*80
  assert.strictEqual((cryptoRes.flags & 2) !== 0, true);

  // 6d. xor reg, reg zeroing idioms must NOT count as bitwise
  const zeroCode = new Uint8Array([
    0x31, 0xC0,             // xor eax, eax
    0x45, 0x31, 0xC0,       // xor r8d, r8d
    0x48, 0x31, 0xC0,       // xor rax, rax
    0xC3,                   // ret
  ]);
  const zeroRes = assertBehaviorParity(zeroCode);
  assert.strictEqual(zeroRes.valid, true);
  assert.strictEqual(zeroRes.cryptoScore, 0);
  assert.strictEqual(zeroRes.topCategory, BEHAVIOR_CATEGORY.NONE);
  assert.strictEqual(zeroRes.insnCount, 4);

  // 6e. ACCESSOR: mov eax, [rdi+0x10]; ret
  const accessorCode = new Uint8Array([
    0x8B, 0x47, 0x10,       // mov eax, [rdi+0x10]
    0xC3,                   // ret
  ]);
  const accessorRes = assertBehaviorParity(accessorCode);
  assert.strictEqual(accessorRes.valid, true);
  assert.strictEqual(accessorRes.topCategory, BEHAVIOR_CATEGORY.ACCESSOR);
  assert.strictEqual(accessorRes.accessorScore, 900);
  assert.strictEqual(accessorRes.insnCount, 2);
  assert.strictEqual((accessorRes.flags & 16) !== 0, true);

  // 6f. 1B ret
  const retOnly = new Uint8Array([0xC3]);
  const retRes = assertBehaviorParity(retOnly);
  assert.strictEqual(retRes.valid, true);
  assert.strictEqual(retRes.insnCount, 1);
  assert.strictEqual(retRes.topCategory, BEHAVIOR_CATEGORY.NONE);
});

test('7. Non-x86-64 architecture guard returns empty + unsupportedArch: true', () => {
  const code = new Uint8Array([0x29, 0x47, 0x10, 0xC3]);

  const rmwArm = scanX86_64RmwFields(code, wasmOpts({ arch: 'arm64' }));
  assert.strictEqual(rmwArm.unsupportedArch, true);
  assert.deepStrictEqual(rmwArm.hits, []);

  const behArm = classifyX86_64Behavior(code, wasmOpts({ arch: 'arm64' }));
  assert.strictEqual(behArm.unsupportedArch, true);
  assert.strictEqual(behArm.valid, false);

  // Accepted x86-64 aliases: x64, amd64
  const rmwX64 = assertRmwParity(code, { arch: 'x64' });
  assert.strictEqual(rmwX64.unsupportedArch, false);
  assert.strictEqual(rmwX64.hits.length, 1);

  const behAmd64 = assertBehaviorParity(code, { arch: 'amd64' });
  assert.strictEqual(behAmd64.unsupportedArch, false);
  assert.strictEqual(behAmd64.valid, true);
});

test('8. Control barriers, base_reg clobber, VEX skip, and truncated bytes parity', () => {
  // Base reg clobber: mov eax, [rdi+0x10]; sub eax, 1; mov rdi, rsi; mov [rdi+0x10], eax -> NO hit
  const clobberCode = new Uint8Array([
    0x8B, 0x47, 0x10,
    0x83, 0xE8, 0x01,
    0x48, 0x89, 0xF7,
    0x89, 0x47, 0x10,
  ]);
  const clobberRes = assertRmwParity(clobberCode);
  assert.strictEqual(clobberRes.hits.length, 0);

  // VEX 2B vzeroupper (C5 F8 77) + truncated trailing prefix (48 0F) must not OOB or loop
  const edgeCode = new Uint8Array([
    0xC5, 0xF8, 0x77,       // vzeroupper
    0x29, 0x47, 0x08,       // sub [rdi+8], eax
    0x48, 0x0F,             // truncated escape at EOF
  ]);
  const edgeRmw = assertRmwParity(edgeCode);
  assert.strictEqual(edgeRmw.hits.length, 1);
  assert.strictEqual(edgeRmw.hits[0].loadOff, 3);
  assertBehaviorParity(edgeCode);
});
