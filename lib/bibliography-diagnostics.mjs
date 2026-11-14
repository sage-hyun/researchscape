import {candidatePolicy} from './bibliography-policy.mjs';
import {lookupKey} from './bibliography.mjs';

export function lookupOutcome(entry,key=''){
  if(entry.status==='error'){
    const status=entry.httpStatus||Number(/HTTP (\d{3})/.exec(entry.error||'')?.[1]);
    if(status===404&&(entry.method==='identifier'||/^(?:doi|arxiv|openreview):/.test(key)))return 'identifier-not-indexed';
    if(status===429)return 'rate-limited';if([401,403].includes(status))return 'access-denied';
    return entry.outcome==='provider-cooldown'||/접근 제한.*재시도하지 않음/.test(entry.error||'')?'provider-cooldown':status?'http-error':entry.outcome||'transport-or-parse-error';
  }
  return entry.recordIds?.length?'retrieved':entry.outcome==='identifier-not-indexed'||/^(?:doi|arxiv|openreview):/.test(key)?'identifier-not-indexed':'no-match';
}
export function bibliographyDiagnostics(raw,store,resolved){
  const lookups=[],seen=new Set();
  for(const [key,entry] of Object.entries(store.providerLookups||{})){
    const at=key.indexOf('|');const provider=entry.provider||key.slice(0,at),queryKey=key.slice(at+1);seen.add(`${provider}|${queryKey}`);lookups.push({key:queryKey,...entry,provider,outcome:lookupOutcome(entry,queryKey)});
  }
  for(const [key,entry] of Object.entries(store.lookups||{})){
    if(entry.providers)continue;
    const provider=entry.provider||(key.startsWith('arxiv:')?'arxiv':key.startsWith('openreview:')?'openreview':'crossref');
    if(!seen.has(`${provider}|${key}`))lookups.push({key,...entry,provider,outcome:lookupOutcome(entry,key)});
  }
  const lookupSummary={},byProvider={};
  for(const l of lookups){lookupSummary[l.outcome]=(lookupSummary[l.outcome]||0)+1;byProvider[l.provider]??={};byProvider[l.provider][l.outcome]=(byProvider[l.provider][l.outcome]||0)+1;}
  const papers=new Map(resolved.papers.map(p=>[p.id,p])),summary={},candidates=[];
  const lookupMap=new Map();for(const l of lookups){if(!lookupMap.has(l.key))lookupMap.set(l.key,[]);lookupMap.get(l.key).push(l);}
  for(const p of raw.papers){
    const result=papers.get(resolved.redirects?.[p.id]||p.id),policy=candidatePolicy(p.title);
    const attempts=[lookupKey(p),...(p.identifiers||[]).map(i=>i.key)].flatMap(key=>lookupMap.get(key)||[]);
    let cause;
    if(result?.metadata)cause='linked';
    else if(result?.resolution.reason==='kept-separate')cause='user-separated';
    else if(['conflicting-metadata','identifier-title-conflict','citation-title-conflict'].includes(result?.resolution.reason))cause='conflict';
    else if(!policy.eligible&&!(p.identifiers?.length&&['acronym','identifier-label'].includes(policy.kind)))cause=['acronym','identifier-label','title'].includes(policy.kind)?'insufficient-evidence':`excluded:${policy.kind}`;
    else if(attempts.some(a=>a.recordIds?.length))cause='matching-failed';
    else if(attempts.some(a=>a.status==='error'&&a.outcome!=='identifier-not-indexed'))cause='lookup-failed';
    else if(attempts.length)cause='search-miss';
    else cause='not-searched';
    summary[cause]=(summary[cause]||0)+1;
    candidates.push({id:p.id,title:p.title,count:p.count,cause,reason:result?.resolution.reason,providers:attempts.map(a=>({provider:a.provider,status:a.status,outcome:a.outcome,httpStatus:a.httpStatus,updatedAt:a.updatedAt,retryAt:a.retryAt})),missingLink:!result?.identifiers?.some(i=>i.url)});
  }
  return {generatedAt:new Date().toISOString(),summary,lookupSummary,byProvider,candidates,notes:['검색 결과 없음은 제공자의 색인에서 찾지 못했다는 뜻이며 논문 미존재 판정이 아닙니다.','구형 로그는 HTTP 상태가 오류 문자열에 있는 경우 복원합니다. 구형 네트워크/파싱 오류의 세부 원인은 구별할 수 없습니다.','조회 결과가 있어도 정확한 제목·식별자 조건을 만족하지 못하면 matching-failed입니다.']};
}
