import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';

async function searchStatus(producerResult) {
  const app = {
    querySearch: async () => ({ results:[{ address:0x1000n }], ...producerResult }),
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  return adapter.search({}, { text:'needle' }, { offset:0, limit:10 });
}

test('query-search preserves an uncontradicted complete status', async () => {
  const result = await searchStatus({ status:{ completeness:'complete' } });
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.value.length, 1);
});

test('top-level negative completeness signals override contradictory complete status', async () => {
  const cases = [
    [{ truncated:true }, 'truncated'],
    [{ unsupported:true }, 'unsupported'],
    [{ partial:true }, 'partial'],
    [{ complete:false }, 'partial'],
    [{ completeness:{ complete:false } }, 'partial'],
  ];

  for (const [negative, expected] of cases) {
    const result = await searchStatus({ status:{ completeness:'complete' }, ...negative });
    assert.equal(result.status.completeness, expected, JSON.stringify(negative));
  }
});

test('existing non-contradictory producer completeness remains unchanged', async () => {
  for (const completeness of ['complete', 'partial', 'truncated', 'unsupported']) {
    const result = await searchStatus({ status:{ completeness } });
    assert.equal(result.status.completeness, completeness);
  }
});
