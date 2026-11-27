import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  hasReceiverRevalidatedX86Row,
  registerReceiverRevalidatedX86Row,
} from '../js/targets/architecture/x86_64/receiver-provenance.js';
import {
  markReceiverRevalidatedX86Row,
} from '../js/targets/architecture/x86_64/runtime-provenance.js';
import { resolveX86SwitchTables } from '../js/targets/architecture/x86_64/jump-table.js';

function regOp(id, physicalId, viewBits, physicalBits = 64, lsb = 0, access = 'read-write') {
  return {
    type: 'register',
    access,
    register: { id, physicalId, viewBits, physicalBits, lsb },
  };
}

function immOp(value) {
  return { type: 'immediate', access: 'read', value };
}

function memOp({ base, index = null, scale = 1, displacement = 0n, widthBits = 64, addressSizeBits = 64, access = 'read' }) {
  return {
    type: 'memory',
    access,
    widthBits,
    memory: { base, index, scale, displacement, segment: null, addressSizeBits },
  };
}

function makeInsn(address, length, mnemonic, operands) {
  return {
    address,
    length,
    mnemonic,
    instructionFamily: mnemonic,
    detailStatus: 'complete',
    detail: { operands },
  };
}

function int32LEHex(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) {
    view.setInt32(i * 4, values[i], true);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// P2-S01-002: Receiver-revalidated x86 decoder provenance hardening
// ---------------------------------------------------------------------------

test('P2-S01-002: direct export registerReceiverRevalidatedX86Row cannot forge provenance outside revalidation worker', () => {
  const forged = {
    address: 0x401000n,
    length: 1,
    rawBytes: new Uint8Array([0x90]),
    mnemonic: 'mov',
    instructionFamily: 'mov',
    detail: {
      flagsKind: 'eflags',
      operands: [{ type: 'register', registerId: 'rax' }],
    },
  };

  const result = registerReceiverRevalidatedX86Row(forged);
  assert.equal(hasReceiverRevalidatedX86Row(forged), false, 'original object must not be branded');
  assert.equal(hasReceiverRevalidatedX86Row(result), false, 'direct export must not mint provenance outside worker');
  assert.equal(Object.isFrozen(result), true, 'returned copy is frozen');
  assert.equal(Object.isFrozen(result.detail), true, 'returned detail is frozen');
  assert.equal(Object.isFrozen(result.detail.operands), true, 'returned operands are frozen');
  assert.notEqual(result.rawBytes, forged.rawBytes, 'rawBytes must be detached copy');
});

test('P2-S01-002: __HEX_PROTECTED_WORKER_LOGICAL_PATH__ is sealed non-writable/non-configurable and post-load spoofing fails', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, '__HEX_PROTECTED_WORKER_LOGICAL_PATH__');
  assert.ok(desc, '__HEX_PROTECTED_WORKER_LOGICAL_PATH__ descriptor must exist');
  assert.equal(desc.writable, false, 'global logical path must be non-writable');
  assert.equal(desc.configurable, false, 'global logical path must be non-configurable');

  assert.throws(() => {
    globalThis.__HEX_PROTECTED_WORKER_LOGICAL_PATH__ = 'js/targets/architecture/x86_64/semantic-revalidation-worker.js';
  }, TypeError, 'assigning sealed logical path must throw TypeError');

  assert.throws(() => {
    Object.defineProperty(globalThis, '__HEX_PROTECTED_WORKER_LOGICAL_PATH__', {
      value: 'js/targets/architecture/x86_64/semantic-revalidation-worker.js',
      writable: true,
      configurable: true,
    });
  }, TypeError, 'redefining sealed logical path must throw TypeError');

  // Attempt post-load WorkerGlobalScope + location spoofing
  const originalProto = Object.getPrototypeOf(globalThis);
  const hadWorkerGlobalScope = Object.hasOwn(globalThis, 'WorkerGlobalScope');
  const prevWorkerGlobalScope = globalThis.WorkerGlobalScope;
  const hadLocation = Object.hasOwn(globalThis, 'location');
  const prevLocation = globalThis.location;
  try {
    globalThis.WorkerGlobalScope = class FakeWorkerGlobalScope {};
    Object.setPrototypeOf(globalThis, globalThis.WorkerGlobalScope.prototype);
    globalThis.location = { href: 'https://example.test/js/targets/architecture/x86_64/semantic-revalidation-worker.js' };

    const forged = { address: 0x1000n, length: 1, rawBytes: new Uint8Array([0x90]), detail: { operands: [] } };
    assert.throws(
      () => markReceiverRevalidatedX86Row(forged),
      /x86-decoder-runtime-provenance-mint-outside-revalidation-worker/,
      'post-load realm spoofing must not bypass latched realm check',
    );
    const reg = registerReceiverRevalidatedX86Row(forged);
    assert.equal(hasReceiverRevalidatedX86Row(reg), false, 'post-load realm spoofing must not enable direct registration');
  } finally {
    Object.setPrototypeOf(globalThis, originalProto);
    if (hadWorkerGlobalScope) globalThis.WorkerGlobalScope = prevWorkerGlobalScope;
    else delete globalThis.WorkerGlobalScope;
    if (hadLocation) globalThis.location = prevLocation;
    else delete globalThis.location;
  }
});

