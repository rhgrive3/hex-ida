import { liftX86MachineEffects } from '../../../js/targets/architecture/x86_64/effects/index.js';
let code=700000,seq=0;
export const reg=(name,access='unknown')=>({type:'register',register:name,access});
export const imm=(value,widthBits=8)=>({type:'immediate',value:BigInt(value),widthBits,encodedWidthBits:widthBits,access:'read'});
export const legacy=()=>({legacy:[],rex:null,vector:null});
export const vex128=(pp=0)=>({legacy:[],rex:null,vector:{kind:'vex2',bytes:[0xc5,0xf8|pp]}});
export const vex256=(pp=0)=>({legacy:[],rex:null,vector:{kind:'vex2',bytes:[0xc5,0xfc|pp]}});
export const evex=(p0=0xf1,p1=0x7c,p2=0x08)=>({legacy:[],rex:null,vector:{kind:'evex',bytes:[0x62,p0,p1,p2]}});
export function instruction(family,operands=[],prefixes=legacy(),rawBytes=[0x90]){seq++;return{address:0x500000n+BigInt(seq*16),length:rawBytes.length,rawBytes:Uint8Array.from(rawBytes),mode:'long-64',instructionCode:code++,instructionFamily:family,instructionId:`x86-denominator:${family}:${seq}`,detailAvailable:true,detailStatus:'complete',mnemonic:family,opStr:'',detail:{operandCount:operands.length,operands,prefixes,implicitReads:[],implicitWrites:[],conditionCode:null}};}
export function effects(family,operands=[],prefixes=legacy(),rawBytes=[0x90]){const input=instruction(family,operands,prefixes,rawBytes);return liftX86MachineEffects(input,{instructionId:input.instructionId});}
export const operations=(bundle,kind)=>bundle.operations.filter((op)=>op.kind===kind);
