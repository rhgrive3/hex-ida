from pathlib import Path

fusion = Path('js/analysis/discovery/fusion.js')
text = fusion.read_text()
anchor = """function compareEvidence(left, right) {\n  return authorityRank(right.authority) - authorityRank(left.authority)\n    || String(left.start).localeCompare(String(right.start))\n    || String(left.producerId).localeCompare(String(right.producerId))\n    || String(left.kind).localeCompare(String(right.kind))\n    || String(left.name ?? '').localeCompare(String(right.name ?? ''))\n    || String(left.extentRole ?? '').localeCompare(String(right.extentRole ?? ''))\n    || String(left.architectureId ?? '').localeCompare(String(right.architectureId ?? ''))\n    || regionSignature(left).localeCompare(regionSignature(right));\n}\n"""
helper = anchor + """\nfunction canonicalStartKey(value) {\n  const type = typeof value;\n  if (type !== 'bigint' && type !== 'string' && !(type === 'number' && Number.isSafeInteger(value))) return null;\n  try {\n    const result = BigInt(value);\n    return result < 0n ? null : result.toString();\n  } catch {\n    return null;\n  }\n}\n"""
if anchor not in text:
    raise SystemExit('compareEvidence anchor not found')
text = text.replace(anchor, helper, 1)
old = """  for (const item of orderedEvidence) {\n    if (item.start == null) continue;\n    const key = BigInt(item.start).toString();\n    if (!byStart.has(key)) byStart.set(key, { items: [], overflow: false });\n"""
new = """  for (const item of orderedEvidence) {\n    if (item.start == null) continue;\n    const key = canonicalStartKey(item.start);\n    if (key == null) continue;\n    if (!byStart.has(key)) byStart.set(key, { items: [], overflow: false });\n"""
if old not in text:
    raise SystemExit('fusion bucket anchor not found')
text = text.replace(old, new, 1)
fusion.write_text(text)

test = Path('tests/phase7/discovery/fusion-start-boundary-3101.test.mjs')
test.write_text("""import assert from 'node:assert/strict';\n\nimport { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';\n\nfunction evidence(start, producerId = 'loader') {\n  return {\n    kind: 'loader-function-start',\n    authority: 'authoritative',\n    producerId,\n    start,\n    extentRole: 'complete',\n    regions: [],\n  };\n}\n\nfor (const malformed of [\n  ['4096'],\n  true,\n  false,\n  { toString: () => '4096' },\n  4096.5,\n  Number.NaN,\n  Number.POSITIVE_INFINITY,\n  Number.MAX_SAFE_INTEGER + 1,\n  -1,\n  '-1',\n]) {\n  const { candidates } = fuseFunctionCandidates([evidence(malformed)]);\n  assert.deepEqual(candidates, [], `malformed start must not create a candidate: ${String(malformed)}`);\n}\n\nconst { candidates } = fuseFunctionCandidates([\n  evidence(4096n, 'bigint'),\n  evidence(4096, 'number'),\n  evidence('4096', 'decimal-string'),\n  evidence('0x1000', 'hex-string'),\n]);\nassert.equal(candidates.length, 1);\nassert.equal(candidates[0].start, '4096');\nassert.equal(candidates[0].startState, 'exact');\n\nconsole.log('fusion start boundary regression: ok');\n""")
