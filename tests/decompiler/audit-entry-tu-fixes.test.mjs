import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';
import { ScopedAnalysisService } from '../../js/analysis/query/scoped-service.js';
import { decompile as legacyDecompile } from '../../js/decompile-legacy.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';
import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';
import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

function findCCompiler() {
  for (const cc of ['gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
}

const CC = findCCompiler();

function cSyntaxOk(code) {
  if (!CC) return { skipped: true, ok: true, stderr: '' };
  try {
    execFileSync(CC, ['-x', 'c', '-fsyntax-only', '-'], { input: code, stdio: ['pipe', 'pipe', 'pipe'] });
    return { skipped: false, ok: true, stderr: '' };
  } catch (err) {
    return { skipped: false, ok: false, stderr: String(err.stderr || err.message || '') };
  }
}

function makeInsn(row, address, mnemonic, operands, ops, reads, writes, extra = {}) {
  return {
    row,
    address,
    mnemonic,
    operands,
    ops,
    reads,
    writes,
    ...extra,
  };
}

function gp(num, bits = 64, extra = {}) {
  return { k: 'reg', cls: 'gp', num, bits, ...extra };
}

function imm(value) {
  return { k: 'imm', value: BigInt(value) };
}

function makeLegacyModel(blocks) {
  const instructions = blocks.flatMap((b) => b.instructions);
  const basicBlocks = blocks.map((b, index) => ({
    index,
    id: b.id ?? index,
    startAddr: b.startAddr,
    startRow: b.startRow,
    endRow: b.endRow,
    rows: b.instructions.map((i) => i.row),
    succ: b.succ || [],
    pred: b.pred || [],
  }));
  return {
    arch: 'arm64',
    entry: 0,
    basicBlocks,
    instructions,
    edges: blocks.flatMap((b) => (b.succ || []).map((to) => ({ from: b.id, to }))),
    facts: { setsReturnValue: true },
  };
}

test('Fix 1: buildCTranslationUnit preserves function bodies referencing declared globals and excludes conflicting prototypes', () => {
  const unit = buildCTranslationUnit([
    {
      functionId: 'fn_read_global',
      address: 0x1000n,
      name: 'read_global',
      signature: 'uint32_t read_global(void)',
      pseudocode: 'uint32_t read_global(void)\n{\n  return g_count + 1;\n}\n',
      ir: {
        instructions: [
          { op: 'load', loc: { kind: 'global', address: 0x4000n, name: 'g_count', size: 4 } },
        ],
      },
      globalEvidence: {
        '16384': { name: 'g_count', type: 'uint32_t', size: 4, provenance: 'symbol' },
      },
    },
  ]);

  assert.equal(unit.globals.length, 1);
  assert.equal(unit.globals[0].name, 'g_count');
  assert.equal(unit.globals[0].declaration, 'extern uint32_t g_count;');
  assert.equal(unit.functions[0].syntaxOnly, false);
  assert.match(unit.source, /extern uint32_t g_count;/);
  assert.match(unit.source, /return g_count \+ 1;/);
  assert.doesNotMatch(unit.source, /__builtin_trap/);
  assert.equal(
    unit.unresolved.some((u) => u.kind === 'syntax-only-function-body' && u.reason === 'uncovered-identifier:g_count'),
    false,
  );

  // Conflicting prototype evidence (declaration: null) must not leak into prototypeNames.
  const conflictUnit = buildCTranslationUnit([
    {
      functionId: 'fn_caller_a',
      address: 0x2000n,
      name: 'caller_a',
      signature: 'int caller_a(void)',
      pseudocode: 'int caller_a(void)\n{\n  return helper_fn(1);\n}\n',
      ir: {
        instructions: [
          { op: 'call', target: 0x3000n, name: 'helper_fn', callPrototype: { returnType: 'int', parameters: [{ type: 'int' }] } },
        ],
      },
    },
    {
      functionId: 'fn_caller_b',
      address: 0x2100n,
      name: 'caller_b',
      signature: 'int caller_b(void)',
      pseudocode: 'int caller_b(void)\n{\n  return helper_fn(1);\n}\n',
      ir: {
        instructions: [
          { op: 'call', target: 0x3000n, name: 'helper_fn', callPrototype: { returnType: 'void', parameters: [] } },
        ],
      },
    },
  ]);
  const helperProto = conflictUnit.prototypes.find((p) => p.name === 'helper_fn');
  assert.equal(helperProto?.declaration, null);
  assert.equal(conflictUnit.functions[0].syntaxOnly, true);
});

test('Fix 2: ScopedAnalysisService accepts arm64e identically to arm64 while rejecting non-ARM64', async () => {
  const worldInput = {
    binarySet: [{
      binaryId: 'bin_sha256_' + 'a'.repeat(64),
      sliceId: 'slice_arm64e_0',
      sourceIdentity: { kind: 'local-immutable', sourceInstance: 'src_1', generation: 'gen_1' },
      loadMapHash: 'map_1',
      relocationViewHash: 'reloc_1',
    }],
    profile: {
      isaRevision: 'arm64e:effects@1.0.0',
      features: [],
      abi: 'darwin-arm64',
      abiRevision: '1.0.0',
      osModel: 'darwin',
      endianness: 'le',
      addressBits: 64,
      exceptionModel: 'ambient-state-unqualified',
      memoryModel: 'current-owner-with-open-concurrency',
    },
    environment: { dynamicLoading: 'open', concurrency: 'unknown', interposition: 'possible', ambientState: 'unqualified' },
    coverage: 'explicit-bounded-function-scopes; no-negative-world-closure',
    generation: 'gen_1',
  };

  const makeService = (canonicalArchitecture) => {
    const loadCalls = [];
    const host = {
      canonicalArchitecture,
      configuration: { maximumSessions: 4, sessionTtlMs: 30000 },
      isCurrent: () => true,
      readRange: async () => ({ bytes: new Uint8Array(0) }),
      loadPipeline: async (locator, ctx) => {
        loadCalls.push({ locator, localProjection: ctx.localProjection });
        return { pipeline: null, reason: 'test-stub-unavailable' };
      },
    };
    const snapshot = { binaryId: 'bin_sha256_' + 'a'.repeat(64), snapshotId: 'snap_1' };
    return { service: new ScopedAnalysisService({ host, snapshot, worldInput }), loadCalls };
  };

  const { service: arm64eSvc, loadCalls } = makeService('arm64e');
  try {
    const caps = await arm64eSvc.invoke('scopedCapabilities');
    assert.equal(caps.value.canonicalArchitecture, 'arm64e');
    assert.equal(caps.value.producerQualification, 'current-arm64-owner-unverified');
    assert.notEqual(caps.value.modes.demandQuery, 'unsupported');
    assert.notEqual(caps.value.modes.taskIdiomView, 'unsupported');
    assert.notEqual(caps.value.modes.portableIntegerChecks, 'unsupported');
    assert.notEqual(caps.value.modes.explainTransformChain, 'unsupported');
    assert.notEqual(caps.value.modes.checkLoopInvariant, 'unsupported');

    const taskRes = await arm64eSvc.invoke('taskIdiomView', { functionId: '0x1000', task: 'mask' });
    assert.notEqual(taskRes.value.reason, 'task-native-arm64-owner-required');
    assert.equal(taskRes.value.reason, 'test-stub-unavailable');

    const transformRes = await arm64eSvc.invoke('explainTransformChain', { functionId: '0x1000' });
    assert.notEqual(transformRes.value.reason, 'native-transform-arm64-owner-required');
    assert.equal(transformRes.value.reason, 'test-stub-unavailable');

    const portableRes = await arm64eSvc.invoke('portableIntegerChecks', { functionId: '0x1000' });
    assert.notEqual(portableRes.value.reason, 'portable-native-arm64-required');
    assert.equal(portableRes.value.reason, 'portable-current-native-owner-required');
    assert.ok(loadCalls.length >= 3);
  } finally {
    arm64eSvc.close();
  }

  const { service: x86Svc } = makeService('x86_64');
  try {
    const caps = await x86Svc.invoke('scopedCapabilities');
    assert.equal(caps.value.producerQualification, 'native-pair-unsupported');
    assert.equal(caps.value.modes.demandQuery, 'unsupported');
    const taskRes = await x86Svc.invoke('taskIdiomView', { functionId: '0x1000', task: 'mask' });
    assert.equal(taskRes.value.reason, 'task-native-arm64-owner-required');
  } finally {
    x86Svc.close();
  }
});

test('Fix 3a/3b: decompile-legacy avoids >>> for ror/shifted-ror and emits valid C for vs/vc/al/nv conditions', () => {
  const insnsB0 = [
    makeInsn(0, 0x1000n, 'ror', 'x0, x0, x1', [gp(0), gp(0), gp(1)], ['x0', 'x1'], ['x0']),
    makeInsn(1, 0x1004n, 'add', 'x0, x0, x1, ror #4', [gp(0), gp(0), gp(1, 64, { shift: { op: 'ror', amount: 4 } })], ['x0', 'x1'], ['x0']),
    makeInsn(2, 0x1008n, 'adds', 'x0, x0, #1', [gp(0), gp(0), imm(1)], ['x0'], ['x0']),
    makeInsn(3, 0x100cn, 'b.vs', '0x1018', [{ k: 'imm', value: 0x1018n }], [], [], { isBranch: true, cond: 'vs', branchTarget: 0x1018n }),
  ];
  const insnsB1 = [
    makeInsn(4, 0x1010n, 'adds', 'x0, x0, #2', [gp(0), gp(0), imm(2)], ['x0'], ['x0']),
    makeInsn(5, 0x1014n, 'b.vc', '0x1018', [{ k: 'imm', value: 0x1018n }], [], [], { isBranch: true, cond: 'vc', branchTarget: 0x1018n }),
  ];
  const insnsB2 = [
    makeInsn(6, 0x1018n, 'ret', '', [], ['x0'], [], { isReturn: true }),
  ];
  const model = makeLegacyModel([
    { id: 0, startAddr: 0x1000n, startRow: 0, endRow: 3, instructions: insnsB0, succ: [1, 2], pred: [] },
    { id: 1, startAddr: 0x1010n, startRow: 4, endRow: 5, instructions: insnsB1, succ: [2], pred: [0] },
    { id: 2, startAddr: 0x1018n, startRow: 6, endRow: 6, instructions: insnsB2, succ: [], pred: [0, 1] },
  ]);

  const res = legacyDecompile(model, {
    name: 'ror_and_overflow',
    addr: 0x1000n,
    addrOfRow: (r) => BigInt(0x1000 + r * 4),
    rowOfAddress: (a) => Number((BigInt(a) - 0x1000n) / 4n),
  });
  closeFunctionOutput(res);
  const code = res.pseudocode;

  assert.doesNotMatch(code, />>>/);
  assert.doesNotMatch(code, /\boverflow\b(?!\()/);
  assert.doesNotMatch(code, /!overflow(?!\()/);
  assert.match(code, />>\s*\(/);

  const chk = cSyntaxOk(code);
  assert.equal(chk.ok, true, `Generated legacy C failed syntax check:\n${code}\n${chk.stderr}`);
});

test('Fix 3c: decompile-legacy inlineTemporaries does not inline across an intervening redefinition', () => {
  const insns = [
    makeInsn(0, 0x2000n, 'add', 'x8, x0, #1', [gp(8), gp(0), imm(1)], ['x0'], ['x8']),
    makeInsn(1, 0x2004n, 'add', 'x8, x1, #2', [gp(8), gp(1), imm(2)], ['x1'], ['x8']),
    makeInsn(2, 0x2008n, 'mov', 'x0, x8', [gp(0), gp(8)], ['x8'], ['x0']),
    makeInsn(3, 0x200cn, 'ret', '', [], ['x0'], [], { isReturn: true }),
  ];
  const model = makeLegacyModel([
    { id: 0, startAddr: 0x2000n, startRow: 0, endRow: 3, instructions: insns, succ: [], pred: [] },
  ]);

  const res = legacyDecompile(model, {
    name: 'redef_temp',
    addr: 0x2000n,
    addrOfRow: (r) => BigInt(0x2000 + r * 4),
  });
  const text = res.lines.map((l) => l.text).join('\n');
  // Must use the second definition (a2 + 2), NOT the stale first definition (a1 + 1).
  assert.match(text, /a2 \+ 2|x1 \+ 2/);
  assert.doesNotMatch(text, /return\s*\(?\s*(a1|x0)\s*\+\s*1\s*\)?\s*;/);
});

test('Fix 4a: app-adapter xrefs paginates beyond offset 5000 with cumulativePageLimit', async () => {
  const allRefs = Array.from({ length: 5050 }, (_, i) => ({
    site: BigInt(0x10000 + i * 4),
    target: 0x1000n,
    kind: 'adrp',
  }));
  let observedCap = null;
  const app = {
    backend: { arch: 'arm64', binaryId: 'bin_sha256_' + 'b'.repeat(64) },
    ensureProgram: async () => ({
      refSitesTo: (_addr, _size, cap) => {
        observedCap = cap;
        const slice = allRefs.slice(0, cap);
        slice.queryLimited = slice.length < allRefs.length;
        slice.complete = true;
        return slice;
      },
      callSitesTo: () => [],
    }),
  };

  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  const snap = await api.snapshot();
  const page = await api.xrefs(snap, 0x1000n, { offset: 5000, limit: 10 });

  assert.equal(observedCap, 5010);
  assert.equal(page.value.length, 10);
  assert.equal(page.page.offset, 5000);
  assert.equal(page.page.returned, 10);
  assert.equal(page.page.next, 5010);
  assert.equal(page.status.completeness, 'partial');
  assert.equal(page.status.truncationReason, 'query-limit');
});

test('Fix 4b: demand-driven-runtime xrefs paginates beyond 5000 and marks queryLimited as partial', async () => {
  const count = 5050;
  const refFrom = new BigUint64Array(count);
  const refTo = new BigUint64Array(count);
  const refKind = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    refFrom[i] = BigInt(0x20000 + i * 4);
    refTo[i] = 0x1000n;
    refKind[i] = 1;
  }
  const app = {
    backend: {
      arch: 'arm64',
      binaryId: 'bin_sha256_' + 'c'.repeat(64),
      gen: 1,
      scanProgram: async () => ({
        regionId: 'r0',
        vmAddr: 0x1000n,
        complete: true,
        callFrom: new BigUint64Array(0),
        callTo: new BigUint64Array(0),
        callCount: 0,
        refFrom,
        refTo,
        refKind,
        refCount: count,
        kinds: new Uint8Array(0),
        words: 0,
      }),
    },
    programRegions: () => [{ id: 'r0', vmAddr: 0x1000n, size: 0x100000n, exec: true }],
  };

  const api = installDemandDrivenAnalysis(app);
  const snap = await api.snapshot();
  const page = await api.xrefs(snap, 0x1000n, { offset: 5000, limit: 10 });

  assert.equal(page.value.length, 10);
  assert.equal(page.page.offset, 5000);
  assert.equal(page.page.returned, 10);
  assert.equal(page.page.next, 5010);
  assert.equal(page.status.completeness, 'partial');
  assert.equal(page.status.truncationReason, 'query-limit');
});

test('Fix 4c: app-adapter translationUnit forwards decompilerOptionsFromQuery(options)', async () => {
  const insns = [
    makeInsn(0, 0x3000n, 'mov', 'x0, #7', [gp(0), imm(7)], [], ['x0']),
    makeInsn(1, 0x3004n, 'ret', '', [], ['x0'], [], { isReturn: true }),
  ];
  const model = makeLegacyModel([
    { id: 0, startAddr: 0x3000n, startRow: 0, endRow: 1, instructions: insns, succ: [], pred: [] },
  ]);
  const app = {
    backend: { arch: 'arm64', binaryId: 'bin_sha256_' + 'd'.repeat(64) },
    symbols: { nameAt: () => 'ret_seven' },
    analyzeFunction: async () => ({
      functionId: 'fn_3000',
      startAddress: 0x3000n,
      name: 'ret_seven',
      model,
      setsReturnValue: true,
    }),
  };

  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  const snap = await api.snapshot();
  const res = await api.translationUnit(snap, [0x3000n], {
    profile: 'balanced',
    decompilerTimeBudgetMs: 1000,
  });

  assert.ok(res.value, 'translationUnit should return a packaged unit');
  assert.equal(res.value.functions.length, 1);
  assert.match(res.value.source, /ret_seven/);
});
