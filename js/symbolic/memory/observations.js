/** Explicit, bounded terminal observations of the executor's own byte state.
 * Observation IDs are query-local memory endpoints, not SSA/alias identities.
 */
import { createBv } from '../expr/index.js';
import { translateExecutionValue, translateMemoryScalar } from '../translate/memory.js';
import { OP } from '../../ir-base.js';
import { QueryFailure } from './query-state.js';

function integer(value, reason) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new QueryFailure(reason);
}
function field(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new QueryFailure('observation-accessor');
  return descriptor?.value;
}
export function prepareMemoryObservations(requests = [], memory) {
  if (!Array.isArray(requests) || requests.length > 4096) throw new QueryFailure('memory-observation-limit');
  memory.chargeExecution(requests.length, requests.length);
  const seen = new Set();
  return Object.freeze(requests.map(request => {
    memory.chargeExecution();
    if (!request || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) throw new QueryFailure('invalid-memory-observation');
    const id = field(request, 'id'), size = field(request, 'size');
    const address = field(request, 'address'), addressValueId = field(request, 'addressValueId');
    if (typeof id !== 'string' || !id || id.length > 512 || seen.has(id)) throw new QueryFailure('invalid-observation-id');
    if (![1, 2, 4, 8].includes(size)) throw new QueryFailure('unsupported-access-width');
    if ((address != null) === (addressValueId != null)) throw new QueryFailure('ambiguous-observation-address');
    if (addressValueId != null && (typeof addressValueId !== 'string' || !addressValueId || addressValueId.length > 1024)) throw new QueryFailure('invalid-observation-value-id');
    const displacement = integer(field(request, 'displacement') ?? 0n, 'unsafe-displacement');
    seen.add(id);
    return Object.freeze({ id, size, ...(addressValueId != null ? { addressValueId } : { address: integer(address, 'unsafe-integer') }), displacement });
  }));
}
export function observeTerminalMemory(requests, state, options) {
  const memory = state.byteMemory;
  memory.chargeExecution(requests.length, requests.length);
  return Object.freeze(requests.map(request => {
    memory.chargeMemoryObservations();
    let address;
    const addressIds = [];
    if (request.addressValueId != null) {
      const value = state.semanticIdentities.get(request.addressValueId);
      if (!value || !state.values.has(value.id) && !state.scalarCache.has(value.id)) {
        throw new QueryFailure('observation-address-not-executed');
      }
      address = translateExecutionValue(value, state, options);
      addressIds.push(request.addressValueId);
      memory.validateExpression(address, memory.addressBits);
    } else {
      if (request.address < 0n || request.address >= (1n << BigInt(memory.addressBits))) throw new QueryFailure('address-out-of-range');
      address = createBv(memory.addressBits, request.address);
    }
    if (request.displacement !== 0n) {
      if (memory.wrapping === 'reject' && (address.kind !== 'const' || address.value + request.displacement < 0n || address.value + request.displacement >= (1n << BigInt(memory.addressBits)))) {
        throw new QueryFailure('effective-address-wrap-unproved');
      }
      address = translateMemoryScalar({ op: OP.BIN, subOp: 'add' }, [address, createBv(memory.addressBits, request.displacement)], memory.addressBits);
    }
    const result = memory.load(address, request.size);
    if (!result.expression) throw new QueryFailure(result.reason);
    state.taint?.observeMemory(request.id, [result.label, ...addressIds], state.control);
    return Object.freeze({ id: request.id, request, address, expression: result.expression });
  }));
}
