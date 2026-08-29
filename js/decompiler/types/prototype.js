/* Architecture-neutral prototype recovery driven by SSA use + ABI contracts. */
import { resolveABIPlugin } from '../../targets/abi/index.js';

function tname(t,fallback='unknown'){return t?.name||t?.type||fallback;}
function used(v){return(v?.uses||[]).some((u)=>u&&!u.clobbered);}
function bitsOf(t){return Number(t?.bits||(t?.size?Number(t.size)*8:0)||0);}
function kindOf(t){return String(t?.kind||t?.class||t?.abiClass||'').toLowerCase();}
function targetContext(ir,opts={}){
  const adapter=opts.abiAdapter||ir?.abiAdapter||null;
  let plugin=opts.abiPlugin&&typeof opts.abiPlugin==='object'?opts.abiPlugin:null;
  if(!plugin){plugin=resolveABIPlugin({abiId:opts.abiId||ir?.abiId,architecture:opts.architecture||opts.arch||ir?.architecture||ir?.arch,platform:opts.platform||ir?.platform,callingConvention:opts.callingConvention||opts.convention||opts.cc},{legacyDefault:false});}
  if(!plugin?.supported||plugin.id==='unknown')plugin=null;
  return{adapter,plugin,supported:!!adapter||!!plugin};
}
function classifiedArgumentLocations(ir,ctx,opts={}){
  const out=[];
  const push=(x)=>{if(!x?.reg)return;const reg=String(x.reg);if(!out.some((y)=>y.reg===reg))out.push({...x,reg});};
  if(ctx.plugin&&ir?.args?.keys)for(const reg of ir.args.keys())try{const c=ctx.plugin.classifyEntryRegister?.(reg);if(c?.kind==='argument')push({...c,reg:c.reg||reg});}catch{}
  try{const locs=ctx.adapter?.argumentLocations?.({functionPrototype:opts.functionPrototype||opts.prototype||null});if(Array.isArray(locs))for(const x of locs)push(x);}catch{}
  if(!out.length)try{const regs=ctx.adapter?.argumentRegisters?.({functionPrototype:opts.functionPrototype||opts.prototype||null});if(Array.isArray(regs))regs.forEach((reg,index)=>push({reg,index,abiClass:null}));}catch{}
  if(!out.length&&ctx.plugin)try{const c=ctx.plugin.classifyArguments?.({callPrototype:null},{callingConvention:opts.callingConvention||opts.convention||opts.cc});for(const a of c?.arguments||[]){if(a?.location==='register'&&a.reg)push(a);else if(Array.isArray(a?.regs))for(const reg of a.regs)push({...a,reg});else for(const reg of a?.candidateRegisters||[])push({...a,reg,possible:true});}}catch{}
  return out;
}
function registerArguments(ir,types,opts,ctx){
  const out=[];
  for(const loc of classifiedArgumentLocations(ir,ctx,opts)){
    const v=ir?.args?.get?.(loc.reg)||null;if(!v||!used(v))continue;
    const recovered=types?.values?.get?.(v.id)||null,index=Number.isInteger(Number(loc.index))?Number(loc.index):null;
    out.push({index,bankIndex:index,reg:loc.reg,abiClass:loc.abiClass||'register',name:opts.argNames?.[loc.reg]||(index!=null?opts.argNames?.[index]:null)||`arg${index!=null?index+1:out.length+1}`,type:tname(recovered),confidence:recovered?.confidence||0.45,valueId:v.id,used:true,sourceOrderKnown:index!=null,evidence:'ABI-declared entry register with SSA use'});
  }
  return out;
}
function stackRules(ctx){try{return ctx.adapter?.stackRules?.()||ctx.plugin?.stackRules?.()||{};}catch{return{};}}
function entryStackArguments(ir,types,ctx){
  const rules=stackRules(ctx),bases=[rules.stackPointer,...(rules.stackPointerAliases||[])].filter(Boolean).map(String),unique=[...new Set(bases)];if(!unique.length)return[];
  const entryValues=unique.map((name)=>ir?.args?.get?.(name)).filter(Boolean);if(!entryValues.length)return[];
  const min=BigInt(rules.entryArgumentOffset??0),byKey=new Map();
  for(const inst of ir?.instructions||[]){if(inst?.op!=='load'||inst.loc?.kind!=='stack'||inst.memUse?.kind!=='entry')continue;const base=String(inst.loc.baseReg||inst.addr?.baseReg||'');if(!unique.includes(base))continue;if(!entryValues.some((v)=>inst.loc.frameEpoch===v.id))continue;const disp=BigInt(inst.loc.disp??0);if(disp<min)continue;const key=inst.loc.key||`${base}:${disp}`,recovered=inst.dst?types?.values?.get?.(inst.dst.id):null;if(!byKey.has(key))byKey.set(key,{index:null,reg:null,abiClass:'stack',stackOffset:disp,name:`stackArg_${disp.toString(16)}`,type:tname(recovered),confidence:recovered?.confidence||0.5,valueId:inst.dst?.id??null,used:true,sourceOrderKnown:false,evidence:`entry-${base} load after ABI stack-argument frontier`});}
  return[...byKey.values()].sort((a,b)=>a.stackOffset<b.stackOffset?-1:a.stackOffset>b.stackOffset?1:0);
}
function functionReturnDecision(ctx,ret,opts={}){
  const request={...opts,functionPrototype:opts.functionPrototype||opts.prototype||null,returnType:tname(ret,opts.returnType||''),returnClass:kindOf(ret)||opts.returnClass,returnBits:bitsOf(ret)||opts.returnBits,returnsValue:ret?true:opts.returnsValue};
  try{const d=ctx.adapter?.classifyFunctionReturn?.(request);if(d!=null)return d;}catch{}
  try{return ctx.plugin?.classifyFunctionReturn?.(request)??null;}catch{return null;}
}
function returnInfo(ctx,ret,opts){
  const d=functionReturnDecision(ctx,ret,opts);if(!d)return{decision:null,locations:[],indirect:false,indirectRegister:null};
  const indirect=d.indirect===true||d.kind==='indirect';if(indirect)return{decision:d,locations:[],indirect:true,indirectRegister:d.hiddenResultPointer||d.hiddenResultRegister||null};
  const regs=Array.isArray(d.regs)&&d.regs.length?d.regs:(d.reg?[d.reg]:[]),locations=regs.map((reg)=>({kind:'register',reg,abiClass:/^(?:v|f|xmm|ymm|zmm)/i.test(String(reg))?'fp':'integer'}));
  return{decision:d,locations,indirect:false,indirectRegister:null};
}
function conventionName(ctx,opts){if(opts.callingConvention||opts.convention||opts.cc)return String(opts.callingConvention||opts.convention||opts.cc);try{return ctx.plugin?.callingConventions?.()?.[0]||ctx.plugin?.id||ctx.adapter?.id||'unknown';}catch{return ctx.plugin?.id||ctx.adapter?.id||'unknown';}}
export function recoverFunctionPrototype(ir,types,opts={}){
  const ctx=targetContext(ir,opts);if(!ctx.supported)return{convention:'unknown',arguments:[],argumentBanks:{register:[],integer:[],fp:[],stack:[]},returnType:tname(types?.ret),returnConfidence:0,returnLocations:[],returnLocationKnown:false,indirectResult:false,indirectResultRegister:null,variadic:opts.variadic===true,partial:true,unsupported:true,evidence:['ABI unresolved; prototype recovery kept unknown']};
  const registerArgs=registerArguments(ir,types,opts,ctx),stackArgs=entryStackArguments(ir,types,ctx),args=[...registerArgs,...stackArgs],ret=types?.ret||null,retInfo=returnInfo(ctx,ret,opts),fp=registerArgs.filter((a)=>/fp|float|vector|sse/i.test(String(a.abiClass))||/^(?:v|f|xmm|ymm|zmm)/i.test(a.reg)),integer=registerArgs.filter((a)=>!fp.includes(a));
  return{convention:conventionName(ctx,opts),arguments:args,argumentBanks:{register:registerArgs,integer,fp,stack:stackArgs},returnType:tname(ret,opts.returnType||'unknown'),returnConfidence:ret?.confidence||(retInfo.decision?0.35:0),returnLocations:retInfo.locations,returnLocationKnown:retInfo.decision!=null,indirectResult:retInfo.indirect,indirectResultRegister:retInfo.indirectRegister,variadic:opts.variadic===true,partial:false,unsupported:false,evidence:[...(registerArgs.length?['ABI-declared entry-register SSA uses']:[]),...(stackArgs.length?['ABI stack frontier + entry Memory-SSA loads']:[]),...(retInfo.decision?['ABI function-return classification']:[])]};
}
