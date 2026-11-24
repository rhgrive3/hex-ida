import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalTypedValue } from '../js/analysis/discovery/canonical-value.js';
import { claimsConflict, createTypeClaim } from '../js/analysis/types/constraints.js';
import { projectCanonicalPhysicalTypes } from '../js/analysis/types/scoped-physical.js';
import { SEMANTIC_IR_CONTRACT_VERSION } from '../js/semantics/ir/index.js';
import { widenPointsTo, createPointsToSet, createPointsToTarget } from '../js/analysis/pointsto/lattice.js';
import { FunctionSummaryCache } from '../js/interproc.js';
import { computeStructuralHash, structuralEquals } from '../js/symbolic/expr/hash.js';
import { EXPR_KIND, createBv, createBinary, createFreshSymbol } from '../js/symbolic/expr/index.js';
import { classifyOpSupport, TRANSLATION_STATUS } from '../js/symbolic/translate/support-matrix.js';
import { OP } from '../js/ir-base.js';
import { readBuildId } from '../js/analysis/debug/dwarf.js';
import { parseTpiStream, describeTypeIndex } from '../js/analysis/debug/pdb.js';
import { parseAarch64GnuProperty as parseAarch64ElfGnuProperty } from '../js/binary/elf-gnu-property.js';
import { elfInstructionTargetRejection } from '../js/binary/elf-mapping.js';
import { validateJvmClassFlags } from '../js/managed/jvm/class-flags.js';
import { decodeJvmInstructionBoundary } from '../js/managed/jvm/instruction-boundary.js';
import { abiResultInvalidState } from '../js/targets/abi/evidence.js';
import {
  microsoftX64AggregateReturnDecision,
  classifyMicrosoftX64Arguments,
  MICROSOFT_X64_ABI as microsoftX64Abi,
} from '../js/targets/abi/microsoft-x64.js';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/dispatcher.js';
import { liftArm64FlagEffects } from '../js/targets/architecture/arm64/effects/flags-core.js';
import { liftArm64IntegerEffects } from '../js/targets/architecture/arm64/effects/integer-core.js';
import { liftArm64FpEffects } from '../js/targets/architecture/arm64/effects/fp-core.js';
import { liftArm64SimdEffects } from '../js/targets/architecture/arm64/effects/simd.js';
import {
  isTerminalDevToolError,
  describeDevToolError,
  createDevToolErrorHistoryEntry,
} from '../js/ai/dev/supervisor/tool-error-recovery.js';
import { collapseActivity } from '../js/ai/render/activity.js';
import { glossaryEntry } from '../js/glossary.js';
import { callGraph } from '../js/graphview-base.js';
import { semanticEvidenceItems } from '../js/semantic-evidence.js';
import { parseOperands, condInfo } from '../js/ui/explain/arm64-operands.js';
import { sectionHint } from '../js/ui/panels/file.js';
import { FieldIndex } from '../js/fields.js';
import { ProgramIndex as Program } from '../js/program.js';
import { createAgentTools } from '../js/agent/tools.js';

test('P1-S13-015: canonicalTypedValue rejects non-plain built-in objects', () => {
  assert.throws(() => canonicalTypedValue(new Date()), /discovery-typed-value-object-invalid/);
  assert.throws(() => canonicalTypedValue(/abc/), /discovery-typed-value-object-invalid/);
  assert.throws(() => canonicalTypedValue(new Map()), /discovery-typed-value-object-invalid/);
  assert.throws(() => canonicalTypedValue(new Set()), /discovery-typed-value-object-invalid/);
  assert.throws(() => canonicalTypedValue(new Error('x')), /discovery-typed-value-object-invalid/);
  assert.equal(canonicalTypedValue({ a: 1 }).value.t, 'object');
});

