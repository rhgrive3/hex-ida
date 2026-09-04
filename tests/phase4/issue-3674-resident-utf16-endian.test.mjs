import assert from 'node:assert/strict';
import { scanStrings } from '../../js/binary/strings.js';
import { scanSourceStrings } from '../../js/bytesource/strings.js';

function makeImage(bytes, endian) {
  return {
    bytes,
    endian,
    sections:[{
      name:'.rodata',
      fileOffset:0n,
      fileSize:BigInt(bytes.length),
      perms:{ execute:false },
    }],
    segments:[],
    offsetToAddress(offset) { return 0x1000n + offset; },
  };
}

function encodeUtf16Ascii(text, encoding) {
  const out=[];
  for (const ch of text) {
    const code=ch.charCodeAt(0);
    if (encoding === 'utf16be') out.push(code >>> 8, code & 0xff);
    else out.push(code & 0xff, code >>> 8);
  }
  return Uint8Array.from(out);
}

function exact(results, text, encoding, fileOffset=0n) {
  return results.find((item) => item.text === text
    && item.encoding === encoding
    && item.fileOffset === fileOffset);
}

async function assertResidentSourceEvidenceParity(bytes, endian, options, expected) {
  const image=makeImage(bytes,endian);
  const resident=scanStrings(image,options);
  const streamed=(await scanSourceStrings(image,bytes,options)).results;
  for (const item of expected) {
    assert.ok(exact(resident,item.text,item.encoding,item.fileOffset), `resident missing ${item.encoding}:${item.text}`);
    assert.ok(exact(streamed,item.text,item.encoding,item.fileOffset), `source-backed missing ${item.encoding}:${item.text}`);
  }
}

const beBytes=encodeUtf16Ascii('ABCD','utf16be');
const leBytes=encodeUtf16Ascii('ABCD','utf16le');

await assertResidentSourceEvidenceParity(beBytes,'big',{ minLength:4 },[
  { text:'ABCD', encoding:'utf16be', fileOffset:0n },
]);
await assertResidentSourceEvidenceParity(leBytes,'little',{ minLength:4 },[
  { text:'ABCD', encoding:'utf16le', fileOffset:0n },
]);

for (const option of ['be','utf16be','utf-16be']) {
  const results=scanStrings(makeImage(beBytes,'little'),{ minLength:4, utf16:option });
  assert.ok(exact(results,'ABCD','utf16be'), `${option} should select UTF-16BE`);
  assert.equal(results.some((item)=>item.encoding==='utf16le'),false,`${option} should not run UTF-16LE`);
}
for (const option of ['le','utf16le','utf-16le']) {
  const results=scanStrings(makeImage(leBytes,'big'),{ minLength:4, utf16:option });
  assert.ok(exact(results,'ABCD','utf16le'), `${option} should select UTF-16LE`);
  assert.equal(results.some((item)=>item.encoding==='utf16be'),false,`${option} should not run UTF-16BE`);
}

{
  const bytes=Uint8Array.from([
    ...encodeUtf16Ascii('ABCD','utf16be'),
    0x00,0x00,
    ...encodeUtf16Ascii('WXYZ','utf16le'),
  ]);
  await assertResidentSourceEvidenceParity(bytes,'big',{ minLength:4, utf16:'both' },[
    { text:'ABCD', encoding:'utf16be', fileOffset:0n },
    { text:'WXYZ', encoding:'utf16le', fileOffset:10n },
  ]);
}

{
  const results=scanStrings(makeImage(beBytes,'big'),{ minLength:4, utf16:false });
  assert.equal(results.some((item)=>item.encoding==='utf16le'||item.encoding==='utf16be'),false,'utf16:false should disable UTF-16 scanning');
}

console.log('issue-3674 resident UTF-16 endian regression: PASS');
