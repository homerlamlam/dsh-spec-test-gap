/** Strict browser boundary; authority and filesystem roots are always Host-derived. */
export const OPERATIONS = Object.freeze(['bootstrap','refs','runs','run','material','models','report','prepare','demo','confirmAnalysis','analyze','cancel','importReview','respond','decide','verify']);
export const ERROR_CODES = Object.freeze(['INVALID_INPUT','FORBIDDEN','NOT_FOUND','ENVIRONMENT','CONFLICT','STALE','CANCELLED','TIMEOUT','INVALID_REVIEW','UNAVAILABLE','INTEGRITY','INTERNAL']);
export const LIMITS = Object.freeze({contextFiles:100,contextBytes:524288,maxContextFiles:2000,maxContextBytes:2097152,requirementsBytes:1048576,verificationBytes:65536,modelInputBytes:8388608,reviewOutputBytes:1048576,outputTokens:8192,modelTimeoutSeconds:300,analysisConcurrency:1,analysisAttempts:1,gitTimeoutSeconds:30,bridgeTimeoutMs:120000,bridgeRequestBytes:8388608,bridgeStdoutBytes:16777216,bridgeStderrBytes:1048576});
export class SpecGapError extends Error {
  constructor(code,message) {super(message);this.name='SpecGapError';this.code=code;}
}
export const fail=(code,message)=>{throw new SpecGapError(code,message);};
function object(value) {return value !== null && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype;}
export const RUN_ID=/^run_[a-f0-9]{32}$/;
export const ATTEMPT_ID=/^attempt_[a-f0-9]{32}$/;
export const ACTION_BODY_BYTES=6*LIMITS.requirementsBytes+16384; // worst-case JSON escaping
const selectors=['workspaceId','sessionId'];
const humanFields=['finding','actor','attestLocal','expectedSequence'];
const humanSelectors=['workspaceId','runId','idempotencyKey',...humanFields];
const requestSchemas={
  bootstrap:[[],selectors],refs:[['workspaceId'],['sessionId','repoPath']],
  runs:[['workspaceId'],['sessionId','limit','offset']],
  run:[['workspaceId','runId'],['sessionId']],material:[['workspaceId','runId'],['sessionId','route','budget']],report:[['workspaceId','runId'],['sessionId']],
  models:[selectors,[]],
  confirmAnalysis:[[...selectors,'runId','previewHash'],[]],analyze:[[...selectors,'runId','confirmationId'],[]],
  prepare:[['workspaceId','repoPath','idempotencyKey'],['sessionId','requirementsPath','requirementsText','head','target','base','maxFiles','maxBytes','policy']],
  demo:[['workspaceId','idempotencyKey'],['sessionId']],
  importReview:[['workspaceId','runId','idempotencyKey','review'],['sessionId']],
  cancel:[['workspaceId','sessionId','runId','attemptId'],[]],
  respond:[[...humanSelectors,'text'],['sessionId']],
  decide:[[...humanSelectors,'outcome','reason'],['sessionId']],
  verify:[[...humanSelectors,'result','evidenceText','note'],['sessionId']],
};
export function validText(value,max=256) {return typeof value==='string' && value.trim().length>0 && value.length<=max && value.isWellFormed() && !value.includes('\0');}
export function relativePath(value) {
  return validText(value,4096) && !/^[\\/]|:/.test(value) && !value.split(/[\\/]/).includes('..');
}
export function validateModelInput(route,budget={}) {
  if(!object(route) || Object.keys(route).some(k=>!['provider','model','reasoningEffort'].includes(k)) || !validText(route.provider) || !validText(route.model) || route.reasoningEffort!=null && !validText(route.reasoningEffort))fail('INVALID_INPUT','Select a complete native provider/model route and advertised effort.');
  if(!object(budget) || Object.keys(budget).some(k=>!['outputTokens','timeoutSeconds'].includes(k)))fail('INVALID_INPUT','Invalid model budget.');
  const selected={outputTokens:budget.outputTokens ?? LIMITS.outputTokens,timeoutSeconds:budget.timeoutSeconds ?? LIMITS.modelTimeoutSeconds};
  if(Object.hasOwn(budget,'outputTokens') && budget.outputTokens===null || Object.hasOwn(budget,'timeoutSeconds') && budget.timeoutSeconds===null || !Number.isSafeInteger(selected.outputTokens) || selected.outputTokens<1 || selected.outputTokens>LIMITS.outputTokens || !Number.isSafeInteger(selected.timeoutSeconds) || selected.timeoutSeconds<1 || selected.timeoutSeconds>LIMITS.modelTimeoutSeconds)fail('INVALID_INPUT','Invalid model budget.');
  return {route:{provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort ?? null},budget:selected};
}
function validateHumanAction(operation,p) {
  if(!['respond','decide','verify'].includes(operation))return;
  if(!Number.isSafeInteger(p.expectedSequence) || p.expectedSequence<0)fail('INVALID_INPUT','Expected sequence must be a nonnegative integer.');
  for(const key of ['finding','actor'])if(!validText(p[key],120))fail('INVALID_INPUT','Invalid finding or actor.');
  if(p.attestLocal!==true)fail('FORBIDDEN','Explicit local attestation is required.');
  const field={respond:'text',decide:'reason',verify:'note'}[operation];
  if(!validText(p[field],12000))fail('INVALID_INPUT','Human action requires bounded nonempty text.');
  if(operation==='decide' && !['confirm_defect','not_an_issue','approve_intent_change','accept_risk'].includes(p.outcome))fail('INVALID_INPUT','Unknown decision outcome.');
  if(operation==='verify' && (!['passed','failed'].includes(p.result) || !validText(p.evidenceText,LIMITS.verificationBytes) || Buffer.byteLength(p.evidenceText,'utf8')>LIMITS.verificationBytes))fail('INVALID_INPUT','Verification requires a result and bounded UTF-8 manual evidence.');
}
export function validateRequest(body) {
  if(!object(body) || Object.keys(body).some(k=>!['operation','payload'].includes(k)) || !OPERATIONS.includes(body.operation) || !object(body.payload))fail('INVALID_INPUT','Invalid SpecGap request.');
  const p=body.payload,[required,optional]=requestSchemas[body.operation] || [[],[]],allowed=[...required,...optional];
  if(required.some(k=>!Object.hasOwn(p,k)) || Object.keys(p).some(k=>!allowed.includes(k)))fail('INVALID_INPUT','Invalid operation payload fields.');
  for(const key of ['workspaceId','sessionId','idempotencyKey','head','target','base'])if(Object.hasOwn(p,key) && !validText(p[key],key==='idempotencyKey'?128:256))fail('INVALID_INPUT','Invalid selector or reference.');
  for(const key of ['repoPath','requirementsPath'])if(Object.hasOwn(p,key) && !relativePath(p[key]))fail('FORBIDDEN','Only contained relative paths are permitted.');
  if(Object.hasOwn(p,'runId') && (typeof p.runId!=='string' || !RUN_ID.test(p.runId)))fail('INVALID_INPUT','Invalid run ID.');
  if(Object.hasOwn(p,'attemptId') && (typeof p.attemptId!=='string' || !ATTEMPT_ID.test(p.attemptId)))fail('INVALID_INPUT','Invalid attempt ID.');
  if(p.sessionId && !p.workspaceId)fail('INVALID_INPUT','Session requires workspace.');
  for(const [key,min,max] of [['maxFiles',1,LIMITS.maxContextFiles],['maxBytes',1,LIMITS.maxContextBytes],['limit',1,100],['offset',0,10000]])if(Object.hasOwn(p,key) && (!Number.isSafeInteger(p[key]) || p[key]<min || p[key]>max))fail('INVALID_INPUT','Invalid numeric budget.');
  if(body.operation==='prepare' && (Object.hasOwn(p,'requirementsPath')===Object.hasOwn(p,'requirementsText')))fail('INVALID_INPUT','Choose requirements path or pasted text.');
  if(Object.hasOwn(p,'requirementsText') && (!validText(p.requirementsText,LIMITS.requirementsBytes) || Buffer.byteLength(p.requirementsText,'utf8')>LIMITS.requirementsBytes))fail('INVALID_INPUT','Requirements exceed input limit.');
  if(Object.hasOwn(p,'policy') && (!object(p.policy) || Buffer.byteLength(JSON.stringify(p.policy),'utf8')>16384))fail('INVALID_INPUT','Invalid or oversized policy.');
  if(Object.hasOwn(p,'review') && (!object(p.review) || Buffer.byteLength(JSON.stringify(p.review),'utf8')>LIMITS.reviewOutputBytes))fail('INVALID_REVIEW','Review must be a bounded JSON object.');
  if(Object.hasOwn(p,'route') || Object.hasOwn(p,'budget')){if(!p.sessionId || !p.route)fail('INVALID_INPUT','A model preview requires a live Session and route.');validateModelInput(p.route,p.budget);}
  if(Object.hasOwn(p,'previewHash') && (typeof p.previewHash!=='string' || !/^[a-f0-9]{64}$/.test(p.previewHash)))fail('INVALID_INPUT','Invalid preview hash.');
  if(Object.hasOwn(p,'confirmationId') && (typeof p.confirmationId!=='string' || !/^confirmation_[a-f0-9]{32}$/.test(p.confirmationId)))fail('INVALID_INPUT','Invalid confirmation ID.');
  validateHumanAction(body.operation,p);
  return body;
}

