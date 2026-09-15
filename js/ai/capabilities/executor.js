import { AIError } from '../schema.js';
import { CapabilityExecutor as BaseCapabilityExecutor } from './executor-base.js';

export * from './executor-base.js';

function runtimeSession(platform) {
  const session = platform?.currentSession?.(false);
  if (!session?.adapter) throw new AIError('tool_failed', 'Runtime adapter is unavailable.');
  return session;
}

function byteArray(value) {
  if (!Array.isArray(value) && !(value instanceof Uint8Array)) {
    throw new AIError('invalid_tool_call', 'Mutation bytes must be an Array or Uint8Array.');
  }
  const raw = Array.from(value);
  for (const byte of raw) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new AIError('invalid_tool_call', 'Mutation contains a non-byte value.');
    }
  }
  return Uint8Array.from(raw);
}

function equalBytes(a, b) {
  return a?.length === b?.length && Array.from(a).every((value, index) => value === b[index]);
}

function staleError(error) {
  return error?.code === 'stale-target'
    || error?.code === 'stale-request'
    || error?.stale === true
    || /stale/i.test(String(error?.message || ''));
}

function sessionSnapshot(session) {
  return Object.freeze({
    id: session?.id ?? null,
    generation: session?.generation ?? null,
    adapterEpoch: session?.adapter?.epoch ?? null,
  });
}

function sameSessionSnapshot(before, session) {
  if (!session) return false;
  if (before.id != null && session.id !== before.id) return false;
  if (before.generation != null && session.generation !== before.generation) return false;
  if (before.adapterEpoch != null && session.adapter?.epoch !== before.adapterEpoch) return false;
  return true;
}

function assertSessionSnapshot(runtimePlatform, before) {
  const current = runtimePlatform?.currentSession?.(false);
  if (!sameSessionSnapshot(before, current)) {
    throw new AIError('tool_failed', 'Runtime memory target is stale: session generation changed during atomic write.');
  }
}

async function atomicBoundedMemoryWrite(runtimePlatform, args, options = {}) {
  const session = runtimeSession(runtimePlatform);
  const adapter = session.adapter;
  const bytes = byteArray(args.bytes);
  const expected = byteArray(args.expectedBefore);
  if (!bytes.length || bytes.length > 64 * 1024 || bytes.length !== expected.length) {
    throw new AIError(
      'invalid_tool_call',
      'Runtime write bytes and expected-before must have the same length between 1 and 65536.',
    );
  }

  // #5812: a split read -> compare -> write sequence cannot establish the
  // expected-before precondition at the mutation linearization point. The
  // adapter must expose an explicitly atomic primitive. A method with the same
  // name but without the authority marker is deliberately not trusted: older
  // adapters implemented this as two independent operations and retained the
  // TOCTOU window.
  if (adapter.compareAndWriteMemoryAtomic !== true || typeof adapter.compareAndWriteMemory !== 'function') {
    throw new AIError(
      'tool_failed',
      'Runtime adapter does not provide an atomic compare-and-write memory primitive.',
    );
  }

  const before = sessionSnapshot(session);
  let result;
  try {
    result = await adapter.compareAndWriteMemory(args.address, expected, bytes, {
      signal: options?.signal || null,
      expectedSessionId: before.id,
      expectedGeneration: before.generation,
      expectedEpoch: before.adapterEpoch,
    });
  } catch (error) {
    if (staleError(error)) {
      throw new AIError(
        'tool_failed',
        `Runtime memory target is stale: ${error?.message || 'atomic compare-and-write rejected the expected-before state.'}`,
      );
    }
    throw error instanceof AIError
      ? error
      : new AIError('tool_failed', error?.message || 'Runtime atomic memory write failed.');
  }

  assertSessionSnapshot(runtimePlatform, before);

  if (result?.written != null && (
    typeof result.written !== 'number'
    || !Number.isSafeInteger(result.written)
    || result.written !== bytes.length
  )) {
    throw new AIError('tool_failed', 'Runtime atomic memory write returned an invalid written count.');
  }

  // Read-back is postcondition verification only; it is never used as the
  // authority for the compare step and is never rolled back from a stale
  // snapshot. A concurrent mutation after the atomic write therefore fails
  // closed instead of overwriting the newer target state.
  const after = await adapter.readMemory(args.address, bytes.length);
  assertSessionSnapshot(runtimePlatform, before);
  if (!equalBytes(after, bytes)) {
    throw new AIError('tool_failed', 'Runtime memory write postcondition verification failed.');
  }

  return {
    address: String(args.address),
    written: bytes.length,
    before: Array.from(expected),
    after: Array.from(bytes),
  };
}

export class CapabilityExecutor extends BaseCapabilityExecutor {
  async executeBuiltIn(entry, args, options, runtimePlatform = null) {
    if (entry.id === 'runtime.memory-write') {
      return atomicBoundedMemoryWrite(runtimePlatform, args, options);
    }
    return super.executeBuiltIn(entry, args, options, runtimePlatform);
  }
}

export function createCapabilityExecutor(options) {
  return new CapabilityExecutor(options);
}
