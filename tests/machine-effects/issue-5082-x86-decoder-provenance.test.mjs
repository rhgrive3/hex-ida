import assert from 'node:assert/strict';

await import('../../js/targets/architecture/x86_64/capstone-structured.js');
const { liftX86MachineEffects } = await import('../../js/targets/architecture/x86_64/effects/index.js');

const adapter = globalThis.HexX86CapstoneStructured;
assert.equal(typeof adapter?.hasRuntimeProvenance, 'function');

function fakeCapstoneRow({ opcodeId = 1, opcodeName = 'nop', byte = 0x90 } = {}) {
  const detailPointer = 0x1000;
  const values = new Map([
    ['0:i32', opcodeId],
    ['8:i64', 0n],
    ['16:i16', 1],
    ['18:i8', byte],
    ['236:i32', detailPointer],
  ]);
  const M = {
    X86_OP_REG:1,
    X86_OP_IMM:2,
    X86_OP_MEM:3,
    AC_READ:1,
    AC_WRITE:2,
    getValue(pointer, type) { return values.get(`${pointer}:${type}`) ?? 0; },
    UTF8ToString(pointer) { return pointer === 42 ? opcodeName : ''; },
    ccall(name) { return name === 'cs_insn_name' ? opcodeName : null; },
  };
  return adapter.parseInstruction(M, 1, 0, { address:0n, mode:'long-64' });
}

const deployedRow = fakeCapstoneRow();
assert.equal(adapter.hasRuntimeProvenance(deployedRow), true, 'adapter-issued rows carry runtime identity');
assert.equal(adapter.hasRuntimeProvenance({ ...deployedRow }), false, 'copying fields must not copy decoder authority');
assert.equal(adapter.hasRuntimeProvenance({ decoderSemanticVersion:'capstone-5-x86-structured-v2' }), false);

const forged = {
  address:0n,
  length:1,
  rawBytes:new Uint8Array([0x90]),
  mode:'long-64',
  instructionId:'issue-5082:forged',
  instructionCode:1,
  instructionFamily:'mov',
  mnemonic:'mov',
  decoderSemanticVersion:'capstone-5-x86-structured-v2',
  detailAvailable:true,
  detailStatus:'complete',
  detail:{
    abiContractVersion:'capstone-5-wasm32-x86-detail/v1',
    operandCount:0,
    operands:[],
    prefixes:{ legacy:[] },
  },
};

const result = liftX86MachineEffects(forged);
assert.equal(result?.completeness, 'partial', 'forged NOP/MOV record must remain fail-closed');
assert.notEqual(result?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');

const stringOnly = liftX86MachineEffects({ ...forged, instructionId:'issue-5082:string-only' });
assert.equal(stringOnly?.completeness, 'partial');
assert.notEqual(stringOnly?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');

console.log('issue-5082 x86 decoder provenance regression: PASS');