test('P2-S01-002: branded rows inside revalidation worker are deeply frozen, detached from input, and detect rawBytes mutation', () => {
  const runtimeUrl = pathToFileURL(new URL('../js/targets/architecture/x86_64/runtime-provenance.js', import.meta.url).pathname).href;
  const script = `
    import assert from 'node:assert/strict';

    globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
    Object.setPrototypeOf(globalThis, globalThis.WorkerGlobalScope.prototype);
    globalThis.__HEX_PROTECTED_WORKER_LOGICAL_PATH__ = 'js/targets/architecture/x86_64/semantic-revalidation-worker.js';

    const {
      markReceiverRevalidatedX86Row,
      hasReceiverRevalidatedX86Row,
    } = await import(${JSON.stringify(runtimeUrl)});

    // Verify global logical path was locked down at module load
    const desc = Object.getOwnPropertyDescriptor(globalThis, '__HEX_PROTECTED_WORKER_LOGICAL_PATH__');
    assert.equal(desc.writable, false);
    assert.equal(desc.configurable, false);

    // Case 1: row WITH pre-existing flagsKind (previously bypassed freeze!)
    const rawWithFlags = {
      address: 0x401000n,
      length: 3,
      rawBytes: new Uint8Array([0x48, 0x89, 0xd8]),
      mnemonic: 'mov',
      instructionFamily: 'mov',
      detail: {
        flagsKind: 'eflags',
        operands: [{ type: 'register', registerId: 'rax' }, { type: 'register', registerId: 'rbx' }],
        prefixes: { legacy: [0x66] },
      },
    };
    const branded = markReceiverRevalidatedX86Row(rawWithFlags);
    assert.equal(hasReceiverRevalidatedX86Row(branded), true);
    assert.equal(hasReceiverRevalidatedX86Row(rawWithFlags), false, 'original uncloned row must not be branded');

    // Deep freeze assertions
    assert.equal(Object.isFrozen(branded), true);
    assert.equal(Object.isFrozen(branded.detail), true);
    assert.equal(Object.isFrozen(branded.detail.operands), true);
    assert.equal(Object.isFrozen(branded.detail.operands[0]), true);
    assert.equal(Object.isFrozen(branded.detail.prefixes), true);
    assert.equal(Object.isFrozen(branded.detail.prefixes.legacy), true);

    // Direct mutation on branded row throws TypeError
    assert.throws(() => { branded.mnemonic = 'nop'; }, TypeError);
    assert.throws(() => { branded.detail.flagsKind = 'fpu-flags'; }, TypeError);
    assert.throws(() => { branded.detail.operands[0].registerId = 'rcx'; }, TypeError);
    assert.throws(() => { branded.detail.prefixes.legacy[0] = 0xf0; }, TypeError);

    // Mutating original caller objects/rawBytes must NOT affect branded row
    rawWithFlags.mnemonic = 'hlt';
    rawWithFlags.detail.operands[0].registerId = 'rdx';
    rawWithFlags.rawBytes[0] = 0x90;
    assert.equal(branded.mnemonic, 'mov');
    assert.equal(branded.detail.operands[0].registerId, 'rax');
    assert.equal(branded.rawBytes[0], 0x48);
    assert.equal(hasReceiverRevalidatedX86Row(branded), true);

    // In-place mutation of branded.rawBytes (TypedArray elements cannot be frozen in JS)
    // MUST invalidate provenance snapshot verification
    branded.rawBytes[0] = 0x90;
    assert.equal(hasReceiverRevalidatedX86Row(branded), false, 'mutated rawBytes must immediately fail provenance check');
  `;

  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    stdio: 'pipe',
    timeout: 10000,
  });
});

