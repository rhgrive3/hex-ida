import assert from 'node:assert/strict';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';

function bounded(values, { limited = true } = {}) {
  const result = [...values];
  Object.defineProperties(result, {
    complete: { value: !limited, enumerable: false },
    queryLimited: { value: limited, enumerable: false },
    incompleteReason: { value: limited ? 'query-limit' : null, enumerable: false },
  });
  return result;
}

const region = { id: 'text', vmAddr: 0x1000n, size: 0x100n, exec: true };
let limited = true;
const app = {
  store: {
    get(key) {
      if (key === 'regions') return [region];
      return null;
    },
  },
  symbols: {
    functionAt(address) {
      if (BigInt(address) !== 0x1000n) return null;
      return { start: 0x1000n, end: 0x1010n };
    },
  },
  async ensureProgram() {
    return {
      callersOf(_address, cap) {
        assert.equal(cap, 2);
        return bounded([0x2000n, 0x3000n], { limited });
      },
      calleesOf(start, end, cap) {
        assert.equal(start, 0x1000n);
        assert.equal(end, 0x1010n);
        assert.equal(cap, 2);
        return bounded([0x4000n, 0x5000n], { limited });
      },
    };
  },
};

const adapter = createAppAnalysisQueryAdapter(app);

for (const method of ['callers', 'callees']) {
  limited = true;
  const page = await adapter[method]({}, 0x1000n, { offset: 0, limit: 2 });
  assert.equal(page.value.length, 2, `${method}: bounded page still returns requested rows`);
  assert.equal(page.status.completeness, 'partial', `${method}: query-limited source remains partial`);
  assert.equal(page.status.reason, 'query-limit', `${method}: query-limit reason is preserved`);
  assert.equal(page.page.next, 2, `${method}: known continuation must remain pageable`);

  limited = false;
  const complete = await adapter[method]({}, 0x1000n, { offset: 0, limit: 2 });
  assert.equal(complete.status.completeness, 'complete', `${method}: complete source remains complete`);
  assert.equal(complete.page.next, null, `${method}: exact complete page must not invent continuation`);
}

console.log('issue-2608-query-limit-pagination: ok');
