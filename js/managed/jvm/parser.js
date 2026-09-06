import { deepFreeze } from '../../core/identity/index.js';
import { createManagedImageId, createManagedModuleId } from '../shared/identity.js';
import { parseJvmFieldDescriptor, parseJvmMethodDescriptor } from './descriptors.js';

function fail(code){throw new TypeError(code);}
function checkedRange(limit,offset,size,code){if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||offset>limit||size>limit-offset)fail(code);}
const JVM_CLASS_VERSIONS = new Map([
  [45, { vmSpecEdition: 'java-se-1', maxMinor: 3 }],
  [46, { vmSpecEdition: 'java-se-2', maxMinor: 0 }],
  [47, { vmSpecEdition: 'java-se-3', maxMinor: 0 }],
  [48, { vmSpecEdition: 'java-se-4', maxMinor: 0 }],
  [49, { vmSpecEdition: 'java-se-5', maxMinor: 0 }],
  [50, { vmSpecEdition: 'java-se-6', maxMinor: 0 }],
  [51, { vmSpecEdition: 'java-se-7', maxMinor: 0 }],
  [52, { vmSpecEdition: 'java-se-8', maxMinor: 0 }],
  [53, { vmSpecEdition: 'java-se-9', maxMinor: 0 }],
  [54, { vmSpecEdition: 'java-se-10', maxMinor: 0 }],
  [55, { vmSpecEdition: 'java-se-11', maxMinor: 0 }],
  [56, { vmSpecEdition: 'java-se-12', maxMinor: 0 }],
  [57, { vmSpecEdition: 'java-se-13', maxMinor: 0 }],
  [58, { vmSpecEdition: 'java-se-14', maxMinor: 0 }],
  [59, { vmSpecEdition: 'java-se-15', maxMinor: 0 }],
  [60, { vmSpecEdition: 'java-se-16', maxMinor: 0 }],
  [61, { vmSpecEdition: 'java-se-17', maxMinor: 0 }],
]);
const CP_TAG_MIN_MAJOR = new Map([[15,51],[16,51],[17,55],[18,51],[19,53],[20,53]]);
function classVersionInfo(major,minor){const version=JVM_CLASS_VERSIONS.get(major);if(!version||!Number.isInteger(minor)||minor<0||minor>version.maxMinor)return null;return version;}
export function probeJvm(bytes){if(!bytes||bytes.length<10)return{supported:false,confidence:0,reason:'too-small'};const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);if(u8[0]!==0xca||u8[1]!==0xfe||u8[2]!==0xba||u8[3]!==0xbe)return{supported:false,confidence:0,reason:'invalid-magic'};const minor=(u8[4]<<8)|u8[5],major=(u8[6]<<8)|u8[7],formatVersion=`class-${major}.${minor}`,version=classVersionInfo(major,minor);if(!version)return{supported:false,confidence:0.95,reason:'unsupported-version',formatVersion};return{supported:true,confidence:1,formatVersion,vmSpecEdition:version.vmSpecEdition};}
function decodeMutf8(bytes){let pos=0,chars=[];while(pos<bytes.length){const b1=bytes[pos++];if(b1>=0x01&&b1<=0x7f){chars.push(String.fromCharCode(b1));continue;}if((b1&0xe0)===0xc0){if(pos>=bytes.length)fail('jvm-invalid-modified-utf8');const b2=bytes[pos++];if((b2&0xc0)!==0x80)fail('jvm-invalid-modified-utf8');const value=((b1&0x1f)<<6)|(b2&0x3f);if(value===0){if(b1!==0xc0||b2!==0x80)fail('jvm-invalid-modified-utf8');}else if(value<0x80)fail('jvm-invalid-modified-utf8');chars.push(String.fromCharCode(value));continue;}if((b1&0xf0)===0xe0){if(pos+1>=bytes.length)fail('jvm-invalid-modified-utf8');const b2=bytes[pos++],b3=bytes[pos++];if((b2&0xc0)!==0x80||(b3&0xc0)!==0x80)fail('jvm-invalid-modified-utf8');const value=((b1&0x0f)<<12)|((b2&0x3f)<<6)|(b3&0x3f);if(value<0x800)fail('jvm-invalid-modified-utf8');chars.push(String.fromCharCode(value));continue;}fail('jvm-invalid-modified-utf8');}return chars.join('');}

