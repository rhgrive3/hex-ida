import assert from 'node:assert/strict';
import {
  CAPABILITY_STATUS,
  architectureMaturity,
  formatMaturity,
  managedMaturity,
  normalizeArchitectureCapabilityId,
  normalizeFormatCapabilityId,
  normalizeManagedCapabilityId,
} from '../js/platform/capability-maturity.js';
import { supportTruthForImage } from '../js/platform/support-capability.js';

function assertUnknownMaturity(actual, kind, limitation) {
  assert.equal(actual.kind, kind);
  assert.equal(actual.id, 'unknown');
  assert.equal(actual.status, CAPABILITY_STATUS.UNSUPPORTED);
  assert.equal(actual.implementedLevel, null);
  assert.equal(actual.level, null);
  assert.deepEqual(actual.features, {});
  assert.ok(actual.limitations.includes(limitation));
}

// Canonical primitive aliases remain compatible.
assert.equal(normalizeArchitectureCapabilityId(' AARCH64 '), 'arm64');
assert.equal(normalizeArchitectureCapabilityId('amd64'), 'x86_64');
assert.equal(normalizeArchitectureCapabilityId('x64'), 'x86_64');
assert.equal(normalizeArchitectureCapabilityId('rv64'), 'riscv64');
assert.equal(normalizeArchitectureCapabilityId('RISCV64GC'), 'riscv64');
assert.equal(normalizeFormatCapabilityId(' Mach-O '), 'macho');
assert.equal(normalizeFormatCapabilityId('mach_o'), 'macho');
assert.equal(normalizeFormatCapabilityId('PE32+'), 'pe');
assert.equal(normalizeManagedCapabilityId(' WebAssembly '), 'wasm');
assert.equal(normalizeManagedCapabilityId('dotnet'), 'cil');
assert.equal(normalizeManagedCapabilityId('.NET'), 'cil');
assert.equal(normalizeManagedCapabilityId('apk'), 'dex');
assert.equal(normalizeManagedCapabilityId('jar'), 'jvm');

// Nullish/blank input preserves the established unknown sentinel.
for (const value of [undefined, null, '', '   ']) {
  assert.equal(normalizeArchitectureCapabilityId(value), 'unknown');
  assert.equal(normalizeFormatCapabilityId(value), 'unknown');
  assert.equal(normalizeManagedCapabilityId(value), 'unknown');
}

for (const value of [false, true, 0, 1, 1n, Symbol('arm64'), () => 'arm64']) {
  assert.equal(normalizeArchitectureCapabilityId(value), 'unknown');
  assert.equal(normalizeFormatCapabilityId(value), 'unknown');
  assert.equal(normalizeManagedCapabilityId(value), 'unknown');
}

// Structured or otherwise non-string identity cannot mint a known support profile.
const structuredCases = [
  ['architecture array', ['arm64'], normalizeArchitectureCapabilityId, architectureMaturity, 'architecture', 'unknown-architecture'],
  ['architecture object', { toString() { return 'x86_64'; } }, normalizeArchitectureCapabilityId, architectureMaturity, 'architecture', 'unknown-architecture'],
  ['architecture boxed string', new String('riscv64'), normalizeArchitectureCapabilityId, architectureMaturity, 'architecture', 'unknown-architecture'],
  ['format array', ['elf'], normalizeFormatCapabilityId, formatMaturity, 'format', 'unknown-format'],
  ['format boxed string', new String('macho'), normalizeFormatCapabilityId, formatMaturity, 'format', 'unknown-format'],
  ['managed array', ['wasm'], normalizeManagedCapabilityId, managedMaturity, 'managed', 'managed-frontend-unsupported'],
  ['managed object', { toString() { return 'dex'; } }, normalizeManagedCapabilityId, managedMaturity, 'managed', 'managed-frontend-unsupported'],
  ['managed boxed string', new String('jvm'), normalizeManagedCapabilityId, managedMaturity, 'managed', 'managed-frontend-unsupported'],
];
for (const [label, value, normalize, maturity, kind, limitation] of structuredCases) {
  assert.equal(normalize(value), 'unknown', `${label} must normalize fail-closed`);
  assertUnknownMaturity(maturity(value), kind, limitation);
}

// Reject without consulting attacker-controlled coercion hooks.
let coercionReads = 0;
const hostile = new Proxy({}, {
  get(target, property, receiver) {
    if (property === Symbol.toPrimitive || property === 'toString' || property === 'valueOf') coercionReads += 1;
    return Reflect.get(target, property, receiver);
  },
});
for (const normalize of [
  normalizeArchitectureCapabilityId,
  normalizeFormatCapabilityId,
  normalizeManagedCapabilityId,
]) {
  assert.equal(normalize(hostile), 'unknown');
}
assert.equal(coercionReads, 0, 'capability identity validation must not read coercion hooks');

// The real support consumer must preserve valid loader metadata and fail closed on structured metadata.
const validTruth = supportTruthForImage(
  { arch: 'x86_64', format: 'elf' },
  { engine: { x86_64: true }, managedFrontend: 'webassembly' },
);
assert.equal(validTruth.architecture.id, 'x86_64');
assert.equal(validTruth.architecture.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(validTruth.format.id, 'elf');
assert.equal(validTruth.format.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(validTruth.managed.id, 'wasm');
assert.equal(validTruth.managed.status, CAPABILITY_STATUS.PARTIAL);

const malformedTruth = supportTruthForImage(
  { arch: ['arm64'], format: new String('macho') },
  { engine: { arm64: true }, managedFrontend: ['wasm'] },
);
assertUnknownMaturity(malformedTruth.architecture, 'architecture', 'unknown-architecture');
assertUnknownMaturity(malformedTruth.format, 'format', 'unknown-format');
assertUnknownMaturity(malformedTruth.managed, 'managed', 'managed-frontend-unsupported');

console.log('issue #5179 capability identity type-boundary regression: PASS');
