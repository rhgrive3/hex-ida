const MAX_SWITCH_CASES = 4096;
const MAX_MEMORY_SEGMENTS = 128;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const MAX_EXPRESSION_DEPTH = 16;
const MAX_EXPRESSION_NODES = 64;
const ADDRESS_LIMIT = 1n << 64n;
const CONTROL_FLOW_KINDS = new Set(['fallthrough', 'call', 'branch', 'conditional-branch', 'return', 'unknown']);
const OPAQUE_EXPRESSION = Object.freeze({ kind:'opaque-expression' });
const EXPRESSION_METRICS = new WeakMap();

function integer(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^(?:-?(?:0|[1-9][0-9]*)|-?0x[0-9a-f]+)$/i.test(trimmed)) return null;
  try {
    return trimmed.startsWith('-') ? -BigInt(trimmed.slice(1)) : BigInt(trimmed);
  } catch { return null; }
}

function address(value) {
  const parsed = integer(value);
  return parsed != null && parsed >= 0n && parsed < ADDRESS_LIMIT ? parsed : null;
}

function operand(instruction, index) {
  return instruction?.detailStatus === 'complete' && Array.isArray(instruction.detail?.operands)
    ? instruction.detail.operands[index] ?? null
    : null;
}

function register(operandValue) {
  const value = operandValue?.type === 'register' ? operandValue.register : null;
  if (!value || typeof value.physicalId !== 'string' || !value.physicalId) return null;
  if (!Number.isSafeInteger(value.viewBits) || value.viewBits <= 0
      || !Number.isSafeInteger(value.physicalBits) || value.physicalBits < value.viewBits) return null;
  return value;
}

function immediate(operandValue) {
  return operandValue?.type === 'immediate' ? integer(operandValue.value) : null;
}

function expressionMetrics(value) {
  if (!value || typeof value !== 'object') return { depth: 0, nodes: 0 };
  return EXPRESSION_METRICS.get(value) ?? { depth: 1, nodes: 1 };
}

function boundExpression(node, children) {
  let maxDepth = 0;
  let totalNodes = 1;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child || typeof child !== 'object' || child.kind === 'opaque-expression') {
      return OPAQUE_EXPRESSION;
    }
    const metrics = expressionMetrics(child);
    if (metrics.depth > maxDepth) maxDepth = metrics.depth;
    totalNodes += metrics.nodes;
    if (maxDepth + 1 > MAX_EXPRESSION_DEPTH || totalNodes > MAX_EXPRESSION_NODES) {
      return OPAQUE_EXPRESSION;
    }
  }
  EXPRESSION_METRICS.set(node, { depth: maxDepth + 1, nodes: totalNodes });
  return node;
}

function serializeExpression(value, depth, budget) {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? null : primitive;
  }
  if (value.kind === 'opaque-expression') return null;
  if (depth > MAX_EXPRESSION_DEPTH) return null;
  budget.remaining -= 1;
  if (budget.remaining < 0) return null;
  if (Array.isArray(value)) {
    const parts = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const child = serializeExpression(value[index], depth + 1, budget);
      if (child == null) return null;
      parts[index] = child;
    }
    return `[${parts.join(',')}]`;
  }
  const keys = Object.keys(value);
  const parts = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (value[key] === undefined) continue;
    const child = serializeExpression(value[key], depth + 1, budget);
    if (child == null) return null;
    parts.push(`${JSON.stringify(key)}:${child}`);
  }
  return `{${parts.join(',')}}`;
}

function expressionKey(value) {
  if (value == null || typeof value !== 'object' || value.kind === 'opaque-expression') return null;
  return serializeExpression(value, 0, { remaining: MAX_EXPRESSION_NODES });
}

function initialRegister(registerValue) {
  return { kind:'input-register', registerId:registerValue.physicalId, widthBits:registerValue.physicalBits };
}

function readRegister(registerValue, state) {
  let value = state.registers.get(registerValue.physicalId) ?? initialRegister(registerValue);
  if (registerValue.viewBits < registerValue.physicalBits) {
    const lsb = Number.isSafeInteger(registerValue.lsb) && registerValue.lsb >= 0 ? registerValue.lsb : 0;
    value = lsb > 0
      ? boundExpression({ kind:'extract', value, lsb, widthBits:registerValue.viewBits }, [value])
      : boundExpression({ kind:'truncate', value, widthBits:registerValue.viewBits }, [value]);
  }
  return value;
}