test('P2-S04-004: claimsConflict detects machine layer kind/format/laneCount/elementType conflicts', () => {
  const mk = (descriptor) => createTypeClaim({ entityId: 'v1', layer: 'machine', descriptor });
  assert.equal(claimsConflict(mk({ kind: 'float', widthBits: 32 }), mk({ kind: 'bitvector', widthBits: 32 })), true);
  assert.equal(claimsConflict(mk({ kind: 'float', widthBits: 32, format: 'ieee754-binary32' }), mk({ kind: 'float', widthBits: 32, format: 'bfloat32' })), true);
  assert.equal(claimsConflict(mk({ kind: 'vector', widthBits: 128, laneCount: 4 }), mk({ kind: 'vector', widthBits: 128, laneCount: 2 })), true);
  assert.equal(claimsConflict(
    mk({ kind: 'vector', widthBits: 128, laneCount: 4, elementType: { kind: 'float', widthBits: 32 } }),
    mk({ kind: 'vector', widthBits: 128, laneCount: 4, elementType: { kind: 'bitvector', widthBits: 32 } }),
  ), true);
  assert.equal(claimsConflict(mk({ kind: 'float', widthBits: 32 }), mk({ kind: 'float', widthBits: 32 })), false);
});

test('P1-S04-034: projectCanonicalPhysicalTypes throws AbortError when signal.reason is undefined', () => {
  const signal = { aborted: true, reason: undefined };
  assert.throws(
    () => projectCanonicalPhysicalTypes(
      {
        binaryId: 'bin-1',
        functionId: 'fn-1',
        instrumentation: { v2Executed: true },
        semanticIr: { contractVersion: SEMANTIC_IR_CONTRACT_VERSION, functionId: 'fn-1', values: [], nodes: [] },
      },
      ['v1'],
      { snapshotId: 'snap-1', worldId: 'world-1', signal },
    ),
    (err) => err instanceof Error && err.name === 'AbortError',
  );
});

test('P2-S13-012 & P1-S13-036: widenPointsTo preserves lossReasons on top and target-cap', () => {
  const topA = createPointsToSet({ top: true, lossReasons: ['integer-to-pointer'] });
  const topB = createPointsToSet({ top: true, lossReasons: ['unresolved-load'] });
  const mergedTop = widenPointsTo(topA, topB);
  assert.equal(mergedTop.top, true);
  assert.ok(mergedTop.lossReasons.includes('integer-to-pointer'));
  assert.ok(mergedTop.lossReasons.includes('unresolved-load'));

  const setA = createPointsToSet({
    targets: [createPointsToTarget({ rootKind: 'stack', rootEntityId: 'r1', offsetRange: { min: 0n, max: 0n } })],
    lossReasons: ['widened'],
  });
  const setB = createPointsToSet({
    targets: [createPointsToTarget({ rootKind: 'stack', rootEntityId: 'r2', offsetRange: { min: 0n, max: 0n } })],
    lossReasons: ['unresolved-call'],
  });
  const capped = widenPointsTo(setA, setB, { maxTargetsPerSet: 1 });
  assert.equal(capped.top, true);
  assert.ok(capped.lossReasons.includes('target-cap'));
  assert.ok(capped.lossReasons.includes('widened'));
  assert.ok(capped.lossReasons.includes('unresolved-call'));
});

test('P2-S09-005 & P1-S09-025: structuralEquals and computeStructuralHash handle deep shared DAGs in linear time', () => {
  const buildDag = (depth) => {
    let node = createBv(64, 42n);
    for (let i = 0; i < depth; i++) {
      node = createBinary('add', node, node);
    }
    return node;
  };
  const dagA = buildDag(40);
  const dagB = buildDag(40);
  const start = Date.now();
  assert.equal(structuralEquals(dagA, dagB), true);
  const hA = computeStructuralHash(dagA);
  const hB = computeStructuralHash(dagB);
  assert.equal(hA, hB);
  assert.ok(Date.now() - start < 2000, 'DAG comparison and hashing should complete rapidly');

  // Cycle detection in computeStructuralHash
  const cyclic = { kind: EXPR_KIND.UNARY, op: 'neg', sort: { kind: 'bv', width: 64 }, arg: null };
  cyclic.arg = cyclic;
  assert.throws(() => computeStructuralHash(cyclic), /symbolic-expr-cycle/);
});

