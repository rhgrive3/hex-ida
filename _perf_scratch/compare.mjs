import { createHash } from 'node:crypto';
import { openProduct } from '../tools/validation/public-benchmark/product-host.mjs';

const binary = process.argv[2];
const address = BigInt(process.argv[3] || '6328');
const runs = Number(process.argv[4] || 3);
const addressId = `0x${address.toString(16)}`;
const j = (v) => JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? `0x${x.toString(16)}` : (x instanceof Map ? { __map: [...x.entries()].map(([a, b]) => [String(a), b]) } : x));
const digest = (v) => createHash('sha256').update(j(v)).digest('hex').slice(0, 16);

globalThis.__hexCapture = true;
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
const fn = discovered.find(f => `0x${BigInt(f.address).toString(16)}` === addressId);

const rows = [];
for (let i = 0; i < runs; i++) {
  globalThis.__hexLastResult = null;
  const current = await product.query.snapshot();
  const response = await product.query.decompile(current, addressId);
  const r = globalThis.__hexLastResult;
  const pipeline = r?.ctx?.decompilerPipeline ?? null;
  const value = response?.value ?? null;
  rows.push({
    run: i,
    statusCompleteness: response?.status?.completeness ?? null,
    statusReason: response?.status?.reason ?? null,
    completeness: pipeline?.completeness ?? null,
    degraded: pipeline?.degraded ?? null,
    pseudocode: r?.pseudocode ?? null,
    pseudocodeDigest: digest(r?.pseudocode ?? null),
    semantic: r?.semantic ?? null,
    signature: r?.signature ?? null,
    summary: r?.summary ?? null,
    warnings: r?.warnings ?? null,
    coverage: r?.coverage ?? null,
    unknownInstructions: r?.unknownInstructions ?? null,
    metrics: r?.metrics ?? null,
    rewriteStats: r?.rewriteStats ?? null,
    expressionHistoryBinding: r?.expressionHistoryBinding ?? null,
    phase8Published: r?.phase8?.published ?? null,
    phase8Completeness: r?.phase8?.completeness ?? null,
    rewriteProofCount: r?.rewriteProof?.length ?? null,
    rewriteProofDigest: digest(r?.rewriteProof ?? []),
    linesCount: r?.lines?.length ?? null,
    linesDigest: digest((r?.lines ?? []).map(l => ({ k: l.kind, i: l.indent, t: l.text, r: l.row, a: l.addr }))),
    sourceMapCount: r?.sourceMap?.length ?? null,
    sourceMapDigest: digest(r?.sourceMap ?? []),
    semanticAstDigest: digest(r?.semanticAst ?? null),
    cAstDigest: digest(r?.cAst ?? null),
    passMetrics: (r?.passMetrics ?? []).map(m => ({ name: m.name, ok: m.ok, skipped: !!m.skipped, degraded: !!m.degraded })),
    publicValue: value ? { pseudocodeDigest: digest(value.pseudocode), warnings: value.warnings, coverage: value.coverage, unknownInstructions: value.unknownInstructions, semantic: value.semantic, labels: value.labels } : null,
  });
}
console.log(j(rows));
await product.close();
