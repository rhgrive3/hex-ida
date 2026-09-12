import assert from 'node:assert/strict';
import { forEachX86BrowserSession } from './helpers/x86-browser-effects.mjs';

// Independent instruction-form construction and arithmetic oracle. Expected
// addresses use the fixture specification, never decoded operands, emitted
// MachineEffects expressions, or the production address normalizer.
const names=['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi',...Array.from({length:8},(_,i)=>`r${i+8}`)];
const seeds=[0n,1n,0x7fffffffn,0x80000000n,0xfffffff0n,0xffffffffn,0x100000003n,0xffffffffffffffffn];
const u=(value,bits)=>BigInt.asUintN(bits,value);
const fixtures=[];
function fixture(spec) {
  const {bits,base=null,index=null,scale=1,displacement=0,segment=null,store=false,rip=false}=spec;
  const bytes=[];
  if(segment!=null)bytes.push(segment);
  if(bits===32)bytes.push(0x67);
  bytes.push(0x48|(!rip&&base>=8?1:0)|(index>=8?2:0),store?0x89:0x8b);
  const mod=rip||base==null?0:displacement>=-128&&displacement<=127?1:2;
  const sib=!rip&&(index!=null||base==null||(base&7)===4);
  bytes.push((mod<<6)|(2<<3)|(rip?5:sib?4:base&7));
  if(sib)bytes.push((Math.log2(scale)<<6)|((index==null?4:index&7)<<3)|(base==null?5:base&7));
  const count=mod===1?1:4;
  for(let i=0;i<count;i++)bytes.push(Number((BigInt(displacement)>>BigInt(i*8))&255n));
  return {...spec,base,index,scale,displacement,store,rip,bytes:Uint8Array.from(bytes),
    pc:fixtures.length%2===0?0xfffffffcn:0x100000040n};
}
function add(spec){fixtures.push(fixture(spec));}
for(const bits of [32,64]) {
  for(let base=0;base<16;base++)for(const segment of [null,0x26,0x2e,0x36,0x3e])for(const store of [false,true]) {
    add({bits,base,segment,store,displacement:base%2===0?0x40:-0x20});
  }
  for(let index=0;index<16;index++)if(index!==4)for(const scale of [1,2,4,8])for(const store of [false,true]) {
    add({bits,base:(index+3)%16,index,scale,store,displacement:-0x1234567});
  }
  for(const displacement of [0,0x7fffffff,-0x80000000,-0x20])for(const store of [false,true]) {
    add({bits,rip:true,displacement,store});
    add({bits,displacement,store});
  }
  for(const index of [0,3,9,12,15])for(const scale of [1,2,4,8]) {
    add({bits,index,scale,displacement:-0x40});
  }
}
assert.equal(fixtures.length,632);

function expectedAddress(spec,state) {
  const base=spec.rip?spec.pc+BigInt(spec.bytes.length):spec.base==null?0n:state[names[spec.base]];
  const index=spec.index==null?0n:state[names[spec.index]];
  return u(u(base,spec.bits)+u(index,spec.bits)*BigInt(spec.scale)+BigInt(spec.displacement),spec.bits);
}

// Evaluate only the pre-SSA IR dependency graph of the memory address. No
// machine-address diagnostic metadata is allowed to supply expected values.
function addressEvaluator(ir,state) {
  const values=new Map(ir.values.map(value=>[value.id,value]));
  const nodes=new Map(ir.nodes.flatMap(node=>node.outputs.map(output=>[output,node])));
  const cache=new Map();
  function evaluate(id) {
    if(cache.has(id))return cache.get(id);
    const value=values.get(id),node=nodes.get(id);
    assert.ok(value&&node,`missing address definition: ${id}`);
    const bits=value.machineType.widthBits;
    let result;
    if(node.kind==='const')result=BigInt(node.attributes.constant.value);
    else if(node.kind==='state-read') {
      const physical=node.variable.physicalIdentity;
      assert.equal(physical.kind,'register');
      assert.ok(Object.hasOwn(state,physical.registerId),`unmodelled physical input: ${physical.registerId}`);
      result=state[physical.registerId];
    } else {
      const inputs=node.inputs.map(evaluate);
      if(node.kind==='address'&&(node.operator==='add'||node.operator==='sub')) {
        result=node.operator==='add'?inputs[0]+inputs[1]:inputs[0]-inputs[1];
      } else if(node.kind==='binary'&&(node.operator==='shl'||node.operator==='lshr')) {
        result=node.operator==='shl'?inputs[0]<<inputs[1]:inputs[0]>>inputs[1];
      } else if(node.kind==='zext')result=u(inputs[0],node.attributes.fromBits);
      else if(node.kind==='sext')result=BigInt.asIntN(node.attributes.fromBits,inputs[0]);
      else throw new Error(`unsupported address IR: ${node.kind}/${node.operator}`);
    }
    result=u(result,bits);cache.set(id,result);return result;
  }
  return evaluate;
}