// ---------------------------------------------------------------------------
// P2-S01-001: Exponential expression DAG blowup DoS in jump-table.js
// ---------------------------------------------------------------------------

test('P2-S01-001: 35 chained add rax, rax instructions do not cause exponential blowup and fail closed in milliseconds', () => {
  const rax = regOp('rax', 'rax', 64, 64, 0);
  const rdx = regOp('rdx', 'rdx', 64, 64, 0);
  const rcx = regOp('rcx', 'rcx', 64, 64, 0);
  const rip = { id: 'rip', physicalId: 'rip', viewBits: 64, physicalBits: 64, lsb: 0 };

  const insns = [];
  let pc = 0x1000n;
  for (let i = 0; i < 35; i += 1) {
    insns.push(makeInsn(pc, 3, 'add', [rax, rax]));
    pc += 3n;
  }
  const cmpAddr = pc;
  insns.push(makeInsn(pc, 4, 'cmp', [rax, immOp(1n)]));
  pc += 4n;
  const jaIdx = insns.length;
  insns.push(makeInsn(pc, 2, 'ja', [immOp(0n)])); // patched to defaultAddr below
  pc += 2n;
  insns.push(makeInsn(pc, 7, 'lea', [rdx, memOp({ base: rip, displacement: 0x200n, widthBits: 64 })]));
  const tableAddr = pc + 7n + 0x200n;
  pc += 7n;
  insns.push(makeInsn(pc, 4, 'movsxd', [rcx, memOp({ base: rdx.register, index: rax.register, scale: 4, widthBits: 32 })]));
  pc += 4n;
  insns.push(makeInsn(pc, 3, 'add', [rcx, rdx]));
  pc += 3n;
  insns.push(makeInsn(pc, 2, 'jmp', [rcx]));
  pc += 2n;
  const case0Addr = pc;
  insns.push(makeInsn(pc, 1, 'ret', []));
  pc += 1n;
  const case1Addr = pc;
  insns.push(makeInsn(pc, 1, 'ret', []));
  pc += 1n;
  const defaultAddr = pc;
  insns.push(makeInsn(pc, 1, 'ret', []));
  insns[jaIdx].detail.operands[0] = immOp(defaultAddr);

  const tableBytes = int32LEHex([Number(case0Addr - tableAddr), Number(case1Addr - tableAddr)]);
  const segments = [{ relativeAddress: (tableAddr - 0x1000n).toString(), bytes: tableBytes }];

  const t0 = performance.now();
  const recovered = resolveX86SwitchTables(insns, segments);
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 500, `expected < 500ms, got ${elapsedMs.toFixed(2)}ms (cmp at ${cmpAddr})`);
  assert.deepEqual(recovered, [], 'over-budget opaque expression must fail closed and not falsely match');
});

