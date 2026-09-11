import assert from 'node:assert/strict';
import { makePinpointAnalyzer } from '../js/ui/pinpoint-runtime.js';

// Issue #5818: the legacy row-based fallback is valid only for proven 4-byte
// ARM64/AArch64 streams. An app whose architecture metadata is absent/unknown
// must fail closed (return null) instead of running 4-byte ARM64 row math.

function appFor({ architecture, fixedInstructionSize }) {
  let legacyCalled = false;
  const app = {
    store: {
      get(key) {
        if (key === 'canDisassemble') return true;
        if (key === 'architecture') return architecture;
        if (key === 'capability') return { architecture, fixedInstructionSize };
        return null;
      },
    },
    backend: {},
    symbols: { functionWindowBound: () => 0x1040n },
  };
  const legacy = async () => { legacyCalled = true; return { model: {} }; };
  return { app, legacy, wasCalled: () => legacyCalled };
}

const region = { id: 'text', vmAddr: 0x1000n, size: 0x100n };

for (const [label, fixture] of Object.entries({
  'null architecture': { architecture: null, fixedInstructionSize: null },
  'unknown architecture': { architecture: 'unknown', fixedInstructionSize: null },
  'empty architecture': { architecture: '', fixedInstructionSize: null },
  'x86_64 variable-length': { architecture: 'x86_64', fixedInstructionSize: null },
})) {
  const { app, legacy, wasCalled } = appFor(fixture);
  const analyze = makePinpointAnalyzer(app, region, null, legacy);
  const result = await analyze(0x1004n, 0x1010n);
  assert.equal(result, null, `${label}: fallback must fail closed`);
  assert.equal(wasCalled(), false, `${label}: 4-byte row analyzer must not run`);
}

// Proven ARM64 (arch + 4-byte fixed size) keeps the compatibility fallback.
{
  const { app, legacy, wasCalled } = appFor({ architecture: 'arm64', fixedInstructionSize: 4 });
  const analyze = makePinpointAnalyzer(app, region, null, legacy);
  const result = await analyze(0x1004n, 0x1010n);
  assert.equal(wasCalled(), true, 'proven arm64 candidate reaches the row analyzer');
  assert.deepEqual(result, {}, 'the legacy model is surfaced');
}

// Proven arm64e with null fixed size also stays eligible (arch is the proof).
{
  const { app, legacy, wasCalled } = appFor({ architecture: 'arm64e', fixedInstructionSize: null });
  const analyze = makePinpointAnalyzer(app, region, null, legacy);
  await analyze(0x1004n, 0x1010n);
  assert.equal(wasCalled(), true);
}

console.log('issue-5818 legacy arm64 fallback requires positive architecture proof: ok');
