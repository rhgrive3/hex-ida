import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makePinpointAnalyzer } from '../../js/ui/pinpoint-runtime.js';

function appFor({ architecture = 'arm64', fixedInstructionSize = 4, regions = [] } = {}) {
  const calls = { legacy: 0, owner: null, startRow: null };
  const app = {
    store: { get(key) {
      if (key === 'canDisassemble') return true;
      if (key === 'architecture') return architecture;
      if (key === 'capability') return { architecture, fixedInstructionSize };
      return null;
    } },
    backend: {},
    symbols: { functionWindowBound: () => null },
    executableRegionFor(addr) {
      const a = BigInt(addr);
      return regions.find((r) => a >= r.vmAddr && a < r.vmAddr + r.size) || null;
    },
  };
  const legacy = async (_backend, owner, startRow) => {
    calls.legacy++;
    calls.owner = owner;
    calls.startRow = startRow;
    return { model: { legacy: true } };
  };
  return { app, calls, legacy };
}

const primary = { id: 'primary', vmAddr: 0x1000n, size: 0x1000n };
const secondary = { id: 'cold', vmAddr: 0x5000n, size: 0x1000n };

{
  const { app, calls, legacy } = appFor({ regions: [primary, secondary] });
  const analyze = makePinpointAnalyzer(app, primary, null, legacy);
  assert.deepEqual(await analyze(0x5100n, 0x5180n), { legacy: true });
  assert.equal(calls.owner, secondary);
  assert.equal(calls.startRow, 0x40);
  assert.equal(calls.legacy, 1);
}

{
  const { app, calls, legacy } = appFor({ regions: [primary] });
  const analyze = makePinpointAnalyzer(app, primary, null, legacy);
  assert.equal(await analyze(0x5000n, 0x5040n), null);
  assert.equal(calls.legacy, 0);
}

{
  const { app, calls, legacy } = appFor({ architecture: 'x86_64', fixedInstructionSize: null, regions: [primary] });
  const analyze = makePinpointAnalyzer(app, primary, null, legacy);
  assert.equal(await analyze(0x1001n, 0x1010n), null);
  assert.equal(calls.legacy, 0);
}

const source = fs.readFileSync(new URL('../../js/panels-base.js', import.meta.url), 'utf8');
const reportStart = source.indexOf('function functionAnalysisWindow');
const reportEnd = source.indexOf('function renderFunctionReport', reportStart);
assert.ok(reportStart >= 0 && reportEnd > reportStart);
const report = source.slice(reportStart, reportEnd);
assert.match(report, /validatedFunctionRange/);
assert.match(report, /executableRegionFor/);
assert.doesNotMatch(report, /app\.codeRegion\(/);
assert.doesNotMatch(report, /app\.selectRegion\(/);
assert.doesNotMatch(report, /app\.viewer\.totalRows/);
assert.match(source, /app\.goToAddress\(region\.vmAddr \+ BigInt\(f\.row\) \* 4n/);

const irStart = source.indexOf('async function attachIrFlow');
const irEnd = source.indexOf('export function showPinned', irStart);
assert.ok(irStart >= 0 && irEnd > irStart);
const ir = source.slice(irStart, irEnd);
assert.match(ir, /functionAnalysisWindow\(app, addr\)/);
assert.doesNotMatch(ir, /app\.codeRegion\(/);
assert.match(ir, /model = await analyze\(start, end\)/);
assert.match(ir, /BigInt\(a\) - region\.vmAddr/);

console.log('issue-2541-address-owned-analysis: PASS');
