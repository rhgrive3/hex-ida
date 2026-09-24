// A BTI landing pad is decorated more than once for one instruction: the effect
// dispatcher decorates every family result, and the ARM64 architecture plugin
// decorates the bundle the dispatcher returned (it has to, because the arm64e
// pointer-authentication extension wraps the dispatcher's bundle and adds the
// pointer-sign intrinsic afterwards). Two defects in that re-decoration
// silently removed the FAST semantic route from BTI-hardened functions:
//
//   1. every application minted a fresh `bti:page-guarded` / `bti:incoming-btype`
//      temporary, so a single instruction bundle defined one temporary identity
//      twice. The compatibility lowering reads two definitions of one temporary
//      identity as a fail-closed conflict
//      (semantic-ir-lowering-duplicate-temporary-definition) and refuses the
//      whole function: no compatibility IR, so no C++ typing on the fast route.
//   2. the unresolved-page-guard projection published `control` among its
//      unknownEffect categories. A landing-pad check never redirects
//      intra-procedural control, so that claim contradicted the block's proven
//      fallthrough edge and the Semantic SSA validator rejected the function
//      (semantic-ssa-control-flow-mismatch).
import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { stableStringify } from '../../js/core/identity/index.js';
import { buildIR } from '../../js/ir.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { liftArm64eEffects } from '../../js/targets/architecture/arm64e/index.js';
import {
  ARM64_BTI_PAGE_GUARD_STATE_ID,
  decorateArm64BtiGuardedPageEffects,
} from '../../js/targets/architecture/arm64/effects/bti-guard-state.js';

const ARM64_BTYPE_REGISTER_ID = 'pstate.btype';
// `bti j` and `b #0x100c` / `mov x0, x1` / `ret` A64 encodings.
const BTI_J = 0xd503249f;
const B = 0x14000003;
const MOV_X0_X1 = 0xaa0103e0;
const RET = 0xd65f03c0;

function decodedBti({ landing = 'j', word = BTI_J, address = 0x1000n, instructionId = 'bti-decoded' } = {}) {
  return {
    instructionId,
    origin: { instructionIds: [instructionId] },
    mode: 'a64',
    address,
    size: 4,
    mnemonic: 'bti',
    operands: landing,
    ops: parseOperands(landing),
    word,
  };
}

/**
 * Fabricate a bundle outside the registry: each application of the decorator
 * must be per-bundle identity-preserving, so the same bundle must stay
 * re-decoratable indefinitely.
 */
