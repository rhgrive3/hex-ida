import {
  createPEMetadataBudget,
  parseCoffSymbols as parseCoffSymbolsCore,
  parseDelayImports as parseDelayImportsCore,
  parseImports as parseImportsCore,
} from './pe-loader-core.js';

function exactCStringAccounting(reader, budget) {
  const rawCStringBytes = [];

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
          return Reflect.apply(Reflect.get(target, 'take', target), target, [exactCost, reason]);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { reader: accountingReader, budget: accountingBudget };
}

function delegatedContext(reader, image, sharedBudget) {
  const budget = sharedBudget || createPEMetadataBudget(image);
  return exactCStringAccounting(reader, budget);
}

export function parseImports(reader, directory, image, sharedBudget = null) {
  if (!directory || !directory.rva || !directory.size) {
    return parseImportsCore(reader, directory, image, sharedBudget);
  }
  const context = delegatedContext(reader, image, sharedBudget);
  return parseImportsCore(context.reader, directory, image, context.budget);
}

export function parseCoffSymbols(reader, pointer, count, image, sharedBudget = null) {
  if (!pointer || !count) {
    return parseCoffSymbolsCore(reader, pointer, count, image, sharedBudget);
  }
  const context = delegatedContext(reader, image, sharedBudget);
  const tableBytes = count * 18;
  const stringBase = Number.isSafeInteger(pointer) && Number.isSafeInteger(tableBytes)
    ? pointer + tableBytes
    : null;
  if (Number.isSafeInteger(stringBase) && stringBase >= 0 && stringBase + 4 <= reader.length) {
    const stringSize = reader.u32(stringBase);
    if (stringSize < 4) {
      context.budget.partial(
        'coff:string-table-size',
        `PE COFF string table size ${stringSize} is smaller than 4`,
      );
    }
  }
  return parseCoffSymbolsCore(context.reader, pointer, count, image, context.budget);
}

export function parseDelayImports(reader, directory, image, sharedBudget = null) {
  if (!directory || !directory.rva || directory.size < 32) {
    return parseDelayImportsCore(reader, directory, image, sharedBudget);
  }
  const context = delegatedContext(reader, image, sharedBudget);
  return parseDelayImportsCore(context.reader, directory, image, context.budget);
}
