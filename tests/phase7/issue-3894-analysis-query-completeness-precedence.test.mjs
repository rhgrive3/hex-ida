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
test('completeness evidence joins by severity regardless of source order', async () => {
  const cases = [
    [{ status:{ completeness:'complete' }, completeness:'truncated' }, 'truncated'],
    [{ status:{ completeness:'unsupported' }, truncated:true }, 'unsupported'],
    [{ status:{ completeness:'truncated' }, partial:true }, 'truncated'],
    [{ status:{ completeness:'partial' }, completeness:'complete' }, 'partial'],
  ];

  for (const [producerResult, expected] of cases) {
    const result = await searchStatus(producerResult);
    assert.equal(result.status.completeness, expected, JSON.stringify(producerResult));
  }
});

test('invalid completeness strings fail closed', async () => {
  const result = await searchStatus({ status:{ completeness:'future-status' } });
  assert.equal(result.status.completeness, 'partial');
});

test('invalid completeness evidence overrides contradictory complete status', async () => {
  const result = await searchStatus({ status:{ completeness:'complete' }, completeness:'future-status' });
  assert.equal(result.status.completeness, 'partial');

  const stronger = await searchStatus({ status:{ completeness:'unsupported' }, completeness:'future-status' });
  assert.equal(stronger.status.completeness, 'unsupported');
});
