import { deepFreeze, stableStringify } from '../../core/identity/index.js';
import { createOriginSet, isReusableOriginSet } from '../../core/identity/origin.js';
import {
  SEMANTIC_IR_CONTRACT_VERSION,
  SEMANTIC_IR_SCHEMA_VERSION,
  SEMANTIC_SETS,
  array,
  assertAllowedKeys,
  assertNotAborted,
  assertWithinBudget,
  enumValue,
  fail,
  nonEmpty,
  object,
  positiveInteger,
  requiredOrigin,
  serializable,
  sortedUniqueStrings,
  uniqueStrings,
} from './common.js';
import { createSemanticNode, createSemanticValue } from './nodes.js';

function normalizeBlock(input) {
  input = object(input, 'semantic-ir-invalid-block');
  assertAllowedKeys(input, new Set(['id', 'nodeIds', 'origin']), 'semantic-ir-unexpected-block-field');
  const out = {
    id: nonEmpty(input.id, 'semantic-ir-block-id-required'),
    nodeIds: uniqueStrings(input.nodeIds ?? [], 'semantic-ir-invalid-block-node-ids', false),
  };
  if (Object.hasOwn(input, 'origin')) out.origin = createOriginSet(input.origin);
  return deepFreeze(out);
}

function normalizeFunctionUnknown(input) {
  input = object(input, 'semantic-ir-invalid-function-unknown');
  assertAllowedKeys(input, new Set(['reason', 'categories', 'detail']), 'semantic-ir-unexpected-function-unknown-field');
  const out = {
    reason: nonEmpty(input.reason, 'semantic-ir-function-unknown-reason-required'),
    categories: sortedUniqueStrings(input.categories ?? [], 'semantic-ir-invalid-function-unknown-categories'),
  };
  if (input.detail != null) out.detail = serializable(input.detail, 'semantic-ir-invalid-function-unknown-detail');
  return out;
}

function assertVersion(input) {
  const schemaVersion = input.schemaVersion;
  if (schemaVersion != null
      && (typeof schemaVersion !== 'number' || schemaVersion !== SEMANTIC_IR_SCHEMA_VERSION)) {
    fail('semantic-ir-schema-version-mismatch');
  }
  const contractVersion = input.contractVersion;
  if (contractVersion != null
      && (typeof contractVersion !== 'string' || contractVersion !== SEMANTIC_IR_CONTRACT_VERSION)) {
    fail('semantic-ir-contract-version-mismatch');
  }
}

const REFERENCE_COUNT_OVERFLOW = Number.MAX_SAFE_INTEGER + 1;

function addReferenceCount(total, amount) {
  if (total === REFERENCE_COUNT_OVERFLOW
    || !Number.isSafeInteger(total)
    || total < 0
    || !Number.isSafeInteger(amount)
    || amount < 0
    || total > Number.MAX_SAFE_INTEGER - amount) {
    return REFERENCE_COUNT_OVERFLOW;
  }
  return total + amount;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

// Cache every raw object/collection read used by the reference preflight. This
// keeps accessor-backed nested summaries and scopes identical when the same
// inputs are normalized after the preflight. The cache is lazy, so the
// preflight still reads collection lengths without enumerating their elements.
function needsReferenceClone(value) {
  if (Array.isArray(value)) return false;
  return Reflect.ownKeys(value).some((property) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
    return descriptor && 'value' in descriptor
      && descriptor.configurable === false
      && descriptor.writable === false
      && descriptor.value !== null
      && typeof descriptor.value === 'object';
  });
}

function cloneReferenceTarget(value) {
  const target = Object.create(Object.getPrototypeOf(value));
  for (const property of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
    if (!descriptor) continue;
    if ('value' in descriptor) {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        writable: true,
        value: descriptor.value,
      });
    } else {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: descriptor.set,
      });
    }
  }
  return target;
}

