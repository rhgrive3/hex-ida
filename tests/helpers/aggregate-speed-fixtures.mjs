export function semanticFunction() {
  const origin={instructionIds:['aggregate:instruction']};
  const call={targetValueIds:[],targetEntityIds:[],arguments:['address'],returns:[],stateReads:[],stateWrites:[],
    memoryRead:{scope:'none'},memoryWrite:{scope:'none'},controlEffects:[],determinism:'deterministic',
    noreturn:false,mayThrow:false,summarySource:'aggregate-test',completeness:'complete',unknownEffects:null};
  return {schemaVersion:2,contractVersion:'2.0.0',functionId:'aggregate:function',entryBlockId:'entry',
    blocks:[{id:'entry',nodeIds:['call','return'],origin}],
    values:[{id:'address',kind:'entry',machineType:{kind:'address',widthBits:64,addressSpace:'memory'},
      metadata:{b:2,a:{values:[1,2,3]}},origin}],
    nodes:[{id:'call',kind:'call',blockId:'entry',inputs:['address'],outputs:[],call,
      attributes:{z:[{a:2}],a:'日本語'},origin},
      {id:'return',kind:'return',blockId:'entry',inputs:[],outputs:[],origin}],
    completeness:'complete',unknowns:[],origin};
}
