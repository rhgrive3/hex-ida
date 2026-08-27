import { createOriginSet } from '../../core/identity/origin.js';
import { createManagedMethodId, createVMOperationId } from '../shared/identity.js';
import { createVMEffectBudgetTracker, createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';
import { decodeSleb128, decodeSleb128_64, decodeUleb128 } from './parser.js';

function fail(code) { throw new TypeError(code); }

const VALUE_TYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);

function typeBits(type) {
  if (type === 0x7e || type === 0x7c) return 64;
  if (type === 0x7b) return 128;
  return 32;
}

function decodeBlockType(bytecode, pos, wasmModule) {
  if (pos >= bytecode.length) fail('wasm-truncated-blocktype');
  const first = bytecode[pos];
  if (first === 0x40) return { params: [], results: [], nextOffset: pos + 1, kind: 'empty' };
  if (VALUE_TYPES.has(first)) return { params: [], results: [first], nextOffset: pos + 1, kind: 'value' };
  const r = decodeSleb128(bytecode, pos);
  if (r.value < 0 || r.value >= wasmModule.types.length) fail('wasm-invalid-block-type-index');
  const t = wasmModule.types[r.value];
  return { params: t.params.slice(), results: t.results.slice(), nextOffset: r.nextOffset, typeIndex: r.value, kind: 'type-index' };
}

function functionTypeForIndex(wasmModule, funcIndex) {
  const imported = wasmModule.imports.filter((i) => i.desc.kind === 0);
  let typeIndex;
  if (funcIndex < imported.length) typeIndex = imported[funcIndex].desc.typeIndex;
  else {
    const internal = funcIndex - imported.length;
    if (internal < 0 || internal >= wasmModule.functions.length) fail('wasm-invalid-callee-index');
    typeIndex = wasmModule.functions[internal];
  }
  const type = wasmModule.types[typeIndex];
  if (!type) fail('wasm-invalid-callee-type-index');
  return type;
}

