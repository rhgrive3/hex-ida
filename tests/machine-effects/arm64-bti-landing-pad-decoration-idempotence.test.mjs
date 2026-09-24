/*
 * #fbb-1 — Landing-pad decoration must be idempotent.
 *
 * `BTI <target>` and the implicit-BTI landing pads carry a symbolic read of the
 * runtime executable-page-guarded state and of the incoming BTYPE. That
 * decoration is applied by the ARM64 MachineEffects dispatcher AND again by the
 * architecture plugin wrapper, so it runs twice on a real bundle.
 *
 * The first observed consequence was on OpenTTD (ARM64 ELF): a single `bti c`
 * published two register-read operations with the same `bti:page-guarded`
 * temporary identity. Semantic IR lowering rejects that as
 * `semantic-ir-lowering-duplicate-temporary-definition`, which is thrown from
 * inside the v2 compatibility pipeline where `irFor` swallows it — so four
 * sampled vtable-slot functions silently lost *all* of their semantic IR and
 * fell back to the legacy renderer. The second consequence was a duplicated
 * architectural input on the reconstructed intrinsic, which fails as
 * `semantic-ir-invalid-node-inputs-duplicate`.
 *
 * These assertions are the permanent regression for both. They also pin the
 * fail-closed classification: an unresolved guarded-page state stays `partial`,
 * it is never promoted to `exact` to make a pipeline green.
 */