export function parseJvm(bytes,options={}){
  const probe=probeJvm(bytes);if(!probe.supported)fail(probe.reason==='unsupported-version'?'jvm-unsupported-version':'jvm-unsupported-binary');const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);const view=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);const ensure=(o,s,c='jvm-truncated-class')=>checkedRange(u8.length,o,s,c);ensure(0,10,'jvm-truncated-header');
  const minorVersion=view.getUint16(4,false),majorVersion=view.getUint16(6,false),cpCount=view.getUint16(8,false);const constantPool=[null];let pos=10;
  for(let i=1;i<cpCount;i++){if(pos>=u8.length)fail('jvm-truncated-constant-pool');const tag=u8[pos++],minMajor=CP_TAG_MIN_MAJOR.get(tag);if(minMajor!==undefined&&majorVersion<minMajor)fail(`jvm-invalid-cp-tag-version-${tag}`);switch(tag){
    case 1:{ensure(pos,2,'jvm-truncated-cp-utf8');const len=view.getUint16(pos,false);pos+=2;ensure(pos,len,'jvm-truncated-cp-utf8');constantPool.push({tag:1,value:decodeMutf8(u8.subarray(pos,pos+len))});pos+=len;break;}
    case 3:ensure(pos,4,'jvm-truncated-cp-integer');constantPool.push({tag:3,value:view.getInt32(pos,false)});pos+=4;break;
    case 4:ensure(pos,4,'jvm-truncated-cp-float');constantPool.push({tag:4,value:view.getFloat32(pos,false)});pos+=4;break;
    case 5:ensure(pos,8,'jvm-truncated-cp-long');if(i+1>=cpCount)fail('jvm-invalid-cp-reserved-slot');constantPool.push({tag:5,value:view.getBigInt64(pos,false)});pos+=8;constantPool.push(null);i++;break;
    case 6:ensure(pos,8,'jvm-truncated-cp-double');if(i+1>=cpCount)fail('jvm-invalid-cp-reserved-slot');constantPool.push({tag:6,value:view.getFloat64(pos,false)});pos+=8;constantPool.push(null);i++;break;
    case 7:ensure(pos,2,'jvm-truncated-cp-class');constantPool.push({tag:7,nameIndex:view.getUint16(pos,false)});pos+=2;break;
    case 8:ensure(pos,2,'jvm-truncated-cp-string');constantPool.push({tag:8,stringIndex:view.getUint16(pos,false)});pos+=2;break;
    case 9:case 10:case 11:ensure(pos,4,'jvm-truncated-cp-memberref');constantPool.push({tag,classIndex:view.getUint16(pos,false),nameAndTypeIndex:view.getUint16(pos+2,false)});pos+=4;break;
    case 12:ensure(pos,4,'jvm-truncated-cp-nameandtype');constantPool.push({tag:12,nameIndex:view.getUint16(pos,false),descriptorIndex:view.getUint16(pos+2,false)});pos+=4;break;
    case 15:ensure(pos,3,'jvm-truncated-cp-methodhandle');constantPool.push({tag:15,referenceKind:u8[pos],referenceIndex:view.getUint16(pos+1,false)});pos+=3;break;
    case 16:ensure(pos,2,'jvm-truncated-cp-methodtype');constantPool.push({tag:16,descriptorIndex:view.getUint16(pos,false)});pos+=2;break;
    case 17:case 18:ensure(pos,4,'jvm-truncated-cp-dynamic');constantPool.push({tag,bootstrapMethodAttrIndex:view.getUint16(pos,false),nameAndTypeIndex:view.getUint16(pos+2,false)});pos+=4;break;
    case 19:case 20:ensure(pos,2,'jvm-truncated-cp-module');constantPool.push({tag,nameIndex:view.getUint16(pos,false)});pos+=2;break;
    default:fail(`jvm-invalid-cp-tag-${tag}`);
  }}
  function requireCp(idx,tag,code){if(!Number.isInteger(idx)||idx<=0||idx>=constantPool.length)fail(code);const entry=constantPool[idx];if(!entry||entry.tag!==tag)fail(code);return entry;}
  function requireCpOneOf(idx,tags,code){if(!Number.isInteger(idx)||idx<=0||idx>=constantPool.length)fail(code);const entry=constantPool[idx];if(!entry||!tags.includes(entry.tag))fail(code);return entry;}
  function requireUtf8(idx,code='jvm-invalid-utf8-index'){return requireCp(idx,1,code).value;}
  function requireClassName(idx,code='jvm-invalid-class-index'){const entry=requireCp(idx,7,code);return requireUtf8(entry.nameIndex,`${code}-name`);}
  function parseNameAndTypeDescriptor(index,kind,code){const nameAndType=requireCp(index,12,code);const descriptor=requireUtf8(nameAndType.descriptorIndex,`${code}-descriptor-index`);if(kind==='field')parseJvmFieldDescriptor(descriptor);else parseJvmMethodDescriptor(descriptor);return nameAndType;}
  function validateConstantPool(){for(let i=1;i<constantPool.length;i++){const entry=constantPool[i];if(!entry)continue;switch(entry.tag){
    case 7:requireCp(entry.nameIndex,1,'jvm-invalid-cp-class-name-index');break;
    case 8:requireCp(entry.stringIndex,1,'jvm-invalid-cp-string-index');break;
    case 9:requireCp(entry.classIndex,7,'jvm-invalid-cp-memberref-class-index');parseNameAndTypeDescriptor(entry.nameAndTypeIndex,'field','jvm-invalid-cp-memberref-name-and-type-index');break;
    case 10:case 11:requireCp(entry.classIndex,7,'jvm-invalid-cp-memberref-class-index');parseNameAndTypeDescriptor(entry.nameAndTypeIndex,'method','jvm-invalid-cp-memberref-name-and-type-index');break;
    case 12:requireCp(entry.nameIndex,1,'jvm-invalid-cp-nameandtype-name-index');requireCp(entry.descriptorIndex,1,'jvm-invalid-cp-nameandtype-descriptor-index');break;
    case 15:{const kind=entry.referenceKind;if(!Number.isInteger(kind)||kind<1||kind>9)fail('jvm-invalid-cp-methodhandle-reference-kind');let tags;if(kind>=1&&kind<=4)tags=[9];else if(kind===9)tags=[11];else if((kind===6||kind===7)&&majorVersion>=52)tags=[10,11];else tags=[10];const target=requireCpOneOf(entry.referenceIndex,tags,'jvm-invalid-cp-methodhandle-reference-index');if(kind>=5){const nameAndType=requireCp(target.nameAndTypeIndex,12,'jvm-invalid-cp-methodhandle-name-and-type-index');const name=requireUtf8(nameAndType.nameIndex,'jvm-invalid-cp-methodhandle-name-index');if((kind===8&&name!=='<init>')||(kind!==8&&(name==='<init>'||name==='<clinit>')))fail('jvm-invalid-cp-methodhandle-target-name');}break;}
    case 16:{const descriptor=requireUtf8(entry.descriptorIndex,'jvm-invalid-cp-methodtype-descriptor-index');parseJvmMethodDescriptor(descriptor);break;}
    case 17:parseNameAndTypeDescriptor(entry.nameAndTypeIndex,'field','jvm-invalid-cp-dynamic-name-and-type-index');break;
    case 18:parseNameAndTypeDescriptor(entry.nameAndTypeIndex,'method','jvm-invalid-cp-dynamic-name-and-type-index');break;
    case 19:case 20:requireCp(entry.nameIndex,1,'jvm-invalid-cp-module-name-index');break;
  }}}
  function validateModuleConstants(accessFlags){if((accessFlags&0x8000)!==0)return;for(const entry of constantPool){if(entry&&(entry.tag===19||entry.tag===20))fail('jvm-invalid-cp-module-context');}}
  function validateBootstrapMethodReferences(bootstrapMethodsCount){for(const entry of constantPool){if(entry&&(entry.tag===17||entry.tag===18)&&(bootstrapMethodsCount===null||entry.bootstrapMethodAttrIndex>=bootstrapMethodsCount))fail('jvm-invalid-cp-bootstrap-method-index');}}
  validateConstantPool();
  ensure(pos,8,'jvm-truncated-class-info');const accessFlags=view.getUint16(pos,false),thisClassIdx=view.getUint16(pos+2,false),superClassIdx=view.getUint16(pos+4,false),interfacesCount=view.getUint16(pos+6,false);pos+=8;validateModuleConstants(accessFlags);
  const interfaces=[];ensure(pos,interfacesCount*2,'jvm-truncated-interfaces');for(let i=0;i<interfacesCount;i++){interfaces.push(requireClassName(view.getUint16(pos,false),'jvm-invalid-interface-index'));pos+=2;}
  ensure(pos,2,'jvm-truncated-fields-count');const fieldsCount=view.getUint16(pos,false);pos+=2;const fields=[];
  for(let i=0;i<fieldsCount;i++){ensure(pos,8,'jvm-truncated-field-info');const fFlags=view.getUint16(pos,false),nameIdx=view.getUint16(pos+2,false),descIdx=view.getUint16(pos+4,false),attrCount=view.getUint16(pos+6,false);pos+=8;for(let a=0;a<attrCount;a++){ensure(pos,6,'jvm-truncated-field-attribute');requireUtf8(view.getUint16(pos,false),'jvm-invalid-field-attribute-name-index');const aLen=view.getUint32(pos+2,false);ensure(pos+6,aLen,'jvm-truncated-field-attribute');pos+=6+aLen;}const fieldDescriptor=requireUtf8(descIdx,'jvm-invalid-field-descriptor-index');parseJvmFieldDescriptor(fieldDescriptor);fields.push({accessFlags:fFlags,name:requireUtf8(nameIdx,'jvm-invalid-field-name-index'),descriptor:fieldDescriptor});}
  ensure(pos,2,'jvm-truncated-methods-count');const methodsCount=view.getUint16(pos,false);pos+=2;const methods=[];
  for(let i=0;i<methodsCount;i++){ensure(pos,8,'jvm-truncated-method-info');const mFlags=view.getUint16(pos,false),nameIdx=view.getUint16(pos+2,false),descIdx=view.getUint16(pos+4,false),attrCount=view.getUint16(pos+6,false);pos+=8;let codeAttr=null,codeCount=0;
    for(let a=0;a<attrCount;a++){ensure(pos,6,'jvm-truncated-method-attribute');const attrNameIdx=view.getUint16(pos,false),attrLen=view.getUint32(pos+2,false),attrName=requireUtf8(attrNameIdx,'jvm-invalid-method-attribute-name-index'),attrDataStart=pos+6;ensure(attrDataStart,attrLen,'jvm-truncated-method-attribute');pos+=6+attrLen;
      if(attrName==='Code'){codeCount++;if(codeCount>1)fail('jvm-duplicate-code-attribute');const attrEnd=attrDataStart+attrLen,ensureCode=(o,s,c)=>checkedRange(attrEnd,o,s,c);ensureCode(attrDataStart,8,'jvm-truncated-code-attribute');const maxStack=view.getUint16(attrDataStart,false),maxLocals=view.getUint16(attrDataStart+2,false),codeLength=view.getUint32(attrDataStart+4,false);ensureCode(attrDataStart+8,codeLength+2,'jvm-truncated-code-bytes');const bytecode=u8.subarray(attrDataStart+8,attrDataStart+8+codeLength);let cPos=attrDataStart+8+codeLength;const excTableLength=view.getUint16(cPos,false);cPos+=2;const exceptionTable=[];ensureCode(cPos,excTableLength*8,'jvm-truncated-exception-table');for(let e=0;e<excTableLength;e++){const startPc=view.getUint16(cPos,false),endPc=view.getUint16(cPos+2,false),handlerPc=view.getUint16(cPos+4,false),catchType=view.getUint16(cPos+6,false);cPos+=8;if(startPc>=endPc||endPc>codeLength||handlerPc>=codeLength)fail('jvm-invalid-exception-table-range');exceptionTable.push({startPc,endPc,handlerPc,catchType:catchType!==0?requireClassName(catchType,'jvm-invalid-catch-type-index'):null});}ensureCode(cPos,2,'jvm-truncated-code-attributes-count');const nestedAttrCount=view.getUint16(cPos,false);cPos+=2;for(let n=0;n<nestedAttrCount;n++){ensureCode(cPos,6,'jvm-truncated-code-attribute');requireUtf8(view.getUint16(cPos,false),'jvm-invalid-code-attribute-name-index');const nestedLen=view.getUint32(cPos+2,false);ensureCode(cPos+6,nestedLen,'jvm-truncated-code-attribute');cPos+=6+nestedLen;}if(cPos!==attrEnd)fail('jvm-invalid-code-attribute-length');codeAttr={maxStack,maxLocals,codeLength,bytecode,exceptionTable,offset:attrDataStart+8};}}
    const forbidsCode=!!(mFlags&(0x0100|0x0400));if(forbidsCode?codeCount!==0:codeCount!==1)fail(forbidsCode?'jvm-code-attribute-forbidden':'jvm-code-attribute-required');
    const methodDescriptor=requireUtf8(descIdx,'jvm-invalid-method-descriptor-index'),parsedMethodDescriptor=parseJvmMethodDescriptor(methodDescriptor);if((mFlags&0x0008)===0){const parameterSlots=parsedMethodDescriptor.parameters.reduce((slots,type)=>slots+(type.kind==='base'&&(type.tag==='J'||type.tag==='D')?2:1),0);if(parameterSlots>=255)fail('jvm-invalid-method-descriptor');}methods.push({accessFlags:mFlags,name:requireUtf8(nameIdx,'jvm-invalid-method-name-index'),descriptor:methodDescriptor,code:codeAttr});
  }
  const thisClassName=requireClassName(thisClassIdx,'jvm-invalid-this-class-index'),superClassName=superClassIdx===0?null:requireClassName(superClassIdx,'jvm-invalid-super-class-index');
  ensure(pos,2,'jvm-truncated-class-attributes-count');const classAttrCount=view.getUint16(pos,false);pos+=2;let bootstrapMethodsCount=null;for(let a=0;a<classAttrCount;a++){ensure(pos,6,'jvm-truncated-class-attribute');const attrName=requireUtf8(view.getUint16(pos,false),'jvm-invalid-class-attribute-name-index'),attrLen=view.getUint32(pos+2,false),attrDataStart=pos+6;ensure(attrDataStart,attrLen,'jvm-truncated-class-attribute');pos=attrDataStart+attrLen;if(attrName==='BootstrapMethods'){if(bootstrapMethodsCount!==null)fail('jvm-duplicate-bootstrap-methods-attribute');const attrEnd=pos,ensureBootstrap=(o,s,c='jvm-truncated-bootstrap-methods-attribute')=>checkedRange(attrEnd,o,s,c);ensureBootstrap(attrDataStart,2);bootstrapMethodsCount=view.getUint16(attrDataStart,false);let bPos=attrDataStart+2;for(let b=0;b<bootstrapMethodsCount;b++){ensureBootstrap(bPos,4);const argumentCount=view.getUint16(bPos+2,false);bPos+=4;ensureBootstrap(bPos,argumentCount*2);bPos+=argumentCount*2;}if(bPos!==attrEnd)fail('jvm-invalid-bootstrap-methods-attribute-length');}}validateBootstrapMethodReferences(bootstrapMethodsCount);if(pos!==u8.length)fail('jvm-trailing-bytes');
  const binaryId=options.binaryId||'jvm-binary',imageId=createManagedImageId(binaryId),moduleId=createManagedModuleId(imageId,`${thisClassName}.class`);
  return deepFreeze({imageId,moduleId,formatVersion:`class-${majorVersion}.${minorVersion}`,vmSpecEdition:probe.vmSpecEdition,thisClassName,superClassName,interfaces,accessFlags,constantPool,fields,methods,rawBytes:u8});
}
