import { diffFunctions } from './index.js';
self.onmessage=(event)=>{
  const msg=event.data||{};if(msg.t!=='diff'||msg.id==null)return;
  try{const result=diffFunctions(msg.before||[],msg.after||[],msg.options||{});self.postMessage({id:msg.id,ok:true,result});}
  catch(error){self.postMessage({id:msg.id,ok:false,error:{name:error?.name||'Error',code:error?.code||null,message:error?.message||String(error)}});}
};
