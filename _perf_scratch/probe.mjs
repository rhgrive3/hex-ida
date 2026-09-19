import { openProduct } from '../tools/validation/public-benchmark/product-host.mjs';

const binary = process.argv[2];
const addressArg = process.argv[3] || '6328';
const runs = Number(process.argv[4] || 3);
const address = BigInt(addressArg);
const addressId = `0x${address.toString(16)}`;

const product = await openProduct(binary);
if (product.unsupported) { console.log('UNSUPPORTED', product.reason); process.exit(2); }

const snapshot = await product.query.snapshot();
let offset = 0;
const discovered = [];
while (true) {
  const page = await product.query.functions(snapshot, {}, { offset, limit: 1000 });
  discovered.push(...(page.value ?? []));
  if (page.page?.next == null) break;
  offset = page.page.next;
}
const fn = discovered.find(f => String(f.address) === String(address) || `0x${BigInt(f.address).toString(16)}` === addressId);
const j = (v) => JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? `0x${x.toString(16)}` : x);
console.log('function:', j(fn));

const rows = [];
for (let i = 0; i < runs; i++) {
  const current = await product.query.snapshot();
  const t0 = performance.now();
  const response = await product.query.decompile(current, addressId);
  const t1 = performance.now();
  const value = response?.value;
  rows.push({
    run: i,
    ms: t1 - t0,
    complete: response?.status?.completeness,
    reason: response?.status?.reason ?? null,
    valueKeys: value ? Object.keys(value) : null,
    ctxKeys: value?.ctx ? Object.keys(value.ctx) : null,
    pseudocodeLen: value?.pseudocode?.length ?? null,
  });
}
console.log('rows:', j(rows));
if (rows[0]?.ctxKeys) {
  const current = await product.query.snapshot();
  const response = await product.query.decompile(current, addressId);
  console.log('pipeline:', j(response?.value?.ctx?.decompilerPipeline));
  console.log('pseudocode:\n' + (response?.value?.pseudocode ?? ''));
}
await product.close();
