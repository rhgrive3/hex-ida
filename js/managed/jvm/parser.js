import { deepFreeze } from '../../core/identity/index.js';
import { createManagedImageId, createManagedModuleId } from '../shared/identity.js';

function fail(code){throw new TypeError(code);}
function checkedRange(limit,offset,size,code){if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||offset>limit||size>limit-offset)fail(code);}
export function probeJvm(bytes){if(!bytes||bytes.length<10)return{supported:false,confidence:0,reason:'too-small'};const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);if(u8[0]===0xca&&u8[1]===0xfe&&u8[2]===0xba&&u8[3]===0xbe){const minor=(u8[4]<<8)|u8[5],major=(u8[6]<<8)|u8[7];return{supported:true,confidence:1,formatVersion:`class-${major}.${minor}`,vmSpecEdition:`java-se-${major>=45?major-44:major}`};}return{supported:false,confidence:0,reason:'invalid-magic'};}
function decodeMutf8(bytes){let pos=0,chars=[];while(pos<bytes.length){const b1=bytes[pos++];if((b1&0x80)===0)chars.push(String.fromCharCode(b1));else if((b1&0xe0)===0xc0){const b2=bytes[pos++];chars.push(String.fromCharCode(((b1&0x1f)<<6)|(b2&0x3f)));}else if((b1&0xf0)===0xe0){const b2=bytes[pos++],b3=bytes[pos++];chars.push(String.fromCharCode(((b1&0x0f)<<12)|((b2&0x3f)<<6)|(b3&0x3f)));}}return chars.join('');}

