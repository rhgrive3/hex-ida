import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableInstructionIndex } from '../../../js/viewer/variable-instruction-index.js';
const A = 0x1000n, B = A + 32n;
function fixture() {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const index = new VariableInstructionIndex({ pageBytes: 32, maxPages: 1, maxInstructions: 32, maxPrefetchPages: 0,
    disassembleAt: async (address) => {
      calls++; if (address === B) await gate;
      return { instructions: Array.from({ length: 32 }, (_, i) => ({
        address: address + BigInt(i), length: 1, rawBytes: Uint8Array.of(0x90), mnemonic: 'nop',
      })) };
    },
  });
  index.configureRegion({ id: 'fixture', vmAddr: A, size: 128n });
  return { index, release, calls: () => calls };
}
test('#6094 navigating into pending prefetch promotes publication protection', async () => {
  const { index, release, calls } = fixture();
  await index.ensurePage(A);
  const prefetch = index.ensurePage(B, { protect: false, priority: 'prefetch' });
  const navigation = index.navigate(B, { trusted: true });
  release(); const [page, nav] = await Promise.all([prefetch, navigation]);
  assert.equal(calls(), 2); assert.equal(nav.status, 'decoded'); assert.equal(nav.page, page);
  assert.equal(index.pages.size, 1); assert.equal(index.pages.get(index.currentPageKey), page);
  assert.equal(index.currentAddress, B); assert.equal(index.localRows(B)[0].address, B);
  assert.equal(index.metrics().retainedInstructions, 32);
});
test('#6094 an unjoined prefetch does not displace the current page', async () => {
  const { index, release } = fixture(); const a = await index.ensurePage(A);
  const prefetch = index.ensurePage(B, { protect: false }); release(); await prefetch;
  assert.equal(index.pages.get(index.currentPageKey), a); assert.equal(index.currentAddress, A);
});
test('#6094 any protected joiner wins without spawning extra decodes', async () => {
  const { index, release, calls } = fixture(); await index.ensurePage(A);
  const first = index.ensurePage(B, { protect: false });
  const second = index.ensurePage(B, { protect: true });
  const third = index.ensurePage(B, { protect: false }); release();
  const [page, joined, other] = await Promise.all([first, second, third]);
  assert.equal(page, joined); assert.equal(page, other); assert.equal(calls(), 2);
  assert.equal(index.pages.get(index.currentPageKey), page);
});
test('#6094 synchronous decoder failures release the reserved inflight lease', async () => {
  let failed = true;
  const index = new VariableInstructionIndex({ disassembleAt() { if (failed) throw new Error('decoder failed'); return { instructions: [] }; } });
  index.configureRegion({ id: 'failure', vmAddr: A, size: 128n });
  await assert.rejects(index.ensurePage(A), /decoder failed/);
  assert.equal(index.inflight.size, 0); failed = false;
  assert.equal((await index.ensurePage(A)).status, 'undecodable');
});
