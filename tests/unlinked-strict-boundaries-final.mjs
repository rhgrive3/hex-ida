import assert from 'node:assert/strict';
import { categoryOf } from '../js/arm64.js';
import { runtimeProfileSupport } from '../js/runtime/authority.js';
import { parseObjcExtendedMetadata } from '../js/apple/objc-metadata.js';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';

assert.equal(categoryOf('eretaa'), 'system');
assert.equal(categoryOf('ERETAB'), 'system');
assert.notEqual(categoryOf('eretax'), 'system');
assert.throws(() => runtimeProfileSupport({ binding:{}, requiredCapabilities:[['readMemory']] }), /runtime-capability-invalid/);
assert.equal(runtimeProfileSupport({ binding:{}, providerProfileId:['native:remote-debug-v1:qemu-lldb'], targetProfileId:['arm64:a64'] }).status, 'unavailable');

const malformedMeta = await parseObjcExtendedMetadata(async () => null, { protocolList:{ vmAddr:0x1000n, size:[] } });
assert.equal(malformedMeta.completeness.protocols.complete, false);
assert.equal(malformedMeta.completeness.protocols.sizeValid, false);

const objc = buildObjcRuntimeIndex({ classes:[{ name:'MyClass', methods:[{ selector:'foo', imp:0x2000n }] }], runtimeCompleteness:{ categories:{ complete:true } } });
const spoofed = { toString(){ return 'MyClass'; } };
const dispatch = resolveObjcDispatch(objc, { receiverType:spoofed, selector:'foo' });
assert.equal(dispatch.receiverType, null);
assert.equal(dispatch.resolved, null);

const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const imm = (value) => ({ k:'imm', text:`#${value}`, value:BigInt(value) });
const mem = (base) => ({ k:'mem', text:'[...]', base, index:null, shift:null, mode:'offset', disp:imm(0), addressDisp:imm(0), writebackDisp:null });
const id='arm64-prefetch-contradictory-evidence';
const mismatch = liftArm64MachineEffects({ instructionId:id, mnemonic:'prfm', word:1, ops:[{k:'other',text:'pldl1keep'},mem(x(1))], mode:'a64', origin:{instructionIds:[id]} });
assert.equal(mismatch.completeness, 'partial');
assert.equal(mismatch.operations.length, 0);
const matching = liftArm64MachineEffects({ instructionId:id+'-ok', mnemonic:'prfm', word:0, ops:[{k:'other',text:'pldl1keep'},mem(x(1))], mode:'a64', origin:{instructionIds:[id+'-ok']} });
assert.equal(matching.completeness, 'exact-with-intrinsic');
console.log('unlinked strict boundaries final: PASS');
