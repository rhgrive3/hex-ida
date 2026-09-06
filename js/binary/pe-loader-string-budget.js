import {
  createPEMetadataBudget,
  parseCoffSymbols as parseCoffSymbolsCore,
  parseDelayImports as parseDelayImportsCore,
  parseImports as parseImportsCore,
} from './pe-loader-core.js';

function exactCStringAccounting(reader, budget) {
  const rawCStringBytes = [];
  const descriptorState = {
    import: { seen: 0, terminated: false, budgetStopped: false },
    delayImport: { seen: 0, terminated: false, budgetStopped: false },
  };
  let descriptorCapture = null;

  const accountingReader = new Proxy(reader, {
    get(target, property) {
      if (property === 'cstring') {
        return (start, max) => {
          const value = target.cstring(start, max);
          const nulAt = target.slice(start, max).indexOf(0);
          rawCStringBytes.push(nulAt >= 0 ? nulAt + 1 : null);
          return value;
        };
      }
      if (property === 'u32') {
        return (offset) => {
          if (descriptorCapture?.kind === 'delay-import') {
            const capture = descriptorCapture;
            if (!capture.snapshot) {
              capture.baseOffset = offset;
              capture.snapshot = Array.from({ length: 8 }, (_, index) => target.u32(offset + index * 4));
              if (capture.snapshot.every((field) => field === 0)) capture.state.terminated = true;
              capture.moduleHandleOnly = capture.snapshot[2] !== 0
                && capture.snapshot.every((field, index) => index === 2 || field === 0);
            }
            const index = (offset - capture.baseOffset) / 4;
            if (Number.isInteger(index) && index >= 0 && index < 8) {
              let value = capture.snapshot[index];
              if (index === 5 && capture.moduleHandleOnly) value = capture.snapshot[2];
              if (index === 7) descriptorCapture = null;
              return value;
            }
          }
          const value = target.u32(offset);
          if (descriptorCapture) {
            descriptorCapture.values.push(value);
            if (descriptorCapture.values.length === descriptorCapture.expected) {
              if (descriptorCapture.values.every((field) => field === 0)) descriptorCapture.state.terminated = true;
              descriptorCapture = null;
            }
          }
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const accountingBudget = new Proxy(budget, {
    get(target, property) {
      if (property === 'take') {
        return (cost = {}, reason = 'metadata') => {
          let exactCost = cost;
          if (typeof reason === 'string' && reason.endsWith('-string') && rawCStringBytes.length) {
            const inputBytes = rawCStringBytes.shift();
            if (inputBytes != null) exactCost = { ...cost, inputBytes };
          }
          const accepted = Reflect.apply(Reflect.get(target, 'take', target), target, [exactCost, reason]);
          const descriptor = reason === 'import-descriptor'
            ? { state: descriptorState.import, expected: 5 }
            : reason === 'delay-import-descriptor'
              ? { state: descriptorState.delayImport, expected: 8, kind: 'delay-import' }
              : null;
          if (descriptor) {
            if (accepted) {
              descriptor.state.seen++;
              descriptorCapture = { ...descriptor, values: [] };
            } else {
              descriptor.state.budgetStopped = true;
              descriptorCapture = null;
            }
          }
          return accepted;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { reader: accountingReader, budget: accountingBudget, descriptorState };
}

function delegatedContext(reader, image, sharedBudget) {
  const budget = sharedBudget || createPEMetadataBudget(image);
  return exactCStringAccounting(reader, budget);
}

function markImportDescriptorGuard(context, directory, image) {
  const state = context.descriptorState.import;
  const hasTrailingDescriptor = directory.size >= (state.seen + 1) * 20;
  if (state.terminated || state.budgetStopped || state.seen !== 65536 || !hasTrailingDescriptor) return;
  image.metadata.peImports ||= { complete: true, truncatedTables: 0 };
  image.metadata.peImports.complete = false;
  image.metadata.peImports.truncatedTables++;
  context.budget.partial('imports-partial', 'PE import descriptor table exceeded its 65536-record safety guard without a zero descriptor');
}

function markDelayImportDescriptorTermination(context, directory) {
  const state = context.descriptorState.delayImport;
  if (state.terminated || state.budgetStopped || state.seen === 0) return;
  const hitGuardWithTrailingCapacity = state.seen === 65536 && directory.size >= (state.seen + 1) * 32;
  context.budget.partial(
    'delay-imports:unterminated-descriptor',
    hitGuardWithTrailingCapacity
      ? 'PE delay-import descriptor table exceeded its 65536-record safety guard without a zero descriptor'
      : 'PE delay-import descriptor table reached its mapped boundary without a zero descriptor',
  );
}

export function parseImports(reader, directory, image, sharedBudget = null) {
  if (!directory || !directory.rva || !directory.size) {
    return parseImportsCore(reader, directory, image, sharedBudget);
  }
  const context = delegatedContext(reader, image, sharedBudget);
  const result = parseImportsCore(context.reader, directory, image, context.budget);
  markImportDescriptorGuard(context, directory, image);
  return result;
}

export function parseCoffSymbols(reader, pointer, count, image, sharedBudget = null) {
  if (!pointer || !count) {
    return parseCoffSymbolsCore(reader, pointer, count, image, sharedBudget);
  }
  const context = delegatedContext(reader, image, sharedBudget);
  return parseCoffSymbolsCore(context.reader, pointer, count, image, context.budget);
}

export function parseDelayImports(reader, directory, image, sharedBudget = null) {
  if (!directory || !directory.rva || directory.size < 32) {
    return parseDelayImportsCore(reader, directory, image, sharedBudget);
  }
  const context = delegatedContext(reader, image, sharedBudget);
  const result = parseDelayImportsCore(context.reader, directory, image, context.budget);
  markDelayImportDescriptorTermination(context, directory);
  return result;
}
