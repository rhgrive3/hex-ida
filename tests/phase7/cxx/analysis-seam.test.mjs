// End-to-end regression for the C++ evidence seam in the analysis entrypoint.
//
// The producer modules are only useful if a real report can carry their output.
// This test drives the canonical analysis entrypoint with a provider built from
// a real compiler-produced ARM64 ELF and asserts on the rendered pseudocode, so
// the whole chain is exercised: ELF -> vtable/RTTI evidence -> per-function
// receiver binding -> decompiled `this`.
//
// The negative controls matter as much as the positive one: the same entrypoint
// with no provider, and with a structural look-alike of the evidence, must both
// render exactly what they rendered before this seam existed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parseOperands } from '../../../js/arm64.js';
import { analyzeSemanticFunction } from '../../../js/analysis/semantic-function.js';
import { createCxxEvidenceProvider } from '../../../js/analysis/cxx/project.js';
import { buildCxxFixtures } from './fixtures/build.mjs';
import { openCxxFixture } from './fixtures/open.mjs';

const FIXTURE = 'game-rtti-o0';
const MEMBER = '_ZN6Player10takeDamageEi';
const FREE_FUNCTION = '_Z10readHealthP6Entity';

function objdumpTool() {
  for (const candidate of [process.env.LLVM_OBJDUMP, 'llvm-objdump', 'objdump']) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function disassemble(elfPath, symbol, tool) {
  const result = spawnSync(tool, [`--disassemble-symbols=${symbol}`, '--no-show-raw-insn', elfPath], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const rows = [];
  for (const line of (result.stdout || '').split('\n')) {
    const match = /^\s*([0-9a-f]+):\s+([a-z][\w.]*)\s*(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      address: BigInt(`0x${match[1]}`),
      mnemonic: match[2],
      opStr: match[3].replace(/\s*\/\/.*$/, '').trim(),
    });
  }
  return rows.length ? rows : null;
}

/**
 * Real disassembly turned into the canonical decoded-instruction shape the
 * analysis entrypoint consumes. Nothing here is hand-written machine code.
 */
function decodedInput(rows, symbol) {
  return {
    architecture: 'arm64',
    platform: 'linux',
    abiId: 'aapcs64',
    mode: 'a64',
    decoderSemanticVersion: 'cxx-projection-seam-v1',
    binaryId: 'cxx-projection-seam-binary',
    sliceId: 'cxx-projection-seam-slice',
    name: symbol,
    instructions: rows.map((row, index) => ({
      address: row.address,
      size: 4,
      length: 4,
      mode: 'a64',
      mnemonic: row.mnemonic,
      opStr: row.opStr,
      ops: parseOperands(row.opStr),
      instructionId: `cxx-seam-${index}`,
      origin: { instructionIds: [`cxx-seam-${index}`] },
    })),
  };
}

function symbolAddressOf(probe, name) {
  for (let index = 0; index < probe.symbols.names.length; index++) {
    if (probe.symbols.names[index] === name) return probe.symbols.addrs[index];
  }
  return null;
}

function openProbe() {
  const probe = openCxxFixture(FIXTURE);
  assert.equal(probe.available, true, probe.reason ?? 'fixture unavailable');
  return probe;
}

function providerFor(probe) {
  return createCxxEvidenceProvider({
    symbols: probe.symbols,
    read: probe.read,
    pointerBytes: probe.pointerBytes,
    symbolSizeOf: probe.symbolSizeOf,
    sectionEndOf: probe.sectionEndOf,
    architecture: 'arm64',
    snapshotId: `fixture:${FIXTURE}`,
  });
}

const tool = objdumpTool();
const built = buildCxxFixtures();
const skip = tool && built.available
  ? false
  : `real ARM64 C++ fixture unavailable: ${tool ? built.reason : 'no llvm-objdump/objdump'}`;

test('the analysis entrypoint renders `this` from provider-held C++ evidence', { skip }, async () => {
  const rows = disassemble(built.artifacts[FIXTURE].path, MEMBER, tool);
  assert.ok(rows, 'fixture must disassemble');

  const provider = providerFor(openProbe());
  await provider.build();
  assert.equal(provider.stats().ready, true);

  const baseline = analyzeSemanticFunction(decodedInput(rows, MEMBER));
  const withProvider = analyzeSemanticFunction({
    ...decodedInput(rows, MEMBER),
    cxxEvidenceProvider: provider,
  });

  assert.ok(baseline.decompiler?.pseudocode, 'baseline must decompile');
  assert.ok(withProvider.decompiler?.pseudocode, 'provider run must decompile');

  assert.doesNotMatch(baseline.decompiler.pseudocode, /\bthis\b/,
    'without evidence the receiver must stay an ordinary argument');
  assert.match(withProvider.decompiler.pseudocode, /\bthis\b/,
    'a proven receiver must project as this');
  assert.equal(provider.stats().provided >= 1, true, 'the seam must have supplied evidence');
});

test('a free function never receives a receiver from the same provider', { skip }, async () => {
  const rows = disassemble(built.artifacts[FIXTURE].path, FREE_FUNCTION, tool);
  assert.ok(rows);

  const provider = providerFor(openProbe());
  await provider.build();

  const result = analyzeSemanticFunction({
    ...decodedInput(rows, FREE_FUNCTION),
    cxxEvidenceProvider: provider,
  });
  assert.ok(result.decompiler?.pseudocode);
  assert.doesNotMatch(result.decompiler.pseudocode, /\bthis\b/,
    'x0 in a free function is never this');
  assert.equal(provider.stats().provided, 0);
  assert.equal(provider.stats().unproven >= 1, true);
});

test('a structural look-alike of the evidence renders nothing', { skip }, async () => {
  const rows = disassemble(built.artifacts[FIXTURE].path, MEMBER, tool);
  assert.ok(rows);

  const probe = openProbe();
  const provider = providerFor(probe);
  await provider.build();

  const projection = provider.projectForFunction({
    functionId: 'fn:player-take-damage',
    functionAddress: symbolAddressOf(probe, MEMBER),
    functionName: MEMBER,
    ir: { values: [{ id: 'arg0', kind: 'arg', reg: 'x0', bits: 64 }], instructions: [] },
  });
  assert.ok(projection, 'control: the provider proves this receiver');

  // Correct-looking but non-canonical: it must be dropped, not rendered.
  const forged = { receiver: { ...projection.receiver }, virtualSlots: [] };
  const result = analyzeSemanticFunction({
    ...decodedInput(rows, MEMBER),
    cxxEvidence: forged,
  });
  assert.ok(result.decompiler?.pseudocode);
  assert.doesNotMatch(result.decompiler.pseudocode, /\bthis\b/,
    'a cloned receiver is not authority');
});