await forEachX86BrowserSession(async({engine,decodeAndLift})=>{
  let projections=0;
  const mutations=new Set();
  for(const [ordinal,spec] of fixtures.entries()) {
    // UD2 is an explicit decoded terminator, not host execution. Without a
    // terminator the real CFG correctly reports a missing fallthrough edge.
    const [{decoded,effects,pipelineSemanticIr:ir}]=await decodeAndLift(
      Uint8Array.from([...spec.bytes,0x0f,0x0b]),spec.pc,2,{includeSemanticIr:true});
    const label=`${engine}: fixture ${ordinal}: ${Buffer.from(spec.bytes).toString('hex')}`;
    assert.equal(decoded.instructionFamily,'mov',label);
    assert.equal(effects.completeness,'exact',label);
    assert.equal(ir.completeness,'complete',`${label}: ${JSON.stringify(ir.unknowns)}`);
    const accesses=ir.nodes.filter(node=>node.kind==='load'||node.kind==='store');
    assert.equal(accesses.length,1,label);
    const access=accesses[0];
    assert.equal(access.kind,spec.store?'store':'load',label);
    assert.equal(access.memory.addressSpace,'memory',label);
    assert.equal(access.memory.widthBits,64,label);
    assert.equal(access.memory.endian,'little',label);
    assert.equal(access.memory.faults[0].kind,'memory-access-fault',label);
    assert.ok(access.sourceEffectIds.length>0,label);
    const addressId=access.memory.addressExpr.valueId;
    for(const [sample,seed] of seeds.entries()) {
      const state=Object.fromEntries(names.map((name,index)=>[name,u(seed+BigInt(index*17),64)]));
      const expected=expectedAddress(spec,state);
      assert.equal(addressEvaluator(ir,state)(addressId),expected,`${label}: sample ${sample}`);
      projections++;
      for(const [key,kind,operator,replacement] of [
        ['subtract','address','add','sub'],['scale','binary','shl','lshr'],['signed','zext',null,null],
      ]) {
        if(mutations.has(key))continue;
        const target=ir.nodes.find(node=>node.kind===kind&&(operator==null||node.operator===operator));
        if(!target)continue;
        const changed={...ir,nodes:ir.nodes.map(node=>node!==target?node:
          key==='signed'?{...node,kind:'sext'}:{...node,operator:replacement})};
        if(addressEvaluator(changed,state)(addressId)!==expected)mutations.add(key);
      }
    }
  }
  assert.deepEqual([...mutations].sort(),['scale','signed','subtract']);
  // These are still genuine shared dependencies, not valid scalar offsets.
  // A segment offset alone must not become a complete linear address or a
  // proof of separation from flat memory.
  for(const prefix of [0x64,0x65])for(const addressPrefix of [[],[0x67]]) {
    const [{pipelineSemanticIr:ir}]=await decodeAndLift(Uint8Array.from([prefix,...addressPrefix,0x48,0x8b,0x00,0x0f,0x0b]),0x1000n,2,{includeSemanticIr:true});
    assert.equal(ir.completeness,'partial');
    assert.ok(ir.unknowns.some(unknown=>unknown.reason==='unsupported-machine-expression:x86-effective-address'));
    assert.ok(ir.nodes.some(node=>node.kind==='unknown-memory-effect'));
  }
  console.log(JSON.stringify({engine,fixtures:fixtures.length,independentAddressProjections:projections,
    rejectedMutations:[...mutations].sort(),unresolvedSegmentCases:4,status:'PASS_SCALAR_ADDRESS_PROJECTION_ONLY'}));
});
