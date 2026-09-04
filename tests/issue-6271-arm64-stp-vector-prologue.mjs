// Issue #6271: STP/LDP on v29/v30 or q29/q30 should not be classified as prologue/epilogue
import assert from 'node:assert/strict';
import { explain } from '../js/arm64.js';

// 1. stp x29, x30, [sp, #-16]! -> prologue special explanation maintained
{
  const res = explain('stp', 'x29, x30, [sp, #-16]!');
  assert.ok(res.title.includes('関数の入り口') || res.title.includes('Function prologue'), 'expected prologue title for x29/x30');
  assert.ok(res.terms.includes('prologue'), 'expected prologue term');
}

// 2. ldp x29, x30, [sp], #16 -> epilogue special explanation maintained
{
  const res = explain('ldp', 'x29, x30, [sp], #16');
  assert.ok(res.title.includes('関数の出口') || res.title.includes('Function epilogue'), 'expected epilogue title for x29/x30');
  assert.ok(res.terms.includes('epilogue'), 'expected epilogue term');
}

// 3. stp q29, q30, [sp, #-32]! -> NOT treated as prologue
{
  const res = explain('stp', 'q29, q30, [sp, #-32]!');
  assert.ok(!res.title.includes('関数の入り口') && !res.title.includes('Function prologue'), 'q29/q30 must not be prologue title');
  assert.ok(!res.terms.includes('prologue'), 'q29/q30 must not have prologue term');
  assert.ok(res.title.includes('スタックへ積む') || res.title.includes('Push onto the stack'), 'should be stack push');
}

// 4. ldp q29, q30, [sp], #32 -> NOT treated as epilogue
{
  const res = explain('ldp', 'q29, q30, [sp], #32');
  assert.ok(!res.title.includes('関数の出口') && !res.title.includes('Function epilogue'), 'q29/q30 must not be epilogue title');
  assert.ok(!res.terms.includes('epilogue'), 'q29/q30 must not have epilogue term');
  assert.ok(res.title.includes('スタックから降ろす') || res.title.includes('Pop from the stack'), 'should be stack pop');
}

// 5. d29, d30 -> NOT treated as prologue
{
  const res = explain('stp', 'd29, d30, [sp, #-16]!');
  assert.ok(!res.title.includes('関数の入り口') && !res.title.includes('Function prologue'), 'd29/d30 must not be prologue');
  assert.ok(!res.terms.includes('prologue'), 'd29/d30 must not have prologue term');
}

// 6. q19, q20 -> NOT treated as callee-saved x19-x28
{
  const res = explain('stp', 'q19, q20, [sp, #-32]!');
  assert.ok(!res.terms.includes('calleesaved'), 'q19/q20 must not be marked callee-saved');
  assert.ok(!res.detail.some((d) => d.includes('x19〜x28') || d.includes('x19–x28')), 'must not mention x19-x28');
}

// 7. x19, x20 -> callee-saved preserved
{
  const res = explain('stp', 'x19, x20, [sp, #-16]!');
  assert.ok(res.terms.includes('calleesaved'), 'x19/x20 must be marked callee-saved');
  assert.ok(res.detail.some((d) => d.includes('x19〜x28') || d.includes('x19–x28')), 'must mention x19-x28');
}

console.log('issue #6271 arm64 stp/ldp vector prologue regressions: PASS');
