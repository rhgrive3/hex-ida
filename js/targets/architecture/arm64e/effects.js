import {
  createBitVectorValue,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../semantics/effects/index.js';
import * as base from './effects-base.js';

export * from './effects-base.js';

export const ARM64E_EFFECTS_SEMANTIC_VERSION = '3';

const POINTER_BITS = 64;
const PAUTH_LR_SECOND_MODIFIER = Object.freeze({
  pacia1716: 'x15',
  pacib1716: 'x15',
  paciasp: 'pc',
  pacibsp: 'pc',
  autia1716: 'x15',
  autib1716: 'x15',
  autiasp: 'x16',
  autibsp: 'x16',
  retaa: 'x16',
  retab: 'x16',
});

function mnemonicOf(decoded) {
  const raw = typeof decoded?.mnemonic === 'string'
    ? decoded.mnemonic
    : typeof decoded?.opcode === 'string'
      ? decoded.opcode
      : '';
  return raw.trim().toLowerCase();
}

function conditionalSecondModifierRead(bundle, registerId) {
  const temporary = createTemporaryValue(
    `${bundle.instructionId}.pauth-lr.second-modifier`,
    createBitVectorValue(POINTER_BITS),
  );
  const condition = Object.freeze({
    kind: 'arm64e-pauth-lr-pacm-active',
    feature: 'FEAT_PAuth_LR',
    pstateField: 'PACM',
    equals: 1,
    architectureStateInput: 'PAuthState',
  });
  const operation = createMachineOperation({
    kind: 'register-read',
    register: createRegisterValue(registerId, POINTER_BITS),
    value: temporary,
    metadata: {
      implicit: true,
      stateKind: registerId === 'pc'
        ? 'pointer-authentication-program-counter-second-modifier'
        : 'pointer-authentication-second-modifier',
      conditional: condition,
    },
  });
  return { temporary, operation, condition };
}

function refinePAuthLrDependency(decoded, bundle) {
  const secondRegister = PAUTH_LR_SECOND_MODIFIER[mnemonicOf(decoded)];
  if (!bundle || !secondRegister) return bundle;

  const second = conditionalSecondModifierRead(bundle, secondRegister);
  let refinedIntrinsic = false;
  const operations = [];

  for (const operation of bundle.operations) {
    if (!refinedIntrinsic && operation.kind === 'intrinsic' && (
      operation.intrinsicId === 'arm64e.pointer.sign'
      || operation.intrinsicId === 'arm64e.pointer.authenticate'
    )) {
      const inputs = [...operation.effectSummary.inputs];
      const insertionIndex = Math.max(2, inputs.length - 2);
      inputs.splice(insertionIndex, 0, second.temporary);
      const registersRead = [...new Set([
        ...operation.effectSummary.registersRead,
        secondRegister,
      ])];

      operations.push(second.operation);
      operations.push(createMachineOperation({
        ...operation,
        effectSummary: {
          ...operation.effectSummary,
          inputs,
          registersRead,
        },
        metadata: {
          ...(operation.metadata ?? {}),
          pauthLrSecondModifier: {
            kind: secondRegister === 'pc' ? 'program-counter' : 'register',
            registerId: secondRegister,
            conditional: second.condition,
          },
        },
      }));
      refinedIntrinsic = true;
      continue;
    }
    operations.push(operation);
  }

  if (!refinedIntrinsic) return bundle;
  return Object.freeze({
    ...bundle,
    operations: Object.freeze(operations),
    metadata: Object.freeze({
      ...bundle.metadata,
      semanticVersion: ARM64E_EFFECTS_SEMANTIC_VERSION,
      pauthLrSecondModifier: Object.freeze({
        kind: secondRegister === 'pc' ? 'program-counter' : 'register',
        registerId: secondRegister,
        conditional: second.condition,
      }),
    }),
  });
}

function normalizeSemanticVersion(bundle) {
  if (!bundle || bundle.metadata?.semanticVersion === ARM64E_EFFECTS_SEMANTIC_VERSION) return bundle;
  return Object.freeze({
    ...bundle,
    metadata: Object.freeze({
      ...bundle.metadata,
      semanticVersion: ARM64E_EFFECTS_SEMANTIC_VERSION,
    }),
  });
}

export function liftArm64eEffects(decoded, context = {}) {
  const bundle = base.liftArm64eEffects(decoded, context);
  return normalizeSemanticVersion(refinePAuthLrDependency(decoded, bundle));
}

export function extendArm64WithArm64eEffects(baseLiftExact) {
  if (baseLiftExact != null && typeof baseLiftExact !== 'function') {
    throw new TypeError('arm64e-base-lifter-must-be-function');
  }
  return function liftArm64eExtension(decoded, context = {}) {
    const refined = liftArm64eEffects(decoded, context);
    if (refined != null) return refined;
    return baseLiftExact ? baseLiftExact(decoded, context) : null;
  };
}

export function createArm64eEffectsExtension(baseLiftExact = null) {
  return Object.freeze({
    architectureId: 'arm64e',
    semanticVersion: ARM64E_EFFECTS_SEMANTIC_VERSION,
    canHandle: base.isArm64ePointerAuthenticationInstruction,
    liftExact: extendArm64WithArm64eEffects(baseLiftExact),
  });
}