function cacheReferenceReads(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object'
    || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return value;
  // Only this producer-owned, recursively checked immutable payload is safe
  // to retain. Proxying it would discard the normalizer's ownership brand and
  // copy/normalize the whole provenance tree again for each semantic entity.
  // Caller-owned frozen objects, accessors and mutable children still capture.
  if (isReusableOriginSet(value)) return value;
  const cached = seen.get(value);
  if (cached) return cached;
  const target = needsReferenceClone(value) ? cloneReferenceTarget(value) : value;
  const reads = new Map();
  const proxy = new Proxy(target, {
    get(proxyTarget, property, receiver) {
      if (reads.has(property)) return reads.get(property);
      const result = Reflect.get(proxyTarget, property, receiver);
      const descriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, property);
      if (descriptor && 'value' in descriptor && descriptor.configurable === false && descriptor.writable === false) {
        // Frozen arrays cannot return a nested proxy through the invariant-protected slot.
        // Cache the nested view by raw identity and return the required raw value.
        cacheReferenceReads(result, seen);
        reads.set(property, result);
        return result;
      }
      const captured = cacheReferenceReads(result, seen);
      reads.set(property, captured);
      return captured;
    },
  });
  seen.set(value, proxy);
  seen.set(proxy, proxy);
  return proxy;
}

// Every collection that can carry a reference or bounded work item is part of
// the maxReferences denominator. Raw lengths are a conservative upper bound
// because normalization only deduplicates/sorts or maps one item to one item.
function summaryReferenceCount(summary, seen) {
  if (!summary || typeof summary !== 'object') return 0;
  summary = seen ? cacheReferenceReads(summary, seen) : summary;
  let count = 0;
  for (const key of [
    'targetValueIds', 'targetEntityIds', 'arguments', 'returns',
    'inputs', 'outputs', 'stateReads', 'stateWrites', 'controlEffects',
  ]) {
    count = addReferenceCount(count, arrayLength(summary[key]));
  }
  for (const scope of [summary.memoryRead, summary.memoryWrite]) {
    if (!scope || typeof scope !== 'object') continue;
    count = addReferenceCount(count, arrayLength(scope.accesses));
    count = addReferenceCount(count, arrayLength(scope.addressSpaces));
  }
  if (summary.unknownEffects && typeof summary.unknownEffects === 'object') {
    count = addReferenceCount(count, arrayLength(summary.unknownEffects.categories));
  }
  return count;
}

function countReferences(nodes, values, blocks) {
  let count = 0;
  for (const node of nodes) {
    for (const key of ['inputs', 'outputs', 'targets', 'sourceEffectIds']) {
      count = addReferenceCount(count, arrayLength(node[key]));
    }
    if (node.memory) count = addReferenceCount(count, 1);
    count = addReferenceCount(count, summaryReferenceCount(node.call));
    count = addReferenceCount(count, summaryReferenceCount(node.intrinsic));
  }
  for (const block of blocks) count = addReferenceCount(count, arrayLength(block.nodeIds));
  for (const value of values) {
    if (value.definitionNodeId != null) count = addReferenceCount(count, 1);
  }
  return count;
}

