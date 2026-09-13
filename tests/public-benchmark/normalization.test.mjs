import test from 'node:test';import assert from 'node:assert/strict';import {normalizePseudocode} from '../../tools/validation/public-benchmark/normalize.mjs';
test('normalizer is syntax-only',()=>{assert.equal(normalizePseudocode('__int64 __fastcall f(__int64 x) { return x + 1; }'),'long long f(long long x) { return x + 1; }')});
