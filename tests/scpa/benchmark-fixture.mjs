// Synthetic offline fixtures verify bookkeeping, NOT actual competitor results.
import { createCompetitiveProtocol, PARTICIPANTS, EXACT_ERROR_COUNTERS, admitCompetitiveProtocol } from '../../js/analysis/benchmark/competitive-protocol.js';
import { createCompetitiveMetricMatrix } from '../../js/analysis/benchmark/competitive-matrix.js';
export const H = 'ab'.repeat(32);
export function protocolInput() {
  const astra = {provider:'test-only', modelId:'test-model', modelRevision:'fixed'};
  for (const key of ['inferenceParameters','systemPrompt','taskPrompt','harness','contextPolicy','knowledgePolicy','resourcePolicy']) astra[key+'Sha256']=H;
  return {campaign:'contract-fixture-not-an-experiment', baselineCommit:'a'.repeat(40), denominatorSha256:H, track:'native-best',
    participants:PARTICIPANTS.map(id=>({id, tool:{name:id, version:'fixture', distributionSha256:H, adapterSha256:H, settingsSha256:H,
      availability:'AVAILABLE',capabilities:[],evidenceRefs:['test-fixture']}, astra:{...astra},
      machine:{machineId:'fixture',osBuild:'fixture',browserBuild:null,cpuProfile:'fixture',memoryBytes:1024,powerMode:'fixture',isolationPolicySha256:H},nativeCapabilitiesPolicySha256:H})),
    cases:['easy','hard'].map(caseId=>({caseId,sourceSha256:H,binarySha256:H,debugBinarySha256:H,twinManifestSchema:'hex-competitive-twin-manifest/v1',
      twinManifestDigest:'test-manifest',executableBytesManifestSha256:H,oracleManifestSha256:H,toolchainManifestSha256:H,
      licenseEvidence:'test-fixture',language:'c',platform:'linux',isaProfile:'arm64'})),
    metrics:['focused-query'],repetitions:1,orderPolicySha256:H,warmStatePolicySha256:H,adjudicationPolicySha256:H,victoryPolicySha256:H,holdoutManifestSha256:H};
}
export function benchmarkFixture(change=()=>{}) {
  const input=protocolInput(); change(input);
  const protocol=createCompetitiveProtocol(input);
  const matrixInput={protocolId:protocol.id,definitionSha256:H,caseStrata:protocol.cases.map(c=>({caseId:c.caseId,stratumId:'both'})),
    metrics:[{id:'focused-query',unit:'ms',direction:'lower-better',cacheStates:['cold'],definitionSha256:H}]};
  return {protocol,matrix:createCompetitiveMetricMatrix(protocol,matrixInput),matrixInput};
}
export function rowsFor(p) {
  return p.cases.flatMap(c=>p.participants.map((participant,i)=>({protocolId:p.id,caseId:c.caseId,participantId:participant.id,
    metric:'focused-query',repetition:0,state:'MEASURED',cacheState:'cold',binarySha256:c.binarySha256,value:i+1,unit:'ms',
    recall:1,unknownRate:0,exactErrors:Object.fromEntries(EXACT_ERROR_COUNTERS.map(k=>[k,0])),
    oracleReceiptId:'test-oracle',executionReceiptId:'test-execution',correctnessReceiptId:'test-correctness',sampleTraceSha256:H})));
}
// These are deliberately named test doubles. Production still has no independent
// preregistration / ground-truth / measurement replay adapter in this package.
export function testAdmission(p,work) {
  return admitCompetitiveProtocol(p,{work,verifyPolicies:()=>({protocolId:p.id,denominatorSha256:p.denominatorSha256,victoryPolicySha256:p.victoryPolicySha256,
    preregistered:true,nativeAdaptersFair:true,counterbalanced:true,knowledgePolicyChecked:true}),
    verifyTwin:c=>({...c,stripLineageVerified:true,executableBytesEqual:true,independentGroundTruth:true,licensePermitted:true,checkerVersion:'TEST-DOUBLE'}),
    verifyParticipant:x=>({participantId:x.id,toolDistributionSha256:x.tool.distributionSha256,adapterSha256:x.tool.adapterSha256,
      sameAstraIdentity:p.sameAstraIdentity,nativeCapabilitiesActuallyExercised:true,availableForMeasurement:true})});
}
export function testVerifiers(p,m,isCurrent=()=>true) {
  return {verifyDefinition:()=>({isCurrent,data:{protocolId:p.id,matrixId:m.id,definitionSha256:m.definitionSha256,
    denominatorSha256:p.denominatorSha256,victoryPolicySha256:p.victoryPolicySha256,checkerId:'TEST-DOUBLE',checkerVersion:'1',receiptId:'test-definition',
    preregistrationVerified:true,fullDenominatorVerified:true,cacheAndStrataPolicyVerified:true}}),
  verifyMeasurement:r=>({isCurrent,data:{protocolId:p.id,matrixId:m.id,measurementId:r.id,sampleTraceSha256:r.sampleTraceSha256,
    definitionSha256:m.metrics[0].definitionSha256,oracleReceiptId:r.oracleReceiptId,executionReceiptId:r.executionReceiptId,correctnessReceiptId:r.correctnessReceiptId,
    sameAstraIdentity:p.sameAstraIdentity,checkerId:'TEST-DOUBLE',checkerVersion:'1',receiptId:'test-row',traceAndToolIdentityVerified:true,
    independentOracleVerified:true,reportedNumbersVerified:true,scopeAndResourceAccountingVerified:true}})};
}
