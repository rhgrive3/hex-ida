#!/usr/bin/env node
// Transparent telemetry around the actual blind collector. Diagnosis only;
// no oracle input, policy change, alternate engine or passing accuracy claim.
import {AnalysisQueryAPI} from '../js/analysis/query/api.js';
import {CxxMemberIndex} from '../js/analysis/cxx/member-index.js';
const emit=value=>console.log(JSON.stringify({diagnostic:true,...value}));
for(const method of ['snapshot','decompile']) {
  const original=AnalysisQueryAPI.prototype[method];
  AnalysisQueryAPI.prototype[method]=async function(...args) {
    const address=method==='decompile'?String(args[1]):null;
    emit({phase:method+'-start',address});const start=performance.now();
    try {return await original.apply(this,args);}
    finally {emit({phase:method+'-end',address,elapsedMs:performance.now()-start});}
  };
}
const publish=CxxMemberIndex.prototype.publish;
CxxMemberIndex.prototype.publish=function(projection) {
  emit({phase:'publication-start',functionId:projection?.functionId});
  const result=publish.call(this,projection);
  emit({phase:'publication-end',fields:this.fieldCount});return result;
};
emit({phase:'collector-start'});
await import('./collect-jev-realgame-recovery.mjs');
emit({phase:'collector-end'});