export function liftWasmFunction(funcIndex, wasmModule, options = {}) {
  const methodId = createManagedMethodId(wasmModule.moduleId, funcIndex);
  const importedFuncs = wasmModule.imports.filter((i) => i.desc.kind === 0);
  const budget = createVMEffectBudgetTracker(options);

  if (funcIndex < importedFuncs.length) {
    const imp = importedFuncs[funcIndex];
    const type = wasmModule.types[imp.desc.typeIndex];
    if (!type) fail('wasm-invalid-import-type-index');
    budget.chargeOperation();
    budget.chargeValues(type.params.length + type.results.length);
    const bundle = createVMEffectBundle({
      frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, 0), bytecodeOffset: 0, opcode: 0x10,
      mnemonic: 'host_import',
      consumedValues: type.params.map((t, i) => ({ id: `arg_${i}`, bits: typeBits(t), type: t })),
      producedValues: type.results.map((t, i) => ({ id: `result_${i}`, bits: typeBits(t), type: t })),
      callEffects: [{ target: `${imp.module}.${imp.field}`, dispatchKind: 'host-import', unresolved: true }],
      controlEffects: [{ kind: 'return' }],
      completeness: 'partial',
      unknownEffects: [{ category: 'calls', reason: 'host-import-effects-unresolved' }],
    }, options);
    return createVMEffectFunction({ methodId, profileId: wasmModule.vmSpecEdition, frontendId: 'wasm', bundles: [bundle], aggregateCompleteness: 'partial' }, options);
  }

  const internalIdx = funcIndex - importedFuncs.length;
  if (internalIdx < 0 || internalIdx >= wasmModule.functions.length || internalIdx >= wasmModule.codeBodies.length) fail('wasm-invalid-function-index');
  const typeIdx = wasmModule.functions[internalIdx];
  const funcType = wasmModule.types[typeIdx];
  if (!funcType) fail('wasm-invalid-function-type-index');
  const codeBody = wasmModule.codeBodies[internalIdx];
  const bytecode = codeBody.bytecode;
  const drafts = [];
  let pos = 0;
  let opSeq = 0;
  let currentStackHeight = 0;
  let frameSeq = 0;

  const functionFrame = { id: `frame_${frameSeq++}`, kind: 'function', startOffset: 0, bodyOffset: 0, stackHeight: 0, params: [], results: funcType.results.slice(), pendingBranches: [], polymorphic: false, elseSeen: false };
  const controlStack = [functionFrame];

  const currentFrame = () => controlStack[controlStack.length - 1];
  const consume = (count, code = 'wasm-stack-underflow') => {
    if (count <= 0) return;
    if (currentStackHeight < count) {
      if (!currentFrame()?.polymorphic) fail(code);
      currentStackHeight = currentFrame()?.stackHeight ?? 0;
      return;
    }
    currentStackHeight -= count;
  };
  const produce = (count) => { currentStackHeight += count; };
  const markUnreachable = () => {
    const frame = currentFrame();
    if (frame) { frame.polymorphic = true; currentStackHeight = frame.stackHeight; }
  };

  function labelTarget(frame, effect, field = 'targetOffset') {
    if (frame.kind === 'loop') { effect[field] = frame.bodyOffset; return; }
    if (frame.kind === 'function') { effect[field] = null; effect.targetKind = 'function-exit'; return; }
    frame.pendingBranches.push({ effect, field });
  }

  while (pos < bytecode.length) {
    budget.checkpoint();
    budget.chargeOperation();
    const opOffset = pos;
    const opcode = bytecode[pos++];
    opSeq++;
    const opId = createVMOperationId(methodId, opOffset, opSeq);
    let mnemonic = 'unknown';
    let completeness = 'exact';
    const locationReads = [];
    const locationWrites = [];
    const memoryEffects = [];
    const callEffects = [];
    const controlEffects = [];
    const producedValues = [];
    const consumedValues = [];
    const possibleExceptions = [];
    const unknownEffects = [];

    switch (opcode) {
      case 0x00:
        mnemonic = 'unreachable';
        controlEffects.push({ kind: 'trap', reason: 'unreachable' });
        possibleExceptions.push({ kind: 'unreachable-trap', condition: 'always' });
        markUnreachable();
        break;
      case 0x01: mnemonic = 'nop'; break;
      case 0x02: case 0x03: case 0x04: {
        const bt = decodeBlockType(bytecode, pos, wasmModule); pos = bt.nextOffset;
        const kind = opcode === 0x02 ? 'block' : opcode === 0x03 ? 'loop' : 'if';
        mnemonic = kind;
        if (kind === 'if') { consumedValues.push({ id: 'cond', bits: 32 }); consume(1); }
        if (currentStackHeight < bt.params.length && !currentFrame().polymorphic) fail('wasm-stack-underflow-block-params');
        const baseHeight = Math.max(0, currentStackHeight - bt.params.length);
        const frame = { id: `frame_${frameSeq++}`, kind, startOffset: opOffset, bodyOffset: pos, stackHeight: baseHeight, params: bt.params, results: bt.results, pendingBranches: [], polymorphic: false, elseSeen: false, ifEffect: null, elseEffect: null };
        controlStack.push(frame);
        if (kind === 'if') {
          const ce = { kind: 'conditional-branch', targetOffset: null, structured: 'if-false' };
          frame.ifEffect = ce;
          controlEffects.push(ce);
        }
        break;
      }
      case 0x05: {
        mnemonic = 'else';
        const frame = currentFrame();
        if (!frame || frame.kind !== 'if' || frame.elseSeen) fail('wasm-invalid-else');
        if (!frame.polymorphic && currentStackHeight !== frame.stackHeight + frame.results.length) fail('wasm-invalid-if-then-stack');
        frame.elseSeen = true;
        frame.polymorphic = false;
        currentStackHeight = frame.stackHeight + frame.params.length;
        if (frame.ifEffect) frame.ifEffect.targetOffset = pos;
        const ce = { kind: 'branch', targetOffset: null, structured: 'else-join' };
        frame.elseEffect = ce;
        frame.pendingBranches.push({ effect: ce, field: 'targetOffset' });
        controlEffects.push(ce);
        break;
      }
      case 0x0b: {
        mnemonic = 'end';
        const frame = controlStack.pop();
        if (!frame) fail('wasm-unmatched-end');
        if (!frame.polymorphic && currentStackHeight !== frame.stackHeight + frame.results.length) fail('wasm-invalid-block-result-stack');
        const continuation = pos;
        frame.endOffset = opOffset;
        frame.continuationOffset = continuation;
        for (const pending of frame.pendingBranches) pending.effect[pending.field] = continuation;
        if (frame.kind === 'if' && frame.ifEffect && !frame.elseSeen) frame.ifEffect.targetOffset = continuation;
        if (frame.kind === 'function') {
          if (pos !== bytecode.length) fail('wasm-trailing-bytes-after-function-end');
          if (!frame.polymorphic && funcType.results.length) {
            for (let i = funcType.results.length - 1; i >= 0; i--) consumedValues.push({ id: `return_${i}`, bits: typeBits(funcType.results[i]), type: funcType.results[i] });
            currentStackHeight -= funcType.results.length;
          }
          controlEffects.push({ kind: 'return' });
        } else {
          currentStackHeight = frame.stackHeight + frame.results.length;
          const parent = currentFrame();
          if (parent?.polymorphic) parent.polymorphic = false;
        }
        break;
      }
      case 0x0c: case 0x0d: {
        const lr = decodeUleb128(bytecode, pos); pos = lr.nextOffset;
        if (lr.value >= controlStack.length) fail('wasm-invalid-branch-depth');
        const targetFrame = controlStack[controlStack.length - 1 - lr.value];
        mnemonic = opcode === 0x0c ? 'br' : 'br_if';
        if (opcode === 0x0d) { consumedValues.push({ id: 'cond', bits: 32 }); consume(1); }
        const ce = { kind: opcode === 0x0c ? 'branch' : 'conditional-branch', targetOffset: null, labelIdx: lr.value };
        labelTarget(targetFrame, ce);
        controlEffects.push(ce);
        if (opcode === 0x0c) markUnreachable();
        break;
      }
      case 0x0e: {
        const cr = decodeUleb128(bytecode, pos); pos = cr.nextOffset;
        const labelDepths = [];
        for (let i = 0; i < cr.value; i++) { const r = decodeUleb128(bytecode, pos); pos = r.nextOffset; labelDepths.push(r.value); }
        const dr = decodeUleb128(bytecode, pos); pos = dr.nextOffset;
        labelDepths.push(dr.value);
        for (const depth of labelDepths) if (depth >= controlStack.length) fail('wasm-invalid-branch-depth');
        mnemonic = 'br_table';
        consumedValues.push({ id: 'index', bits: 32 }); consume(1);
        const ce = { kind: 'switch', targetOffsets: new Array(labelDepths.length - 1).fill(null), defaultTargetOffset: null, labelDepths: labelDepths.slice(0, -1), defaultLabelDepth: labelDepths.at(-1) };
        for (let i = 0; i < labelDepths.length - 1; i++) labelTarget(controlStack[controlStack.length - 1 - labelDepths[i]], ce, `__case_${i}`);
        const defFrame = controlStack[controlStack.length - 1 - labelDepths.at(-1)];
        const defHolder = { kind: 'branch', targetOffset: null }; labelTarget(defFrame, defHolder); ce.__defaultHolder = defHolder;
        controlEffects.push(ce);
        markUnreachable();
        break;
      }
      case 0x0f:
        mnemonic = 'return';
        for (let i = funcType.results.length - 1; i >= 0; i--) consumedValues.push({ id: `return_${i}`, bits: typeBits(funcType.results[i]), type: funcType.results[i] });
        consume(funcType.results.length, 'wasm-stack-underflow-return');
        controlEffects.push({ kind: 'return' });
        markUnreachable();
        break;
      case 0x10: {
        const r = decodeUleb128(bytecode, pos); pos = r.nextOffset;
        const calleeType = functionTypeForIndex(wasmModule, r.value);
        mnemonic = 'call';
        for (let i = calleeType.params.length - 1; i >= 0; i--) consumedValues.push({ id: `arg_${i}`, bits: typeBits(calleeType.params[i]), type: calleeType.params[i] });
        consume(calleeType.params.length, 'wasm-stack-underflow-call');
        for (let i = 0; i < calleeType.results.length; i++) producedValues.push({ id: `result_${i}`, bits: typeBits(calleeType.results[i]), type: calleeType.results[i] });
        produce(calleeType.results.length);
        callEffects.push({ targetIndex: r.value, target: `func_${r.value}`, dispatchKind: 'direct', signature: { params: calleeType.params, results: calleeType.results } });
        break;
      }
      case 0x11: {
        const tr = decodeUleb128(bytecode, pos); pos = tr.nextOffset;
        const type = wasmModule.types[tr.value]; if (!type) fail('wasm-invalid-call-indirect-type-index');
        const table = decodeUleb128(bytecode, pos); pos = table.nextOffset;
        const importedTables = wasmModule.imports.filter((i) => i.desc.kind === 1).length;
        if (table.value >= importedTables + wasmModule.tables.length) fail('wasm-invalid-call-indirect-table-index');
        mnemonic = 'call_indirect';
        consumedValues.push({ id: 'func_index', bits: 32 });
        for (let i = type.params.length - 1; i >= 0; i--) consumedValues.push({ id: `arg_${i}`, bits: typeBits(type.params[i]), type: type.params[i] });
        consume(1 + type.params.length, 'wasm-stack-underflow-call-indirect');
        for (let i = 0; i < type.results.length; i++) producedValues.push({ id: `result_${i}`, bits: typeBits(type.results[i]), type: type.results[i] });
        produce(type.results.length);
        callEffects.push({ typeIndex: tr.value, tableIndex: table.value, dispatchKind: 'indirect', unresolved: true, signature: { params: type.params, results: type.results } });
        break;
      }
      case 0x1a: mnemonic = 'drop'; consumedValues.push({ id: 'top' }); consume(1); break;
      case 0x1b:
        mnemonic = 'select'; consumedValues.push({ id: 'cond', bits: 32 }, { id: 'val2' }, { id: 'val1' }); consume(3); producedValues.push({ bits: 32 }); produce(1); break;
      case 0x20: {
        const r = decodeUleb128(bytecode, pos); pos = r.nextOffset;
        const localTypes = [...funcType.params, ...codeBody.locals];
        if (r.value >= localTypes.length) fail('wasm-invalid-local-index');
        const t = localTypes[r.value]; mnemonic = 'local.get'; locationReads.push({ kind: 'local', index: r.value, bits: typeBits(t), type: t }); producedValues.push({ bits: typeBits(t), type: t, fromLocationRead: 0 }); produce(1); break;
      }
      case 0x21: case 0x22: {
        const r = decodeUleb128(bytecode, pos); pos = r.nextOffset;
        const localTypes = [...funcType.params, ...codeBody.locals]; if (r.value >= localTypes.length) fail('wasm-invalid-local-index');
        const t = localTypes[r.value]; mnemonic = opcode === 0x21 ? 'local.set' : 'local.tee';
        consumedValues.push({ id: 'value', bits: typeBits(t), type: t }); consume(1); locationWrites.push({ kind: 'local', index: r.value, bits: typeBits(t), type: t });
        if (opcode === 0x22) { producedValues.push({ bits: typeBits(t), type: t, forwardedConsumedIndex: 0 }); produce(1); }
        break;
      }
      case 0x23: case 0x24: {
        const r = decodeUleb128(bytecode, pos); pos = r.nextOffset;
        const importedGlobals = wasmModule.imports.filter((i) => i.desc.kind === 3);
        const globals = [...importedGlobals.map((i) => i.desc), ...wasmModule.globals]; if (r.value >= globals.length) fail('wasm-invalid-global-index');
        const t = globals[r.value].valType;
        if (opcode === 0x23) { mnemonic = 'global.get'; locationReads.push({ kind: 'global', index: r.value, bits: typeBits(t), type: t }); producedValues.push({ bits: typeBits(t), type: t, fromLocationRead: 0 }); produce(1); }
        else { mnemonic = 'global.set'; if (!globals[r.value].mutable) fail('wasm-write-immutable-global'); consumedValues.push({ id: 'value', bits: typeBits(t), type: t }); consume(1); locationWrites.push({ kind: 'global', index: r.value, bits: typeBits(t), type: t }); }
        break;
      }
      case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d: case 0x2e: case 0x2f: {
        const ar = decodeUleb128(bytecode, pos); pos = ar.nextOffset; const or = decodeUleb128(bytecode, pos); pos = or.nextOffset;
        const bits = (opcode === 0x29 || opcode === 0x2b) ? 64 : 32; const byteWidth = opcode === 0x2c || opcode === 0x2d ? 1 : opcode === 0x2e || opcode === 0x2f ? 2 : bits / 8;
        mnemonic = opcode === 0x28 ? 'i32.load' : opcode === 0x29 ? 'i64.load' : opcode === 0x2a ? 'f32.load' : opcode === 0x2b ? 'f64.load' : 'load';
        consumedValues.push({ id: 'addr', bits: 32 }); consume(1); producedValues.push({ bits }); produce(1); memoryEffects.push({ space: 'linear-memory', byteWidth, offset: or.value, align: ar.value, isWrite: false });
        possibleExceptions.push({ kind: 'linear-memory-oob', condition: `effectiveAddress+${byteWidth}>memorySize` });
        break;
      }
      case 0x36: case 0x37: case 0x38: case 0x39: case 0x3a: case 0x3b: {
        const ar = decodeUleb128(bytecode, pos); pos = ar.nextOffset; const or = decodeUleb128(bytecode, pos); pos = or.nextOffset;
        const bits = (opcode === 0x37 || opcode === 0x39) ? 64 : 32; const byteWidth = opcode === 0x3a ? 1 : opcode === 0x3b ? 2 : bits / 8;
        mnemonic = opcode === 0x36 ? 'i32.store' : opcode === 0x37 ? 'i64.store' : 'store'; consumedValues.push({ id: 'val', bits }, { id: 'addr', bits: 32 }); consume(2); memoryEffects.push({ space: 'linear-memory', byteWidth, offset: or.value, align: ar.value, isWrite: true });
        possibleExceptions.push({ kind: 'linear-memory-oob', condition: `effectiveAddress+${byteWidth}>memorySize` });
        break;
      }
      case 0x41: { const r = decodeSleb128(bytecode, pos); pos = r.nextOffset; mnemonic = 'i32.const'; producedValues.push({ bits: 32, constant: r.value }); produce(1); break; }
      case 0x42: { const r = decodeSleb128_64(bytecode, pos); pos = r.nextOffset; mnemonic = 'i64.const'; producedValues.push({ bits: 64, constant: r.value }); produce(1); break; }
      case 0x45: case 0x46: case 0x47: case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: {
        mnemonic = opcode === 0x45 ? 'i32.eqz' : 'i32.cmp'; const n = opcode === 0x45 ? 1 : 2; for (let i = 0; i < n; i++) consumedValues.push({ id: `arg_${i}`, bits: 32 }); consume(n); producedValues.push({ bits: 32 }); produce(1); break;
      }
      case 0x6a: case 0x6b: case 0x6c: case 0x6d: case 0x6e: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: {
        const names = { 0x6a:'i32.add',0x6b:'i32.sub',0x6c:'i32.mul',0x6d:'i32.div_s',0x6e:'i32.div_u',0x71:'i32.and',0x72:'i32.or',0x73:'i32.xor',0x74:'i32.shl',0x75:'i32.shr_s',0x76:'i32.shr_u' };
        mnemonic = names[opcode]; consumedValues.push({ id:'rhs',bits:32 },{ id:'lhs',bits:32 }); consume(2); producedValues.push({bits:32}); produce(1);
        if (opcode === 0x6d || opcode === 0x6e) possibleExceptions.push({ kind: 'integer-divide-by-zero', condition: 'rhs==0' });
        if (opcode === 0x6d) possibleExceptions.push({ kind: 'integer-divide-overflow', condition: 'lhs==INT32_MIN&&rhs==-1' });
        break;
      }
      case 0x7c: case 0x7d: case 0x7e:
        mnemonic = opcode === 0x7c ? 'i64.add' : opcode === 0x7d ? 'i64.sub' : 'i64.mul'; consumedValues.push({id:'rhs',bits:64},{id:'lhs',bits:64}); consume(2); producedValues.push({bits:64}); produce(1); break;
      default:
        mnemonic = `wasm_op_0x${opcode.toString(16)}`; completeness = 'partial'; unknownEffects.push({ category:'other', reason:`unsupported-opcode-0x${opcode.toString(16)}` }); break;
    }

    budget.chargeValues(consumedValues.length + producedValues.length);
    const origin = createOriginSet({ operationIds: [opId], byteRanges: [{ start: codeBody.bodyOffset + opOffset, end: codeBody.bodyOffset + pos }] });
    drafts.push({ frontendId:'wasm', frontendSemanticVersion:'1.0.0', profileId:wasmModule.vmSpecEdition, methodId, operationId:opId, bytecodeOffset:opOffset, opcode, mnemonic, consumedValues, producedValues, locationReads, locationWrites, memoryEffects, callEffects, controlEffects, possibleExceptions, origin, completeness, unknownEffects });
  }

  if (controlStack.length !== 0) fail('wasm-missing-function-end');
  for (const d of drafts) for (const c of d.controlEffects) if (c.kind === 'switch') {
    for (let i = 0; i < c.targetOffsets.length; i++) { const k = `__case_${i}`; if (c[k] != null) c.targetOffsets[i] = c[k]; delete c[k]; }
    if (c.__defaultHolder) { c.defaultTargetOffset = c.__defaultHolder.targetOffset; delete c.__defaultHolder; }
  }
  const bundles = drafts.map((d) => createVMEffectBundle(d, options));
  const aggregateCompleteness = bundles.some((b) => b.completeness === 'unknown') ? 'unknown' : bundles.some((b) => b.completeness === 'partial') ? 'partial' : bundles.some((b) => b.completeness === 'exact-with-intrinsic') ? 'exact-with-intrinsic' : 'exact';
  return createVMEffectFunction({ methodId, profileId: wasmModule.vmSpecEdition, frontendId:'wasm', bundles, entryState:{ params:funcType.params, locals:codeBody.locals }, exceptionRegions:[], aggregateCompleteness }, options);
}
