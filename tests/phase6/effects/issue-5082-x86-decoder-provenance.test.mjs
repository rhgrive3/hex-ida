import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await import('../../../js/targets/architecture/x86_64/capstone-structured.js');
const { liftX86MachineEffects } = await import('../../../js/targets/architecture/x86_64/effects/index.js');
const { x86SemanticFunctionRequiresDecoderRevalidation } = await import('../../../js/targets/architecture/x86_64/semantic-function.js');
const {
  hasReceiverRevalidatedX86Row,
  markReceiverRevalidatedX86Row,
} = await import('../../../js/targets/architecture/x86_64/runtime-provenance.js');

const adapter = globalThis.HexX86CapstoneStructured;
assert.equal(typeof adapter?.parseInstruction, 'function');
assert.equal('hasRuntimeProvenance' in adapter, false, 'public parser must expose no authority-mint/probe API');
assert.deepEqual(
  Object.getOwnPropertyDescriptor(globalThis, 'HexX86CapstoneStructured'),
  {
    value:adapter,
    writable:false,
    enumerable:true,
    configurable:false,
  },
  'structured parser binding itself remains non-substitutable',
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

// Exact review counterexample: public parseInstruction() remains a useful
// structured parser, but fake/caller-controlled M can never mint receiver-only
// terminal authority, even if it claims MOV for NOP bytes.
const fakeParsedMov = fakeCapstoneRow({ opcodeName:'mov', byte:0x90, origin });
assert.deepEqual(fakeParsedMov.origin, origin);
assert.equal(hasReceiverRevalidatedX86Row(fakeParsedMov), false);
assert.throws(
  () => markReceiverRevalidatedX86Row(fakeParsedMov),
  /x86-decoder-runtime-provenance-mint-outside-revalidation-worker/,
  'page/Node/public code cannot mint receiver decoder authority',
);
assert.equal(
  x86SemanticFunctionRequiresDecoderRevalidation({ architecture:'x86_64', instructions:[fakeParsedMov] }),
  true,
  'even parser-produced rows require receiver byte revalidation after transport',
);
const fakeParsedResult = liftX86MachineEffects(fakeParsedMov, { instructionId:'issue-5082:fake-parser' });
assert.equal(fakeParsedResult?.completeness, 'partial', 'fake-M parser row must not reach terminal exactness');
assert.notEqual(fakeParsedResult?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');

const transportedRow = structuredClone(fakeParsedMov);
assert.equal(hasReceiverRevalidatedX86Row(transportedRow), false);
assert.deepEqual(transportedRow.origin, origin, 'transport preserves source origin but never receiver authority');
assert.equal(
  x86SemanticFunctionRequiresDecoderRevalidation({ architecture:'x86_64', instructions:[transportedRow] }),
  true,
);
const transportedResult = liftX86MachineEffects(transportedRow, { instructionId:'issue-5082:transported' });
assert.equal(transportedResult?.completeness, 'partial');
assert.notEqual(transportedResult?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');

const transportedGapRow = structuredClone(fakeParsedMov);
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

const replacement = Object.freeze({ ABI:adapter.ABI, parseInstruction:() => forged });
assert.throws(
  () => { globalThis.HexX86CapstoneStructured = replacement; },
  TypeError,
  'same-realm replacement must fail closed',
);
assert.equal(globalThis.HexX86CapstoneStructured, adapter);

const forgedResult = liftX86MachineEffects(forged);
assert.equal(forgedResult?.completeness, 'partial', 'forged NOP/MOV record must remain fail-closed');
assert.notEqual(forgedResult?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');

const semanticEntrySource = await readFile(new URL('../../../js/targets/architecture/x86_64/semantic-function.js', import.meta.url), 'utf8');
const revalidationWorkerSource = await readFile(new URL('../../../js/targets/architecture/x86_64/semantic-revalidation-worker.js', import.meta.url), 'utf8');
const structuredParserSource = await readFile(new URL('../../../js/targets/architecture/x86_64/capstone-structured.js', import.meta.url), 'utf8');
const provenanceSource = await readFile(new URL('../../../js/targets/architecture/x86_64/runtime-provenance.js', import.meta.url), 'utf8');
const protectedWorkersSource = await readFile(new URL('../../../js/userscript/protected-workers.js', import.meta.url), 'utf8');
const userscriptBuildSource = await readFile(new URL('../../../scripts/build-userscript.mjs', import.meta.url), 'utf8');

assert.match(semanticEntrySource, /__HEX_X86_SEMANTIC_REVALIDATION_WORKER_URL__/,
  'protected runtime may inject only the dedicated receiver worker URL');
assert.match(semanticEntrySource, /new URL\('\.\/semantic-revalidation-worker\.js', import\.meta\.url\)/,
  'ordinary web builds keep the source-relative receiver worker route');
assert.match(semanticEntrySource, /const worker = new Worker\(workerURL\)/,
  'transported x86 rows must route to the selected canonical receiver worker');
assert.match(semanticEntrySource, /hasReceiverRevalidatedX86Row/,
  'only the receiver-private WeakSet may bypass a second revalidation');
assert.match(semanticEntrySource, /addEventListener\?\.\('abort', abort, \{ once:true \}\);\s*if \(signal\?\.aborted\)/,
  'revalidation cancellation must close the check-to-listener registration race');

assert.doesNotMatch(structuredParserSource, /RUNTIME_PROVENANCE|publishDecodedRow|hasRuntimeProvenance/,
  'public structured parser must contain no terminal-authority mint path');
assert.match(provenanceSource, /REVALIDATION_WORKER_PATH = '\/js\/targets\/architecture\/x86_64\/semantic-revalidation-worker\.js'/);
assert.match(provenanceSource, /PROTECTED_LOGICAL_PATH = 'js\/targets\/architecture\/x86_64\/semantic-revalidation-worker\.js'/);
assert.match(provenanceSource, /pathname\.endsWith\(REVALIDATION_WORKER_PATH\)/,
  'ordinary-web authority minting is restricted to the deployed receiver worker URL realm');
assert.match(provenanceSource, /__HEX_PROTECTED_WORKER_LOGICAL_PATH__ === PROTECTED_LOGICAL_PATH/,
  'protected blob workers require the integrity-bound logical receiver identity');

const initAt = revalidationWorkerSource.indexOf('const M = await MCapstone(');
const verifyAt = revalidationWorkerSource.indexOf('HexX86CapstoneStructured.verifyVersion(M)');
const disasmAt = revalidationWorkerSource.indexOf("M.ccall('cs_disasm'");
const parseAt = revalidationWorkerSource.indexOf('HexX86CapstoneStructured.parseInstruction(M, handle, base');
const byteProofAt = revalidationWorkerSource.indexOf('if (!sameBytes(decoded.rawBytes, expected.bytes))');
const mintAt = revalidationWorkerSource.indexOf('markReceiverRevalidatedX86Row(decoded)');
assert.ok(initAt >= 0 && verifyAt > initAt && disasmAt > verifyAt && parseAt > disasmAt && byteProofAt > parseAt && mintAt > byteProofAt,
  'positive authority path must be real MCapstone init -> version proof -> decode -> exact byte proof -> private mint');
assert.match(revalidationWorkerSource, /expected\.bytes\.length, expected\.address, 1, outputPointer/,
  'each transported row is independently re-decoded from exactly its own bytes/address');
assert.doesNotMatch(revalidationWorkerSource, /decoder-revalidation-noncontiguous/,
  'receiver revalidation must not invent whole-function contiguity');
assert.match(revalidationWorkerSource, /instructions\.length !== serialized\.rows\.length/,
  'receiver revalidation rejects decode-count incompleteness');

assert.match(userscriptBuildSource, /BUNDLED_CLASSIC_ENTRIES = \['js\/targets\/architecture\/x86_64\/semantic-revalidation-worker\.js'\]/,
  'protected runtime build must package the receiver worker as a standalone integrity-bound asset');
assert.match(userscriptBuildSource, /bundleInlinedClassic\(entry, inlineImports\(entry, sources\)\)/,
  'receiver dynamic ESM dependencies and classic Capstone scripts must be bundled into the protected worker blob');
assert.match(protectedWorkersSource, /X86_REVALIDATION_WORKER = 'js\/targets\/architecture\/x86_64\/semantic-revalidation-worker\.js'/);
assert.match(protectedWorkersSource, /CAPSTONE_CLASSIC_WORKERS = new Set\([\s\S]*X86_REVALIDATION_WORKER/,
  'protected receiver worker must receive the integrity-bound Capstone WASM bootstrap');
assert.match(protectedWorkersSource, /semanticURL,\s*wasmBinary/,
  'platform worker bootstrap must carry both the receiver blob URL and a private WASM copy');
assert.match(protectedWorkersSource, /e\.stopImmediatePropagation\(\)/,
  'protected bootstrap control messages must not fall through into application worker protocol');
assert.match(protectedWorkersSource, /__HEX_X86_SEMANTIC_REVALIDATION_WORKER_URL__/,
  'platform blob worker must install the protected receiver URL before semantic traffic');

console.log('issue-5082 x86 decoder provenance regression: PASS');
