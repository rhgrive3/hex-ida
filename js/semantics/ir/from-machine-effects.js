import { lowerMachineEffectBundleToSemanticIr as lowerMachineEffectBundleToSemanticIrImpl } from './from-machine-effects-impl.js';

function canonicalAddressWidthBits(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function loweringContextWithCanonicalAddressWidth(context) {
  const source = Object(context);
  let addressWidthBits;
  let addressWidthBitsRead = false;
  const view = Object.create(null);
  Object.defineProperties(view, {
    functionId: { enumerable: true, get: () => Reflect.get(source, 'functionId', source) },
    blockId: { enumerable: true, get: () => Reflect.get(source, 'blockId', source) },
    entryBlockId: { enumerable: true, get: () => Reflect.get(source, 'entryBlockId', source) },
    addressWidthBits: {
      enumerable: true,
      get: () => {
        if (!addressWidthBitsRead) {
          addressWidthBits = canonicalAddressWidthBits(Reflect.get(source, 'addressWidthBits', source));
          addressWidthBitsRead = true;
        }
        return addressWidthBits;
      },
    },
    controlTargets: { enumerable: true, get: () => Reflect.get(source, 'controlTargets', source) },
  });
  return view;
}

export function lowerMachineEffectBundleToSemanticIr(input, context = {}, options = {}) {
  return lowerMachineEffectBundleToSemanticIrImpl(
    input,
    loweringContextWithCanonicalAddressWidth(context),
    options,
  );
}

export const lowerMachineEffectsToSemanticIr = lowerMachineEffectBundleToSemanticIr;