test('P2-S01-001: 35 chained partial-register add al, al + sub chains complete in milliseconds without blowup', () => {
  const al = regOp('al', 'rax', 8, 64, 0);
  const rax = regOp('rax', 'rax', 64, 64, 0);

  const insns = [];
  let pc = 0x2000n;
  for (let i = 0; i < 35; i += 1) {
    insns.push(makeInsn(pc, 2, 'add', [al, al]));
    pc += 2n;
    insns.push(makeInsn(pc, 4, 'sub', [rax, immOp(1n)]));
    pc += 4n;
  }
  insns.push(makeInsn(pc, 4, 'cmp', [rax, immOp(3n)]));
  pc += 4n;
  const defaultAddr = pc + 2n + 1n;
  insns.push(makeInsn(pc, 2, 'ja', [immOp(defaultAddr)]));
  pc += 2n;
  insns.push(makeInsn(pc, 1, 'ret', []));
  pc += 1n;
  insns.push(makeInsn(pc, 1, 'ret', []));

  const t0 = performance.now();
  const recovered = resolveX86SwitchTables(insns, []);
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 500, `expected < 500ms, got ${elapsedMs.toFixed(2)}ms`);
  assert.deepEqual(recovered, []);
});

test('P2-S01-001: legitimate bounded switch table still resolves normally within expression limits', () => {
  const rax = regOp('rax', 'rax', 64, 64, 0);
  const rdx = regOp('rdx', 'rdx', 64, 64, 0);
  const rcx = regOp('rcx', 'rcx', 64, 64, 0);
  const rip = { id: 'rip', physicalId: 'rip', viewBits: 64, physicalBits: 64, lsb: 0 };

  let pc = 0x3000n;
  const insns = [];
  insns.push(makeInsn(pc, 4, 'sub', [rax, immOp(1n)]));
  pc += 4n;
  insns.push(makeInsn(pc, 4, 'cmp', [rax, immOp(2n)]));
  pc += 4n;
  const jaIdx = insns.length;
  insns.push(makeInsn(pc, 2, 'ja', [immOp(0n)]));
  pc += 2n;
  insns.push(makeInsn(pc, 7, 'lea', [rdx, memOp({ base: rip, displacement: 0x100n, widthBits: 64 })]));
  const tableAddr = pc + 7n + 0x100n;
  pc += 7n;
  insns.push(makeInsn(pc, 4, 'movsxd', [rcx, memOp({ base: rdx.register, index: rax.register, scale: 4, widthBits: 32 })]));
  pc += 4n;
  insns.push(makeInsn(pc, 3, 'add', [rcx, rdx]));
  pc += 3n;
  const jmpAddr = pc;
  insns.push(makeInsn(pc, 2, 'jmp', [rcx]));
  pc += 2n;
  const case0 = pc; insns.push(makeInsn(pc, 1, 'ret', [])); pc += 1n;
  const case1 = pc; insns.push(makeInsn(pc, 1, 'ret', [])); pc += 1n;
  const case2 = pc; insns.push(makeInsn(pc, 1, 'ret', [])); pc += 1n;
  const defAddr = pc; insns.push(makeInsn(pc, 1, 'ret', []));
  insns[jaIdx].detail.operands[0] = immOp(defAddr);

  const tableBytes = int32LEHex([
    Number(case0 - tableAddr),
    Number(case1 - tableAddr),
    Number(case2 - tableAddr),
  ]);
  const segments = [{ relativeAddress: (tableAddr - 0x3000n).toString(), bytes: tableBytes }];

  const recovered = resolveX86SwitchTables(insns, segments);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].instructionAddress, jmpAddr);
  assert.equal(recovered[0].tableAddress, tableAddr);
  assert.equal(recovered[0].lowerBound, 0n);
  assert.equal(recovered[0].upperBound, 2n);
  assert.deepEqual(recovered[0].targets, [case0, case1, case2]);
});