import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { stableStringify } from '../../js/core/identity/index.js';
import { ARM64_ARCHITECTURE, ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { decorateArm64BtiGuardedPageEffects } from '../../js/targets/architecture/arm64/effects/bti-guard-state.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

const ARM64_BTI_PAGE_GUARD_STATE_ID = 'arm64.exec-page.guarded';
const PAGE_GUARD_TEMPORARY_ID = 'bti:page-guarded';
const INCOMING_BTYPE_TEMPORARY_ID = 'bti:incoming-btype';

let sequence = 0;
function instruction(mnemonic, operands = '', extra = {}) {
  sequence += 1;
  const instructionId = `arm64-bti-idempotence-${sequence}`;
  return {
    instructionId,
    mnemonic,
    operands,
    ops:parseOperands(operands),
    mode:'a64',
    address:0x4000n + BigInt(sequence * 4),
    origin:{ instructionIds:[instructionId] },
    ...extra,
  };
}

/*
 * Every MachineEffects operation that publishes a value in a lowerable role.
 * `register-write` and `memory-write` consume values but publish none, which is
 * exactly how Semantic IR lowering enumerates producer effects.
 */
function publishedTemporaries(bundle) {
  const ids = [];
  for (const operation of bundle.operations) {
    const outputs = operation.kind === 'value' ? operation.outputs
      : ['register-read', 'flag-read', 'memory-read'].includes(operation.kind) ? [operation.value]
        : operation.kind === 'intrinsic' ? operation.effectSummary.outputs
          : [];
    for (const value of outputs || []) {
      if (value?.kind === 'temporary' && typeof value.temporaryId === 'string') ids.push(value.temporaryId);
    }
  }
  return ids;
}

function guardStateReads(bundle) {
  return bundle.operations.filter((operation) => operation.kind === 'register-read'
    && operation.register?.registerId === ARM64_BTI_PAGE_GUARD_STATE_ID);
}

function bundleSignature(bundle) {
  return stableStringify(bundle);
}

function lowerOnce(bundle, label) {
  return lowerMachineEffectBundleToSemanticIr(bundle, {
    functionId:`fbb-idempotence-${label}`,
    blockId:`fbb-idempotence-block-${label}`,
    entryBlockId:`fbb-idempotence-block-${label}`,
    addressWidthBits:64,
  }, {});
}

for (const [mnemonic, operands] of [['bti', 'c'], ['bti', 'j'], ['bti', 'jc']]) {
  const lifted = instruction(mnemonic, operands);
  const once = liftArm64MachineEffects(lifted, {});
  assert.ok(once, `${mnemonic} ${operands}: the ARM64 effects layer must lift it`);
  assert.equal(guardStateReads(once).length, 1,
    `${mnemonic} ${operands}: exactly one executable-page-guarded read is published`);
  assert.equal(publishedTemporaries(once).filter((id) => id === PAGE_GUARD_TEMPORARY_ID).length, 1,
    `${mnemonic} ${operands}: the guarded-page temporary is published exactly once`);

  const twice = ARM64_ARCHITECTURE.liftExact(lifted, {});
  assert.equal(bundleSignature(twice), bundleSignature(once),
    `${mnemonic} ${operands}: the architecture-plugin decoration layer must not change an already-decorated bundle`);
  assert.equal(guardStateReads(twice).length, 1,
    `${mnemonic} ${operands}: the second decoration pass must not add a second guarded-page read`);

  const redecorated = decorateArm64BtiGuardedPageEffects(lifted, once, {});
  assert.equal(bundleSignature(redecorated), bundleSignature(once),
    `${mnemonic} ${operands}: re-applying the landing-pad decoration is an identity`);

  const lowered = lowerOnce(twice, `${mnemonic}-${operands.replace(/\W/g, '')}`);
  assert.ok(lowered, `${mnemonic} ${operands}: the decorated bundle must lower to Semantic IR`);

  const duplicateTemporaries = publishedTemporaries(twice)
    .filter((id, index, all) => all.indexOf(id) !== index);
  assert.deepEqual(duplicateTemporaries, [],
    `${mnemonic} ${operands}: no temporary identity may be published twice (semantic-ir-lowering-duplicate-temporary-definition)`);
}

/*
 * An unresolved guarded-page state is a real unknown: the fault condition cannot
 * be decided. It must stay `partial` and explicit. The unknown is a fault, not a
 * control effect: a landing-pad check never redirects intra-procedural control,
 * and a `control` unknown would contradict the block's proven fallthrough edge.
 */
{
  const bundle = ARM64_ARCHITECTURE.liftExact(instruction('bti', 'c'), {});
  assert.equal(bundle.completeness, 'partial', 'an unresolved guarded-page state is not exact');
  assert.equal(bundle.unknownEffects?.reason, 'bti-mapped-page-guarded-state-unresolved');
  assert.deepEqual(bundle.unknownEffects.categories.slice().sort(), ['faults']);
  assert.equal(bundle.possibleFaults[0]?.kind, 'branch-target-exception');
}

/*
 * An observed non-guarded page is the one state where BTI is architecturally
 * NOP-like, and there the bundle is exact with no published temporary.
 */
{
  const bundle = ARM64_ARCHITECTURE.liftExact(instruction('bti', 'c'), { btiGuardedPage:false });
  assert.equal(bundle.completeness, 'exact', 'BTI on an observed non-guarded page is exact');
  assert.equal(guardStateReads(bundle).length, 0, 'a proven non-guarded page needs no runtime guard-state read');
  assert.deepEqual(bundle.unknownEffects ?? null, null, 'a proven non-guarded page has no unknown effects');
  const nonResetOperations = bundle.operations.filter((operation) => !(
    operation.kind === 'register-write' && operation.register?.registerId === 'pstate.btype'
  ));
  assert.deepEqual(nonResetOperations, [], 'the exact non-guarded-page bundle carries only the architectural BTYPE post-state reset');
}

/*
 * `paciasp` is the implicit-BTI landing pad of the same sample. FEAT_BTI is an
 * optional feature: an unprovisioned one must fail closed instead of being
 * laundered into an implicit landing-pad check. With the feature positively
 * present the landing pad publishes two architectural reads, and that decoration
 * must be idempotent for the same reason as the explicit `bti` form.
 */
const landingPadInstruction = instruction('paciasp', '', { mode:'arm64e' });
{
  const unresolvedFeature = ARM64E_ARCHITECTURE.liftExact(landingPadInstruction, {});
  assert.ok(unresolvedFeature, 'paciasp: the ARM64e layer must lift the pointer-authentication instruction');
  assert.equal(unresolvedFeature.completeness, 'partial', 'paciasp: an unprovisioned FEAT_BTI fails closed');
  assert.equal(unresolvedFeature.unknownEffects?.reason, 'bti-feature-unknown');
  assert.equal(unresolvedFeature.metadata?.implicitBtiLanding, false,
    'paciasp: the implicit landing-pad check is not fabricated without FEAT_BTI evidence');
  assert.equal(publishedTemporaries(unresolvedFeature).filter((id) => id === PAGE_GUARD_TEMPORARY_ID).length, 0,
    'paciasp: no guarded-page read without a proven implicit landing pad');

  const bundle = ARM64E_ARCHITECTURE.liftExact(landingPadInstruction, { featBti:true });
  assert.equal(bundle.metadata?.implicitBtiLanding, true, 'paciasp: FEAT_BTI present evaluates the implicit landing pad');
  assert.equal(publishedTemporaries(bundle).filter((id) => id === PAGE_GUARD_TEMPORARY_ID).length, 1,
    'paciasp: exactly one guarded-page temporary');
  assert.equal(publishedTemporaries(bundle).filter((id) => id === INCOMING_BTYPE_TEMPORARY_ID).length, 1,
    'paciasp: exactly one incoming-BTYPE temporary');
  assert.equal(bundle.possibleFaults.filter((fault) => fault?.kind === 'branch-target-exception').length, 1,
    'paciasp: exactly one conditional landing-pad fault');

  const redecorated = decorateArm64BtiGuardedPageEffects(landingPadInstruction, bundle, { featBti:true });
  assert.equal(bundleSignature(redecorated), bundleSignature(bundle),
    'paciasp: implicit landing-pad decoration is idempotent');

  const lowered = lowerOnce(bundle, 'paciasp');
  assert.ok(lowered, 'paciasp: the implicit landing-pad bundle must lower to Semantic IR');
  assert.deepEqual(publishedTemporaries(bundle).filter((id, index, all) => all.indexOf(id) !== index), [],
    'paciasp: no temporary identity is published twice');
}

/*
 * `autiasp` authenticates and returns; it is never a branch target, so it must
 * not be decorated as a landing pad. Its decoration is still required to be an
 * identity on an already-decorated bundle.
 */
{
  const lifted = instruction('autiasp', '', { mode:'arm64e' });
  const bundle = ARM64E_ARCHITECTURE.liftExact(lifted, {});
  assert.ok(bundle, 'autiasp: the ARM64e layer must lift the pointer-authentication instruction');
  assert.equal(bundle.metadata?.implicitBtiLanding, undefined, 'autiasp is not a branch target and has no implicit landing pad');
  assert.equal(publishedTemporaries(bundle).filter((id) => id === PAGE_GUARD_TEMPORARY_ID).length, 0,
    'autiasp: no guarded-page read is invented');
  assert.deepEqual(publishedTemporaries(bundle).filter((id, index, all) => all.indexOf(id) !== index), [],
    'autiasp: no temporary identity is published twice');
  const redecorated = decorateArm64BtiGuardedPageEffects(lifted, bundle, {});
  assert.equal(bundleSignature(redecorated), bundleSignature(bundle), 'autiasp: decoration is idempotent');
  assert.ok(lowerOnce(bundle, 'autiasp'), 'autiasp: the bundle must lower to Semantic IR');
}

/*
 * The architecture plugin owns the PAC feature policy. When PAC is proven absent
 * the instruction is the exact architectural NOP; with an unresolved runtime
 * state it fails closed. Neither outcome may be invented by the ARM64 effects
 * family layer, which carries no feature context.
 */
for (const mnemonic of ['paciasp', 'autiasp']) {
  // The v2 compatibility pipeline spreads its `machineEffectsContext` into the
  // lift context, so the policy keys arrive at the top level.
  const absent = ARM64_ARCHITECTURE.liftExact(
    instruction(mnemonic, ''),
    { pacRequested:false, pacEnabled:false },
  );
  assert.equal(absent?.completeness, 'exact', `${mnemonic}: PAC proven absent is an exact NOP`);
  assert.equal(absent.operations.length, 0, `${mnemonic}: the exact NOP publishes no operations`);
  assert.equal(absent.statePreservation?.proven, true);

  const unresolved = ARM64_ARCHITECTURE.liftExact(instruction(mnemonic, ''), {});
  assert.equal(unresolved?.completeness, 'partial', `${mnemonic}: an unresolved PAC runtime state fails closed`);
  assert.equal(unresolved.controlEffect?.kind, 'unknown');
  assert.equal(unresolved.unknownEffects?.reason, 'arm64-pac-runtime-state-unresolved');
}

console.log('arm64-bti-landing-pad-decoration-idempotence: PASS');
