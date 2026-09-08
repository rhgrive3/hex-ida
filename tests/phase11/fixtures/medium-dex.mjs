// Small self-contained DEX builders; no production parser/validator is used here.
export function uleb(value) {
  let n = BigInt(value), out = [];
  do { const b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n);
  return out;
}
export function sleb(value) {
  let n = BigInt(value), out = [];
  for (;;) { const b = Number(n & 127n); n >>= 7n; const done = (n === 0n && !(b & 64)) || (n === -1n && (b & 64)); out.push(b | (done ? 0 : 128)); if (done) return out; }
}
export function dexMethod(words = [0x000e], options = {}) {
  const codeOff = 4, start = codeOff + 16;
  const tries = options.tries ?? [];
  const pad = tries.length && words.length % 2 ? 2 : 0;
  const handlers = options.handlers ?? [];
  const bytes = new Uint8Array(start + words.length * 2 + pad + tries.length * 8 + handlers.length + (options.extra ?? 0));
  const v = new DataView(bytes.buffer);
  v.setUint16(codeOff, options.registers ?? 8, true);
  v.setUint16(codeOff + 2, options.ins ?? 0, true);
  v.setUint16(codeOff + 4, options.outs ?? 5, true);
  v.setUint16(codeOff + 6, options.triesSize ?? tries.length, true);
  v.setUint32(codeOff + 12, words.length, true);
  words.forEach((w, i) => v.setUint16(start + i * 2, w, true));
  const triesStart = start + words.length * 2 + pad;
  tries.forEach((t, i) => { const p = triesStart + i * 8; v.setUint32(p, t.start, true); v.setUint16(p + 4, t.count, true); v.setUint16(p + 6, t.handlerOff, true); });
  bytes.set(handlers, triesStart + tries.length * 8);
  return {
    moduleId: 'managed-mod:medium-dex', vmSpecEdition: 'dalvik-dex-039', rawBytes: bytes,
    strings: options.strings ?? [''], types: options.types ?? ['LTest;'],
    fields: options.fields ?? [{ classType:'LTest;', type:'I', name:'x' }],
    methods: options.methods ?? [{ name:'m', classType:'LTest;', proto:{ params:[], returnType:'V' } }],
    classes: options.classes ?? [{ classType:'LTest;', directMethods:[{ methodIdx:0, codeOff, accessFlags:9 }], virtualMethods:[] }],
  };
}

