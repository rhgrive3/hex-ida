const MAX_SWITCH_CASES = 4096;
const MAX_MEMORY_SEGMENTS = 128;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const ADDRESS_LIMIT = 1n << 64n;
const CONTROL_FLOW_KINDS = new Set(['fallthrough', 'call', 'branch', 'conditional-branch', 'return', 'unknown']);

function integer(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value !== 'string' || !/^(?:-?(?:0|[1-9][0-9]*)|-?0x[0-9a-f]+)$/i.test(value.trim())) return null;
  try { return BigInt(value.trim()); } catch { return null; }
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

function expressionKey(value) {
  return value == null ? null : JSON.stringify(value);
}

function initialRegister(registerValue) {
  return { kind:'input-register', registerId:registerValue.physicalId, widthBits:registerValue.physicalBits };
}

function readRegister(registerValue, state) {
  let value = state.registers.get(registerValue.physicalId) ?? initialRegister(registerValue);
  if (registerValue.viewBits < registerValue.physicalBits) {
    value = { kind:'truncate', value, widthBits:registerValue.viewBits };
  }
  return value;
}

function writeRegister(registerValue, value, state) {
  const fullValue = registerValue.viewBits < registerValue.physicalBits
    ? { kind:'zero-extend', value, fromBits:registerValue.viewBits, toBits:registerValue.physicalBits }
    : value;
  state.registers.set(registerValue.physicalId, fullValue);
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

function boundedFallthrough(instruction, comparison, instructions) {
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
  if (target == null || !instructions.some(item => address(item.address) === target)) return null;
  const next = instructions[instructions.indexOf(instruction) + 1];
  if (!next || address(next.address) !== address(instruction.address) + BigInt(instruction.length)) return null;
  return { selector:comparison.lhs, selectorKey:expressionKey(comparison.lhs), min:0n, max:maximum,
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

function dispatchIsBounded(bounds, indirectJump, instructions, classifyControlFlow) {
  const jumpAddress = address(indirectJump.address);
  if (!bounds || jumpAddress == null || bounds.defaultAddress >= bounds.fallthroughAddress
      && bounds.defaultAddress <= jumpAddress) return false;
  const branchIndex = instructions.findIndex(item => address(item.address) === bounds.branchAddress);
  const jumpIndex = instructions.findIndex(item => address(item.address) === jumpAddress);
  if (branchIndex < 0 || jumpIndex <= branchIndex) return false;
  for (let index = branchIndex + 1; index < jumpIndex; index += 1) {
    if (controlFlowKind(instructions[index], classifyControlFlow) !== 'fallthrough') return false;
  }
  for (let index = 0; index < instructions.length; index += 1) {
    if (index === branchIndex || index === jumpIndex) continue;
    const item = instructions[index];
    const kind = controlFlowKind(item, classifyControlFlow);
    if (kind === 'fallthrough' || kind === 'return') continue;
    if (kind === 'unknown') return false;
    const target = address(immediate(operand(item, 0)));
    if (target == null) return false;
    if (target >= bounds.fallthroughAddress && target <= jumpAddress) return false;
  }
  return true;
}

function targetAddresses(segments, pattern, bounds) {
  if (!pattern || !bounds || expressionKey(pattern.indexValue) !== bounds.selectorKey) return null;
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
    const instructionAddresses = new Set(ordered.map(item => address(item.address).toString()));
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
        if (!dispatchIsBounded(bounds, instruction, ordered, classifyControlFlow)) {
          pendingJump = null;
          pendingTable = null;
          bounds = null;
          comparison = null;
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

      const flowKind = controlFlowKind(instruction, classifyControlFlow);
      const resolvedBounds = boundedFallthrough(instruction, comparison, ordered);
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
          const value = address(instruction.address) + BigInt(instruction.length) + displacement;
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
          storeStackValue(first, value, state);
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
          writeRegister(destination, { kind:'subtract', left:lhs, right:constant.toString(), widthBits:destination.viewBits }, state);
        }
        pendingTable = null;
        pendingJump = null;
        continue;
      }

      if (family === 'add') {
        const destination = register(first), source = register(second);
        if (destination && source) {
          const left = readRegister(destination, state), right = readRegister(source, state);
          writeRegister(destination, { kind:'add', left, right, widthBits:destination.viewBits }, state);
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
          if (written) state.registers.delete(written.physicalId);
          else if (item?.type === 'memory') storeStackValue(item, null, state);
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
