import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await import('../../../js/targets/architecture/x86_64/capstone-structured.js');
const { liftX86MachineEffects } = await import('../../../js/targets/architecture/x86_64/effects/index.js');
const { x86SemanticFunctionRequiresDecoderRevalidation } = await import('../../../js/targets/architecture/x86_64/semantic-function.js');

const adapter = globalThis.HexX86CapstoneStructured;
assert.equal(typeof adapter?.hasRuntimeProvenance, 'function');
assert.deepEqual(
  Object.getOwnPropertyDescriptor(globalThis, 'HexX86CapstoneStructured'),
  {
    value:adapter,
    writable:false,
    enumerable:true,
    configurable:false,
  },
  'decoder authority binding must be non-substitutable',
);

function fakeCapstoneRow({ opcodeId = 1, opcodeName = 'nop', byte = 0x90, origin = null } = {}) {
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
  return adapter.parseInstruction(M, 1, 0, { address:0n, mode:'long-64', origin });
}

const origin = Object.freeze({
  byteRanges:Object.freeze([{ binaryId:'binary:issue-5082', start:0n, length:1 }]),
  virtualRanges:Object.freeze([{ sliceId:'slice:0', start:0n, length:1 }]),
});
const deployedRow = fakeCapstoneRow({ opcodeName:'mov', origin });
assert.equal(adapter.hasRuntimeProvenance(deployedRow), true, 'adapter-issued rows carry runtime identity');
assert.deepEqual(deployedRow.origin, origin, 'canonical re-decode must preserve Backend origin evidence');
assert.equal(adapter.hasRuntimeProvenance({ ...deployedRow }), false, 'copying fields must not copy decoder authority');
assert.equal(adapter.hasRuntimeProvenance(new Proxy(deployedRow, {})), false, 'wrapping must not copy decoder authority');
assert.equal(adapter.hasRuntimeProvenance({ decoderSemanticVersion:'capstone-5-x86-structured-v2' }), false);
assert.equal(
  x86SemanticFunctionRequiresDecoderRevalidation({ architecture:'x86_64', instructions:[deployedRow] }),
  false,
  'same-realm canonical decoder rows need no transport revalidation',
);

const deployedResult = liftX86MachineEffects(deployedRow, { instructionId:'issue-5082:deployed' });
assert.equal(deployedResult?.completeness, 'exact-with-intrinsic', 'adapter-issued rows keep terminal exactness');
assert.equal(deployedResult?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');

const transportedRow = structuredClone(deployedRow);
assert.equal(adapter.hasRuntimeProvenance(transportedRow), false, 'structured clone must not preserve WeakSet authority');
assert.deepEqual(transportedRow.origin, origin, 'transported row retains source origin for decoder revalidation');
assert.equal(
  x86SemanticFunctionRequiresDecoderRevalidation({ architecture:'x86_64', instructions:[transportedRow] }),
  true,
  'the production structured-clone boundary must route through canonical decoder revalidation',
);
const transportedResult = liftX86MachineEffects(transportedRow, { instructionId:'issue-5082:transported' });
assert.equal(transportedResult?.completeness, 'partial', 'copy-only rows cannot mint exactness without receiver revalidation');
assert.notEqual(transportedResult?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');

const transportedGapRow = structuredClone(deployedRow);
transportedGapRow.address = 0x100n;
assert.equal(
  x86SemanticFunctionRequiresDecoderRevalidation({ architecture:'x86_64', instructions:[transportedRow, transportedGapRow] }),
  true,
  'non-contiguous transported rows still require receiver revalidation instead of being assumed invalid',
);

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
assert.equal(
  x86SemanticFunctionRequiresDecoderRevalidation({ architecture:'x86_64', instructions:[forged] }),
  true,
  'manual structured rows must route to independent byte re-decode in the platform worker realm',
);

const replacement = Object.freeze({
  ABI:adapter.ABI,
  hasRuntimeProvenance:() => true,
});
assert.throws(
  () => { globalThis.HexX86CapstoneStructured = replacement; },
  TypeError,
  'same-realm replacement must fail closed',
);
assert.equal(globalThis.HexX86CapstoneStructured, adapter, 'failed replacement must leave canonical adapter installed');

const result = liftX86MachineEffects(forged);
assert.equal(result?.completeness, 'partial', 'forged NOP/MOV record must remain fail-closed');
assert.notEqual(result?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');

const stringOnly = liftX86MachineEffects({ ...forged, instructionId:'issue-5082:string-only' });
assert.equal(stringOnly?.completeness, 'partial');
assert.notEqual(stringOnly?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');

const semanticEntrySource = await readFile(new URL('../../../js/targets/architecture/x86_64/semantic-function.js', import.meta.url), 'utf8');
const revalidationWorkerSource = await readFile(new URL('../../../js/targets/architecture/x86_64/semantic-revalidation-worker.js', import.meta.url), 'utf8');
assert.match(semanticEntrySource, /new Worker\(new URL\('\.\/semantic-revalidation-worker\.js'/,
  'platform semantic entry must route unbranded transported x86 rows to the canonical revalidation worker');
assert.match(semanticEntrySource, /addEventListener\?\.\('abort', abort, \{ once:true \}\);\s*if \(signal\?\.aborted\)/,
  'revalidation cancellation must close the check-to-listener registration race');
assert.match(revalidationWorkerSource, /HexX86CapstoneStructured\.parseInstruction/,
  'receiver-side proof must be rebuilt by the deployed canonical Capstone adapter');
assert.match(revalidationWorkerSource, /decoderSemanticVersion:'capstone-5-x86-structured-v2'/,
  'receiver must replace caller-supplied decoder version authority after byte re-decode');
assert.doesNotMatch(revalidationWorkerSource, /decoder-revalidation-noncontiguous/,
  'receiver revalidation must not invent a whole-function contiguity requirement');
assert.match(revalidationWorkerSource, /for \(const expected of serialized\.rows\)/,
  'transported instructions must be independently re-decoded so CFG address gaps remain valid');
assert.match(revalidationWorkerSource, /expected\.bytes\.length, expected\.address, 1, outputPointer/,
  'each transported row must be re-decoded from exactly its own bytes and address');
assert.match(revalidationWorkerSource, /instructions\.length !== serialized\.rows\.length/,
  'receiver revalidation must reject decode-count incompleteness');

console.log('issue-5082 x86 decoder provenance regression: PASS');
