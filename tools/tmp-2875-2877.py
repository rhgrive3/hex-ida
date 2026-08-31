from pathlib import Path

# #2877: debug identity authority tokens must remain typed strings.
p=Path('js/analysis/debug/provider.js')
s=p.read_text()
old="""function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}"""
new="""function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}"""
if old not in s: raise SystemExit('debug nonEmpty anchor drift')
s=s.replace(old,new,1)
s=s.replace("    expected: input.expected == null ? null : String(input.expected),\n    observed: input.observed == null ? null : String(input.observed),", "    expected: input.expected == null ? null : strictNonEmptyString(input.expected, 'debug-identity-invalid-expected'),\n    observed: input.observed == null ? null : strictNonEmptyString(input.observed, 'debug-identity-invalid-observed'),",1)
p.write_text(s)

# #2875: product query controls must reject implicit scalar conversion.
p=Path('js/analysis/query/product-surface.js')
s=p.read_text()
anchor="""function sameSnapshot(left, right) {
  return !!left && !!right && left.snapshotId === right.snapshotId;
}
"""
helper=anchor+"""
function queryText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function claimIdFilter(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('analysis-product-claim-id-invalid');
  return value.trim();
}
function verdictFilter(values) {
  if (!Array.isArray(values) || !values.length) return null;
  if (values.some((value) => typeof value !== 'string' || !value.trim())) throw new TypeError('analysis-product-verdict-invalid');
  return new Set(values.map((value) => value.trim().toLowerCase()));
}
function functionAddress(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError('analysis-product-function-id-invalid');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('analysis-product-function-id-invalid');
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(text)) throw new TypeError('analysis-product-function-id-invalid');
    return BigInt(text);
  }
  throw new TypeError('analysis-product-function-id-invalid');
}
"""
if anchor not in s: raise SystemExit('product helper anchor drift')
s=s.replace(anchor,helper,1)
s=s.replace("      const needle = String(query.text ?? query.query ?? '').trim().toLowerCase();", "      const needle = queryText(query.text ?? query.query ?? '');",1)
s=s.replace("      if (query.claimId != null) rows = rows.filter((row) => row.claimId === String(query.claimId));\n      if (Array.isArray(query.verdict) && query.verdict.length) {\n        const accepted = new Set(query.verdict.map((value) => String(value).toLowerCase()));\n        rows = rows.filter((row) => accepted.has(row.verdict));\n      }", "      const claimId = claimIdFilter(query.claimId);\n      if (claimId != null) rows = rows.filter((row) => row.claimId === claimId);\n      const accepted = verdictFilter(query.verdict);\n      if (accepted) rows = rows.filter((row) => accepted.has(row.verdict));",1)
s=s.replace("      const address = BigInt(functionId);", "      const address = functionAddress(functionId);",1)
p.write_text(s)

Path('tests/phase7/issues-2875-2877-strict-inputs.mjs').write_text(r'''import assert from 'node:assert/strict';
import { createDebugIdentity, isAuthoritative } from '../../js/analysis/debug/provider.js';
import { createProductSurfaceQueries } from '../../js/analysis/query/product-surface.js';

const valid=createDebugIdentity({verdict:'matched-authoritative',providerId:'pdb',providerVersion:'1',expected:'build-A',observed:'build-A',method:'guid-age'});
assert.equal(isAuthoritative(valid),true);
for (const field of ['verdict','providerId','providerVersion','expected','observed','method']) {
  const input={verdict:'matched-authoritative',providerId:'pdb',providerVersion:'1',expected:'build-A',observed:'build-A',method:'guid-age'};
  input[field]=[input[field]];
  assert.throws(()=>createDebugIdentity(input),TypeError,`debug ${field} must reject array coercion`);
}

let analyzed=null;
const snapshot={snapshotId:'s',analysisEpoch:1};
const app={
  analysisQueries:{snapshot:async()=>snapshot},
  store:{get(key){if(key==='regions')return []; if(key==='sliceIndex')return 0; return null;}},
  backend:{gen:1},
  autoReport:{report:{findings:[{claimId:'claim-1',verdict:'confirmed'}]}},
  recognition:{records:[]},
  ensureRecognition:async()=>null,
  analyzeFunctionAt:async(address)=>{analyzed=address; return {model:null};},
};
const q=createProductSurfaceQueries(app);
await assert.rejects(()=>q.claims(snapshot,{claimId:['claim-1']}),/analysis-product-claim-id-invalid/);
await assert.rejects(()=>q.claims(snapshot,{verdict:[['confirmed']]}),/analysis-product-verdict-invalid/);
for (const bad of [['0x1000'],{toString(){return '0x1000';}},true]) await assert.rejects(()=>q.classification(snapshot,bad),/analysis-product-function-id-invalid/);
await q.classification(snapshot,'0x1000');
assert.equal(analyzed,0x1000n);
const strings=await q.strings(snapshot,{text:['needle']},{offset:0,limit:10});
assert.equal(strings.value.length,0,'non-string string filter must not be coerced into a search term');
console.log('issues-2875-2877-strict-inputs: PASS');
''')
