/** Bounded data-only snapshots at query boundaries, not a general deserializer.
 * In particular, caller slice/iterator/some implementations carry no authority.
 */
import { QueryFailure } from './query-state.js';
export function queryRecord(object, guard = null, maximum = 64) {
  if (!object || typeof object !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(object))) {
    throw new QueryFailure('non-data-request');
  }
  const keys = Object.getOwnPropertyNames(object);
  if (keys.length > maximum || Object.getOwnPropertySymbols(object).length) throw new QueryFailure('budget:request-fields');
  guard?.take('workItems', keys.length);
  const out = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new QueryFailure('request-accessor');
    Object.defineProperty(out, key, { value:descriptor.value, enumerable:true });
  }
  return Object.freeze(out);
}
export function queryArray(array, guard = null, maximum = 4096) {
  if (!Array.isArray(array) || array.length > maximum) throw new QueryFailure('invalid-or-budgeted-array');
  guard?.take('workItems', array.length);
  const out = [];
  for (let index = 0; index < array.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new QueryFailure('non-data-array');
    out.push(descriptor.value);
  }
  return Object.freeze(out);
}