function writeRegister(registerValue, value, state) {
  let fullValue = value;
  if (registerValue.viewBits < registerValue.physicalBits) {
    const lsb = Number.isSafeInteger(registerValue.lsb) && registerValue.lsb >= 0 ? registerValue.lsb : 0;
    if (registerValue.viewBits === 32 && registerValue.physicalBits === 64 && lsb === 0) {
      fullValue = boundExpression({ kind:'zero-extend', value, fromBits:registerValue.viewBits, toBits:registerValue.physicalBits }, [value]);
    } else {
      const prior = state.registers.get(registerValue.physicalId) ?? initialRegister(registerValue);
      fullValue = boundExpression({ kind:'insert', into:prior, value, lsb, widthBits:registerValue.viewBits, physicalBits:registerValue.physicalBits }, [prior, value]);
    }
  }
  state.registers.set(registerValue.physicalId, fullValue);
  if (registerValue.physicalId === 'rbp') state.stack = [];
}

function stackAddress(memory) {
  if (memory?.type !== 'memory' || memory.memory?.index != null || memory.memory?.segment != null
      || memory.memory?.addressSizeBits !== 64) return null;
  const base = memory.memory?.base?.physicalId;
  if (base !== 'rbp') return null;
  const displacement = integer(memory.memory.displacement);
  const widthBits = memory.widthBits;
  if (displacement == null || !Number.isSafeInteger(widthBits) || widthBits <= 0 || widthBits % 8 !== 0) return null;
  return { base, displacement, widthBytes:widthBits / 8 };
}

function stackValue(memory, state) {
  const slot = stackAddress(memory);
  if (!slot) return null;
  return state.stack.find(value => value.base === slot.base && value.displacement === slot.displacement
    && value.widthBytes === slot.widthBytes)?.value ?? null;
}

function storeStackValue(memory, value, state) {
  const slot = stackAddress(memory);
  if (!slot) return false;
  const start = slot.displacement, end = start + BigInt(slot.widthBytes);
  state.stack = state.stack.filter(prior => prior.base !== slot.base
    || prior.displacement + BigInt(prior.widthBytes) <= start
    || end <= prior.displacement);
  if (value != null) state.stack.push({ ...slot, value });
  return true;
}

function absoluteRegisterValue(registerValue, state) {
  const value = readRegister(registerValue, state);
  return value?.kind === 'absolute-address' ? integer(value.value) : null;
}

function registerSource(operandValue, state) {
  const sourceRegister = register(operandValue);
  if (sourceRegister) return readRegister(sourceRegister, state);
  const constant = immediate(operandValue);
  if (constant != null) return { kind:'integer-constant', value:constant.toString() };
  if (operandValue?.type === 'memory') return stackValue(operandValue, state);
  return null;
}

function memoryTableShape(memoryOperand, state) {
  if (memoryOperand?.type !== 'memory' || memoryOperand.memory?.segment != null
      || memoryOperand.memory?.addressSizeBits !== 64) return null;
  const base = register({ type:'register', register:memoryOperand.memory?.base });
  const index = register({ type:'register', register:memoryOperand.memory?.index });
  const widthBits = memoryOperand.widthBits;
  const scale = memoryOperand.memory?.scale;
  const displacement = integer(memoryOperand.memory?.displacement);
  if (!base || !index || !Number.isSafeInteger(widthBits) || widthBits % 8 !== 0
      || !Number.isSafeInteger(scale) || scale !== widthBits / 8 || displacement == null) return null;
  const tableBase = absoluteRegisterValue(base, state);
  const indexValue = readRegister(index, state);
  if (tableBase == null || indexValue == null) return null;
  return { tableBase, tableAddress:tableBase + displacement, indexValue,
    indexRegister:index.physicalId, widthBits, scale, displacement };
}

