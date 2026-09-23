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
import { isCanonicalCppMemberEvidence, isCanonicalCppReceiverEvidence } from '../../../js/analysis/cxx/object-evidence.js';
import { buildCxxFixtures } from './fixtures/build.mjs';
import { openCxxFixture } from './fixtures/open.mjs';

const FIXTURE = 'game-rtti-o0';
const MEMBER = '_ZN6Player10takeDamageEi';
const FREE_FUNCTION = '_Z10readHealthP6Entity';

function objdumpTool() {
  // LLVM objdump only. GNU objdump rejects an AArch64 fixture
  // (`can't disassemble for architecture UNKNOWN`) unless the host binutils was
  // built with that target, and it does not accept the symbol selector this test
  // uses, so accepting a GNU `objdump` would leave `skip` false and fail every
  // assertion with no rows. The selector itself is `--disassemble-symbols=`:
  // measured against LLVM 14.0.0 and LLVM 18.1.3, both reject the newer-looking
  // `--disassemble=<symbol>` with `unknown argument`. Requiring the version
  // banner keeps the skip honest instead of silently measuring nothing.
  //
  // The versioned binary is preferred where it exists: LLVM 14 emits no rows at
  // all for a symbol that shares its address with another symbol, which is how a
  // constructor/destructor alias would otherwise measure as "no evidence".
  for (const candidate of [process.env.LLVM_OBJDUMP, 'llvm-objdump-18', 'llvm-objdump']) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    if (!/LLVM/i.test(probe.stdout || '')) continue;
    return candidate;
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

test('the analysis entrypoint projects typed member evidence for a proven receiver', { skip }, async () => {
  const rows = disassemble(built.artifacts[FIXTURE].path, MEMBER, tool);
  assert.ok(rows, 'fixture must disassemble');

  const provider = providerFor(openProbe());
  await provider.build();

  const result = analyzeSemanticFunction({ ...decodedInput(rows, MEMBER), cxxEvidenceProvider: provider });
  assert.match(result.decompiler?.pseudocode || '', /this->field_8\s*\/\* int32_t\|uint32_t \*\//,
    'real compiler spill/reload must carry the proven member type into pseudocode');

  const attempt = provider.lastAttempt();
  assert.equal(attempt.functionAddress, rows[0].address,
    'the answer must belong to the function that was asked about');
  const projection = attempt.projection;
  assert.ok(projection, 'the seam must have projected evidence');
  assert.equal(projection.receiver.receiverRole, 'this');
  assert.equal(projection.members.length >= 1, true,
    'Player::takeDamage touches at least one member');

  for (const member of projection.members) {
    assert.equal(isCanonicalCppMemberEvidence(member), true);
    assert.equal(member.accessProven, true, 'every member offset is binary-grounded');
    assert.equal(member.receiverDigest, projection.receiver.digest);
    assert.equal(member.functionId, projection.functionId);
    // The producer never invents a field name; only a category may appear.
    assert.equal(typeof member.offsetBytes, 'bigint');
    if (member.typeProven) {
      assert.equal(typeof member.typeLabel, 'string');
      assert.equal(typeof member.rule, 'string');
    } else {
      assert.equal(typeof member.reason, 'string');
    }
  }

  // `health`/`state` are plain 4-byte aggregates in the fixture, so the honest
  // answer is a width-proven integer pair, not a claimed signedness.
  const typed = projection.members.filter((member) => member.typeProven);
  assert.equal(typed.length >= 1, true);
  for (const member of typed) assert.match(member.typeLabel, /int32_t/);
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
  assert.equal(provider.stats().memberFields, 0,
    'a free function\'s pointer argument is not a member base');
  assert.equal(provider.lastAttempt().projection, null,
    'the attempt must be recorded for the free function and prove nothing');
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

test('a caller cannot mint `this` by replaying canonical evidence', { skip }, async () => {
  const memberRows = disassemble(built.artifacts[FIXTURE].path, MEMBER, tool);
  const freeRows = disassemble(built.artifacts[FIXTURE].path, FREE_FUNCTION, tool);
  assert.ok(memberRows && freeRows);

  const probe = openProbe();
  const provider = providerFor(probe);
  await provider.build();
  const projection = provider.projectForFunction({
    functionId: 'fn:player-take-damage',
    functionAddress: symbolAddressOf(probe, MEMBER),
    functionName: MEMBER,
    ir: { values: [{ id: 'arg0', kind: 'arg', reg: 'x0', bits: 64 }], instructions: [] },
  });
  assert.ok(projection, 'control: the evidence itself is canonical');
  // The object is not a look-alike: it came from the canonical producer and
  // passes the canonicality gate the seam applies to caller input.
  assert.equal(isCanonicalCppReceiverEvidence(projection.receiver), true,
    'control: the replayed receiver is genuinely canonical');

  // Replayed against a function it was not issued for.
  const replayed = analyzeSemanticFunction({
    ...decodedInput(freeRows, FREE_FUNCTION),
    cxxEvidence: { receiver: projection.receiver, virtualSlots: [] },
  });
  assert.ok(replayed.decompiler?.pseudocode);
  assert.doesNotMatch(replayed.decompiler.pseudocode, /\bthis\b/,
    'evidence must not be replayable against another function');

  // Replayed against its OWN address. Canonicality plus a matching function
  // address is still not authority: the receiver must additionally bind to a
  // value the pipeline itself produced for this function, which is why a
  // caller who holds the producer's output still cannot mint `this`.
  assert.equal(BigInt(projection.receiver.functionAddress), memberRows[0].address,
    'the address in the evidence already matches the replay target');
  const sameAddress = analyzeSemanticFunction({
    ...decodedInput(memberRows, MEMBER),
    cxxEvidence: { receiver: projection.receiver, virtualSlots: [] },
  });
  assert.ok(sameAddress.decompiler?.pseudocode);
  assert.doesNotMatch(sameAddress.decompiler.pseudocode, /\bthis\b/,
    'canonicality and a matching address are still not authority');

  // Positive control: the pipeline CAN establish that binding, but only by
  // running the provider against the function's own canonical IR.
  const issued = analyzeSemanticFunction({
    ...decodedInput(memberRows, MEMBER),
    cxxEvidenceProvider: provider,
  });
  assert.match(issued.decompiler.pseudocode, /\bthis\b/,
    'the control must project when the pipeline issues the evidence itself');
});
