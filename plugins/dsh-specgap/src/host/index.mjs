import {randomUUID} from 'node:crypto';
import {createRuntime} from './runtime.mjs';
import {createService} from './service.mjs';
import {SpecGapError,validateRequest,parseStrictJSON,ACTION_BODY_BYTES} from '../shared/contract.mjs';
export const name='specgap';
// Cordis inject is a required-service map/list, not a required/optional object.
export const inject=['connection'];
const status={INVALID_INPUT:400,INVALID_REVIEW:400,FORBIDDEN:403,NOT_FOUND:404,CONFLICT:409,STALE:409,CANCELLED:499,UNAVAILABLE:503,ENVIRONMENT:503,TIMEOUT:504,INTEGRITY:409};
const invalid=message=>{throw new SpecGapError('INVALID_INPUT',message);};
async function readBody(request) {
  const length=request.headers.get('content-length');
  if(length!==null && (!/^\d+$/.test(length) || +length>ACTION_BODY_BYTES))invalid('Request exceeds input limit.');
  const reader=request.body?.getReader();if(!reader)invalid('JSON request required.');
  const chunks=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>ACTION_BODY_BYTES){await reader.cancel();invalid('Request exceeds input limit.');}chunks.push(value);}
    return {text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)),size};
  }catch(e){if(e instanceof SpecGapError)throw e;invalid('Invalid UTF-8 request.');}
  finally{reader.releaseLock();}
}

/** Used only behind Connection's admitted owner route; never registered as an Agent tool. */
export function createFetchHandler(service,{report=false}={}) {
  return async request=>{
    const requestId=randomUUID(),headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
    try {
      let operation,payload;
      if(report) {
        const query=new URL(request.url).searchParams;payload={};
        for(const [key,value] of query){if(Object.hasOwn(payload,key) || !['workspaceId','sessionId','runId'].includes(key))invalid('Invalid report selectors.');payload[key]=value;}
        operation='report';validateRequest({operation,payload});
      }else {
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))invalid('JSON request required.');
        const {text,size}=await readBody(request);let body;
        try{body=parseStrictJSON(text);}catch{invalid('Invalid JSON request.');}
        ({operation,payload}=validateRequest(body));
        if(!['prepare','importReview','respond','decide','verify'].includes(operation) && size>16384)invalid('Request exceeds operation limit.');
      }
      const data=await service.dispatch(operation,payload,{isOwner:true,signal:request.signal});
      if(report)return new Response(data.markdown,{status:200,headers:{...headers,'content-type':'text/markdown; charset=utf-8','content-disposition':`attachment; filename="specgap-${payload.runId}.md"`}});
      return new Response(JSON.stringify({ok:true,data,requestId}),{status:200,headers});
    }catch(error) {
      const known=error instanceof SpecGapError,code=known?error.code:'INTERNAL';
      return new Response(JSON.stringify({ok:false,error:{code,message:known?error.message:'SpecGap request failed.'},requestId}),{status:status[code]??500,headers});
    }
  };
}
/** Exact routes inherit Connection's owner-only admission. No Peer is fabricated here. */
export function apply(ctx,config={}) {
  const service=createService({runtime:createRuntime(ctx,config)});
  ctx.effect(()=>()=>service.dispose());
  for(const [path,methods,report] of [['/api/specgap/v1/action',['POST'],false],['/api/specgap/v1/report',['GET'],true]]) {
    ctx.effect(()=>ctx.connection.fetch.register({path,methods,requestBody:'buffered',fetch:createFetchHandler(service,{report})}));
  }
}
