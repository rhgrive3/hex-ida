import path from 'node:path'; import { pathToFileURL } from 'node:url';
const root=path.resolve(process.argv[2]);
const {openProduct}=await import(pathToFileURL(root+'/tools/validation/public-benchmark/product-host.mjs').href);
const rtti=await import(pathToFileURL(root+'/js/rtti.js').href);
const p=await openProduct(process.argv[3]);
const syms=p.app.symbols;
const c=rtti.findCxxClasses(syms,10000);
console.log(JSON.stringify({root, classes:c.length, vtables:c.filter(x=>x.vtable!=null).length, typeinfos:c.filter(x=>x.typeinfo!=null).length, symCount: syms.all?.length ?? syms.count ?? null, profile:p.profile}));
await p.close();