// Fail-closed raw-input preflight (#5858): reject the full raw denomina²È="25¹½‘”¹¥¹ÑÉ¥¹Í¥Œ€ü€¡¹½‘”¹¥¹ÑÉ¥¹Í¥Œ¹µ•µ½ÉåI•…¹…•ÍÍ•Ì€üümt¤¹½¹…Ğ¡¹½‘”¹¥¹ÑÉ¥¹Í¥Œ¹µ•µ½Éå]É¥Ñ”¹…•ÍÍ•Ì€üümt¤¹µ…À ¡…•ÍÌ¤€ôø…•ÍÌ¹…‘‘É•ÍÍáÁÈ¹Ù…±Õ•%¤€èmt¤°(€€€tì(€€€™½È€¡½¹ÍĞ¥½˜ÕÍ•‘Y…±Õ•%‘Ì¤ì(€€€€€½¹ÍĞÙ…±Õ”€ôÙ…±Õ•	å%¹•Ğ¡¥¤ì(€€€€€¥˜€ …Ù…±Õ”ñğÙ…±Õ”¹‘•™¥¹¥Ñ¥½¹9½‘•%€ôô¹Õ±°¤½¹Ñ¥¹Õ”ì(€€€€€½¹ÍĞ‘•™¥¹¥Ñ¥½¹9½‘”€ô¹½‘•	å%¹•Ğ¡Ù…±Õ”¹‘•™¥¹¥Ñ¥½¹9½‘•%¤ì(€€€€€¥˜€ …‘•™¥¹¥Ñ¥½¹9½‘”ñğ‘•™¥¹¥Ñ¥½¹9½‘”¹‰±½­%€„ôô¹½‘”¹‰±½­%¤½¹Ñ¥¹Õ”ì(€€€€€½¹ÍĞ‘•™¥¹¥Ñ¥½¹A½Í¥Ñ¥½¸€ôÁ½Í¥Ñ¥½¹Ì¹•Ğ¡‘•™¥¹¥Ñ¥½¹9½‘”¹¥¤ì(€€€€€¥˜€¡‘•™¥¹¥Ñ¥½¹A½Í¥Ñ¥½¸€„ô¹Õ±°€˜˜‘•™¥¹¥Ñ¥½¹A½Í¥Ñ¥½¸€øôÁ½Í¥Ñ¥½¹Ì¹•Ğ¡¹½‘”¹¥¤¤ì(€€€€€€€™…¥° Í•µ…¹Ñ¥Œµ¥ÈµÙ…±Õ”µÕÍ”µ‰•™½É”µ‘•™¥¹¥Ñ¥½¸µ¥¸µ‰±½¬œ¤ì(€€€€€ô(€€€ô(€€€™½È€¡½¹ÍĞ¥½˜¹½‘”¹½ÕÑÁÕÑÌ¤ì(€€€€€½¹ÍĞÙ…±Õ”€ôÙ…±Õ•	å%¹•Ğ¡¥¤ì(€€€€€¥˜€ …Ù…±Õ”¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ‘…¹±¥¹œµÙ…±Õ”µ¥œ¤ì(€€€€€¥˜€¡Ù…±Õ”¹­¥¹€„ôô€‘•™¥¹¥Ñ¥½¸œñğÙ…±Õ”¹‘•™¥¹¥Ñ¥½¹9½‘•%€„ôô¹½‘”¹¥¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ½ÕÑÁÕĞµ‘•™¥¹¥Ñ¥½¸µµ¥Íµ…Ñ œ¤ì(€€€ô(€€€¥˜€¡¹½‘”¹­¥¹€ôôô€é•áĞœñğ¹½‘”¹­¥¹€ôôô€Í•áĞœ¤ì(€€€€€€¼¼…¹½¹¥…°•áÑ•¹Í¥½¸ÑåÁ”É•±…Ñ¥½¸€ ŒĞÔÜØ¤è„é•áĞ½Í•áĞµ…ä•á¥ÍĞ…Ì„(€€€€€€¼¼…¹½¹¥…°•á…Ğ½Á•É…Ñ¥½¸½¹±äİ¡•¸¥ÑÌ‘•±…É•Í½ÕÉ”½Ñ…É•Ğİ¥‘Ñ¡Ì(€€€€€€¼¼•ÅÕ…°Ñ¡”µ…¡¥¹”ÑåÁ•Ì½¸‰½Ñ Í¥‘•Ì¸Q¡¥Ì¥ÌÑ¡”¹½¸µ‰åÁ…ÍÍ…‰±”(€€€€€€¼¼‰½Õ¹‘…Éä¡•¬ìÑ¡”±½İ•É¥¹œµÍ¥‘”Õ…ÉÍÑ…åÌ…Ì‘•™•¹Í”¥¸‘•ÁÑ ¸(€€€€€½¹ÍĞ™É½µ	¥ÑÌ€ôÁ½Í¥Ñ¥Ù•%¹Ñ••È¡¹½‘”¹…ÑÑÉ¥‰ÕÑ•Ìü¹™É½µ	¥ÑÌ°€Í•µ…¹Ñ¥Œµ¥Èµ•áÑ•¹Í¥½¸µİ¥‘Ñ µ…ÑÑÉ¥‰ÕÑ•ÌµÉ•ÅÕ¥É•œ¤ì(€€€€€½¹ÍĞÑ½	¥ÑÌ€ôÁ½Í¥Ñ¥Ù•%¹Ñ••È¡¹½‘”¹…ÑÑÉ¥‰ÕÑ•Ìü¹Ñ½	¥ÑÌ°€Í•µ…¹Ñ¥Œµ¥Èµ•áÑ•¹Í¥½¸µİ¥‘Ñ µ…ÑÑÉ¥‰ÕÑ•ÌµÉ•ÅÕ¥É•œ¤ì(€€€€€¥˜€¡Ñ½	¥ÑÌ€ğ™É½µ	¥ÑÌ¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ•áÑ•¹Í¥½¸µİ¥‘Ñ µÉ•±…Ñ¥½¸µ¥¹Ù…±¥œ¤ì(€€€€€¥˜€¡¹½‘”¹¥¹ÁÕÑÌ¹±•¹Ñ €„ôô€Äñğ¹½‘”¹½ÕÑÁÕÑÌ¹±•¹Ñ €„ôô€Ä¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ•áÑ•¹Í¥½¸µ½Á•É…¹µ½Õ¹Ğµ¥¹Ù…±¥œ¤ì(€€€€€½¹ÍĞ•áÑ•¹Í¥½¹%¹ÁÕĞ€ôÙ…±Õ•	å%¹•Ğ¡¹½‘”¹¥¹ÁÕÑÍlÁt¤ì(€€€€€½¹ÍĞ•áÑ•¹Í¥½¹=ÕÑÁÕĞ€ôÙ…±Õ•	å%¹•Ğ¡¹½‘”¹½ÕÑÁÕÑÍlÁt¤ì(€€€€€¥˜€ …•áÑ•¹Í¥½¹%¹ÁÕĞñğ€…•áÑ•¹Í¥½¹=ÕÑÁÕĞ¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ‘…¹±¥¹œµÙ…±Õ”µ¥œ¤ì(€€€€€¥˜€¡•áÑ•¹Í¥½¹%¹ÁÕĞ¹µ…¡¥¹•QåÁ”¹İ¥‘Ñ¡	¥ÑÌ€„ôô™É½µ	¥ÑÌ¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ•áÑ•¹Í¥½¸µ¥¹ÁÕĞµİ¥‘Ñ µµ¥Íµ…Ñ œ¤ì(€€€€€¥˜€¡•áÑ•¹Í¥½¹=ÕÑÁÕĞ¹µ…¡¥¹•QåÁ”¹İ¥‘Ñ¡	¥ÑÌ€„ôôÑ½	¥ÑÌ¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ•áÑ•¹Í¥½¸µ½ÕÑÁÕĞµİ¥‘Ñ µµ¥Íµ…Ñ œ¤ì(€€€ô(€€€¥˜€¡¹½‘”¹µ•µ½Éä€˜˜€…Ù…±Õ•	å%¹¡…Ì¡¹½‘”¹µ•µ½Éä¹…‘‘É•ÍÍáÁÈ¹Ù…±Õ•%¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ‘…¹±¥¹œµ…‘‘É•ÍÌµÙ…±Õ”µ¥œ¤ì(€€€¥˜€¡¹½‘”¹…±°¤ì(€€€€€¥˜€ ……±±%¹ÁÕÑÍ5…Ñ¡9½‘”¡¹½‘”¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ…±°µ¥¹ÁÕĞµµ¥Íµ…Ñ œ¤ì(€€€€€¥˜€ …Í…µ•MÑÉ¥¹M•ÅÕ•¹”¡¹½‘”¹½ÕÑÁÕÑÌ°¹½‘”¹…±°¹É•ÑÕÉ¹Ì¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ…±°µ½ÕÑÁÕĞµµ¥Íµ…Ñ œ¤ì(€€€€€™½È€¡½¹ÍĞ¥½˜l¸¸¹¹½‘”¹…±°¹Ñ…É•ÑY…±Õ•%‘Ì°€¸¸¹¹½‘”¹…±°¹…ÉÕµ•¹ÑÌ°€¸¸¹¹½‘”¹…±°¹É•ÑÕÉ¹Ít¤ì(€€€€€€€¥˜€ …Ù…±Õ•	å%¹¡…Ì¡¥¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ‘…¹±¥¹œµ…±°µÙ…±Õ”µ¥œ¤ì(€€€€€ô(€€€€€™½È€¡½¹ÍĞÍ½Á”½˜m¹½‘”¹…±°¹µ•µ½ÉåI•…°¹½‘”¹…±°¹µ•µ½Éå]É¥Ñ•t¤ì(€€€€€€€™½È€¡½¹ÍĞ…•ÍÌ½˜Í½Á”¹…•ÍÍ•Ì€üümt¤ì(€€€€€€€€€¥˜€ …Ù…±Õ•	å%¹¡…Ì¡…•ÍÌ¹…‘‘É•ÍÍáÁÈ¹Ù…±Õ•%¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ‘…¹±¥¹œµ…‘‘É•ÍÌµÙ…±Õ”µ¥œ¤ì(€€€€€€€ô(€€€€€ô(€€€ô(€€€¥˜€¡¹½‘”¹¥¹ÑÉ¥¹Í¥Œ¤ì(€€€€€¥˜€ …Í…µ•MÑÉ¥¹M•ÅÕ•¹”¡¹½‘”¹¥¹ÁÕÑÌ°¹½‘”¹¥¹ÑÉ¥¹Í¥Œ¹¥¹ÁÕÑÌ¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ¥¹ÑÉ¥¹Í¥Œµ¥¹ÁÕĞµµ¥Íµ…Ñ œ¤ì(€€€€€¥˜€ …Í…µ•MÑÉ¥¹M•ÅÕ•¹”¡¹½‘”¹½ÕÑÁÕÑÌ°¹½‘”¹¥¹ÑÉ¥¹Í¥Œ¹½ÕÑÁÕÑÌ¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ¥¹ÑÉ¥¹Í¥Œµ½ÕÑÁÕĞµµ¥Íµ…Ñ œ¤ì(€€€€€™½È€¡½¹ÍĞ¥½˜l¸¸¹¹½‘”¹¥¹ÑÉ¥¹Í¥Œ¹¥¹ÁÕÑÌ°€¸¸¹¹½‘”¹¥¹ÑÉ¥¹Í¥Œ¹½ÕÑÁÕÑÍt¤ì(€€€€€€€¥˜€ …Ù…±Õ•	å%¹¡…Ì¡¥¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ‘…¹±¥¹œµ¥¹ÑÉ¥¹Í¥ŒµÙ…±Õ”µ¥œ¤ì(€€€€€ô(€€€€€™½È€¡½¹ÍĞÍ½Á”½˜m¹½‘”¹¥¹ÑÉ¥¹Í¥Œ¹µ•µ½ÉåI•…°¹½‘”¹¥¹ÑÉ¥¹Í¥Œ¹µ•µ½Éå]É¥Ñ•t¤ì(€€€€€€€™½È€¡½¹ÍĞ…•ÍÌ½˜Í½Á”¹…•ÍÍ•Ì€üümt¤ì(€€€€€€€€€¥˜€ …Ù…±Õ•	å%¹¡…Ì¡…•ÍÌ¹…‘‘É•ÍÍáÁÈ¹Ù…±Õ•%¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ‘…¹±¥¹œµ…‘‘É•ÍÌµÙ…±Õ”µ¥œ¤ì(€€€€€€€ô(€€€€€ô(€€€ô(€€€™½È€¡½¹ÍĞÑ…É•Ğ½˜¹½‘”¹Ñ…É•ÑÌ¤¥˜€ …‰±½­	å%¹¡…Ì¡Ñ…É•Ğ¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ¥¹Ù…±¥µ½¹ÑÉ½°µÑ…É•Ğœ¤ì(€ô((€™½È€¡½¹ÍĞÙ…±Õ”½˜½ÕĞ¹Ù…±Õ•Ì¤ì(€€€¥˜€¡Ù…±Õ”¹‘•™¥¹¥Ñ¥½¹9½‘•%€ôô¹Õ±°¤½¹Ñ¥¹Õ”ì(€€€½¹ÍĞ¹½‘”€ô¹½‘•	å%¹•Ğ¡Ù…±Õ”¹‘•™¥¹¥Ñ¥½¹9½‘•%¤ì(€€€¥˜€ …¹½‘”ñğ€…¹½‘”¹½ÕÑÁÕÑÌ¹¥¹±Õ‘•Ì¡Ù…±Õ”¹¥¤¤™…¥° Í•µ…¹Ñ¥Œµ¥ÈµÙ…±Õ”µ‘•™¥¹¥Ñ¥½¸µµ¥Íµ…Ñ œ¤ì(€ô((€€¼¼¹½‘”µ±½…°Õ¹­¹½İ¸Á…å±½…¥Ì•áÁ±¥¥ĞÕ¹­¹½İ¸•Ù¥‘•¹”•Ù•¸½¸…¸(€€¼¼½É‘¥¹…Éä¹½‘”°Í¼¥ĞµÕÍĞ­••ÀÑ¡”™Õ¹Ñ¥½¸™É½´±…¥µ¥¹œ½µÁ±•Ñ•¹•ÍÌ(€€¼¼€¡‘•™•¹Í”¥¸‘•ÁÑ …±½¹Í¥‘”Ñ¡”½¹ÍÑÉÕÑ½ÈÌ½İ¸½¹™±¥Ğ¡•¬ì€ŒÔÌäÀ¤¸(€½¹ÍĞ¡…ÍU¹­¹½İ¹9½‘”€ô½ÕĞ¹¹½‘•Ì¹Í½µ” ¡¹½‘”¤€ôøM59Q%}MQL¹Õ¹­¹½İ¹=Á•É…Ñ¥½¹Ì¹¡…Ì¡¹½‘”¹­¥¹¤ñğ¹½‘”¹½µÁ±•Ñ•¹•ÍÌ€„ôô€½µÁ±•Ñ”œñğ¹½‘”¹Õ¹­¹½İ¸€„ô¹Õ±°¤ì(€¥˜€¡½ÕĞ¹½µÁ±•Ñ•¹•ÍÌ€ôôô€½µÁ±•Ñ”œ€˜˜€¡¡…ÍU¹­¹½İ¹9½‘”ñğ½ÕĞ¹Õ¹­¹½İ¹Ì¹±•¹Ñ ¤¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ½µÁ±•Ñ•¹•ÍÌµ½¹™±¥Ğœ¤ì(€¥˜€¡½ÕĞ¹½µÁ±•Ñ•¹•ÍÌ€„ôô€½µÁ±•Ñ”œ€˜˜½ÕĞ¹Õ¹­¹½İ¹Ì¹±•¹Ñ €ôôô€À¤™…¥° Í•µ…¹Ñ¥Œµ¥Èµ™Õ¹Ñ¥½¸µÕ¹­¹½İ¹ÌµÉ•ÅÕ¥É•œ¤ì)ô()•áÁ½ÉĞ™Õ¹Ñ¥½¸É•…Ñ•M•µ…¹Ñ¥%ÉÕ¹Ñ¥½¸¡¥¹ÁÕĞ°½ÁÑ¥½¹Ì€ôíô¤ì(€…ÍÍ•ÉÑ9½Ñ‰½ÉÑ•¡½ÁÑ¥½¹Ì¤ì(€¥¹ÁÕĞ€ô½‰©•Ğ¡¥¹ÁÕĞ°€Í•µ…¹Ñ¥Œµ¥Èµ¥¹Ù…±¥µ™Õ¹Ñ¥½¸œ¤ì(€…ÍÍ•ÉÑ±±½İ•‘-•åÌ¡¥¹ÁÕĞ°¹•ÜM•Ğ¡l(€€€€Í¡•µ…Y•ÉÍ¥½¸œ°€½¹ÑÉ…ÑY•ÉÍ¥½¸œ°€™Õ¹Ñ¥½¹%œ°€•¹ÑÉå	±½­%œ°€‰±½­Ìœ°€Ù…±Õ•Ìœ°€¹½‘•Ìœ°(€€€€½µÁ±•Ñ•¹•ÍÌœ°€Õ¹­¹½İ¹Ìœ°€½É¥¥¸œ°(€t¤°€Í•µ…¹Ñ¥Œµ¥ÈµÕ¹•áÁ•Ñ•µ™Õ¹Ñ¥½¸µ™¥•±œ¤ì(€…ÍÍ•ÉÑY•ÉÍ¥½¸¡¥¹ÁÕĞ¤ì(€½¹ÍĞÉ•™•É•¹•I•…‘Ì€ô¹•Ü]•…­5…À ¤ì(€½¹ÍĞÉ…İ	±½­Ì€ô…¡•I•™•É•¹•I•…‘Ì¡…ÉÉ…ä¡¥¹ÁÕĞ¹‰±½­Ì°€Í•µ…¹Ñ¥Œµ¥Èµ‰±½­ÌµÉ•ÅÕ¥É•œ¤°É•™•É•¹•I•…‘Ì¤ì(€½¹ÍĞÉ…İY…±Õ•Ì€ô…¡•I•™•É•¹•I•…‘Ì¡…ÉÉ…ä¡¥¹ÁÕĞ¹Ù…±Õ•Ì°€Í•µ…¹Ñ¥Œµ¥ÈµÙ…±Õ•ÌµÉ•ÅÕ¥É•œ¤°É•™•É•¹•I•…‘Ì¤ì(€½¹ÍĞÉ…İ9½‘•Ì€ô…¡•I•™•É•¹•I•…‘Ì¡…ÉÉ…ä¡¥¹ÁÕĞ¹¹½‘•Ì°€Í•µ…¹Ñ¥Œµ¥Èµ¹½‘•ÌµÉ•ÅÕ¥É•œ¤°É•™•É•¹•I•…‘Ì¤ì(€…ÍÍ•ÉÑ]¥Ñ¡¥¹	Õ‘•Ğ¡É…İ	±½­Ì¹±•¹Ñ °½ÁÑ¥½¹Ì°€µ…á	±½­Ìœ¤ì(€…ÍÍ•ÉÑ]¥Ñ¡¥¹	Õ‘•Ğ¡É…İY…±Õ•Ì¹±•¹Ñ °½ÁÑ¥½¹Ì°€µ…áY…±Õ•Ìœ¤ì(€…ÍÍ•ÉÑ]¥Ñ¡¥¹	Õ‘•Ğ¡É…İ9½‘•Ì¹±•¹Ñ °½ÁÑ¥½¹Ì°€µ…á9½‘•Ìœ¤ì(€€¼¼AÉ•™±¥¡ĞÑ¡”½µÁ±•Ñ”É•™•É•¹”‘•¹½µ¥¹…Ñ½È‰•™½É”¹•ÍÑ•¹½Éµ…±¥é…Ñ¥½¸¸(€…ÍÍ•ÉÑ]¥Ñ¡¥¹	Õ‘•Ğ¡½Õ¹ÑI…İI•™•É•¹•Ì¡É…İ	±½­Ì°É…İY…±Õ•Ì°É…İ9½‘•Ì°É•™•É•¹•I•…‘Ì¤°½ÁÑ¥½¹Ì°€µ…áI•™•É•¹•Ìœ¤ì((€€¼¼¥á•UQ´ÄØ½‘”µÕ¹¥Ğ½É‘•È­••ÁÌ…¹½¹¥…°Í•É¥…±¥é…Ñ¥½¸±½…±”¥¹‘•Á•¹‘•¹Ğ€ ŒÔÜØÔ¤¸(€½¹ÍĞ½µÁ…É•½‘•U¹¥Ğ€ô€¡„°ˆ¤€ôø€¡„€ğˆ€ü€´Ä€è„€øˆ€ü€Ä€è€À¤ì(€½¹ÍĞ½ÕĞ€ôì(€€€Í¡•µ…Y•ÉÍ¥½¸èM59Q%}%I}M!5}YIM%=8°(€€€½¹ÑÉ…ÑY•ÉÍ¥½¸èM59Q%}%I}=9QIQ}YIM%=8°(€€€™Õ¹Ñ¥½¹%è¹½¹µÁÑä¡¥¹ÁÕĞ¹™Õ¹Ñ¥½¹%°€Í•µ…¹Ñ¥Œµ¥Èµ™Õ¹Ñ¥½¸µ¥µÉ•ÅÕ¥É•œ¤°(€€€•¹ÑÉå	±½­%è¹½¹µÁÑä¡¥¹ÁÕĞ¹•¹ÑÉå	±½­%°€Í•µ…¹Ñ¥Œµ¥Èµ•¹ÑÉäµ‰±½¬µÉ•ÅÕ¥É•œ¤°(€€€‰±½­ÌèÉ…İ	±½­Ì¹µ…À ¡‰±½¬¤€ôø¹½Éµ…±¥é•	±½¬¡…¡•I•™•É•¹•I•…‘Ì¡‰±½¬°É•™•É•¹•I•…‘Ì¤¤¤¹Í½ÉĞ ¡„°ˆ¤€ôø½µÁ…É•½‘•U¹¥Ğ¡„¹¥°ˆ¹¥¤¤°(€€€Ù…±Õ•ÌèÉ…İY…±Õ•Ì¹µ…À ¡Ù…±Õ”¤€ôøÉ•…Ñ•M•µ…¹Ñ¥Y…±Õ”¡…¡•I•™•É•¹•I•…‘Ì¡Ù…±Õ”°É•™•É•¹•I•…‘Ì¤¤¤¹Í½ÉĞ ¡„°ˆ¤€ôø½µÁ…É•½‘•U¹¥Ğ¡„¹¥°ˆ¹¥¤¤°(€€€¹½‘•ÌèÉ…İ9½‘•Ì¹µ…À ¡¹½‘”¤€ôøÉ•…Ñ•M•µ…¹Ñ¥9½‘”¡…¡•I•™•É•¹•I•…‘Ì¡¹½‘”°É•™•É•¹•I•…‘Ì¤¤¤¹Í½ÉĞ ¡„°ˆ¤€ôø½µÁ…É•½‘•U¹¥Ğ¡„¹¥°ˆ¹¥¤¤°(€€€½µÁ±•Ñ•¹•ÍÌè•¹ÕµY…±Õ”¡¥¹ÁÕĞ¹½µÁ±•Ñ•¹•ÍÌ€üü€½µÁ±•Ñ”œ°M59Q%}MQL¹½µÁ±•Ñ•¹•ÍÌ°€Í•µ…¹Ñ¥Œµ¥Èµ¥¹Ù…±¥µ™Õ¹Ñ¥½¸µ½µÁ±•Ñ•¹•ÍÌœ¤°(€€€Õ¹­¹½İ¹Ìè…ÉÉ…ä¡¥¹ÁÕĞ¹Õ¹­¹½İ¹Ì€üümt°€Í•µ…¹Ñ¥Œµ¥Èµ¥¹Ù…±¥µ™Õ¹Ñ¥½¸µÕ¹­¹½İ¹Ìœ¤(€€€€€€¹µ…À¡¹½Éµ…±¥é•Õ¹Ñ¥½¹U¹­¹½İ¸¤(€€€€€€¹Í½ÉĞ ¡„°ˆ¤€ôø½µÁ…É•½‘•U¹¥Ğ¡ÍÑ…‰±•MÑÉ¥¹¥™ä¡„¤°ÍÑ…‰±•MÑÉ¥¹¥™ä¡ˆ¤¤¤°(€€€½É¥¥¸èÉ•ÅÕ¥É•‘=É¥¥¸¡¥¹ÁÕĞ°€Í•µ…¹Ñ¥Œµ¥Èµ™Õ¹Ñ¥½¸µ½É¥¥¸µÉ•ÅÕ¥É•œ¤°(€ôì(€…ÍÍ•ÉÑ]¥Ñ¡¥¹	Õ‘•Ğ¡½Õ¹ÑI•™•É•¹•Ì¡½ÕĞ¹¹½‘•Ì°½ÕĞ¹Ù…±Õ•Ì°½ÕĞ¹‰±½­Ì¤°½ÁÑ¥½¹Ì°€µ…áI•™•É•¹•Ìœ¤ì(€Ù…±¥‘…Ñ•9½Éµ…±¥é•‘Õ¹Ñ¥½¸¡½ÕĞ°½ÁÑ¥½¹Ì¤ì(€É•ÑÕÉ¸‘••ÁÉ••é”¡½ÕĞ¤ì)ô()•áÁ½ÉĞ™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•M•µ…¹Ñ¥%ÉÕ¹Ñ¥½¸¡¥¹ÁÕĞ°½ÁÑ¥½¹Ì€ôíô¤ì(€É•ÑÕÉ¸É•…Ñ•M•µ…¹Ñ¥%ÉÕ¹Ñ¥½¸¡¥¹ÁÕĞ°½ÁÑ¥½¹Ì¤ì)ô()•áÁ½ÉĞ™Õ¹Ñ¥½¸…¹½¹¥…±M•É¥…±¥é•M•µ…¹Ñ¥%È¡¥¹ÁÕĞ°½ÁÑ¥½¹Ì€ôíô¤ì(€É•ÑÕÉ¸ÍÑ…‰±•MÑÉ¥¹¥™ä¡É•…Ñ•M•µ…¹Ñ¥%ÉÕ¹Ñ¥½¸¡¥¹ÁÕĞ°½ÁÑ¥½¹Ì¤¤ì)ô(