test('P1-S05-009 & P2-S05-015: classifyOpSupport handles OP.SEL conditionValue and OP.CMP token validation', () => {
  assert.equal(classifyOpSupport(OP.SEL, { conditionValue: { id: 'c1' } }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.SEL, { cond: { id: 'c1' } }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.SEL, { cond: 'eq' }), TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(classifyOpSupport(OP.CMP, { sub: 'eq' }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.CMP, { cond: 'bogus-op' }), TRANSLATION_STATUS.UNSUPPORTED);
});

test('P1-S15-030: readBuildId returns null on 0-byte NT_GNU_BUILD_ID note', () => {
  const note = new Uint8Array(16);
  const dv = new DataView(note.buffer);
  dv.setUint32(0, 4, true); // namesz = 4 ("GNU\0")
  dv.setUint32(4, 0, true); // descsz = 0
  dv.setUint32(8, 3, true); // type = NT_GNU_BUILD_ID
  note.set([0x47, 0x4e, 0x55, 0x00], 12);
  assert.equal(readBuildId(note), null);
});

test('P1-S15-017: PDB describeTypeIndex does not poison memo cache with cycle-broken result', () => {
  const types = new Map([
    [0x1000, { kind: 'pointer', referent: 0x1001, attributes: 0x000a }],
    [0x1001, { kind: 'pointer', referent: 0x1000, attributes: 0x000a }],
  ]);
  const res = describeTypeIndex(0x1000, types);
  assert.equal(res.complete, false);
});

test('P1-S06-028: parseAarch64ElfGnuProperty accepts 52-byte ELF32 header and phnum=0 ET_REL', () => {
  const elf32 = new Uint8Array(52);
  const dv = new DataView(elf32.buffer);
  elf32.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0); // ELF32 LE
  dv.setUint16(16, 1, true); // ET_REL
  dv.setUint16(18, 183, true); // EM_AARCH64
  dv.setUint32(28, 0, true); // e_phoff = 0
  dv.setUint16(42, 0, true); // e_phentsize = 0
  dv.setUint16(44, 0, true); // e_phnum = 0
  const res = parseAarch64ElfGnuProperty(elf32);
  assert.notEqual(res.loaderPolicy, 'unavailable');
  assert.notEqual(res.loaderPolicy, 'unknown');
});

test('P1-S06-039: elfInstructionTargetRejection enforces 2-byte minimum span for ARM32 and RISC-V', () => {
  const mkImage = (arch) => ({
    arch,
    metadata: { type: 2 },
    segments: [{ address: 0x1000n, size: 1n, fileOffset: 0n, fileSize: 1n, perms: { read: true, execute: true } }],
    sections: [],
  });
  assert.equal(elfInstructionTargetRejection(mkImage('arm'), 0x1000n), 'instruction bytes cross the canonical executable extent');
  assert.equal(elfInstructionTargetRejection(mkImage('riscv64'), 0x1000n), 'instruction bytes cross the canonical executable extent');
});

test('P1-S12-006 & P1-S12-038: JVM class flags and invokedynamic reserved bytes validation', () => {
  assert.ok(validateJvmClassFlags(0x0200).errors.includes('jvm-interface-requires-abstract'));
  assert.ok(validateJvmClassFlags(0x0200 | 0x0400 | 0x4000).errors.includes('jvm-interface-enum-conflict'));
  assert.ok(validateJvmClassFlags(0x8000 | 0x0001, { majorVersion: 53 }).errors.includes('jvm-module-flag-conflict'));
  assert.equal(validateJvmClassFlags(0x8000, { majorVersion: 53 }).errors.length, 0);

  const badIndy = new Uint8Array([0xba, 0x00, 0x01, 0x01, 0x00]);
  assert.equal(decodeJvmInstructionBoundary(badIndy, 0).complete, false);
  const okIndy = new Uint8Array([0xba, 0x00, 0x01, 0x00, 0x00]);
  assert.equal(decodeJvmInstructionBoundary(okIndy, 0).complete, true);
});

