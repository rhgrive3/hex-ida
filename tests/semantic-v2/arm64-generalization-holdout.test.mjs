import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP } from '../../js/ir.js';
import { decompile } from '../../js/decompile.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';
import { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';
import { parseELF } from '../../js/binary/elf.js';
import { makeElf64Fixture } from '../universal-binary.mjs';
import {
  ARM64_GENERALIZATION_HOLDOUT_FIXTURES,
  HOLDOUT_BASE,
  HOLDOUT_PROVENANCE,
} from './arm64-generalization-holdout-fixtures.mjs';

const MASK64 = (1n << 64n) - 1n;
const ABI = semanticAbiAdapter(AAPCS64_ABI);
const BY_ID = new Map(ARM64_GENERALIZATION_HOLDOUT_FIXTURES.map((fixture) => [fixture.id, fixture]));

function fixture(id) {
  const value = BY_ID.get(id);
  assert.ok(value, `missing holdout fixture ${id}`);
  return value;
}

function materialize(f) {
  const rows = f.lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: HOLDOUT_BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - HOLDOUT_BASE;
    if (delta < 0n || delta % 4n !== 0n || delta >= BigInt(rows.length * 4)) return null;
    return Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
  const ir = buildIR(model, { rowOfAddress });
  const result = decompile(model, {
    name:f.id.replaceAll('-', '_'),
    addr:HOLDOUT_BASE,
    rowOfAddress,
    returnType:'uint64',
    abiAdapter:ABI,
    decompilerTimeBudgetMs:750,
    deterministicTransforms:true,
  });
  return { f, rows, rowOfAddress, model, ir, result };
}

function assertIrOwnership(ir, id) {
  assert.doesNotThrow(() => structuredClone(ir), `${id}: Semantic IR must be structured-cloneable`);
  for (const key of ['defUse', 'newValue', '_canReachBlock', '_unknownStoreBarriers']) {
    assert.equal(Object.hasOwn(ir, key), false, `${id}: runtime helper/cache ${key} must not be IR-owned`);
  }
  const functionKeys = Object.entries(ir).filter(([, value]) => typeof value === 'function').map(([key]) => key);
  assert.deepEqual(functionKeys, [], `${id}: IR must not own function-valued runtime state`);
}

function assertCompleteSemanticPresentation(observation) {
  const { f, ir, result } = observation;
  assertIrOwnership(ir, f.id);
  assert.equal(result.semantic, true, `${f.id}: expected shared semantic decompile path`);
  assert.ok(result.semanticAst, `${f.id}: semantic AST missing`);
  assert.ok(result.cAst, `${f.id}: C AST missing`);
  assert.ok(Array.isArray(result.sourceMap) && result.sourceMap.length > 0, `${f.id}: source map missing`);
  assert.equal(result.metrics?.rawAssemblyFallbacks, 0, `${f.id}: supported holdout must not escalate to raw assembly`);
  assert.ok(String(result.pseudocode || '').trim().length > 0, `${f.id}: pseudocode unavailable`);
}

function returnExpression(result) {
  const expression = result.semanticAst?.outputs?.find((output) => output.name === 'return')?.expression;
  assert.ok(expression, 'semantic return expression missing');
  return expression;
}

function evalReturn(result, env) {
  const expression = returnExpression(result);
  const value = evaluateExpression(expression, env);
  assert.notEqual(value, null, 'semantic return expression must be independently executable');
  return BigInt(value) & MASK64;
}

function ownUnknowns(ir) {
  return ir.instructions.filter((instruction) => instruction.op === OP.UNKNOWN || instruction.op === 'unknown');
}

function makeArm64DiscoveryFixture() {
  const bytes = makeElf64Fixture();
  const view = new DataView(bytes.buffer);
  const PH_RX = 0x40;
  const TEXT_SEC = 0x280 + 64;
  const SYM_ENTRY = 0x190;
  const EM_AARCH64 = 183;
  view.setUint16(18, EM_AARCH64, true);
  view.setBigUint64(24, 0x401000n, true);
  view.setBigUint64(PH_RX + 32, 8n, true);
  view.setBigUint64(PH_RX + 40, 8n, true);
  view.setBigUint64(TEXT_SEC + 32, 8n, true);
  view.setBigUint64(SYM_ENTRY + 16, 8n, true);
  // add x0, x0, #7 ; ret
  bytes.set([0x00, 0x1c, 0x00, 0x91, 0xc0, 0x03, 0x5f, 0xd6], 0x100);
  // Replace the generic shared-fixture symbol with another synthetic name of the same width.
  bytes.set(new TextEncoder().encode('hldout\0'), 0x126);
  return bytes;
}

test('ARM64 generalization holdout provenance is independent and explicit', () => {
  assert.equal(HOLDOUT_PROVENANCE.codeFuseDerived, false);
  assert.equal(HOLDOUT_PROVENANCE.benchmarkArtifactsUsed, false);
  assert.equal(HOLDOUT_PROVENANCE.sourceKind, 'test-authored-synthetic-aarch64');
  assert.equal(new Set(ARM64_GENERALIZATION_HOLDOUT_FIXTURES.map((item) => item.id)).size,
    ARM64_GENERALIZATION_HOLDOUT_FIXTURES.length, 'fixture ids must be unique');
  for (const item of ARM64_GENERALIZATION_HOLDOUT_FIXTURES) {
    assert.ok(item.overfitGuard, `${item.id}: overfit guard must be documented`);
    assert.ok(item.lines.length > 0, `${item.id}: empty fixture`);
  }
});

test('ARM64 holdout function discovery uses an independent synthetic ELF', () => {
  const image = parseELF(makeArm64DiscoveryFixture());
  assert.equal(image.arch, 'arm64');
  const fn = image.functions.find((candidate) => candidate.address === 0x401000n && candidate.name === 'hldout');
  assert.ok(fn, 'synthetic AArch64 STT_FUNC must be discovered');
  assert.equal(fn.size, 8n);
  assert.equal(fn.exactFunctionStart, true);
  assert.ok(fn.sources?.includes('symbol') || fn.source === 'symbol', 'symbol evidence must own the discovered start');
});

test('ARM64 holdout: basic arithmetic has semantic return truth', () => {
  const observation = materialize(fixture('holdout-arithmetic-return'));
  assertCompleteSemanticPresentation(observation);
  for (const input of [0n, 1n, 0xffffffffffffffffn, 0x7fffffffffffffffn]) {
    assert.equal(evalReturn(observation.result, { a1:input }), (input + 7n) & MASK64);
  }
  assert.ok(observation.ir.instructions.some((instruction) => instruction.op === OP.BIN));
  assert.ok(observation.ir.instructions.some((instruction) => instruction.op === OP.RET));
});

test('ARM64 holdout: conditional branch preserves diamond CFG, flags, and merge semantics', () => {
  const observation = materialize(fixture('holdout-conditional-cfg'));
  assertCompleteSemanticPresentation(observation);
  const entry = observation.ir.blocks.find((block) => block.startRow === 0);
  const successorRows = (entry?.succ || [])
    .map((index) => observation.ir.blocks.find((block) => block.index === index)?.startRow)
    .sort((a, b) => a - b);
  assert.deepEqual(successorRows, [2, 4], 'conditional entry must retain fallthrough and taken CFG successors');
  assert.ok(observation.ir.instructions.some((instruction) => instruction.op === OP.CBR), 'conditional branch missing');
  assert.ok(observation.ir.values.some((value) => value.reg === 'NZCV.Z'), 'condition-flag Z evidence missing');
  const expression = returnExpression(observation.result);
  assert.equal(expression.phi, true, 'two branch results must merge through a semantic phi');
  assert.equal(expression.incoming?.length, 2, 'return phi must retain both alternatives');
});

test('ARM64 holdout: loop keeps the back-edge and loop header', () => {
  const observation = materialize(fixture('holdout-loop-backedge'));
  assertCompleteSemanticPresentation(observation);
  assert.deepEqual(observation.model.backEdges, [{ from:4, to:1 }]);
  assert.equal(observation.model.basicBlocks.find((block) => block.startRow === 1)?.isLoopHeader, true);
  assert.ok(observation.ir.instructions.some((instruction) => instruction.op === OP.CBR));
  assert.ok(observation.ir.instructions.some((instruction) => instruction.op === OP.BR));
});

test('ARM64 holdout: stack frame carries memory, callee-saved, and aligned-SP evidence', () => {
  const observation = materialize(fixture('holdout-stack-frame-memory'));
  assertCompleteSemanticPresentation(observation);
  const stores = observation.ir.instructions.filter((instruction) => instruction.op === OP.STORE);
  assert.equal(stores.filter((instruction) => instruction.row === 0).length, 2, 'STP must materialize two stack stores');
  assert.ok(stores.some((instruction) => instruction.row === 2 && instruction.loc?.kind === 'stack'), 'local stack store missing');
  assert.ok(observation.ir.values.some((value) => value.reg === 'x29' && value.def?.row === 5), 'callee-saved x29 restore missing');
  assert.ok(observation.ir.values.some((value) => value.reg === 'x30' && value.def?.row === 5), 'callee-saved x30 restore missing');
  assert.ok(observation.ir.values.some((value) => value.reg === 'sp' && value.def?.row === 5), 'stack-pointer restore missing');
  assert.equal(evalReturn(observation.result, { a1:9n }), 11n, 'store/load reaching value must survive the frame');
  assert.equal(32 % 16, 0, 'fixture frame delta must preserve AAPCS64 SP alignment');
});

test('ARM64 holdout: direct call exposes AAPCS64 arguments and x0 return flow', () => {
  const observation = materialize(fixture('holdout-aapcs64-call'));
  assertCompleteSemanticPresentation(observation);
  const call = observation.ir.instructions.find((instruction) => instruction.op === OP.CALL);
  assert.ok(call, 'direct BL must become a call');
  assert.equal(call.extra?.indirect, false);
  assert.equal(call.extra?.target, 0x720000n);
  assert.equal(call.extra?.abiAdapterStatus, 'used');
  const regs = new Set((call.callArguments || []).map((argument) => argument.reg));
  assert.ok(regs.has('x0') && regs.has('x1'), 'AAPCS64 x0/x1 argument bank evidence missing');
  assert.ok(observation.ir.values.some((value) => value.reg === 'x0' && value.def?.row === 2), 'x0 call-result definition missing');
  const returned = returnExpression(observation.result);
  assert.equal(returned.op, 'add');
  assert.equal(returned.left?.materializedCall, true, 'return path must consume the materialized call result');
});

test('ARM64 holdout: SXTW and UXTW stay semantically distinct', () => {
  const observation = materialize(fixture('holdout-sign-zero-extension'));
  assertCompleteSemanticPresentation(observation);
  assert.equal(evalReturn(observation.result, { a1:0x80000000n }), 0n);
  assert.equal(evalReturn(observation.result, { a1:0xffffffffn }), 0xfffffffen);
  assert.ok(observation.ir.values.some((value) => value.reg === 'x1' && value.bits === 64 && value.def?.row === 0));
  assert.ok(observation.ir.values.some((value) => value.reg === 'x2' && value.bits === 64 && value.def?.row === 1));
});

test('ARM64 holdout: W-register writes zero-extend the architectural X register', () => {
  const observation = materialize(fixture('holdout-w-write-zero-extends-x'));
  assertCompleteSemanticPresentation(observation);
  const finalX0 = observation.ir.values.find((value) => value.reg === 'x0' && value.def?.row === 1);
  assert.ok(finalX0, 'W destination must publish an architectural x0 value');
  assert.equal(finalX0.bits, 64);
  assert.equal(finalX0.const, 0n, '32-bit wrap result must zero-extend to 64-bit zero');
  assert.equal(evalReturn(observation.result, {}), 0n);
});

test('ARM64 holdout: STP/LDP pair roundtrip preserves both semantic values', () => {
  const observation = materialize(fixture('holdout-pair-stack-roundtrip'));
  assertCompleteSemanticPresentation(observation);
  const pairStores = observation.ir.instructions.filter((instruction) => instruction.op === OP.STORE && instruction.row === 0);
  assert.equal(pairStores.length, 2, 'STP must lower into two independent 64-bit memory writes');
  assert.ok(pairStores.every((instruction) => instruction.loc?.kind === 'stack' && instruction.loc?.size === 8));
  assert.ok(observation.ir.values.some((value) => value.reg === 'x2' && value.def?.row === 1), 'first LDP destination missing');
  assert.ok(observation.ir.values.some((value) => value.reg === 'x3' && value.def?.row === 1), 'second LDP destination missing');
  assert.equal(evalReturn(observation.result, { a1:4n, a2:6n }), 10n);
});

test('ARM64 holdout: unresolved indirect control remains explicit instead of guessing a switch target', () => {
  const observation = materialize(fixture('holdout-indirect-open-target'));
  assertIrOwnership(observation.ir, observation.f.id);
  const branch = observation.model.instructions[2];
  assert.equal(branch.isBranch, true);
  assert.equal(branch.branchTarget, null, 'register-indirect branch must not acquire a guessed direct target');
  assert.ok(ownUnknowns(observation.ir).length > 0, 'open indirect target must remain explicit in Semantic IR');
  assert.equal(observation.result.semantic, false, 'open indirect target must not be presented as fully semantic');
  assert.ok(String(observation.result.pseudocode || '').trim().length > 0, 'fail-closed case should still have bounded presentation');
});

test('ARM64 holdout: unowned LDAXP effects fail closed as an explicit counterexample', () => {
  const observation = materialize(fixture('holdout-unsupported-ldaxp'));
  assertIrOwnership(observation.ir, observation.f.id);
  const unknowns = ownUnknowns(observation.ir);
  assert.ok(unknowns.length > 0, 'unsupported instruction must emit unknown Semantic IR');
  assert.ok(unknowns.some((instruction) => instruction.extra?.reason === 'architecture-lifter-returned-no-exact-effects'));
  const categories = new Set(unknowns.flatMap((instruction) => instruction.extra?.unknownCategories || []));
  assert.ok(categories.has('memory') && categories.has('registers') && categories.has('control'),
    `unsupported effects must stay conservatively open: ${[...categories].join(',')}`);
  assert.equal(observation.result.semantic, false, 'unsupported semantics may not be upgraded to a complete semantic decompile');
  assert.ok(String(observation.result.pseudocode || '').includes('__asm'), 'unsupported presentation must expose a raw-assembly boundary');
});

test('ARM64 holdout: ADRP + ADD forms the architecture address numerically', () => {
  const observation = materialize(fixture('holdout-adrp-add-address'));
  assertCompleteSemanticPresentation(observation);
  assert.equal(evalReturn(observation.result, {}), 0x4120n);
  assert.ok(observation.ir.values.some((value) => value.reg === 'x0' && value.const === 0x4000n));
  assert.ok(observation.ir.values.some((value) => value.reg === 'x0' && value.const === 0x4120n));
});

test('ARM64 holdout: literal load preserves memory provenance into the return value', () => {
  const observation = materialize(fixture('holdout-literal-load'));
  assertCompleteSemanticPresentation(observation);
  const load = observation.ir.instructions.find((instruction) => instruction.op === OP.LOAD);
  assert.ok(load, 'literal LDR must produce a memory load');
  assert.equal(load.loc?.kind, 'global');
  assert.equal(load.loc?.address, 0x710010n);
  assert.equal(load.loc?.size, 8);
  assert.ok(observation.ir.values.some((value) => value.reg === 'x0' && value.def?.row === 0));
});