export function parseJvm(bytes,options={}){
  const probe=probeJvm(bytes);if(!probe.supported)fail('jvm-unsupported-binary');const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);const view=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);const ensure=(o,s,c='jvm-truncated-class')=>checkedRange(u8.length,o,s,c);ensure(0,10,'jvm-truncated-header');
  const minorVersion=view.getUint16(4,false),majorVersion=view.getUint16(6,false),cpCount=view.getUint16(8,false);const constantPool=[null];let pos=10;
  for(let i=1;i<cpCount;i++){if(pos>=u8.length)fail('jvm-truncated-constant-pool');const tag=u8[pos++];switch(tag){
    case 1:{ensure(pos,2,'jvm-truncated-cp-utf8');const len=view.getUint16(pos,false);pos+=2;ensure(pos,len,'jvm-truncated-cp-utf8');constantPool.push({tag:1,value:decodeMutf8(u8.subarray(pos,pos+len))});pos+=len;break;}
    case 3:ensure(pos,4,'jvm-truncated-cp-integer');constantPool.push({tag:3,value:view.getInt32(pos,false)});pos+=4;break;
    case 4:ensure(pos,4,'jvm-truncated-cp-float');constantPool.push({tag:4,value:view.getFloat32(pos,false)});pos+=4;break;
    case 5:ensure(pos,8,'jvm-truncated-cp-long');constantPool.push({tag:5,value:view.getBigInt64(pos,false)});pos+=8;constantPool.push(null);i++;break;
    case 6:ensure(pos,8,'jvm-truncated-cp-double');constantPool.push({tag:6,value:view.getFloat64(pos,false)});pos+=8;constantPool.push(null);i++;break;
    case 7:ensure(pos,2,'jvm-truncated-cp-class');constantPool.push({tag:7,nameIndex:view.getUint16(pos,false)});pos+=2;break;
    case 8:ensure(pos,2,'jvm-truncated-cp-string');constantPool.push({tag:8,stringIndex:view.getUint16(pos,false)});pos+=2;break;
    case 9:case 10:case 11:ensure(pos,4,'jvm-truncated-cp-memberref');constantPool.push({tag,classIndex:view.getUint16(pos,false),nameAndTypeIndex:view.getUint16(pos+2,false)});pos+=4;break;
    case 12:ensure(pos,4,'jvm-truncated-cp-nameandtype');constantPool.push({tag:12,nameIndex:view.getUint16(pos,false),descriptorIndex:view.getUint16(pos+2,false)});pos+=4;break;
    case 15:ensure(pos,3,'jvm-truncated-cp-methodhandle');pos+=3;constantPool.push({tag:15});break;
    case 16:ensure(pos,2,'jvm-truncated-cp-methodtype');pos+=2;constantPool.push({tag:16});break;
    case 17:case 18:ensure(pos,4,'jvm-truncated-cp-dynamic');pos+=4;constantPool.push({tag});break;
    case 19:case 20:ensure(pos,2,'jvm-truncated-cp-module');pos+=2;constantPool.push({tag});break;
    default:fail(`jvm-invalid-cp-tag-${tag}`);
  }}
  function requireCp(idx,tag,code){if(!Number.isInteger(idx)||idx<=0||idx>=constantPool.length)fail(code);const entry=constantPool[idx];if(!entry||entry.tag!==tag)fail(code);return entry;}
  function requireUtf8(idx,code='jvm-invalid-utf8-index'){return requireCp(idx,1,code).value;}
  function requireClassName(idx,code='jvm-invalid-class-index'){const entry=requireCp(idx,7,code);return requireUtf8(entry.nameIndex,`${code}-name`);}
  ensure(pos,8,'jvm-truncated-class-info');const accessFlags=view.getUint16(pos,false),thisClassIdx=view.getUint16(pos+2,false),superClassIdx=view.getUint16(pos+4,false),interfacesCount=view.getUint16(pos+6,false);pos+=8;
  const interfaces=[];ensure(pos,interfacesCount*2,'jvm-truncated-interfaces');for(let i=0;i<interfacesCount;i++){interfaces.push(requireClassName(view.getUint16(pos,false),'jvm-invalid-interface-index'));pos+=2;}
  ensure(pos,2,'jvm-truncated-fields-count');const fieldsCount=view.getUint16(pos,false);pos+=2;const fields=[];
  for(let i=0;i<fieldsCount;i++){ensure(pos,8,'jvm-truncated-field-info');const fFlags=view.getUint16(pos,false),nameIdx=view.getUint16(pos+2,false),descIdx=view.getUint16(pos+4,false),attrCount=view.getUint16(pos+6,false);pos+=8;for(let a=0;a<attrCount;a++){ensure(pos,6,'jvm-truncated-field-attribute');requireUtf8(view.getUint16(pos,false),'jvm-invalid-field-attribute-name-index');const aLen=view.getUint32(pos+2,false);ensure(pos+6,aLen,'jvm-truncated-field-attribute');pos+=6+aLen;}fields.push({accessFlags:fFlags,name:requireUtf8(nameIdx,'jvm-invalid-field-name-index'),descriptor:requireUtf8(descIdx,'jvm-invalid-field-descriptor-index')});}
  ensure(pos,2,'jvm-truncated-methods-count');const methodsCount=view.getUint16(pos,false);pos+=2;const methods=[];
  for(let i=0;i<methodsCount;i++){ensure(pos,8,'jvm-truncated-method-info');const mFlags=view.getUint16(pos,false),nameIdx=view.getUint16(pos+2,false),descIdx=view.getUint16(pos+4,false),attrCount=view.getUint16(pos+6,false);pos+=8;let codeAttr=null;
    for(let a=0;a<attrCount;a++){ensure(pos,6,'jvm-truncated-method-attribute');const attrNameIdx=view.getUint16(pos,false),attrLen=view.getUint32(pos+2,false),attrName=requireUtf8(attrNameIdx,'jvm-invalid-method-attribute-name-index'),attrDataStart=pos+6;ensure(attrDataStart,attrLen,'jvm-truncated-method-attribute');pos+=6+attrLen;
      if(attrName==='Code'){ensure(attrDataStart,8,'jvm-truncated-code-attribute');const maxStack=view.getUint16(attrDataStart,false),maxLocals=view.getUint16(attrDataStart+2,false),codeLength=view.getUint32(attrDataStart+4,false);ensure(attrDataStart+8,codeLength+2,'jvm-truncated-code-bytes');const bytecode=u8.subarray(attrDataStart+8,attrDataStart+8+codeLength);let cPos=attrDataStart+8+codeLength;const excTableLength=view.getUint16(cPos,false);cPos+=2;const exceptionTable=[];ensure(cPos,excTableLength*8,'jvm-truncated-exception-table');for(let e=0;e<excTableLength;e++){const startPc=view.getUint16(cPos,false),endPc=view.getUint16(cPos+2,false),handlerPc=view.getUint16(cPos+4,false),catchType=view.getUint16(cPos+6,false);cPos+=8;exceptionTable.push({startPc,endPc,handlerPc,catchType:catchType!==0?requireClassName(catchType,'jvm-invalid-catch-type-index'):null});}codeAttr={maxStack,maxLocals,codeLength,bytecode,exceptionTable,offset:attrDataStart+8};}}
    methods.push({accessFlags:mFlags,name:requireUtf8(nameIdx,'jvm-invalid-method-name-index'),descriptor:requireUtf8(descIdx,'jvm-invalid-method-descriptor-index'),code:codeAttr});
  }
  const thisClassName=requireClassName(thisClassIdx,'jvm-invalid-this-class-index'),superClassName=superClassIdx===0?null:requireClassName(superClassIdx,'jvm-invalid-super-class-index');
  ensure(pos,2,'jvm-truncated-class-attributes-count');const classAttrCount=view.getUint16(pos,false);pos+=2;for(let a=0;a<classAttrCount;a++){ensure(pos,6,'jvm-truncated-class-attribute');requireUtf8(view.getUint16(pos,false),'jvm-invalid-class-attribute-name-index');const attrLen=view.getUint32(pos+2,false);ensure(pos+6,attrLen,'jvm-truncated-class-attribute');pos+=6+attrLen;}if(pos!==u8.length)fail('jvm-trailing-bytes');
  const binaryId=options.binaryId||'jvm-binary',imageId=createManagedImageId(binaryId),moduleId=createManagedModuleId(imageId,`${thisClassName}.class`);
  return deepFreeze({imageId,moduleId,formatVersion:`class-${majorVersion}.${minorVersion}`,vmSpecEdition:probe.vmSpecEdition,thisClassName,superClassName,interfaces,accessFlags,constantPool,fields,methods,rawBytes:u8});
}