export function buildDex(options = {}) {
  const fields = options.fields ?? [{ classType:'LTest;', type:'I', name:'x' }];
  const methods = options.methods ?? [{ classType:'LTest;', name:'foo', returnType:'V', params:[], flags:9, words:[0x000e] }];
  const classNames = options.classNames ?? ['LTest;'];
  const typeNames = [...new Set([...classNames, ...fields.flatMap(f => [f.classType, f.type]), ...methods.flatMap(m => [m.classType, m.returnType, ...(m.params ?? [])])])].sort();
  const shorty = m => [m.returnType, ...(m.params ?? [])].map(t => /^[L[]/.test(t) ? 'L' : t).join('');
  const strings = [...new Set([...typeNames, ...fields.map(f => f.name), ...methods.flatMap(m => [m.name, m.shorty ?? shorty(m)]), ...(options.strings ?? [])])].sort();
  const si = s => strings.indexOf(s), ti = s => typeNames.indexOf(s);
  const data = new Uint8Array(65536), v = new DataView(data.buffer), maps = [[0,1,0]], layout = {};
  let pos = 0x70;
  const align = () => { pos = Math.ceil(pos / 4) * 4; };
  const emit = a => { const p = pos; data.set(a, pos); pos += a.length; return p; };
  const reserve = (name, type, count, width, header) => { if (!count) return 0; align(); const p = pos; pos += count * width; v.setUint32(header,count,true); v.setUint32(header+4,p,true); maps.push([type,count,p]); layout[name]=p; return p; };
  reserve('strings',1,strings.length,4,56); reserve('types',2,typeNames.length,4,64);
  reserve('protos',3,methods.length,12,72); reserve('fields',4,fields.length,8,80);
  reserve('methods',5,methods.length,8,88); reserve('classes',6,classNames.length,32,96);
  align(); const dataStart = pos;
  const stringStart = pos;
  strings.forEach((s,i) => {
    // This test builder deliberately needs only ASCII descriptor/name strings.
    const off = emit([...uleb(s.length), ...new TextEncoder().encode(s), 0]);
    v.setUint32(layout.strings+i*4,off,true);
  });
  maps.push([0x2002,strings.length,stringStart]); layout.stringDataEnd=pos;
  // Padding is kept available for malformed-reference tests, outside the map's declared items.
  emit(new Uint8Array(16));
  const paramsOffsets=[]; let paramStart=null, paramCount=0;
  for (const m of methods) {
    if (!(m.params ?? []).length) { paramsOffsets.push(0); continue; }
    align(); if (paramStart===null) paramStart=pos;
    const p=pos; v.setUint32(pos,m.params.length,true); pos+=4;
    for (const t of m.params) { v.setUint16(pos,ti(t),true); pos+=2; }
    align(); paramsOffsets.push(p); paramCount++;
  }
  if(paramCount) maps.push([0x1001,paramCount,paramStart]);
  const codeOffsets=[]; let codeStart=null, codeCount=0;
  for(const m of methods) {
    if(m.words==null) {codeOffsets.push(0);continue;}
    align(); if(codeStart===null) codeStart=pos;
    const p=pos; codeOffsets.push(p); pos+=16;
    v.setUint16(p,m.registers ?? 8,true); v.setUint16(p+2,m.ins ?? ((m.flags??9)&8?0:1)+(m.params??[]).reduce((a,t)=>a+(t==='J'||t==='D'?2:1),0),true);
    v.setUint16(p+4,m.outs ?? 5,true); v.setUint32(p+12,m.words.length,true);
    for(const w of m.words) {v.setUint16(pos,w,true);pos+=2;} codeCount++;
  }
  if(codeCount) maps.push([0x2001,codeCount,codeStart]);
  layout.codeOffsets=codeOffsets;
  let classDataStart=null; layout.classData=[];
  classNames.forEach((name,index) => {
    if(classDataStart===null) classDataStart=pos;
    const start=pos; layout.classData.push(start);
    const ownedFields=fields.map((f,i)=>({f,i})).filter(({f})=>f.owner==null?f.classType===name:f.owner===name);
    const statics=ownedFields.filter(({f})=>f.static!==false), instances=ownedFields.filter(({f})=>f.static===false);
    const ownedMethods=methods.map((m,i)=>({m,i})).filter(({m})=>m.defined!==false && m.classType===name);
    const direct=ownedMethods.filter(({m})=>!m.virtual), virtual=ownedMethods.filter(({m})=>m.virtual);
    emit([...uleb(statics.length),...uleb(instances.length),...uleb(direct.length),...uleb(virtual.length)]);
    for(const list of [statics,instances]) {let previous=0; for(const {f,i}of list){emit([...uleb(i-previous),...uleb(f.flags??(f.static===false?1:9))]);previous=i;}}
    for(const list of [direct,virtual]) {let previous=0; for(const {m,i}of list){emit([...uleb(i-previous),...uleb(m.flags??9),...uleb(codeOffsets[i])]);previous=i;}}
    const p=layout.classes+index*32; v.setUint32(p,ti(name),true);v.setUint32(p+4,1,true);v.setUint32(p+8,0xffffffff,true);v.setUint32(p+16,0xffffffff,true);v.setUint32(p+24,start,true);
  });
  if(classNames.length) maps.push([0x2000,classNames.length,classDataStart]);
  align(); const mapOff=pos; maps.push([0x1000,1,mapOff]); v.setUint32(pos,maps.length,true);pos+=4;
  for(const[type,size,off]of maps){v.setUint16(pos,type,true);v.setUint32(pos+4,size,true);v.setUint32(pos+8,off,true);pos+=12;}
  layout.mapOff=mapOff;layout.maps=maps;layout.dataStart=dataStart;layout.stringsList=strings;layout.typesList=typeNames;
  typeNames.forEach((s,i)=>v.setUint32(layout.types+i*4,si(s),true));
  fields.forEach((f,i)=>{const p=layout.fields+i*8;v.setUint16(p,ti(f.classType),true);v.setUint16(p+2,ti(f.type),true);v.setUint32(p+4,si(f.name),true);});
  methods.forEach((m,i)=>{let p=layout.protos+i*12;v.setUint32(p,si(m.shorty??shorty(m)),true);v.setUint32(p+4,ti(m.returnType),true);v.setUint32(p+8,paramsOffsets[i],true);p=layout.methods+i*8;v.setUint16(p,ti(m.classType),true);v.setUint16(p+2,i,true);v.setUint32(p+4,si(m.name),true);});
  data.set([100,101,120,10,48,51,57,0]);v.setUint32(32,pos,true);v.setUint32(36,0x70,true);v.setUint32(40,0x12345678,true);v.setUint32(52,mapOff,true);v.setUint32(104,pos-dataStart,true);v.setUint32(108,dataStart,true);
  return { bytes:data.slice(0,pos), layout };
}
