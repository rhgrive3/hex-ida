/**
 * js/symbolic/translate/semantic-ir.js
 *
 * Architecture-neutral translator from Semantic IR / SSA to solver-neutral Expr DAG.
 * Preserves provenance, origin mappings, and explicit assumptions.
 * Guarantees fail-closed behavior on unknown semantics and unsupported operations.
 * Never leaks solver-native AST objects.
 */

import { OP, VK, MK } from '../../ir-base.js';
import {
  bvSort,
  boolSort,
  BV_UNARY_OP,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BOOL_CONNECTIVE_OP,
  CAST_OP,
} from '../expr/kinds.js';
import {
  createBool,
  createBv,
  createFreshSymbol,
  createUnknownSemantic,
  createUnary,
  createBinary,
  createCompare,
  createConnective,
  createIte,
  createExtract,
  createConcat,
  createCast,
} from '../expr/factory.js';
import { computeStructuralHash } from '../expr/hash.js';
import {
  TRANSLATION_STATUS,
  ASSUMPTION_TRUST,
  COMPLETENESS_STATUS,
  createAssumption,
  createCompleteness,
  classifyOpSupport,
} from './support-matrix.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from '../../semantics/memoryssa/queries.js';
import {
  ByteMemory,
  createByteMemory,
  readCanonicalMemory,
  MEMORY_RESULT_STATUS,
} from '../memory/byte-memory.js';
import { TaintStore, taintExpression } from '../taint/flow.js';
import { taintDigest } from '../taint/lattice.js';

