import { readFile } from 'node:fs/promises';
import { parseELF } from '/mnt/workspace/hex-ida/js/binary/index.js';
const bytes = new Uint8Array(await readFile(process.argv[2]));
const t=performance.now();
const img=parseELF(bytes,{});
console.log('ms',(performance.now()-t).toFixed(0),'syms',img.symbols.length,'fns',img.functions.length,'imports',img.imports?.length);
