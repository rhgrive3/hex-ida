import assert from 'node:assert/strict';
import { effects,reg,legacy,vex2,ops } from '../phase5/effects/fp-simd/helpers.mjs';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

const vex = effects('vxorps',[reg('xmm0'),reg('xmm1'),reg('xmm2')],{prefixes:vex2(0xf0),rawBytes:[0xc5,0xf0,0x57,0xc2],instructionId:'extended:vex'});
assert.equal(vex.completeness,'exact');
assert.ok(ops(vex,'register-write').some((op)=>op.register.registerId==='zmmh0'));
assert.equal(vex.metadata.maxVlAliasModeled,true);

const vcompare=effects('vcomiss',[reg('xmm0'),reg('xmm1')],{prefixes:vex2(0xf0),rawBytes:[0xc5,0xf0,0x2f,0xc1],instructionId:'extended:vcompare'});
assert.equal(vcompare.completeness,'exact-with-intrinsic');
assert.equal(ops(vcompare,'register-write').some((op)=>op.register.registerId==='zmmh0'),false,'VCOMISS must not synthesize a vector destination write');

const vzu=effects('vzeroupper',[],{prefixes:vex2(0xf8),rawBytes:[0xc5,0xf8,0x77],instructionId:'extended:vzu'});
assert.equal(vzu.completeness,'exact');
assert.equal(ops(vzu,'register-write').filter((op)=>/^zmmh(?:[0-9]|1[0-5])$/.test(op.register.registerId)).length,16);
assert.equal(ops(vzu,'register-write').filter((op)=>/^ymm(?:[0-9]|1[0-5])$/.test(op.register.registerId)).length,16);
const vzuAddressSize=effects('vzeroupper',[],{prefixes:{legacy:[0x67],rex:null,vector:{kind:'vex2',bytes:[0xc5,0xf8]}},rawBytes:[0x67,0xc5,0xf8,0x77],instructionId:'extended:vzu-67'});
assert.equal(vzuAddressSize.completeness,'exact');

const vza=effects('vzeroall',[],{prefixes:vex2(0xfc),rawBytes:[0xc5,0xfc,0x77],instructionId:'extended:vza'});
assert.equal(vza.completeness,'exact');
assert.equal(ops(vza,'register-write').filter((op)=>/^zmmh(?:[0-9]|1[0-5])$/.test(op.register.registerId)).length,16);

const emms=effects('emms',[],{prefixes:legacy(),rawBytes:[0x0f,0x77],instructionId:'extended:emms'});
assert.equal(emms.completeness,'exact');
assert.ok(ops(emms,'register-write').some((op)=>op.register.registerId==='fptw'));

const fldzSynthetic=effects('fldz',[],{prefixes:legacy(),rawBytes:[0xd9,0xee],instructionId:'extended:fldz-synthetic'});
assert.equal(fldzSynthetic.completeness,'partial');
assert.match(fldzSynthetic.unknownEffects.reason,/trusted-decoder-provenance/);

const capstone=await createCapstoneX86Session();
try {
  const fixtures={
    vxorps_maskz:[0x62,0xf1,0x74,0xc9,0x57,0xc2],
    vxorps_high_merge:[0x62,0xa1,0x74,0x22,0x57,0xc2],
    vxorps_high_xmm:[0x62,0xa1,0x74,0x02,0x57,0xc2],
    vaddps_maskz:[0x62,0xf1,0x54,0xcc,0x58,0xde],
    vaddps_rd_sae:[0x62,0xf1,0x54,0x3c,0x58,0xde],
    vpaddd_merge:[0x62,0xd1,0x3d,0x4b,0xfe,0xf9],
    vpcmpeqd_mask:[0x62,0xf1,0x5d,0x4b,0x76,0xd5],
    vcomiss_sae:[0x62,0xf1,0x7c,0x18,0x2f,0xca],
  };
  for(const [name,bytes] of Object.entries(fixtures)){
    const raw=capstone.decode(bytes,0x720000n)[0];
    const bundle=liftX86MachineEffects(raw,{instructionId:`extended:${name}`});
    assert.ok(bundle,`${name}:bundle`);
    assert.equal(bundle.completeness,'exact-with-intrinsic',`${name}:${bundle.unknownEffects?.reason}`);
    assert.equal(bundle.metadata.terminalizedBy,'trusted-capstone-structured-intrinsic',name);
    assert.match(bundle.metadata.priorFailClosedReason,/requires-dedicated-semantics/);
  }

  const x87Fixtures={
    fldz:[0xd9,0xee],
    fstp_m64:[0xdd,0x18],
    fnstcw:[0xd9,0x38],
    fldcw:[0xd9,0x28],
    fnstsw_ax:[0xdf,0xe0],
  };
  for(const [name,bytes] of Object.entries(x87Fixtures)){
    const raw=capstone.decode(bytes,0x721000n)[0];
    const bundle=liftX86MachineEffects(raw,{instructionId:`extended:${name}`});
    assert.ok(bundle,`${name}:bundle`);
    assert.equal(bundle.completeness,'exact-with-intrinsic',`${name}:${bundle.unknownEffects?.reason}`);
    assert.equal(bundle.metadata.terminalizedBy,'trusted-capstone-structured-intrinsic',name);
    assert.match(bundle.metadata.priorFailClosedReason,/requires-dedicated-semantics/);
    assert.equal(bundle.metadata.x87PhysicalStateModeled,true,name);
  }
} finally { capstone.close(); }

const badEvex=effects('vxorps',[reg('zmm0'),reg('zmm1'),reg('zmm2')],{prefixes:{legacy:[],rex:null,vector:{kind:'evex',bytes:[0x62,0xf1,0x78,0x68]}},rawBytes:[0x62,0xf1,0x78,0x68,0x57,0xc0],instructionId:'extended:bad-evex'});
assert.notEqual(badEvex?.completeness,'exact-with-intrinsic');
assert.throws(()=>effects('vxorps',[reg('xmm16'),reg('xmm17'),reg('xmm18')],{prefixes:vex2(0xf0),rawBytes:[0xc5,0xf0,0x57,0xc2],instructionId:'extended:bad-high-vex'}),/high-vector-register-requires-evex/);

console.log('x86 long64 extended state integration: PASS');