function byteSegments(memorySegments, functionAddress) {
  if (!Array.isArray(memorySegments) || memorySegments.length > MAX_MEMORY_SEGMENTS) return null;
  const output = [];
  let total = 0;
  for (const segment of memorySegments) {
    if (!segment || typeof segment !== 'object' || typeof segment.relativeAddress !== 'string'
        || typeof segment.bytes !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(segment.bytes)) return null;
    const relative = integer(segment.relativeAddress);
    if (relative == null || segment.bytes.length / 2 > MAX_SEGMENT_BYTES) return null;
    const length = segment.bytes.length / 2;
    total += length;
    if (total > MAX_MEMORY_BYTES) return null;
    const start = functionAddress + relative;
    const end = start + BigInt(length);
    if (start < 0n || end > ADDRESS_LIMIT) return null;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = Number.parseInt(segment.bytes.slice(index * 2, index * 2 + 2), 16);
    output.push({ start, end, bytes });
  }
  return output;
}

function readLittleEndian(segments, start, widthBytes) {
  const end = start + BigInt(widthBytes);
  const matches = segments.filter(segment => start >= segment.start && end <= segment.end);
  if (matches.length !== 1) return null;
  const segment = matches[0];
  const offset = Number(start - segment.start);
  let value = 0n;
  for (let index = 0; index < widthBytes; index += 1) value |= BigInt(segment.bytes[offset + index]) << BigInt(index * 8);
  return value;
}

function boundedFallthrough(instruction, comparison, instructions, instructionIndex, instructionAddresses) {
  const family = String(instruction?.instructionFamily || instruction?.mnemonic || '').toLowerCase();
  if (family !== 'ja' && family !== 'jae') return null;
  if (!comparison || !['cmp', 'sub'].includes(comparison.op)) return null;
  // CMP and SUB establish the same unsigned relation for these guards:
  // fallthrough from JA proves value <= immediate; from JAE it proves
  // value < immediate. SUB's value is captured before the subtraction so a
  // later reload of the original selector can still be matched structurally.
  if (comparison.rhs < 0n) return null;
  const maximum = family === 'ja' ? comparison.rhs : comparison.rhs - 1n;
  if (maximum < 0n || maximum >= BigInt(MAX_SWITCH_CASES)) return null;
  const target = address(immediate(operand(instruction, 0)));
  if (target == null || !instructionAddresses.has(target.toString())) return null;
  const next = instructions[instructionIndex + 1];
  if (!next || address(next.address) !== BigInt.asUintN(64, address(instruction.address) + BigInt(instruction.length))) return null;
  const selectorKey = expressionKey(comparison.lhs);
  if (!selectorKey) return null;
  return { selector:comparison.lhs, selectorKey, min:0n, max:maximum,
    defaultAddress:target, branchAddress:address(instruction.address),
    fallthroughAddress:address(next.address) };
}

function controlFlowKind(instruction, classifyControlFlow) {
  const family = String(instruction?.instructionFamily || instruction?.mnemonic || '').toLowerCase();
  let classified = null;
  try {
    const kind = classifyControlFlow?.(instruction);
    if (typeof kind === 'string' && CONTROL_FLOW_KINDS.has(kind)) classified = kind;
  } catch { /* Use the local x86 mnemonic fallback below. */ }
  let inferred = 'fallthrough';
  if (/^ret/.test(family)) inferred = 'return';
  else if (family === 'call' || family === 'lcall') inferred = 'call';
  else if (family === 'jmp' || family === 'ljmp' || ['syscall', 'sysret', 'sysretq'].includes(family)) inferred = 'branch';
  else if (/^(?:j|loop)/.test(family) || family === 'xbegin') inferred = 'conditional-branch';
  else if (/^(?:ud[012]|int(?:3|1)?|icebp|hlt|iret|iretd|iretq|sysenter|sysexit|sysexitq|xabort)/.test(family)) inferred = 'unknown';
  return classified && classified !== 'fallthrough' ? classified : inferred;
}

