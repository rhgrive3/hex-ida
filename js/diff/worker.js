import { diffFunctions } from './index.js';
import { materializeCompactFunctionSet } from './compact-function-set.js';
self.onmessage=(event)=>{
  const msg=event.data||{};if(msg.t!=='diff'||msg.id==null)return;
  try{const before=materializeCompactFunctionSet(msg.before||[]);const after=materializeCompactFunctionSet(msg.after||[]);const result=diffFunctions(before,after,msg.options||{});self.postMessage({id:msg.id,ok:true,result});}
  catch(error){self.postMessage({id:msg.id,ok:false,error:{name:error?.name||'Error',code:error?.code||null,message:error?.message||String(error)}});}
};