export function translateSemanticIR(target, options = {}) {
  const ir = options.ir || null;
  const defaultWidth = typeof options.bitWidth === 'number' ? (options.bitWidth || 64) : 64;
  const fromBlock = options.fromBlock != null ? options.fromBlock : null;
  const configuredArgs = options.symbolicArgs || {};

  const assumptions = [];
  const unsupportedEntities = [];
  let semanticUnknowns = 0;
  const originMap = new Map(); // expr hash / sym id -> Set of origins
  const memo = new Map();
  const active = new Set();
  const byteMemoryEnabled = options.symbolicMemory === true
    || options.strictMemory === true
    || options.memoryMode === 'byte'
    || options.memoryModel === 'byte'
    || options.symbolicMemory instanceof ByteMemory
    || (options.symbolicMemory && typeof options.symbolicMemory === 'object' && !Array.isArray(options.symbolicMemory))
    || options.byteMemory != null
    || options.memory instanceof ByteMemory
    || options.memoryInitial != null
    || options.memorySsa != null;
  let byteMemory = null;
  if (byteMemoryEnabled) {
    if (options.byteMemory instanceof ByteMemory) byteMemory = options.byteMemory.clone();
    else if (options.symbolicMemory instanceof ByteMemory) byteMemory = options.symbolicMemory.clone();
    else if (options.memory instanceof ByteMemory) byteMemory = options.memory.clone();
    else {
      const config = options.byteMemory && typeof options.byteMemory === 'object' && !Array.isArray(options.byteMemory)
        ? { ...options.byteMemory }
        : options.symbolicMemory && typeof options.symbolicMemory === 'object' && !(options.symbolicMemory instanceof ByteMemory) && !Array.isArray(options.symbolicMemory)
          ? { ...options.symbolicMemory }
        : options.memory && typeof options.memory === 'object' && !(options.memory instanceof Map) && !Array.isArray(options.memory)
          ? { ...options.memory }
          : {};
      const initial = config.initial ?? config.bytes ?? options.memoryInitial
        ?? (options.byteMemory instanceof Map ? options.byteMemory : null)
        ?? (options.symbolicMemory instanceof Map ? options.symbolicMemory : null)
        ?? (options.memory instanceof Map || (options.memory && typeof options.memory === 'object' && !(options.memory instanceof ByteMemory) && !Array.isArray(options.memory)) ? options.memory : null);
      byteMemory = createByteMemory({
        ...config,
        ...(initial != null ? { initial } : {}),
        signal: options.signal ?? config.signal ?? null,
        isCancelled: options.isCancelled ?? (() => false),
      });
    }
  }

  function recordOrigin(node, ...origins) {
    if (!node) return;
    const key = node.symbolId || computeStructuralHash(node);
    if (!originMap.has(key)) originMap.set(key, new Set());
    const set = originMap.get(key);
    for (const o of origins) {
      if (o != null) set.add(String(o));
    }
  }

  function memoryWidthBits(inst) {
    const candidates = [
      inst?.extra?.widthBits,
      inst?.extra?.memoryAccess?.widthBits,
      inst?.widthBits,
      inst?.extra?.size != null ? Number(inst.extra.size) * 8 : null,
      inst?.loc?.size != null ? Number(inst.loc.size) * 8 : null,
      inst?.addr?.size != null ? Number(inst.addr.size) * 8 : null,
      inst?.dst?.bits,
      defaultWidth,
    ];
    return candidates.find((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value % 8 === 0) || 8;
  }

  function memoryEndian(inst) {
    const candidates = [
      inst?.extra?.memoryAccess?.endian,
      inst?.extra?.endian,
      inst?.memoryAccess?.endian,
      inst?.endian,
      options.memoryEndian,
      options.endian,
      'little',
    ];
    return candidates.find((value) => value === 'little' || value === 'big') || 'little';
  }

  function memoryQualifiers(inst) {
    const access = inst?.extra?.memoryAccess ?? inst?.memoryAccess ?? {};
    return {
      volatile: inst?.volatile === true || inst?.extra?.volatile === true || access.volatile === true || access.isVolatile === true,
      atomic: inst?.atomic === true || inst?.extra?.atomic === true || access.atomic === true || access.isAtomic === true,
      barrier: inst?.barrier === true || inst?.extra?.barrier === true || access.barrier === true,
      ordering: inst?.ordering ?? inst?.extra?.ordering ?? access.ordering ?? null,
    };
  }

  function memoryAddress(inst, width = defaultWidth) {
    const addr = inst?.addr;
    if (addr?.base) {
      let expression = translateValue(addr.base, width);
      if (addr.index) {
        const index = translateValue(addr.index, width);
        const scale = typeof addr.scale === 'number' && Number.isSafeInteger(addr.scale) && addr.scale > 0 ? addr.scale : 0;
        const offset = scale > 0 ? createBinary(BV_BINARY_OP.SHL, index, createBv(width, BigInt(scale))) : index;
        expression = createBinary(BV_BINARY_OP.ADD, expression, offset);
      }
      let displacement = 0n;
      try { displacement = addr.disp == null ? 0n : BigInt(addr.disp); } catch {
        return createUnknownSemantic(bvSort(width), 'malformed-memory-displacement', { instructionId: inst?.id ?? null });
      }
      if (displacement !== 0n) expression = createBinary(BV_BINARY_OP.ADD, expression, createBv(expression.sort.width, displacement));
      return expression;
    }
    if (inst?.loc?.address != null) {
      try { return createBv(width, BigInt(inst.loc.address)); } catch { /* explicit unknown below */ }
    }
    const key = inst?.loc?.key;
    if (key && inst.loc.kind !== MK.UNKNOWN) return createFreshSymbol(bvSort(width), `memory_${key}`, { source: 'symbolic-memory-address', locationKey: key });
    return createUnknownSemantic(bvSort(width), 'unknown-memory-address', { instructionId: inst?.id ?? null });
  }

  function canonicalLoad(inst) {
    const qualifiers = memoryQualifiers(inst);
    if (qualifiers.volatile || qualifiers.atomic || qualifiers.barrier || qualifiers.ordering != null) {
      return {
        status: MEMORY_RESULT_STATUS.UNKNOWN,
        expression: createUnknownSemantic(bvSort(memoryWidthBits(inst)), qualifiers.atomic || qualifiers.ordering != null ? 'atomic-memory-barrier' : 'volatile-memory-barrier'),
      };
    }
    const attached = inst?.memoryForwarding ?? null;
    const context = canonicalMemoryForwardingContextForLoad(attached, inst,
      inst?.memoryForwardingContext ?? inst?.extra?.memoryForwardingContext ?? options.memoryForwardingContext ?? {});
    if (attached != null) {
      if (isCanonicalExactMemoryForwarding(attached, context) && attached.value != null) {
        return { status: MEMORY_RESULT_STATUS.EXACT, expression: createBv(Number(attached.widthBits), attached.value), fact: attached };
      }
      return { status: MEMORY_RESULT_STATUS.UNKNOWN, expression: createUnknownSemantic(bvSort(memoryWidthBits(inst)), attached.reason || 'missing-canonical-memory-proof'), fact: attached };
    }
    if (!options.memorySsa) return null;
    let useId = inst?.memorySsaUseId ?? inst?.extra?.memorySsaUseId ?? inst?.memorySsaUse?.id ?? inst?.extra?.memorySsaUse?.id ?? null;
    const byInstruction = options.memorySsaUseByInstruction ?? options.memorySsaUses ?? null;
    if (useId == null && byInstruction instanceof Map) useId = byInstruction.get(inst?.id) ?? null;
    if (useId == null && byInstruction && typeof byInstruction === 'object') useId = byInstruction[inst?.id] ?? null;
    if (useId == null) {
      const candidates = (options.memorySsa.uses || []).filter((use) => String(use?.sourceEntityId ?? '') === String(inst?.id ?? ''));
      if (candidates.length === 1) useId = candidates[0].id;
    }
    if (useId == null) return { status: MEMORY_RESULT_STATUS.UNKNOWN, expression: createUnknownSemantic(bvSort(memoryWidthBits(inst)), 'memoryssa-use-identity-missing') };
    const queried = readCanonicalMemory(options.memorySsa, useId, {
      context,
      signal: options.signal,
      budget: options.memoryBudget,
      maxIterations: options.memoryMaxIterations,
      ir: options.memoryIr,
      cfg: options.memoryCfg,
      sourceByEntityId: options.sourceByEntityId,
      widthBits: memoryWidthBits(inst),
    });
    return queried.exact
      ? { status: MEMORY_RESULT_STATUS.EXACT, expression: queried.expression, fact: queried.fact }
      : { status: queried.status || MEMORY_RESULT_STATUS.UNKNOWN, expression: queried.expression || createUnknownSemantic(bvSort(memoryWidthBits(inst)), 'canonical-memory-forwarding-not-exact'), fact: queried.fact };
  }

  function translateValue(val, width = defaultWidth) {
    if (!val) {
      semanticUnknowns++;
      const unk = createUnknownSemantic(bvSort(width), 'missing-ssa-value');
      return unk;
    }

    const valId = val.id != null ? String(val.id) : null;
    const memoKey = `${valId || 'anon'}@${fromBlock}@${width}`;
    if (memo.has(memoKey)) return memo.get(memoKey);

    if (valId && active.has(valId)) {
      semanticUnknowns++;
      assumptions.push(
        createAssumption({
          id: `cycle_${valId}`,
          kind: 'phi-cycle-unroll-boundary',
          statement: `Detected recursion/cycle in SSA value ${valId}`,
          source: 'translator',
          originIds: val.origin != null ? [String(val.origin)] : [],
          trust: ASSUMPTION_TRUST.BOUNDED_UNROLL,
        })
      );
      const unk = createUnknownSemantic(bvSort(width), 'ssa-dependency-cycle', { valueId: valId });
      return unk;
    }

    if (valId) active.add(valId);
    let res = null;

    if (val.const != null) {
      res = createBv(width, val.const);
      recordOrigin(res, val.origin, `const:${val.const}`);
    } else if (val.kind === VK.ARG || val.kind === 'arg') {
      const reg = String(val.reg || val.id || 'arg');
      const argIndex = val.index != null ? val.index : (reg.startsWith('x') ? Number(reg.slice(1)) : null);
      let name = `arg_${reg}`;
      let customVal = null;
      if (configuredArgs) {
        if (argIndex != null && configuredArgs[argIndex] !== undefined) customVal = configuredArgs[argIndex];
        else if (configuredArgs[reg] !== undefined) customVal = configuredArgs[reg];
      }
      if (customVal !== null && typeof customVal === 'bigint') {
        res = createBv(width, customVal);
      } else if (customVal !== null && typeof customVal === 'number') {
        // Fail-closed concrete binding: only finite safe integers may become
        // exact BV constants. Fractional/NaN/Infinity/unsafe numbers are
        // caller-supplied garbage that must not crash the translator with a
        // raw BigInt conversion error nor mint as exact evidence.
        if (!Number.isFinite(customVal) || !Number.isSafeInteger(customVal)) {
          semanticUnknowns++;
          unsupportedEntities.push({
            id: valId,
            op: `arg:${reg}`,
            reason: `invalid-numeric-concrete-binding:${String(customVal)}`,
          });
          res = createUnknownSemantic(bvSort(width), 'invalid-numeric-concrete-binding', {
            valueId: valId,
            reg,
            argIndex,
          });
        } else {
          res = createBv(width, BigInt(customVal));
        }
      } else if (typeof customVal === 'string') {
        name = customVal;
        res = createFreshSymbol(bvSort(width), name, { source: 'argument', reg, argIndex });
      } else {
        res = createFreshSymbol(bvSort(width), name, { source: 'argument', reg, argIndex });
      }
      recordOrigin(res, val.origin, `arg:${reg}`);
    } else if (val.def) {
      res = translateInstruction(val.def, width);
      recordOrigin(res, val.origin, val.def.origin, val.def.id ? `inst:${val.def.id}` : null);
    } else {
      // Unresolved value without definition
      semanticUnknowns++;
      unsupportedEntities.push({ id: valId, op: 'unresolved-def', reason: 'value without def' });
      res = createUnknownSemantic(bvSort(width), 'value-without-definition', { valueId: valId });
      recordOrigin(res, val.origin);
    }

    if (valId) active.delete(valId);
    memo.set(memoKey, res);
    return res;
  }

  function translateInstruction(inst, width = defaultWidth) {
    if (!inst) {
      semanticUnknowns++;
      return createUnknownSemantic(bvSort(width), 'missing-instruction');
    }

    const opSupport = classifyOpSupport(inst.op, inst);
    const byteMemoryLoad = byteMemoryEnabled && inst.op === OP.LOAD;
    if (opSupport === TRANSLATION_STATUS.UNSUPPORTED && !byteMemoryLoad) {
      semanticUnknowns++;
      unsupportedEntities.push({ id: inst.id, op: inst.op, reason: 'unsupported-instruction-op' });
      return createUnknownSemantic(bvSort(width), `unsupported-instruction-op-${inst.op}`, {
        instructionId: inst.id,
        op: inst.op,
      });
    }

    switch (inst.op) {
      case OP.CONST: {
        const value = inst.value;
        if (value == null) {
          semanticUnknowns++;
          unsupportedEntities.push({ id: inst.id, op: inst.op, reason: 'missing-constant-value' });
          return createUnknownSemantic(bvSort(width), 'missing-constant-value', { instructionId: inst.id });
        }
        return createBv(width, value);
      }

      case OP.MOV:
      case OP.ADDR: {
        const src = inst.args?.[0]?.value || inst.args?.[0];
        return translateValue(src, width);
      }

      case OP.BIN: {
        const subOp = String(inst.subOp || inst.name || 'add').toLowerCase();
        const leftVal = inst.args?.[0]?.value || inst.args?.[0];
        const rightVal = inst.args?.[1]?.value || inst.args?.[1];
        const leftExpr = translateValue(leftVal, width);
        const rightExpr = translateValue(rightVal, width);

        let bvOp = null;
        if (subOp === 'add') bvOp = BV_BINARY_OP.ADD;
        else if (subOp === 'sub') bvOp = BV_BINARY_OP.SUB;
        else if (subOp === 'mul') bvOp = BV_BINARY_OP.MUL;
        else if (subOp === 'and') bvOp = BV_BINARY_OP.AND;
        else if (subOp === 'or' || subOp === 'orr') bvOp = BV_BINARY_OP.OR;
        else if (subOp === 'xor' || subOp === 'eor') bvOp = BV_BINARY_OP.XOR;
        else if (subOp === 'shl') bvOp = BV_BINARY_OP.SHL;
        else if (subOp === 'lshr') bvOp = BV_BINARY_OP.LSHR;
        else if (subOp === 'ashr') bvOp = BV_BINARY_OP.ASHR;
        else if (subOp === 'udiv') bvOp = BV_BINARY_OP.UDIV;
        else if (subOp === 'sdiv') bvOp = BV_BINARY_OP.SDIV;
        else if (subOp === 'urem') bvOp = BV_BINARY_OP.UREM;
        else if (subOp === 'srem') bvOp = BV_BINARY_OP.SREM;

        if (!bvOp) {
          semanticUnknowns++;
          unsupportedEntities.push({ id: inst.id, op: `bin:${subOp}`, reason: 'unsupported-binary-subop' });
          return createUnknownSemantic(bvSort(width), `unsupported-binary-subop-${subOp}`, { instructionId: inst.id });
        }
        return createBinary(bvOp, leftExpr, rightExpr);
      }

      case OP.UN: {
        const subOp = String(inst.subOp || inst.name || 'not').toLowerCase();
        const srcVal = inst.args?.[0]?.value || inst.args?.[0];
        const srcExpr = translateValue(srcVal, width);
        if (subOp === 'not') return createUnary(BV_UNARY_OP.NOT, srcExpr);
        if (subOp === 'neg') return createUnary(BV_UNARY_OP.NEG, srcExpr);
        semanticUnknowns++;
        unsupportedEntities.push({ id: inst.id, op: `un:${subOp}`, reason: 'unsupported-unary-subop' });
        return createUnknownSemantic(bvSort(width), `unsupported-unary-subop-${subOp}`);
      }

      case OP.CMP: {
        const condOp = inst.cond || inst.subOp || '==';
        const isSigned = inst.signed === true;
        const leftVal = inst.args?.[0]?.value || inst.args?.[0];
        const rightVal = inst.args?.[1]?.value || inst.args?.[1];
        const leftExpr = translateValue(leftVal, width);
        const rightExpr = translateValue(rightVal, width);

        let cmpOp = null;
        if (condOp === '==' || condOp === 'eq') cmpOp = BV_COMPARE_OP.EQ;
        else if (condOp === '!=' || condOp === 'ne') cmpOp = BV_COMPARE_OP.NE;
        else if (condOp === '<' || condOp === 'lt') cmpOp = isSigned ? BV_COMPARE_OP.SLT : BV_COMPARE_OP.ULT;
        else if (condOp === '<=' || condOp === 'le') cmpOp = isSigned ? BV_COMPARE_OP.SLE : BV_COMPARE_OP.ULE;
        else if (condOp === '>' || condOp === 'gt') cmpOp = isSigned ? BV_COMPARE_OP.SGT : BV_COMPARE_OP.UGT;
        else if (condOp === '>=' || condOp === 'ge') cmpOp = isSigned ? BV_COMPARE_OP.SGE : BV_COMPARE_OP.UGE;

        if (!cmpOp) {
          semanticUnknowns++;
          unsupportedEntities.push({ id: inst.id, op: `cmp:${condOp}`, reason: 'unsupported-cmp-op' });
          return createUnknownSemantic(boolSort(), `unsupported-cmp-op-${condOp}`);
        }
        return createCompare(cmpOp, leftExpr, rightExpr);
      }

      case OP.SEL: {
        const condExpr = inst.cond ? translateInstruction(inst.cond, width) : createBool(true);
        const thenExpr = translateValue(inst.args?.[0]?.value || inst.args?.[0], width);
        const elseExpr = translateValue(inst.args?.[1]?.value || inst.args?.[1], width);
        return createIte(condExpr, thenExpr, elseExpr);
      }

      case OP.PHI: {
        if (!Array.isArray(inst.incoming) || inst.incoming.length === 0) {
          semanticUnknowns++;
          unsupportedEntities.push({ id: inst.id, op: 'phi', reason: 'phi-without-incoming' });
          return createUnknownSemantic(bvSort(width), 'phi-without-incoming');
        }
        if (fromBlock != null) {
          const hit = inst.incoming.find((inc) => inc.from === fromBlock);
          if (hit && hit.value) {
            return translateValue(hit.value, width);
          }
        }
        if (inst.incoming.length === 1 && inst.incoming[0]?.value) {
          return translateValue(inst.incoming[0].value, width);
        }
        // Unconstrained phi without specific incoming block
        assumptions.push(
          createAssumption({
            id: `phi_unconstrained_${inst.id}`,
            kind: 'phi-branch-merge',
            statement: `PHI node ${inst.id} merged across ${inst.incoming.length} predecessor blocks`,
            source: 'translator',
            originIds: inst.origin != null ? [String(inst.origin)] : [],
            trust: ASSUMPTION_TRUST.QUERY_SCOPE,
          })
        );
        const sym = createFreshSymbol(bvSort(width), `phi_${inst.id}`, { phiInst: inst.id });
        return sym;
      }

      case OP.LOAD: {
        // A structural reachingStore pointer is not a value proof. Only the
        // canonical query capability may turn a load into a concrete solver
        // value; forged/serialized/partial facts stay explicitly unknown.
        const qualifiers = memoryQualifiers(inst);
        if (!qualifiers.volatile && !qualifiers.atomic && !qualifiers.barrier && qualifiers.ordering == null
          && isCanonicalExactMemoryForwarding(
            inst.memoryForwarding,
            canonicalMemoryForwardingContextForLoad(inst.memoryForwarding, inst,
              inst.memoryForwardingContext ?? inst.extra?.memoryForwardingContext),
          )
          && inst.memoryForwarding?.value != null) {
          const value = createBv(width, inst.memoryForwarding.value);
          recordOrigin(value, inst.origin, ...(inst.memoryForwarding.provenance?.sourceEntityIds || []));
          return value;
        }
        if (byteMemoryEnabled) {
          const canonical = canonicalLoad(inst);
          if (canonical?.status === MEMORY_RESULT_STATUS.EXACT && canonical.expression) {
            recordOrigin(canonical.expression, inst.origin, ...(canonical.fact?.provenance?.sourceEntityIds || []));
            return canonical.expression;
          }
          if (canonical) {
            semanticUnknowns++;
            const reason = canonical.expression?.reason || 'canonical-memory-forwarding-not-exact';
            unsupportedEntities.push({ id: inst.id, op: 'load', reason });
            return canonical.expression || createUnknownSemantic(bvSort(memoryWidthBits(inst)), reason, { instructionId: inst.id });
          }
          const loaded = byteMemory?.read(memoryAddress(inst, 64), memoryWidthBits(inst), {
            endian: memoryEndian(inst),
            aliasRelation: inst.memoryAliasRelation ?? inst.extra?.aliasRelation ?? options.memoryAliasRelation ?? null,
            ...qualifiers,
          });
          if (loaded?.status === MEMORY_RESULT_STATUS.EXACT && loaded.expression) {
            recordOrigin(loaded.expression, inst.origin);
            return loaded.expression;
          }
          semanticUnknowns++;
          const reason = loaded?.reason || 'symbolic-memory-read-not-exact';
          unsupportedEntities.push({ id: inst.id, op: 'load', reason });
          return createUnknownSemantic(bvSort(memoryWidthBits(inst)), reason, { instructionId: inst.id });
        }
        semanticUnknowns++;
        const reason = inst.loc && inst.loc.kind !== MK.UNKNOWN
          ? 'missing-canonical-memory-proof'
          : 'unknown-load-alias';
        unsupportedEntities.push({ id: inst.id, op: 'load', reason });
        return createUnknownSemantic(bvSort(width), reason, { instructionId: inst.id });
      }

      default: {
        semanticUnknowns++;
        unsupportedEntities.push({ id: inst.id, op: inst.op, reason: 'unsupported-instruction' });
        return createUnknownSemantic(bvSort(width), `unsupported-instruction-${inst.op}`);
      }
    }
  }

  // Translate entry point
  let rootExpr = null;
  if (target) {
    if (target.op != null) {
      rootExpr = translateInstruction(target, defaultWidth);
    } else if (target.id != null || target.kind != null || target.const != null) {
      rootExpr = translateValue(target, defaultWidth);
    }
  }
  // A missing/untranslatable target must fail closed: reporting no expression
  // as `exact`/complete mints a self-contradictory translation artifact that
  // downstream proof gates would treat as an exact translation (#5499).
  if (!rootExpr) {
    semanticUnknowns++;
    unsupportedEntities.push({ id: target?.id ?? null, op: 'translation-target', reason: 'missing-translation-target' });
  }

  // Determine overall translation status
  let status = TRANSLATION_STATUS.EXACT;
  if (semanticUnknowns > 0 || unsupportedEntities.length > 0) {
    status = TRANSLATION_STATUS.UNSUPPORTED;
  } else if (assumptions.length > 0) {
    status = TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS;
  }

  const completeness = createCompleteness({
    translation: status === TRANSLATION_STATUS.EXACT ? COMPLETENESS_STATUS.COMPLETE : (status === TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS ? COMPLETENESS_STATUS.COMPLETE : COMPLETENESS_STATUS.UNSUPPORTED),
    controlFlow: status === TRANSLATION_STATUS.EXACT ? COMPLETENESS_STATUS.COMPLETE : COMPLETENESS_STATUS.PARTIAL,
    memoryEffects: status === TRANSLATION_STATUS.EXACT ? COMPLETENESS_STATUS.COMPLETE : COMPLETENESS_STATUS.PARTIAL,
    pathCoverage: COMPLETENESS_STATUS.COMPLETE,
    queryScope: COMPLETENESS_STATUS.COMPLETE,
  });

  const serializedOrigins = {};
  for (const [k, set] of originMap.entries()) {
    serializedOrigins[k] = [...set].sort();
  }

  const taintEnabled = options.taint === true || options.taint != null || options.taintSources != null || options.sources != null;
  const translationTaint = taintEnabled
    ? taintExpression(rootExpr, {
      store: options.taint instanceof TaintStore ? options.taint : new TaintStore({
        ...(options.taint && typeof options.taint === 'object' ? options.taint : {}),
        signal: options.signal ?? null,
        isCancelled: options.isCancelled ?? (() => false),
      }),
      sourceByValueId: options.taintSourcesByValueId ?? options.sourceByValueId,
      sourceLabels: options.taintSourceLabels ?? options.sourceLabels,
      sources: options.taintSources ?? options.sources,
      treatArgumentsAsSources: options.treatArgumentsAsSources === true,
      autoSourceMetadata: options.autoSourceMetadata === true,
    })
    : null;

  return Object.freeze({
    status,
    expression: rootExpr,
    assumptions: Object.freeze(assumptions),
    unsupportedEntities: Object.freeze(unsupportedEntities),
    semanticUnknowns,
    originMap: Object.freeze(serializedOrigins),
    completeness,
    memoryModel: byteMemoryEnabled ? 'symbolic-byte-memory-v1' : 'canonical-memoryssa-forwarding',
    taint: translationTaint,
    taintDigest: translationTaint ? taintDigest(translationTaint) : null,
  });
}
