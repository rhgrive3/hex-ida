import { createOriginSet } from '../../core/identity/origin.js';
import { createManagedExceptionRegionId, createManagedMethodId, createVMOperationId } from '../shared/identity.js';
import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';

function fail(code) { throw new TypeError(code); }

export function liftCilMethod(bodyIndex, cilImage, options = {}) {
  const methodBody = cilImage.methodBodies[bodyIndex];
  if (!methodBody) fail('cil-invalid-method-body-index');

  const methodId = createManagedMethodId(cilImage.moduleId, `0x0600000${(bodyIndex + 1).toString(16)}`);
  const bytecode = methodBody.bytecode;
  const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
  // IL stream base for provenance ranges. The parser records the code start
  // separately from the method header; bodies built before that field fall
  // back to the header for compatibility (#5396).
  const codeBase = methodBody.codeOffset ?? methodBody.headerOffset;

  // Operand reads must stay inside the method bytecode. A truncated operand
  // fails closed with a typed error instead of lifting an index-less exact
  // effect or leaking a raw RangeError (#5350).
  const need = (count) => {
    if (pc + count > bytecode.length) fail('cil-truncated-operand');
  };

  let pc = 0;
  let opSeq = 0;
  let currentStackHeight = 0;
  const bundles = [];

  const exceptionRegions = (methodBody.exceptionClauses || []).map((cl, idx) => ({
    id: createManagedExceptionRegionId(methodId, idx),
    startOffset: cl.tryOffset,
    endOffset: cl.tryOffset + cl.tryLength,
    handlerOffset: cl.handlerOffset,
    handlerLength: cl.handlerLength,
    handlerEndOffset: cl.handlerOffset + cl.handlerLength,
    handlerKind: cl.kind,
    // The trailing union field is the filter-code offset for filter clauses
    // and a class token only for catch clauses (ECMA-335 §II.25.4.6): mapping
    // it blindly to catchToken mislabels IL offsets and loses the filter
    // start (#5356).
    ...(cl.kind === 'filter'
      ? { filterOffset: cl.classTokenOrFilter }
      : cl.kind === 'catch'
        ? { catchToken: cl.classTokenOrFilter }
        : {}),
  }));

  while (pc < bytecode.length) {
    const opOffset = pc;
    let opcode = bytecode[pc++];
    opSeq++;

    let isPrefixFE = false;
    if (opcode === 0xfe) {
      isPrefixFE = true;
      need(1);
      opcode = (0xfe << 8) | bytecode[pc++];
    }

    const opId = createVMOperationId(methodId, opOffset, opSeq);

    let mnemonic = 'unknown';
    let completeness = 'exact';
    let locationReads = [];
    let locationWrites = [];
    let memoryEffects = [];
    let callEffects = [];
    let controlEffects = [];
    let producedValues = [];
    let consumedValues = [];
    let unknownEffects = [];

    if (!isPrefixFE) {
      switch (opcode) {
        case 0x00: // nop
          mnemonic = 'nop';
          break;

        case 0x01: // break
          mnemonic = 'break';
          break;

        // ldarg.0 .. ldarg.3
        case 0x02: case 0x03: case 0x04: case 0x05:
          {
            const argIdx = opcode - 0x02;
            mnemonic = `ldarg.${argIdx}`;
            locationReads.push({ kind: 'argument', index: argIdx, bits: 32 });
            producedValues.push({ bits: 32 });
            currentStackHeight++;
          }
          break;

        // ldloc.0 .. ldloc.3
        case 0x06: case 0x07: case 0x08: case 0x09:
          {
            const locIdx = opcode - 0x06;
            mnemonic = `ldloc.${locIdx}`;
            locationReads.push({ kind: 'local', index: locIdx, bits: 32 });
            producedValues.push({ bits: 32 });
            currentStackHeight++;
          }
          break;

        // stloc.0 .. stloc.3
        case 0x0a: case 0x0b: case 0x0c: case 0x0d:
          {
            const locIdx = opcode - 0x0a;
            mnemonic = `stloc.${locIdx}`;
            locationWrites.push({ kind: 'local', index: locIdx, bits: 32 });
            consumedValues.push({ id: `stack_top` });
            currentStackHeight--;
          }
          break;

        case 0x0e: // ldarg.s
          {
            need(1);
            const argIdx = bytecode[pc++];
            mnemonic = 'ldarg.s';
            locationReads.push({ kind: 'argument', index: argIdx, bits: 32 });
            producedValues.push({ bits: 32 });
            currentStackHeight++;
          }
          break;

        case 0x11: // ldloc.s
          {
            need(1);
            const locIdx = bytecode[pc++];
            mnemonic = 'ldloc.s';
            locationReads.push({ kind: 'local', index: locIdx, bits: 32 });
            producedValues.push({ bits: 32 });
            currentStackHeight++;
          }
          break;

        case 0x13: // stloc.s
          {
            need(1);
            const locIdx = bytecode[pc++];
            mnemonic = 'stloc.s';
            locationWrites.push({ kind: 'local', index: locIdx, bits: 32 });
            consumedValues.push({ id: 'top' });
            currentStackHeight--;
          }
          break;

        case 0x14: // ldnull
          mnemonic = 'ldnull';
          producedValues.push({ bits: 64, isNull: true });
          currentStackHeight++;
          break;

        // ldc.i4.0 .. ldc.i4.8, ldc.i4.m1
        case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e:
          {
            const val = opcode === 0x15 ? -1 : opcode - 0x16;
            mnemonic = `ldc.i4.${opcode === 0x15 ? 'm1' : val}`;
            producedValues.push({ bits: 32, constant: val });
            currentStackHeight++;
          }
          break;

        case 0x1f: // ldc.i4.s
          {
            need(1);
            let val = bytecode[pc++];
            if (val >= 128) val -= 256;
            mnemonic = 'ldc.i4.s';
            producedValues.push({ bits: 32, constant: val });
            currentStackHeight++;
          }
          break;

        case 0x20: // ldc.i4
          {
            need(4);
            const val = view.getInt32(pc, true);
            pc += 4;
            mnemonic = 'ldc.i4';
            producedValues.push({ bits: 32, constant: val });
            currentStackHeight++;
          }
          break;

        case 0x21: // ldc.i8
          {
            need(8);
            const val = view.getBigInt64(pc, true);
            pc += 8;
            mnemonic = 'ldc.i8';
            producedValues.push({ bits: 64, constant: val });
            currentStackHeight++;
          }
          break;

        case 0x25: // dup
          mnemonic = 'dup';
          consumedValues.push({ id: 'top' });
          producedValues.push({ id: 'dup1' }, { id: 'dup2' });
          currentStackHeight++;
          break;

        case 0x26: // pop
          mnemonic = 'pop';
          consumedValues.push({ id: 'top' });
          currentStackHeight--;
          break;

        case 0x28: // call
        case 0x6f: // callvirt
        case 0x73: // newobj
          {
            need(4);
            const token = view.getUint32(pc, true);
            pc += 4;
            const kind = opcode === 0x28 ? 'call' : opcode === 0x6f ? 'callvirt' : 'newobj';
            mnemonic = kind;
            callEffects.push({
              token,
              dispatchKind: kind === 'callvirt' ? 'virtual' : kind === 'newobj' ? 'constructor' : 'direct',
            });
            if (kind === 'newobj') {
              producedValues.push({ bits: 64 });
              currentStackHeight++;
            }
          }
          break;

        case 0x2a: // ret
          mnemonic = 'ret';
          controlEffects.push({ kind: 'return' });
          break;

        // short branches: br.s (0x2B), brfalse.s (0x2C), brtrue.s (0x2D),
        // beq.s (0x2E), bge.s (0x2F), bgt.s (0x30), ble.s (0x31), blt.s (0x32), bne.un.s (0x33),
        // bge.un.s (0x34), bgt.un.s (0x35), ble.un.s (0x36), blt.un.s (0x37)
        case 0x2b: case 0x2c: case 0x2d: case 0x2e: case 0x2f: case 0x30: case 0x31: case 0x32: case 0x33:
        case 0x34: case 0x35: case 0x36: case 0x37:
          {
            need(1);
            let offset = bytecode[pc++];
            if (offset >= 128) offset -= 256;
            const targetOffset = pc + offset;
            if (opcode === 0x2b) {
              mnemonic = 'br.s';
              controlEffects.push({ kind: 'branch', targetOffset });
            } else if (opcode === 0x2c || opcode === 0x2d) {
              mnemonic = opcode === 0x2c ? 'brfalse.s' : 'brtrue.s';
              consumedValues.push({ id: 'cond' });
              currentStackHeight--;
              controlEffects.push({ kind: 'conditional-branch', targetOffset });
            } else {
              const shortNames = {
                0x2e: 'beq.s', 0x2f: 'bge.s', 0x30: 'bgt.s', 0x31: 'ble.s', 0x32: 'blt.s',
                0x33: 'bne.un.s', 0x34: 'bge.un.s', 0x35: 'bgt.un.s', 0x36: 'ble.un.s', 0x37: 'blt.un.s',
              };
              mnemonic = shortNames[opcode] || 'bcond.s';
              consumedValues.push({ id: 'val1' }, { id: 'val2' });
              currentStackHeight -= 2;
              controlEffects.push({ kind: 'conditional-branch', targetOffset });
            }
          }
          break;

        // long branches: br (0x38), brfalse (0x39), brtrue (0x3A),
        // beq (0x3B), bge (0x3C), bgt (0x3D), ble (0x3E), blt (0x3F), bne.un (0x40),
        // bge.un (0x41), bgt.un (0x42), ble.un (0x43), blt.un (0x44)
        case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: case 0x3e: case 0x3f: case 0x40:
        case 0x41: case 0x42: case 0x43: case 0x44:
          {
            need(4);
            const offset = view.getInt32(pc, true);
            pc += 4;
            const targetOffset = pc + offset;
            if (opcode === 0x38) {
              mnemonic = 'br';
              controlEffects.push({ kind: 'branch', targetOffset });
            } else if (opcode === 0x39 || opcode === 0x3a) {
              mnemonic = opcode === 0x39 ? 'brfalse' : 'brtrue';
              consumedValues.push({ id: 'cond' });
              currentStackHeight--;
              controlEffects.push({ kind: 'conditional-branch', targetOffset });
            } else {
              const longNames = {
                0x3b: 'beq', 0x3c: 'bge', 0x3d: 'bgt', 0x3e: 'ble', 0x3f: 'blt',
                0x40: 'bne.un', 0x41: 'bge.un', 0x42: 'bgt.un', 0x43: 'ble.un', 0x44: 'blt.un',
              };
              mnemonic = longNames[opcode] || 'bcond';
              consumedValues.push({ id: 'val1' }, { id: 'val2' });
              currentStackHeight -= 2;
              controlEffects.push({ kind: 'conditional-branch', targetOffset });
            }
          }
          break;

        case 0x45: // switch
          {
            need(4);
            const count = view.getUint32(pc, true);
            pc += 4;
            if (count > Math.floor((bytecode.length - pc) / 4)) fail('cil-truncated-operand');
            const deltas = [];
            for (let index = 0; index < count; index++) {
              deltas.push(view.getInt32(pc, true));
              pc += 4;
            }
            const switchBase = pc;
            mnemonic = 'switch';
            consumedValues.push({ id: 'selector', bits: 32 });
            currentStackHeight--;
            controlEffects.push({ kind: 'switch', targetOffsets:deltas.map((delta) => switchBase + delta) });
          }
          break;

        // binops: add (0x58), sub (0x59), mul (0x5A), div (0x5B), rem (0x5D), and (0x5F), or (0x60), xor (0x61), shl (0x62), shr (0x63)
        case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5d: case 0x5f: case 0x60: case 0x61: case 0x62: case 0x63:
          {
            const names = {
              0x58: 'add', 0x59: 'sub', 0x5a: 'mul', 0x5b: 'div', 0x5d: 'rem',
              0x5f: 'and', 0x60: 'or', 0x61: 'xor', 0x62: 'shl', 0x63: 'shr',
            };
            mnemonic = names[opcode] || 'binop';
            consumedValues.push({ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 });
            producedValues.push({ bits: 32 });
            currentStackHeight--;
          }
          break;

        // unops: neg (0x65), not (0x66)
        case 0x65: case 0x66:
          mnemonic = opcode === 0x65 ? 'neg' : 'not';
          consumedValues.push({ id: 'val', bits: 32 });
          producedValues.push({ bits: 32 });
          break;

        case 0x72: // ldstr
          {
            need(4);
            const token = view.getUint32(pc, true);
            pc += 4;
            mnemonic = 'ldstr';
            producedValues.push({ bits: 64, stringToken: token });
            currentStackHeight++;
          }
          break;

        case 0x7a: // throw
          mnemonic = 'throw';
          consumedValues.push({ id: 'exception' });
          controlEffects.push({ kind: 'throw' });
          currentStackHeight--;
          break;

        case 0x7b: // ldfld
        case 0x7d: // stfld
          {
            need(4);
            const token = view.getUint32(pc, true);
            pc += 4;
            const isWrite = opcode === 0x7d;
            mnemonic = isWrite ? 'stfld' : 'ldfld';
            if (isWrite) {
              consumedValues.push({ id: 'val' }, { id: 'obj' });
              currentStackHeight -= 2;
            } else {
              consumedValues.push({ id: 'obj' });
              producedValues.push({ bits: 32 });
            }
            memoryEffects.push({
              space: 'field',
              token,
              isWrite,
            });
          }
          break;

        case 0x7e: // ldsfld
        case 0x80: // stsfld
          {
            need(4);
            const token = view.getUint32(pc, true);
            pc += 4;
            const isWrite = opcode === 0x80;
            mnemonic = isWrite ? 'stsfld' : 'ldsfld';
            if (isWrite) {
              consumedValues.push({ id: 'val' });
              currentStackHeight--;
            } else {
              producedValues.push({ bits: 32 });
              currentStackHeight++;
            }
            memoryEffects.push({
              space: 'static-field',
              token,
              isWrite,
            });
          }
          break;

        case 0xdc: // endfinally
          mnemonic = 'endfinally';
          controlEffects.push({ kind: 'endfinally' });
          break;

        case 0xdd: // leave
          {
            need(4);
            const offset = view.getInt32(pc, true);
            pc += 4;
            mnemonic = 'leave';
            controlEffects.push({ kind: 'leave', targetOffset:pc + offset });
            currentStackHeight = 0;
          }
          break;

        case 0xde: // leave.s
          {
            need(1);
            let offset = bytecode[pc++];
            if (offset >= 128) offset -= 256;
            mnemonic = 'leave.s';
            controlEffects.push({ kind: 'leave', targetOffset:pc + offset });
            currentStackHeight = 0;
          }
          break;

        default:
          mnemonic = `cil_op_0x${opcode.toString(16)}`;
          completeness = 'partial';
          unknownEffects.push({ category: 'other', reason: `unsupported-cil-opcode-0x${opcode.toString(16)}` });
          break;
      }
    } else {
      // 0xFE prefix opcodes
      const subOp = opcode & 0xff;
      switch (subOp) {
        case 0x01: // ceq
        case 0x02: // cgt
        case 0x04: // clt
          mnemonic = subOp === 0x01 ? 'ceq' : subOp === 0x02 ? 'cgt' : 'clt';
          consumedValues.push({ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 });
          producedValues.push({ bits: 32 });
          currentStackHeight--;
          break;

        case 0x09: // ldarg
          {
            need(2);
            const argIdx = view.getUint16(pc, true);
            pc += 2;
            mnemonic = 'ldarg';
            locationReads.push({ kind: 'argument', index: argIdx, bits: 32 });
            producedValues.push({ bits: 32 });
            currentStackHeight++;
          }
          break;

        case 0x0c: // ldloc
          {
            need(2);
            const locIdx = view.getUint16(pc, true);
            pc += 2;
            mnemonic = 'ldloc';
            locationReads.push({ kind: 'local', index: locIdx, bits: 32 });
            producedValues.push({ bits: 32 });
            currentStackHeight++;
          }
          break;

        case 0x0e: // stloc
          {
            need(2);
            const locIdx = view.getUint16(pc, true);
            pc += 2;
            mnemonic = 'stloc';
            locationWrites.push({ kind: 'local', index: locIdx, bits: 32 });
            consumedValues.push({ id: 'top' });
            currentStackHeight--;
          }
          break;

        case 0x11: // endfilter
          mnemonic = 'endfilter';
          consumedValues.push({ id: 'filter-result', bits: 32 });
          currentStackHeight--;
          controlEffects.push({ kind: 'endfilter' });
          break;

        case 0x1a: // rethrow
          mnemonic = 'rethrow';
          controlEffects.push({ kind: 'rethrow' });
          break;

        case 0x16: // volatile.
        case 0x14: // tail.
        case 0x12: // unaligned.
        case 0x1e: // readonly.
          mnemonic = `prefix_${subOp.toString(16)}`;
          break;

        default:
          mnemonic = `cil_fe_0x${subOp.toString(16)}`;
          completeness = 'partial';
          unknownEffects.push({ category: 'other', reason: `unsupported-cil-fe-opcode-0x${subOp.toString(16)}` });
          break;
      }
    }

    const origin = createOriginSet({
      operationIds: [opId],
      byteRanges: [{ start: codeBase + opOffset, end: codeBase + pc }],
    });

    bundles.push(createVMEffectBundle({
      schemaVersion: 1,
      contractVersion: '1.0.0',
      frontendId: 'cil',
      frontendSemanticVersion: '1.0.0',
      profileId: cilImage.vmSpecEdition,
      methodId,
      operationId: opId,
      bytecodeOffset: opOffset,
      opcode,
      mnemonic,
      consumedValues,
      producedValues,
      locationReads,
      locationWrites,
      memoryEffects,
      callEffects,
      controlEffects,
      possibleExceptions: [],
      origin,
      completeness,
      unknownEffects,
    }, options));
  }

  return createVMEffectFunction({
    methodId,
    profileId: cilImage.vmSpecEdition,
    frontendId: 'cil',
    bundles,
    entryState: {
      maxStack: methodBody.maxStack,
      isTiny: methodBody.isTiny,
    },
    exceptionRegions,
  }, options);
}