function dispatchIsBounded(bounds, indirectJump, instructions, flowMeta, addressToIndex) {
  const jumpAddress = address(indirectJump.address);
  if (!bounds || jumpAddress == null || bounds.defaultAddress >= bounds.fallthroughAddress
      && bounds.defaultAddress <= jumpAddress) return false;
  const branchIndex = addressToIndex.get(bounds.branchAddress.toString()) ?? -1;
  const jumpIndex = addressToIndex.get(jumpAddress.toString()) ?? -1;
  if (branchIndex < 0 || jumpIndex <= branchIndex) return false;
  for (let index = branchIndex + 1; index < jumpIndex; index += 1) {
    if (flowMeta.kinds[index] !== 'fallthrough') return false;
  }
  for (let i = 0; i < flowMeta.nonTrivial.length; i += 1) {
    const entry = flowMeta.nonTrivial[i];
    if (entry.index === branchIndex || entry.index === jumpIndex) continue;
    if (entry.kind === 'unknown' || entry.target == null) return false;
    if (entry.target >= bounds.fallthroughAddress && entry.target <= jumpAddress) return false;
  }
  return true;
}

function targetAddresses(segments, pattern, bounds) {
  const indexKey = pattern ? expressionKey(pattern.indexValue) : null;
  if (!pattern || !bounds || !bounds.selectorKey || !indexKey || indexKey !== bounds.selectorKey) return null;
  const count = bounds.max - bounds.min + 1n;
  if (bounds.min !== 0n || count <= 0n || count > BigInt(MAX_SWITCH_CASES)) return null;
  const widthBytes = pattern.widthBits / 8;
  const targets = [];
  for (let index = 0n; index < count; index += 1n) {
    const entryAddress = pattern.tableAddress + index * BigInt(pattern.scale);
    const raw = readLittleEndian(segments, entryAddress, widthBytes);
    if (raw == null) return null;
    let target;
    if (pattern.kind === 'relative-signed') {
      const signed = BigInt.asIntN(pattern.widthBits, raw);
      target = pattern.relativeBase + signed;
    } else {
      target = raw;
    }
    if (target < 0n || target >= ADDRESS_LIMIT || !pattern.instructionAddresses.has(target.toString())) return null;
    targets.push(target);
  }
  return targets;
}

function tableInstruction(instruction, state) {
  const family = String(instruction?.instructionFamily || instruction?.mnemonic || '').toLowerCase();
  const destination = register(operand(instruction, 0));
  const memory = operand(instruction, 1);
  const shape = memoryTableShape(memory, state);
  if (!shape || !destination || shape.widthBits !== 32 || family !== 'movsxd'
      || destination.viewBits !== 64 || shape.scale !== 4) return null;
  return { ...shape, kind:'relative-signed', destination:destination.physicalId,
    relativeBase:shape.tableBase, widthBits:32 };
}

function isAddToTableBase(instruction, pending, state) {
  if (!pending || String(instruction?.instructionFamily || instruction?.mnemonic || '').toLowerCase() !== 'add') return false;
  const destination = register(operand(instruction, 0)), source = register(operand(instruction, 1));
  if (!destination || !source || destination.physicalId !== pending.destination) return false;
  return absoluteRegisterValue(source, state) === pending.relativeBase;
}

function recoverAtIndirect(instruction, pending) {
  if (!pending) return null;
  const targetOperand = operand(instruction, 0);
  const targetRegister = register(targetOperand);
  if (!targetRegister || targetRegister.physicalId !== pending.destination) return null;
  return pending;
}

/**
 * Resolve only x86-64 switch tables whose index range, table address, entry
 * width, relative/absolute encoding and every target byte are all proven.
 * Missing mapped bytes, unsupported arithmetic, or any target outside the
 * decoded function leave the branch unresolved.
 */