// Private native-Host protocol, not authenticated browser request schemas.
const common=['workspaceRoot','dataRoot','runPath'];
const actions=[...common,...humanFields];
const bridgeSchemas={health:[[],[]],refs:[['workspaceRoot','repoPath'],[]],
  prepare:[[...common,'repoPath'],['requirementsPath','requirementsText','head','target','base','maxFiles','maxBytes','policy']],
  read:[common,[]],material:[common,[]],report:[common,[]],import_review:[[...common,'review'],[]],
  respond:[[...actions,'text'],[]],decide:[[...actions,'outcome','reason'],[]],verify:[[...actions,'result','evidenceText','note'],[]],
  demo:[['workspaceRoot','dataRoot','demoPath'],[]]};
export function validateBridgeRequest(operation,payload) {
  if(typeof operation!=='string' || !Object.hasOwn(bridgeSchemas,operation))fail('INVALID_INPUT','Unknown bridge operation.');
  if(!object(payload))fail('INVALID_INPUT','Invalid bridge payload.');
  const [required,optional]=bridgeSchemas[operation],allowed=new Set([...required,...optional]);
  if(required.some(k=>!Object.hasOwn(payload,k)) || Object.keys(payload).some(k=>!allowed.has(k)))fail('INVALID_INPUT','Invalid bridge payload fields.');
  validateHumanAction(operation,payload);
  for(const [key,max] of [['maxFiles',LIMITS.maxContextFiles],['maxBytes',LIMITS.maxContextBytes]])
    if(Object.hasOwn(payload,key) && (!Number.isSafeInteger(payload[key]) || payload[key]<1 || payload[key]>max))fail('INVALID_INPUT','Invalid context budget.');
}

