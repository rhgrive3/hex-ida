import assert from 'node:assert/strict';
import { makePinpointAnalyzer } from '../../js/ui/pinpoint-runtime.js';

function appFor({ architecture, fixedInstructionSize, queryValue, withQueries = true }) {
  const calls = { snapshots:0, functions:[], legacy:0 };
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
  if (withQueries) {
    app.analysisQueries = {
      async snapshot(options = {}) {
        calls.snapshots++;
        assert.equal(options.signal?.aborted, false);
        return { snapshotId:'s1' };
      },
      async function(snapshot, address, options = {}) {
        assert.equal(snapshot.snapshotId, 's1');
        assert.equal(options.signal?.aborted, false);
        calls.functions.push(address);
        return { completeness:'complete', value:queryValue };
      },
    };
  }
  const legacy = async (_backend, _region, startRow) => {
    calls.legacy++;
    calls.startRow = startRow;
    return { model:{ legacy:true } };
  };
  return { app, calls, legacy };
}

const region = { id:'text', vmAddr:0x1000n, size:0x100n };
const activeSignal = new AbortController().signal;

{
  const { app, calls, legacy } = appFor({ architecture:'x86_64', fixedInstructionSize:null, queryValue:{ architectureId:'x86_64', semanticIR:{ instructions:[] } } });
  const analyze = makePinpointAnalyzer(app, region, activeSignal, legacy);
  assert.equal(await analyze(0x1001n, 0x1010n), null);
  assert.deepEqual(calls.functions, [0x1001n]);
  assert.equal(calls.legacy, 0);
}

{
  const { app, calls, legacy } = appFor({ architecture:'riscv64', fixedInstructionSize:null, queryValue:{ architectureId:'riscv64', semanticIR:{ instructions:[] } } });
  const analyze = makePinpointAnalyzer(app, region, activeSignal, legacy);
  assert.equal(await analyze(0x1002n, 0x1010n), null);
  assert.deepEqual(calls.functions, [0x1002n]);
  assert.equal(calls.legacy, 0);
}

{
  const canonicalModel = { canonical:true };
  const { app, calls, legacy } = appFor({ architecture:'arm64', fixedInstructionSize:4, queryValue:{ architectureId:'arm64', model:canonicalModel } });
  const analyze = makePinpointAnalyzer(app, region, activeSignal, legacy);
  assert.equal(await analyze(0x1004n, 0x1010n), canonicalModel);
  assert.deepEqual(calls.functions, [0x1004n]);
  assert.equal(calls.legacy, 0);
}

{
  const { app, calls, legacy } = appFor({ architecture:'arm64e', fixedInstructionSize:4, queryValue:null, withQueries:false });
  const analyze = makePinpointAnalyzer(app, region, null, legacy);
  assert.deepEqual(await analyze(0x1004n, 0x1010n), { legacy:true });
  assert.equal(calls.startRow, 1);
  assert.equal(calls.legacy, 1);
}

{
  const { app, calls, legacy } = appFor({ architecture:'unknown', fixedInstructionSize:null, queryValue:null, withQueries:false });
  const analyze = makePinpointAnalyzer(app, region, null, legacy);
  assert.equal(await analyze(0x1004n, 0x1010n), null);
  assert.equal(calls.legacy, 0);
}

console.log('issue-2601-pinpoint-architecture-query: PASS');
