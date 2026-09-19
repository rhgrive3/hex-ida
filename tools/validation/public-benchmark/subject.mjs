import { openProduct } from './product-host.mjs';
import { classifySubjectResult, SUBJECT_RESULT_SCHEMA } from './outcome.mjs';

const binary = process.argv[2];
if (!binary) {
  console.error('subject requires binary');
  process.exit(2);
}

let product;
try {
  product = await openProduct(binary);
  if (product.unsupported) {
    console.log(JSON.stringify(classifySubjectResult({
      schema: SUBJECT_RESULT_SCHEMA,
      state: 'UNSUPPORTED',
      reason: product.reason,
      functions: [],
    })));
    process.exitCode = 2;
  } else {
    const snapshot = await product.query.snapshot();
    let offset = 0;
    const discovered = [];
    while (true) {
      const page = await product.query.functions(snapshot, {}, { offset, limit: 1000 });
      discovered.push(...(page.value ?? []));
      if (page.page?.next == null) break;
      offset = page.page.next;
    }

    const functions = [];
    for (const fn of discovered) {
      try {
        const currentSnapshot = await product.query.snapshot();
        const response = await product.query.decompile(currentSnapshot, fn.address);
        const value = response?.value;
        const completeness = response?.status?.completeness ?? response?.completeness ?? 'unknown';
        functions.push({
          address: String(fn.address),
          name: fn.name ?? null,
          end: fn.end == null ? null : String(fn.end),
          state: value ? (completeness === 'complete' ? 'PASS' : String(completeness).toUpperCase()) : 'UNSUPPORTED',
          completeness,
          pseudocode: value?.pseudocode ?? value?.code ?? null,
          // TEMPORARY Phase-2 PARTIAL diagnostic (remove after classification):
          // pass through the existing first-divergence reason and minimal
          // provenance without changing any analysis semantics.
          hasExactEnd: fn.end != null,
          reason: response?.status?.reason ?? value?.completeness?.reason ?? null,
          provenance: value?.completeness?.provenance ?? null,
        });
      } catch (error) {
        functions.push({
          address: String(fn.address),
          name: fn.name ?? null,
          end: fn.end == null ? null : String(fn.end),
          state: error?.name === 'AbortError' ? 'TIMEOUT' : 'CRASH',
          reason: String(error?.message || error),
          pseudocode: null,
          hasExactEnd: fn.end != null,
        });
      }
    }

    const result = classifySubjectResult({
      schema: SUBJECT_RESULT_SCHEMA,
      state: 'PASS',
      inputSha256: product.sha,
      productRoute: product.app.backend.analysisRouteInfo(),
      functionDiscoveryComplete: product.app.symbols.functionStartsComplete === true,
      functions,
    });
    console.log(JSON.stringify(result));
    if (result.state === 'CRASH' || result.state === 'TIMEOUT') process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify(classifySubjectResult({
    schema: SUBJECT_RESULT_SCHEMA,
    state: 'CRASH',
    reason: String(error?.stack || error),
    functions: [],
  })));
  process.exitCode = 1;
} finally {
  await product?.close?.();
}
