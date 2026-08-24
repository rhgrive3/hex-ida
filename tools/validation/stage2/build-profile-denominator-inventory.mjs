import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUTPUT = path.join(ROOT, 'tools/validation/stage2/profile-denominator-inventory.json');
const GENERATOR_REF = 'tools/validation/stage2/build-profile-denominator-inventory.mjs';

const a2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/machine-effects/a2-denominator-inventory.json'), 'utf8'));
const phase12 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase12/denominator-inventory.json'), 'utf8'));

function sorted(values) { return [...new Set(values.map(String))].sort(); }
function item(profiles, unitIds, inventoryRefs) {
  return { profiles: sorted(profiles), unitIds: sorted(unitIds), inventoryRefs: sorted([GENERATOR_REF, ...inventoryRefs]) };
}
function units(profiles, names) { return profiles.flatMap((profile) => names.map((name) => `${profile}:${name}`)); }

const nativeProfiles = ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'];
const nativeRuntimeCapabilities = [
  'attach', 'breakpointAddress', 'cancel', 'connect', 'disconnect', 'modules', 'pause',
  'readMemory', 'readRegisters', 'removeBreakpoint', 'resume', 'stepInto', 'threads', 'writeMemory',
];
const managedRuntimeCapabilities = [
  'backtrace', 'cancel', 'connect', 'disconnect', 'modules', 'pause', 'readMemory',
  'readRegisters', 'resume', 'stepInto', 'threads',
];
const managedStaticUnits = [
  'container-and-version-profile', 'metadata-denominator', 'opcode-denominator',
  'provider-and-module-binding', 'real-compiled-fixture', 'negative-corpus', 'bounded-runtime-state',
];
const rebuildUnits = [
  'transaction-identity', 'layout-and-structure', 'relocations-and-bindings', 'branch-ranges',
  'unwind-and-debug', 'imports-and-exports', 'signature-consequence', 'loader-reparse',
  'independent-differential-oracle', 'atomic-publication', 'real-fixture', 'negative-validator-corpus',
];

const a2Units = [];
for (const architecture of a2.architectures) {
  const profile = architecture.profileId;
  // Exact decoder units remain in the canonical proof denominator even after
  // they stop appearing in the blocking-gap projection. Older inventories use
  // missingUnits as both the denominator and gap list, so preserve that shape.
  a2Units.push(...(architecture.decoder.units || architecture.decoder.missingUnits));
  for (const family of architecture.effectRegistry.families || []) {
    a2Units.push(`${profile}:effect-family:${family.id}`);
    for (const subunit of family.subunits || []) a2Units.push(`${profile}:effect-family:${family.id}:${subunit.id}`);
  }
  for (const alias of architecture.aliases || []) a2Units.push(`${profile}:alias:${alias.id}`);
  for (const exclusion of architecture.exclusions || []) a2Units.push(`${profile}:explicit-case:${exclusion.id}`);
  for (const mnemonic of architecture.pointerAuthenticationMnemonics || []) a2Units.push(`${profile}:pac-mnemonic:${mnemonic}`);
}

const phase12Category = Object.fromEntries(phase12.categories.map((category) => [category.id, category.units.map((unit) => unit.id)]));
const items = {
  'S1-A2-NATIVE': item(nativeProfiles, a2Units, [
    'tests/machine-effects/a2-denominator-inventory.json',
    'tools/validation/machine-effects/a2-denominator.mjs',
    'tools/validation/machine-effects/riscv64-rv64imc-denominator.mjs',
    'tests/machine-effects/riscv64-rv64imc-denominator.test.mjs',
    'tools/validation/machine-effects/x86-capstone-registry.mjs',
    'tests/machine-effects/x86-capstone-registry.test.mjs',
    'tools/validation/machine-effects/x86-long64-lea-denominator.mjs',
    'tests/machine-effects/x86-long64-lea-denominator.test.mjs',
  ]),
  'S2-A7-NATIVE': item(nativeProfiles, units(nativeProfiles, nativeRuntimeCapabilities), [
    'js/runtime/authority.js', 'js/runtime/stage2.js', 'tests/stage2/runtime-authority.test.mjs',
  ]),
};

for (const frontend of ['wasm', 'dex', 'cil', 'jvm']) {
  const id = `S2-M6-${frontend.toUpperCase()}`;
  const profile = `managed:${frontend}:m6`;
  items[id] = item([profile], units([profile], [...managedRuntimeCapabilities.map((name) => `runtime:${name}`), ...managedStaticUnits]), [
    'js/managed/runtime-binding.js',
    `js/managed/${frontend}/parser.js`,
    `tests/phase11/${frontend}/${frontend}-adversarial.test.mjs`,
    'tests/stage2/managed-runtime.test.mjs',
    'tests/stage2/fixtures/managed-real/manifest.json',
  ]);
}

for (const [format, profiles] of Object.entries({ macho: ['macho:64'], elf: ['elf:64'], pe: ['pe:pe32', 'pe:pe32+'] })) {
  items[`S2-F6-${format.toUpperCase()}`] = item(profiles, units(profiles, rebuildUnits), [
    'js/rebuild/transaction-v2.js',
    'tools/validation/rebuild-independent-oracle.mjs',
    'tests/stage2/rebuild-transaction.test.mjs',
    'tests/stage2/independent-oracle.test.mjs',
    'js/rebuild/format-safe.js',
    'tests/phase12/rebuild/f6-real-fixtures.test.mjs',
    'tests/phase12/rebuild/fixtures/manifest.json',
  ]);
}

for (const [id, category, profile] of [
  ['S2-P12-KNOWLEDGE', 'knowledge', 'knowledge-packages:v1'],
  ['S2-P12-RULES', 'rules', 'capability-rules:v1'],
  ['S2-P12-PATTERNS', 'patterns', 'patterns:read-only-v1'],
  ['S2-P12-COLLAB-REMOTE', 'remote-collaboration', 'collaboration:remote-security-v1'],
]) {
  items[id] = item([profile], phase12Category[category].map((unitId) => `${profile}:${unitId}`), [
    'tools/validation/phase12/denominator-inventory.json',
    'tools/validation/phase12/denominator.mjs',
  ]);
}

export function buildStage2ProfileDenominatorInventory() {
  return {
    schemaVersion: 'hex-stage2-profile-denominator-inventory/v1',
    generatedFrom: [
      'tests/machine-effects/a2-denominator-inventory.json',
      'tools/validation/phase12/denominator-inventory.json',
    ],
    items,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUTPUT, `${JSON.stringify(buildStage2ProfileDenominatorInventory(), null, 2)}\n`);
}