test('P1-S15-001 & P2-S15-002: abiResultInvalidState prioritizes hard terminal flags over partial', () => {
  assert.equal(abiResultInvalidState({ partial: true, malformed: true }), 'malformed');
  assert.equal(abiResultInvalidState({ partial: true, cancelled: true }), 'cancelled');
  assert.equal(abiResultInvalidState({ partial: true, status: 'stale' }), 'stale');
  assert.equal(abiResultInvalidState({ partial: true }), 'partial');
});

test('P2-S15-004 & P1-S15-023: Win64 conservative args unique indices, >8B padded return, non-string entry reg', () => {
  const conservative = classifyMicrosoftX64Arguments(null);
  const indices = conservative.arguments.map((a) => a.index);
  assert.equal(new Set(indices).size, indices.length);

  const paddedReturn = microsoftX64AggregateReturnDecision(
    { bits: 96, layout: { bytes: 16 } },
    { trivialForCalls: true },
  );
  assert.equal(paddedReturn.kind, 'indirect');

  const nonStr = microsoftX64Abi.classifyEntryRegister(12345);
  assert.deepEqual(nonStr, { kind: 'incoming-register-state', reg: '' });
});

test('P2-S01-012, P1-S01-008, P2-S01-024, P2-S01-030, P1-S01-014, P2-S01-027, P1-S01-026: ARM64 effects fixes', () => {
  // P1-S01-008 & P2-S01-024: uppercase LSL in MOVZ
  const movz = liftArm64IntegerEffects({
    instructionId: 'ins-1',
    mnemonic: 'movz',
    ops: [{ k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' }, { k: 'imm', value: 1n, shift: { op: 'LSL', amount: 16 } }],
  });
  assert.equal(movz.completeness, 'exact');
  const writeOp = movz.operations.find((o) => o.kind === 'register-write');
  assert.equal(String(writeOp.value.value), '65536');

  // P2-S01-030: widthBits === 0 returns partial instead of throwing
  const badFlags = liftArm64FlagEffects({ instructionId: 'ins-2', mnemonic: 'cmp', ops: [{ k: 'reg', cls: 'gp', num: 0, bits: 16, text: 'h0' }, { k: 'imm', value: 2n }] });
  assert.equal(badFlags.completeness, 'partial');

  // P1-S01-014: fcvtzs rejects invalid destination width (e.g. 16-bit)
  const badFcvt = liftArm64FpEffects({
    instructionId: 'ins-3',
    mnemonic: 'fcvtzs',
    ops: [{ k: 'reg', cls: 'gp', num: 0, bits: 16, text: 'h0' }, { k: 'reg', cls: 'fp', num: 0, bits: 32, text: 's0' }],
  });
  assert.equal(badFcvt.completeness, 'partial');

  // P2-S01-027: -0.0 in FP/SIMD is not collapsed to +0.0
  const fcmpNegZero = liftArm64FpEffects({
    instructionId: 'ins-4',
    mnemonic: 'fcmp',
    ops: [{ k: 'reg', cls: 'fp', num: 0, bits: 32, text: 's0' }, { k: 'imm', float: -0.0 }],
  });
  assert.equal(fcmpNegZero.completeness, 'partial');

  // P1-S01-026: uppercase LSL and LSL #0 in SIMD MOVI
  const movi = liftArm64SimdEffects({
    instructionId: 'ins-5',
    mnemonic: 'movi',
    ops: [{ k: 'reg', cls: 'vec', num: 0, bits: 128, arr: '4s', text: 'v0.4s' }, { k: 'imm', value: 1n, shift: { op: 'LSL', amount: 0 } }],
  });
  assert.equal(movi.completeness, 'exact-with-intrinsic');
});

test('P2-S09-003 & P1-S09-022: dev-admin-not-authorized is terminal and error.code is bounded', () => {
  assert.equal(isTerminalDevToolError({ code: 'dev-admin-not-authorized' }), true);
  const entry = createDevToolErrorHistoryEntry({
    tool: 'test',
    error: { code: 'Authorization: Bearer supersecret1234567890', message: 'fail' },
    attempt: 1,
    remaining: 5,
  });
  assert.equal(entry.code, 'dev-tool-error');
  assert.equal(describeDevToolError({ code: 'ok-code_1' }).code, 'ok-code_1');
});

test('P1-S03-038, P2-S05-013, P2-S13-031, P1-S13-027: UI/Glossary/Activity/Operands safety', () => {
  const collapsed = collapseActivity([
    { label: 'step', error: 'boom' },
    { label: 'step', detail: 'ok' },
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].error, null);

  assert.equal(glossaryEntry('toString'), null);
  assert.equal(glossaryEntry('constructor'), null);
  assert.equal(condInfo('toString'), null);
  assert.equal(sectionHint('toString'), '');

  const parsed = parseOperands('x0, x1, lsl #-0x10');
  assert.equal(parsed[1].shift, undefined);
});

test('P1-S05-043 & P2-S05-014: callGraph does not exponentially blow up on cyclic call graphs', () => {
  let calls = 0;
  const program = {
    callersOf(a) { calls++; return [{ addr: a === 1n ? 2n : 1n }]; },
    functionRange(a) { return { start: a, end: a + 4n }; },
    calleesOf(s) { calls++; return [{ addr: s === 1n ? 2n : 1n }]; },
  };
  const g = callGraph(program, { nameAt: () => null }, 1n, { depth: 20, limit: 10 });
  assert.ok(calls < 20, `expected bounded calls on 2-node cycle, got ${calls}`);
  assert.equal(g.nodes.length, 2);
});

test('P1-S02-033: semanticEvidenceItems checks strength <= 0 before seen.add', () => {
  const items = semanticEvidenceItems([
    { kind: 'write', confidence: 0, evidence: [{ id: 'ev-1', row: 1 }] },
    { kind: 'write', confidence: 0.9, evidence: [{ id: 'ev-1', row: 1 }] },
  ]);
  assert.equal(items.length, 1);
});

test('P1-S02-011, P2-S02-029 & P1-S02-026: Program callersOf/calleesOf count accuracy and statsOf fields', () => {
  const prog = new Program({ vmAddr: 0x1000n, words: 0 });
  prog.callFrom = [0x1000n, 0x1004n, 0x1008n];
  prog.callTo = [0x2000n, 0x3000n, 0x2000n];
  const callees = prog.calleesOf(0x1000n, 0x1010n, 1);
  assert.equal(callees.length, 1);
  assert.equal(callees[0].addr, 0x2000n);
  assert.equal(callees[0].count, 2);

  const stats = prog.statsOf(0x1000n, 0x1010n);
  assert.equal(stats.numeric, 0);
  assert.equal(stats.memory, 0);
});

test('P1-S05-041: FieldIndex accessorField does not strip leading underscore and fieldAt checks safe integer', () => {
  const idx = new FieldIndex({ classes: [{
    name: 'Hero',
    instanceSize: 32,
    ivars: [{ name: '_hp', offset: 16, size: 4, property: { name: 'hp' } }],
    methods: [{ sel: '_hp', addr: 0x1000n }, { sel: 'hp', addr: 0x1010n }],
  }] });
  assert.equal(idx.ownerOf(0x1000n).accessorField, null);
  assert.equal(idx.ownerOf(0x1010n).accessorField.name, '_hp');
  assert.equal(idx.fieldAt('Hero', (1n << 60n)), null);
});

test('P1-S04-020: agent tools get_callees throws invalid-argument on bad address', async () => {
  const tools = createAgentTools({ program: { functionRange: () => null } });
  await assert.rejects(() => tools.get_callees('not-an-address'), (e) => e.code === 'invalid-argument');
});

test('P2-S09-006: FunctionSummaryCache concurrent summaryFor calls do not poison each other as cycles', async () => {
  let releases = [];
  const cache = new FunctionSummaryCache({
    analyze: async (addr) => {
      await new Promise((r) => releases.push(r));
      return { instructions: [], blocks: [], address: addr };
    },
  });
  const p1 = cache.summaryFor(0x1000n);
  const p2 = cache.summaryFor(0x1000n);
  await new Promise((r) => setTimeout(r, 10));
  for (const r of releases) r();
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.notEqual(s1?.cycle, true);
  assert.notEqual(s2?.cycle, true);
});
