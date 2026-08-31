from pathlib import Path
p=Path('js/analysis/semantic-function-base.js')
s=p.read_text()
old="function addressOf(instruction) { return BigInt(instruction.address); }"
new="""function normalizedProtocolString(value, code, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim().toLowerCase();
  if (!allowEmpty && !text) throw new TypeError(code);
  return text;
}

function addressOf(instruction) { return BigInt(instruction.address); }"""
if old not in s: raise SystemExit('semantic helper anchor drift')
s=s.replace(old,new,1)
old="""  const architectureId = String(input.architecture || '').trim().toLowerCase();
  const architecturePlugin = architecturePluginV2(architectureId);"""
new="""  const architectureId = normalizedProtocolString(input.architecture, 'semantic-function-architecture-required');
  const architecturePlugin = architecturePluginV2(architectureId);"""
if old not in s: raise SystemExit('architecture anchor drift')
s=s.replace(old,new,1)
old="""  const requestedInstructionEndianness = input.instructionEndianness ?? input.endianness ?? input.endian;
  if (requestedInstructionEndianness != null && requestedInstructionEndianness !== 'unknown') {
    const endian = String(requestedInstructionEndianness).trim().toLowerCase();
    const supported = architecturePlugin.supportedInstructionEndianness ?? [];
    if (supported.length && !supported.includes(endian))
      throw new TypeError(`semantic-function-unsupported-instruction-endianness:${endian}`);
  }
  const requestedMemoryEndianness = input.dataEndianness ?? input.endianness ?? input.endian;
  if (requestedMemoryEndianness != null && requestedMemoryEndianness !== 'unknown') {
    const endian = String(requestedMemoryEndianness).trim().toLowerCase();
    const supported = architecturePlugin.supportedMemoryEndianness ?? [];
    if (supported.length && !supported.includes(endian))
      throw new TypeError(`semantic-function-unsupported-memory-endianness:${endian}`);
  }"""
new="""  const requestedInstructionEndianness = input.instructionEndianness ?? input.endianness ?? input.endian;
  if (requestedInstructionEndianness != null) {
    const endian = normalizedProtocolString(requestedInstructionEndianness, 'semantic-function-invalid-instruction-endianness');
    if (endian !== 'unknown') {
      const supported = architecturePlugin.supportedInstructionEndianness ?? [];
      if (supported.length && !supported.includes(endian))
        throw new TypeError(`semantic-function-unsupported-instruction-endianness:${endian}`);
    }
  }
  const requestedMemoryEndianness = input.dataEndianness ?? input.endianness ?? input.endian;
  if (requestedMemoryEndianness != null) {
    const endian = normalizedProtocolString(requestedMemoryEndianness, 'semantic-function-invalid-memory-endianness');
    if (endian !== 'unknown') {
      const supported = architecturePlugin.supportedMemoryEndianness ?? [];
      if (supported.length && !supported.includes(endian))
        throw new TypeError(`semantic-function-unsupported-memory-endianness:${endian}`);
    }
  }"""
if old not in s: raise SystemExit('endianness anchor drift')
p.write_text(s.replace(old,new,1))

Path('tests/phase7/issues-2812-2864-semantic-protocol.mjs').write_text(r'''import assert from 'node:assert/strict';
import { analyzeDecodedSemanticFunction } from '../../js/analysis/semantic-function-base.js';

for (const architecture of [['arm64'],{toString(){return 'arm64';}},true,1]) {
  assert.throws(()=>analyzeDecodedSemanticFunction({architecture,instructions:[]}),/semantic-function-architecture-required/);
}
for (const [field,value,code] of [
  ['instructionEndianness',['little'],'semantic-function-invalid-instruction-endianness'],
  ['dataEndianness',{toString(){return 'little';}},'semantic-function-invalid-memory-endianness'],
]) {
  assert.throws(()=>analyzeDecodedSemanticFunction({architecture:'arm64',instructions:[],[field]:value}),new RegExp(code));
}
console.log('issues-2812-2864-semantic-protocol: PASS');
''')