export function resolveX86SwitchTables(instructions, memorySegments, classifyControlFlow) {
  try {
    if (!Array.isArray(instructions) || instructions.length === 0) return [];
    const ordered = [...instructions].sort((left, right) => {
      const a = address(left?.address), b = address(right?.address);
      return a == null || b == null ? 0 : a < b ? -1 : a > b ? 1 : 0;
    });
    if (ordered.some((item, index) => !item || address(item.address) == null
        || !Number.isSafeInteger(item.length) || item.length <= 0
        || (index > 0 && address(ordered[index - 1].address) + BigInt(ordered[index - 1].length) !== address(item.address)))) return [];
    const start = address(ordered[0].address);
    const segments = byteSegments(memorySegments, start);
    if (!segments) return [];
    const instructionAddresses = new Set();
    const addressToIndex = new Map();
    const kinds = new Array(ordered.length);
    const nonTrivial = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const addrKey = address(ordered[i].address).toString();
      instructionAddresses.add(addrKey);
      addressToIndex.set(addrKey, i);
      const kind = controlFlowKind(ordered[i], classifyControlFlow);
      kinds[i] = kind;
      if (kind !== 'fallthrough' && kind !== 'return') {
        nonTrivial.push({ index: i, kind, target: kind === 'unknown' ? null : address(immediate(operand(ordered[i], 0))) });
      }
    }
    const flowMeta = { kinds, nonTrivial };
    const state = { registers:new Map(), stack:[] };
    const recovered = [];
    let comparison = null;
    let bounds = null;
    let pendingTable = null;
    let pendingJump = null;

    for (let index = 0; index < ordered.length; index += 1) {
      const instruction = ordered[index];
      if (instruction.detailStatus !== 'complete' || !Array.isArray(instruction.detail?.operands)) return recovered;
      const family = String(instruction.instructionFamily || instruction.mnemonic || '').toLowerCase();
      const first = operand(instruction, 0), second = operand(instruction, 1);

      if (family === 'jmp') {
        const registerJump = recoverAtIndirect(instruction, pendingJump);
        const pattern = registerJump;
        if (!dispatchIsBounded(bounds, instruction, ordered, flowMeta, addressToIndex)) {
          pendingJump = null;
          pendingTable = null;
          bounds = null;
          comparison = null;
          state.registers.clear();
          state.stack = [];
          continue;
        }
        const targets = pattern ? targetAddresses(segments, { ...pattern, instructionAddresses }, bounds) : null;
        if (targets?.length) {
          const cases = targets.map((target, caseIndex) => Object.freeze({ value:BigInt(caseIndex), address:target }));
          recovered.push(Object.freeze({
            instructionAddress:address(instruction.address),
            tableAddress:pattern.tableAddress,
            entryWidthBytes:pattern.widthBits / 8,
            lowerBound:bounds.min,
            upperBound:bounds.max,
            selectorRegister:pattern.indexRegister,
            defaultAddress:bounds.defaultAddress,
            cases:Object.freeze(cases),
            targets:Object.freeze([...new Set(targets.map(String))].map(BigInt)),
          }));
        }
        pendingJump = null;
        pendingTable = null;
        bounds = null;
        comparison = null;
        state.registers.clear();
        state.stack = [];
        continue;
      }

      if (/^(?:j|ljmp|call|ret)/.test(family) && family !== 'ja' && family !== 'jae') {
        bounds = null;
        comparison = null;
        pendingTable = null;
        pendingJump = null;
        state.registers.clear();
        state.stack = [];
        continue;
      }

      const flowKind = flowMeta.kinds[index];
      const resolvedBounds = boundedFallthrough(instruction, comparison, ordered, index, instructionAddresses);
      if (resolvedBounds) bounds = resolvedBounds;
      else if (flowKind !== 'fallthrough') bounds = null;
      if (flowKind !== 'fallthrough' && !resolvedBounds) {
        comparison = null;
        pendingTable = null;
        pendingJump = null;
        state.registers.clear();
        state.stack = [];
        continue;
      }

      if (family === 'lea' && first?.type === 'register' && second?.type === 'memory'
          && second.memory?.base?.physicalId === 'rip' && second.memory?.index == null
          && second.memory?.segment == null && second.memory?.addressSizeBits === 64) {
        const destination = register(first), displacement = integer(second.memory.displacement);
        if (destination && displacement != null) {
          const value = BigInt.asUintN(64, address(instruction.address) + BigInt(instruction.length) + displacement);
          writeRegister(destination, { kind:'absolute-address', value:value.toString() }, state);
          pendingTable = null;
          pendingJump = null;
          comparison = null;
          continue;
        }
      }

      if (family === 'mov' && first?.type === 'register' && second?.type === 'memory') {
        const shape = memoryTableShape(second, state), destination = register(first);
        if (shape && destination && shape.widthBits === 64 && shape.scale === 8 && destination.viewBits === 64) {
          const pattern = { ...shape, kind:'absolute', destination:destination.physicalId };
          writeRegister(destination, { kind:'table-value', tableAddress:pattern.tableAddress.toString() }, state);
          pendingTable = pattern;
          pendingJump = pattern;
          comparison = null;
          continue;
        }
      }

      if (family === 'movsxd') {
        const pattern = tableInstruction(instruction, state);
        const destination = register(first);
        if (pattern && destination) {
          writeRegister(destination, { kind:'table-value', tableAddress:pattern.tableAddress.toString() }, state);
          pendingTable = pattern;
          pendingJump = null;
          comparison = null;
          continue;
        }
      }

      if (family === 'add' && isAddToTableBase(instruction, pendingTable, state)) {
        pendingJump = pendingTable;
        const destination = register(first);
        writeRegister(destination, { kind:'table-target', tableAddress:pendingTable.tableAddress.toString() }, state);
        pendingTable = null;
        comparison = null;
        continue;
      }

      if (family === 'mov') {
        if (first?.type === 'register') {
          const destination = register(first), value = registerSource(second, state);
          if (destination) writeRegister(destination, value ?? { kind:'unresolved-write', instructionAddress:String(instruction.address) }, state);
        } else if (first?.type === 'memory') {
          const value = registerSource(second, state);
          if (!storeStackValue(first, value, state)) state.stack = [];
        }
        pendingTable = null;
        pendingJump = null;
        continue;
      }

      if (family === 'cmp' || family === 'sub') {
        const destination = register(first), constant = immediate(second);
        comparison = destination && constant != null
          ? { lhs:readRegister(destination, state), rhs:constant, widthBits:destination.viewBits, op:family }
          : null;
        if (family === 'sub' && destination && constant != null) {
          const lhs = readRegister(destination, state);
          writeRegister(destination, boundExpression({ kind:'subtract', left:lhs, right:constant.toString(), widthBits:destination.viewBits }, [lhs]), state);
        }
        pendingTable = null;
        pendingJump = null;
        continue;
      }

      if (family === 'add') {
        const destination = register(first), source = register(second);
        if (destination && source) {
          const left = readRegister(destination, state), right = readRegister(source, state);
          writeRegister(destination, boundExpression({ kind:'add', left, right, widthBits:destination.viewBits }, [left, right]), state);
        } else if (destination) writeRegister(destination, { kind:'unresolved-write', instructionAddress:String(instruction.address) }, state);
        comparison = null;
        pendingTable = null;
        pendingJump = null;
        continue;
      }

      if (family === 'ja' || family === 'jae') {
        comparison = null;
        pendingTable = null;
        pendingJump = null;
        continue;
      }

      // Structured write access is used to invalidate facts across operations
      // the narrow resolver does not model. It never carries a prior value or
      // flags proof through an unrecognized state change.
      if (family !== 'nop') {
        for (const item of instruction.detail.operands) {
          if (!['write', 'read-write'].includes(item?.access)) continue;
          const written = register(item);
          if (written) {
            state.registers.delete(written.physicalId);
            if (written.physicalId === 'rbp') state.stack = [];
          } else if (item?.type === 'memory') {
            if (!storeStackValue(item, null, state)) state.stack = [];
          }
        }
        const implicitLists = [instruction.detail.implicitWrites, instruction.detail.registersWritten];
        for (const list of implicitLists) {
          if (!Array.isArray(list)) continue;
          for (const regItem of list) {
            const physId = typeof regItem === 'string'
              ? regItem.toLowerCase()
              : (typeof regItem?.physicalId === 'string' ? regItem.physicalId : null);
            if (physId) {
              state.registers.delete(physId);
              if (physId === 'rbp') state.stack = [];
            }
          }
        }
        if (!['mov', 'lea'].includes(family)) comparison = null;
      }
      pendingTable = null;
      pendingJump = null;
    }
    return recovered;
  } catch {
    // Recovery is optional proof work. Any malformed or unavailable evidence
    // leaves the caller's existing explicit unknown-control path unchanged.
    return [];
  }
}