function temporaryDefinitions(bundle) {
  const counts = new Map();
  for (const operation of bundle.operations) {
    if (operation?.kind !== 'register-read' || operation.value?.kind !== 'temporary') continue;
    const key = `${operation.register?.registerId}\u0000${operation.value.temporaryId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function assertUniqueTemporaryDefinitions(bundle, label) {
  for (const [key, count] of temporaryDefinitions(bundle)) {
    assert.equal(count, 1, `${label}: temporary ${key} must be defined exactly once, saw ${count}`);
  }
}

function liftThroughPlugin(decoded, context = {}) {
  // The registered plugin is the production entry: it resolves the lifter and
  // applies the BTI decoration on top of what the dispatcher already did.
  return ARM64_ARCHITECTURE.liftExact(decoded, {
    instructionId: decoded.instructionId,
    origin: decoded.origin,
    mode: 'a64',
    machineEffectsOptions: {},
    ...context,
  });
}

{
  // Defect 1: one bundle must define each landing-pad temporary identity once,
  // however many times the decorator runs over it.
  const decoded = decodedBti();
  const bundle = liftThroughPlugin(decoded);
  assertUniqueTemporaryDefinitions(bundle, 'plugin bti j');
  const guardReads = bundle.operations.filter((operation) => operation?.kind === 'register-read'
    && operation.register?.registerId === ARM64_BTI_PAGE_GUARD_STATE_ID);
  assert.equal(guardReads.length, 1, 'exactly one executable-page-guarded state read');
  assert.equal(bundle.metadata.btiCheck, 'conditional-on-unknown-page-guard-state');

  let reDecorated = bundle;
  for (let round = 0; round < 3; round++) {
    reDecorated = decorateArm64BtiGuardedPageEffects(decoded, reDecorated, { instructionId: decoded.instructionId });
    assertUniqueTemporaryDefinitions(reDecorated, `re-decoration ${round + 1} bti j`);
    // The decorator is applied by the dispatcher and again by the architecture
    // plugin, so its own output must be a fixed point: a second application may
    // not add a read, an input, or a fault.
    assert.equal(stableStringify(reDecorated), stableStringify(bundle),
      `re-decoration ${round + 1} of bti j must reproduce the decorated bundle exactly`);
  }
  const intrinsic = reDecorated.operations.find((operation) => operation.kind === 'intrinsic');
  assert.deepEqual(intrinsic.effectSummary.inputs.map((input) => input.temporaryId ?? `${input.widthBits}:${input.value}`),
    ['bti:page-guarded', 'bti:btype', '2:2']);
  assert.equal(intrinsic.metadata.inputOrder.length, 2 + 1, 'inputOrder describes the decorator-owned inputs once');
}

{
  // Defect 1, pointer-authentication form: PACIASP's implicit landing pad reads
  // both the page-guard state and the incoming BTYPE. Reuse must hold for both.
  const instructionId = 'arm64-bti-redecoration-paciasp';
  const decoded = {
    instructionId,
    origin: { instructionIds: [instructionId] },
    mode: 'a64',
    address: 0x2000n,
    mnemonic: 'paciasp',
    opStr: '',
    ops: parseOperands(''),
  };
  const base = liftArm64eEffects(decoded);
  const decorated = decorateArm64BtiGuardedPageEffects(decoded, base, { featBti: true, btiGuardedPage: { state: 'unknown' } });
  assertUniqueTemporaryDefinitions(decorated, 'paciasp implicit landing pad');
  const temporaryIds = new Set([...temporaryDefinitions(decorated).keys()]);
  assert.ok([...temporaryIds].some((key) => key.endsWith('\u0000bti:page-guarded')), 'page-guard read present');
  assert.ok([...temporaryIds].some((key) => key.endsWith('\u0000bti:incoming-btype')), 'incoming BTYPE read present');
  const again = decorateArm64BtiGuardedPageEffects(decoded, decorated, { featBti: true, btiGuardedPage: { state: 'unknown' } });
  assertUniqueTemporaryDefinitions(again, 'paciasp implicit landing pad (re-decorated)');
  assert.equal(stableStringify(again), stableStringify(decorated),
    'the implicit landing pad decoration is a fixed point too');
}

{
  // Defect 2: an unresolved page-guard state must publish the unproven fault
  // (fail closed) without claiming the instruction's control effect is unknown.
  const bundle = liftThroughPlugin(decodedBti({ landing: 'jc' }));
  assert.ok(bundle.unknownEffects, 'unresolved page-guard state publishes explicit unknown effects');
  assert.equal(bundle.unknownEffects.reason, 'bti-mapped-page-guarded-state-unresolved');
  assert.deepEqual([...bundle.unknownEffects.categories].sort(), ['faults']);
  assert.ok(!bundle.unknownEffects.categories.includes('control'),
    'a landing pad never redirects intra-procedural control');
  const faults = bundle.possibleFaults.filter((fault) => fault.kind === 'branch-target-exception');
  assert.equal(faults.length, 1, 'the conditional branch-target exception is still published');
  assert.equal(faults[0].condition.terms[0].value, 'unknown', 'the fault stays conditional on the unknown page state');
}

{
  // End to end: the FAST route (buildIR -> buildV2CompatFromLegacyModel) over a
  // function whose BTI block falls through into the next block. Before the fix
  // this raised duplicate-temporary-definition, and after only the temporary
  // reuse it raised semantic-ssa-control-flow-mismatch; either way the function
  // lost its whole compatibility IR.
  const rows = [
    { row: 0, address: 0x1000n, mn: 'b', ops: '#0x100c', word: B },
    { row: 1, address: 0x1004n, mn: 'bti', ops: 'j', word: BTI_J },
    { row: 2, address: 0x1008n, mn: 'mov', ops: 'x0, x1', word: MOV_X0_X1 },
    { row: 3, address: 0x100cn, mn: 'ret', ops: '', word: RET },
  ];
  const model = buildSemanticModel(rows, {
    startRow: 0,
    endRow: 3,
    name: 'bti-landing-pad-block',
    rowOfAddress: (address) => {
      const rel = BigInt(address) - 0x1000n;
      return rel < 0n || rel % 4n !== 0n ? null : Number(rel / 4n);
    },
  });
  assert.equal((model.basicBlocks || []).length, 3, 'the synthetic fixture has a BTI block that falls through');
  const ir = buildIR(model);
  assert.ok(ir, 'the FAST compatibility route builds IR for a BTI-hardened function');
  assert.ok(ir.instructions.some((instruction) => instruction.op === 'ret'),
    'the proven return stays the control projection');
  const btiBlock = ir.blocks.find((block) => block.startRow === 1 && block.endRow === 2);
  const retBlock = ir.blocks.find((block) => block.startRow === 3 && block.endRow === 3);
  assert.ok(btiBlock && retBlock, 'the BTI landing block and the return block survive the projection');
  assert.deepEqual(btiBlock.succ, [retBlock.index], 'the BTI block keeps its proven fallthrough successor');
  assert.ok((ir.compat?.controlEdges ?? []).some((edge) => edge.from === btiBlock.index
    && edge.to === retBlock.index && edge.kind === 'fallthrough'),
  'the projected control edge stays an exact fallthrough');
}

console.log('arm64 BTI landing-pad re-decoration / FAST compatibility IR regression: PASS');
