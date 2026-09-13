import assert from 'node:assert/strict';
import test from 'node:test';

import { Backend } from '../../js/backend.js';

// Issue #4179: Mach-O asm search must pick the producer by the active slice's
// canonical architecture, never by format alone. The legacy worker is a
// fixed-width ARM64 decoder (INSN_SIZE=4); sending x86_64/RISC-V bytes to it
// fabricates false mnemonic hits. Non-ARM64 asm search must therefore route to
// the platform producer, which fails closed (unsupported) for asm, and never
// fall back to the ARM64 decoder.

function machoBackend(architecture) {
  const backend = new Backend();
  backend.formatId = 'macho';
  const routes = [];
  backend._callTo = (worker, t, payload) => {
    routes.push({ worker, t, payload });
    return Promise.resolve(worker === 'platform'
      ? { cancelled: false, results: [], scanned: 0, capped: false, unsupported: true }
      : { results: [], scanned: 0, capped: false, cancelled: false });
  };
  if (architecture != null) backend._activeMachArchitecture = architecture;
  return { backend, routes };
}

test('x86_64 Mach-O asm search routes to the platform producer, not the legacy ARM64 worker (#4179)', async () => {
  const { backend, routes } = machoBackend('x86_64');
  await backend.search({ regionId: 'text', kind: 'asm', query: 'nop' }, null);
  assert.equal(routes.at(-1).worker, 'platform', 'non-ARM64 asm search must not use the legacy ARM64 decoder');
  backend.dispose();
});

test('riscv64 Mach-O asm search routes to the platform producer (#4179)', async () => {
  const { backend, routes } = machoBackend('riscv64');
  await backend.search({ regionId: 'text', kind: 'asm', query: 'addi' }, null);
  assert.equal(routes.at(-1).worker, 'platform');
  backend.dispose();
});

test('arm64 / arm64e / arm64_32 Mach-O asm search keeps the legacy ARM64 route (#4179)', async () => {
  for (const architecture of ['arm64', 'arm64e', 'arm64_32']) {
    const { backend, routes } = machoBackend(architecture);
    await backend.search({ regionId: 'text', kind: 'asm', query: 'add' }, null);
    assert.equal(routes.at(-1).worker, 'legacy', `${architecture} asm search must remain on the ARM64 legacy worker`);
    backend.dispose();
  }
});

test('explicit architecture parameter overrides the active slice for asm search routing (#4179)', async () => {
  const { backend, routes } = machoBackend(null);
  await backend.search({ regionId: 'text', kind: 'asm', query: 'nop', architecture: 'X86_64' }, null);
  assert.equal(routes.at(-1).worker, 'platform', 'caller-supplied architecture is the canonical routing input');
  backend.dispose();
});

test('hex/text Mach-O search is not rerouted by architecture (byte search is arch-neutral) (#4179)', async () => {
  for (const kind of ['hex', 'text']) {
    const { backend, routes } = machoBackend('x86_64');
    await backend.search({ regionId: 'text', kind, query: 'a', hex: { bytes: [0], mask: [0xff] } }, null);
    assert.equal(routes.at(-1).worker, 'legacy', `${kind} search semantics must be preserved`);
    backend.dispose();
  }
});

test('only confirmed ARM64 uses the legacy ARM64 decoder: unknown asm search fails closed to the platform producer (#4179)', async () => {
  const { backend, routes } = machoBackend('unknown');
  await backend.search({ regionId: 'text', kind: 'asm', query: 'nop' }, null);
  assert.equal(routes.at(-1).worker, 'platform', 'an unconfirmed architecture must not reach the ARM64 decoder');
  backend.dispose();
});

test('a Mach-O with no architecture information at all preserves the current legacy route (#4179)', async () => {
  const { backend, routes } = machoBackend(null);
  await backend.search({ regionId: 'text', kind: 'asm', query: 'nop' }, null);
  assert.equal(routes.at(-1).worker, 'legacy', 'absence of architecture keeps the established default routing');
  backend.dispose();
});

test('platformInfo capability is the routing fallback when no explicit/active architecture is known (#4179)', async () => {
  const { backend, routes } = machoBackend(null);
  backend.platformInfo = { capability: { architecture: 'x86_64' } };
  await backend.search({ regionId: 'text', kind: 'asm', query: 'nop' }, null);
  assert.equal(routes.at(-1).worker, 'platform');
  backend.dispose();
});

test('non-Mach-O formats are untouched by the architecture routing (#4179)', async () => {
  const backend = new Backend();
  backend.formatId = 'elf';
  const routes = [];
  backend._callTo = (worker, t, payload) => { routes.push({ worker, t, payload }); return Promise.resolve({ results: [] }); };
  await backend.search({ regionId: 'text', kind: 'asm', query: 'addi' }, null);
  assert.equal(routes.at(-1).worker, 'platform', 'ELF already used the platform producer before the fix');
  backend.dispose();
});
