from pathlib import Path
p=Path('js/core/artifacts/contracts.js'); s=p.read_text()
def rep(old,new,label):
 global s
 c=s.count(old)
 if c!=1: raise SystemExit(f'{label}: expected 1, found {c}')
 s=s.replace(old,new,1)
rep("const RESERVED_TAGS = Object.freeze(['$map', '$set', '$bigint']);\n","const RESERVED_TAGS = Object.freeze(['$map', '$set', '$bigint', '$date', '$bytes']);\n",'reserved tags')
rep("  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));\n","  if (ArrayBuffer.isView(value)) return { $bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };\n",'view tag')
rep("  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));\n","  if (value instanceof ArrayBuffer) return { $bytes: Array.from(new Uint8Array(value)) };\n",'buffer tag')
rep("  if (value instanceof Date) return value.toISOString();\n","  if (value instanceof Date) return { $date: value.toISOString() };\n",'date tag')
rep("  if (record.completeness !== 'complete' && expected.allowIncomplete !== true) throw new ArtifactCorruptionError('artifact-incomplete');\n","  if (!COMPLETENESS.has(record.completeness)) throw new ArtifactCorruptionError('artifact-completeness-invalid');\n  if (record.completeness !== 'complete' && expected.allowIncomplete !== true) throw new ArtifactCorruptionError('artifact-incomplete');\n",'completeness enum')
p.write_text(s)
