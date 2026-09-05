import assert from 'node:assert/strict';
import test from 'node:test';

import { InvestigationService } from '../../js/analysis/investigation-service.js';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';
import { installSharedWorkerBinaryIdentity } from '../../js/analysis/shared-binary-identity.js';

test('#3490 synchronous metadata producer failure is captured instead of hard-rejecting', async () => {
  const app = {
    backend:{ gen:1 },
    store:{ get(key) { return key === 'sliceIndex' ? 0 : null; } },
    ensureObjc() { throw new Error('objc-sync-failed'); },
    ensureSwift() { return Promise.resolve(); },
  };

  const metadata = await new InvestigationService(app).ensureMetadata();
  assert.equal(metadata.complete, false);
  assert.deepEqual(metadata.reasons, ['objc-sync-failed']);
});

test('#4012 malformed present RISC-V bitness cannot become default 64-bit ABI authority', async () => {
  const region = { id:'text', vmAddr:0n, size:0x100n, exec:true };

  const run = async (summary) => {
    let request = null;
    const app = {
      store:{ architecture:'riscv64' },
      backend:{
        gen:0,
        async binaryMetadata() { return { summary, metadata:{ flags:0 } }; },
        async analyzeSemanticFunction(value) {
          request = value;
          return { completeness:'complete' };
        },
      },
      symbols:{
        functionAt() { return { start:0n, end:4n }; },
        nameAt() { return null; },
      },
      validatedFunctionRange() {
        return {
          ok:true, start:0n, end:4n, region,
          function:{ start:0n, end:4n },
          complete:true, provenance:'test',
        };
      },
    };
    const result = await createAppAnalysisQueryAdapter(app).functionById(null, 0n, {});
    return { result, request };
  };

  const malformed = await run({ bits:'64' });
  assert.equal(malformed.result.status.completeness, 'unsupported');
  assert.equal(malformed.result.status.reason, 'riscv-bits-invalid');
  assert.equal(malformed.request, null);

  const omitted = await run({});
  assert.notEqual(omitted.request, null, 'omitted bitness must retain the documented RV64 default');
});

test('#6242 negative explicit function addresses fail closed', async () => {
  const app = {
    symbols:{
      funcs:[0x1000n],
      functionStartsComplete:true,
      nameAt(address) { return `fn_${address.toString(16)}`; },
      functionAt(address) { return { start:address, end:address + 0x20n }; },
    },
  };
  const adapter = createAppAnalysisQueryAdapter(app);

  for (const address of [-1n, '-1']) {
    const result = await adapter.functions(null, { address });
    assert.equal(result.status.completeness, 'unsupported');
    assert.equal(result.status.reason, 'function-query-address-invalid');
  }
});

test('shared binary identity rejects pre-aborted callers before producer creation', async () => {
  let calls = 0;
  const backend = {
    file:{},
    gen:1,
    ensureContentHash() {
      calls++;
      return Promise.resolve('00'.repeat(32));
    },
  };
  installSharedWorkerBinaryIdentity({ backend });

  const signal = AbortSignal.abort(new Error('pre-aborted'));
  await assert.rejects(async () => backend.ensureBinaryId({ signal }), /pre-aborted/);
  assert.equal(calls, 0);
  assert.equal(backend._binaryIdPromise ?? null, null);
});

test('shared binary identity attaches producer rejection handling before post-registration abort', async () => {
  class RegistrationRaceSignal {
    constructor(reason) {
      this.reason = reason;
      this._aborted = false;
    }
    get aborted() { return this._aborted; }
    addEventListener(type) {
      if (type === 'abort') this._aborted = true;
    }
    removeEventListener() {}
  }

  const backend = {
    file:{},
    gen:1,
    ensureContentHash() { return Promise.resolve('00'.repeat(32)); },
  };
  installSharedWorkerBinaryIdentity({ backend });

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const signal = new RegistrationRaceSignal(new Error('registration-race-abort'));
    await assert.rejects(async () => backend.ensureBinaryId({ signal }), /registration-race-abort/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