/** JSON.parse alone accepts duplicate keys and non-finite 1e999. */
export function parseStrictJSON(text) {
  let i=0;
  const invalid=()=>fail('ENVIRONMENT','Invalid bridge response.');
  const space=()=>{while(i<text.length && /[\x20\t\r\n]/.test(text[i]))i++;};
  const string=()=>{
    const start=i++;
    while(i<text.length){
      const c=text[i++];
      if(c==='\\'){i++;continue;}
      if(c==='"'){
        let value;try{value=JSON.parse(text.slice(start,i));}catch{invalid();}
        if(!value.isWellFormed())invalid();return value;
      }
      if(c<' ')invalid();
    }
    invalid();
  };
  const value=(depth=0)=>{
    if(depth>100)invalid();space();const c=text[i];
    if(c==='"')return string();
    if(c==='{' || c==='['){
      i++;const array=c==='[',end=array?']':'}',result=array?[]:{},keys=new Set();space();
      if(text[i]===end){i++;return result;}
      while(i<text.length){
        space();let key;
        if(!array){if(text[i]!=='"')invalid();key=string();if(keys.has(key))invalid();keys.add(key);space();if(text[i++]!==':')invalid();}
        const item=value(depth+1);
        if(array)result.push(item);else Object.defineProperty(result,key,{value:item,enumerable:true,writable:true,configurable:true});
        space();const delimiter=text[i++];if(delimiter===end)return result;if(delimiter!==',')invalid();
      }
      invalid();
    }
    for(const [literal,result] of [['true',true],['false',false],['null',null]])if(text.startsWith(literal,i)){i+=literal.length;return result;}
    const number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if(!number)invalid();i+=number[0].length;const result=Number(number[0]);if(!Number.isFinite(result))invalid();return result;
  };
  const result=value();space();if(i!==text.length)invalid();return result;
}

export function validateBridgeResponse(value) {
  const valid=object(value) && value.version===1 && typeof value.ok==='boolean';
  if(!valid || Object.keys(value).sort().join(',')!==(value.ok?'data,ok,version':'error,ok,version'))fail('ENVIRONMENT','Invalid bridge envelope.');
  if(!value.ok){
    const e=value.error;
    if(!object(e) || Object.keys(e).sort().join(',')!=='code,message' || !ERROR_CODES.includes(e.code) || typeof e.message!=='string' || e.message.length>512)fail('ENVIRONMENT','Invalid bridge error.');
  }
  return value;
}
