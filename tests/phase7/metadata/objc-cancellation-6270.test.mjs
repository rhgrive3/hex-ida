import test from 'node:test';

test('issue 6270: ObjC extended metadata cancellation regression', async () => {
  await import('../../issue-6270-objc-methodlist-cancellation.mjs');
});
