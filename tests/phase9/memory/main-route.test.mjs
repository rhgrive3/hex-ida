import assert from 'node:assert/strict';
import test from 'node:test';
import * as symbolic from '../../../js/symbolic/index.js';

import {identity,partialStoreFixture} from './main-fixtures.mjs';

test('main production executor preserves bytes across a partial overwrite', () => {
  const result = symbolic.symbolicExecute(partialStoreFixture(), { byteMemory: { identity } });
  assert.equal(result.paths[0]?.returnValue?.value, 0x1122aa44n);
  assert.equal(result.status, 'complete');
});
