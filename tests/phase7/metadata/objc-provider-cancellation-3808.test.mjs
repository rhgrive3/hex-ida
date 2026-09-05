import assert from 'node:assert/strict';
import { parseObjcExtendedMetadata } from '../../../js/apple/objc-metadata.js';

function pointerPage(...addresses) {
  const page = new Uint8Array(64);
  const view = new DataView(page.buffer);
  addresses.forEach((address, index) => view.setBigUint64(index * 8, BigInt(address), true));
  return page;
}

function abortError() {
  const error = new Error('provider aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

async function expectProviderAbort(sectionKey, tableAddress, firstEntryAddress) {
  const table = pointerPage(firstEntryAddress, firstEntryAddress + 0x1000);
  const entryReads = [];
  const read = async (address, length) => {
    const at = Number(address);
    if (at === tableAddress) return table.subarray(0, length);
    if (at === firstEntryAddress || at === firstEntryAddress + 0x1000) {
      entryReads.push(at);
      throw abortError();
    }
    return new Uint8Array(length);
  };

  await assert.rejects(
    parseObjcExtendedMetadata(read, {
      [sectionKey]: { vmAddr: BigInt(tableAddress), size: 16 },
    }, { pageBytes: 64 }),
    (error) => error?.name === 'AbortError',
    `${sectionKey} provider AbortError must propagate`,
  );
  assert.deepEqual(entryReads, [firstEntryAddress], `${sectionKey} must stop before the next entry after cancellation`);
}

await expectProviderAbort('protocolList', 0x1000, 0x3000);
await expectProviderAbort('categoryList', 0x2000, 0x5000);

// Ordinary malformed-entry failures remain fail-soft and count as invalid metadata.
{
  const table = pointerPage(0x7000);
  const read = async (address, length) => {
    const at = Number(address);
    if (at === 0x6000) return table.subarray(0, length);
    if (at === 0x7000) throw new Error('malformed entry');
    return new Uint8Array(length);
  };
  const result = await parseObjcExtendedMetadata(read, {
    protocolList: { vmAddr: 0x6000n, size: 8 },
  }, { pageBytes: 64 });
  assert.equal(result.protocols.length, 0);
  assert.equal(result.completeness.protocols.invalidEntries, 1);
  assert.equal(result.completeness.protocols.complete, false);
}

// AbortSignal cancellation remains a cancellation/partial condition, never an invalid entry.
{
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const result = await parseObjcExtendedMetadata(async (_address, length) => {
    reads++;
    return new Uint8Array(length);
  }, {
    protocolList: { vmAddr: 0x8000n, size: 8 },
  }, { signal: controller.signal, pageBytes: 64 });
  assert.equal(reads, 0, 'pre-aborted parsing must not read metadata');
  assert.equal(result.completeness.protocols.invalidEntries, 0);
  assert.equal(result.completeness.protocols.complete, false);
  assert.equal(result.completeness.complete, false);
}

console.log('✔ #3808 ObjC provider cancellation propagation passed');
