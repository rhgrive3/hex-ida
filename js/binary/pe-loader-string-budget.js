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

function coffSectionNumberGuard(reader, image, budget, pointer, count) {
  const tableBytes = count * 18;
  const tableEnd = Number.isSafeInteger(pointer) && Number.isSafeInteger(tableBytes)
    ? pointer + tableBytes
    : null;
  if (!Number.isSafeInteger(tableEnd) || pointer < 0 || tableBytes < 0) {
    return { reader, image };
  }

  const sectionIndexes = new Set(
    (Array.isArray(image.sections) ? image.sections : [])
      .map((section) => section?.index)
      .filter((index) => Number.isInteger(index) && index > 0),
  );
  const invalidSectionNumber = (sectionNumber) => (
    (sectionNumber > 0 && !sectionIndexes.has(sectionNumber))
    || sectionNumber < -2
  );

  const validatingReader = new Proxy(reader, {
    get(target, property) {
      if (property === 'i16') {
        return (offset) => {
          const sectionNumber = target.i16(offset);
          const relative = offset - pointer;
          if (
            Number.isSafeInteger(relative)
            && relative >= 12
            && offset < tableEnd
            && relative % 18 === 12
            && invalidSectionNumber(sectionNumber)
          ) {
            budget.partial(
              'coff:invalid-section-number',
              `Ignored PE COFF symbol with invalid SectionNumber ${sectionNumber}`,
            );
          }
          return sectionNumber;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const validatingSymbols = new Proxy(image.symbols, {
    get(target, property) {
      if (property === 'push') {
        return (...entries) => {
          const accepted = entries.filter((entry) => !(
            entry?.source === 'COFF'
            && invalidSectionNumber(entry.sectionIndex)
          ));
          return accepted.length ? target.push(...accepted) : target.length;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const validatingImage = new Proxy(image, {
    get(target, property) {
      if (property === 'symbols') return validatingSymbols;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { reader: validatingReader, image: validatingImage };
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
  const guarded = coffSectionNumberGuard(context.reader, image, context.budget, pointer, count);
  return parseCoffSymbolsCore(guarded.reader, pointer, count, guarded.image, context.budget);
}

export function parseDelayImports(reader, directory, image, sharedBudget = null) {
  if (!directory || !directory.rva || directory.size < 32) {
    return parseDelayImportsCore(reader, directory, image, sharedBudget);
  }
  const context = delegatedContext(reader, image, sharedBudget);
  return parseDelayImportsCore(context.reader, directory, image, context.budget);
}
