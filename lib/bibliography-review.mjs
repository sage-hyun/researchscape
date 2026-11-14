import {createHash} from 'node:crypto';
import {validRecord} from './bibliography.mjs';
import {metadataCatalog,paperRecord} from './bibliography-catalog.mjs';
import {exactTitle} from './bibliography-policy.mjs';

export const EVIDENCE_TYPES=['identifier-match','exact-title','author-year-match','explicit-alias-expansion','same-message','adjacent-message','possible-work-version','insufficient-evidence','conflicting-identifiers'];
const reviewItemProperties={
  candidateId:{type:'string',minLength:1,maxLength:300},
  decision:{enum:['match','separate','defer']},
  recordId:{type:['string','null'],maxLength:300},
  evidence:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,required:['type','detail'],properties:{type:{enum:EVIDENCE_TYPES},detail:{type:'string',minLength:1,maxLength:1000}}}},
  needsManualReview:{type:'boolean'}
};
export const reviewResultSchema={
  $schema:'https://json-schema.org/draft/2020-12/schema',title:'Researchscape LLM review result',
  type:'object',additionalProperties:false,required:['schemaVersion','decisions'],
  properties:{schemaVersion:{const:1},decisions:{type:'array',maxItems:50,items:{
    type:'object',additionalProperties:false,required:Object.keys(reviewItemProperties),properties:reviewItemProperties,
    allOf:[{if:{properties:{decision:{const:'match'}}},then:{properties:{recordId:{type:'string',minLength:1}}},else:{properties:{recordId:{type:'null'}}}}]
  }}}
};

function compactRecord(s,p,q){
  const r=s.record,types=new Set();
  if((p.identifiers||[]).some(a=>r.identifiers.some(b=>a.key===b.key)))types.add('identifier-match');
  if([p.title,...(p.aliases||[])].some(t=>[r.title,...(r.alternateTitles||[])].some(x=>exactTitle(t,x))))types.add('exact-title');
  for(const e of q?.evidence||[])if(e.recordId===s.recordId)types.add(e.source);
  if(!types.size)types.add('title-or-alias-candidate');
  return {recordId:s.recordId,title:r.title,authors:r.authors||[],year:r.year||null,doi:r.identifiers.filter(i=>i.kind==='doi').map(i=>i.value),arxiv:r.identifiers.filter(i=>i.kind==='arxiv').map(i=>i.value),evidenceTypes:[...types].sort()};
}

export function reviewGroups(raw,resolved,decisions={}){
  const queue=new Map((resolved.resolutionQueue||[]).map(q=>[q.id,q])),papers=new Map(resolved.papers.map(p=>[p.id,p])),seen=new Set(),withCandidates=[],withoutCandidates=[];
  for(const p of raw.papers){
    if(seen.has(p.id))continue;seen.add(p.id);
    const result=papers.get(resolved.redirects?.[p.id]||p.id);if(!result||result.metadata||decisions[p.id]?.action==='separate')continue;
    const q=queue.get(p.id),row={candidateId:p.id,title:p.title,count:p.count,reason:q?.reason||result.resolution?.reason||'unresolved',candidates:[...new Map((q?.suggestions||[]).map(s=>[s.recordId,compactRecord(s,p,q)])).values()]};
    (row.candidates.length?withCandidates:withoutCandidates).push(row);
  }
  const order=(a,b)=>b.count-a.count||a.candidateId.localeCompare(b.candidateId);withCandidates.sort(order);withoutCandidates.sort(order);
  return {withCandidates,withoutCandidates};
}
export const reviewSnapshot=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function compactReviewExport(raw,resolved,decisions={},options={}){
  const group=options.group||'with-candidates',limit=options.limit===undefined?40:Number(options.limit),offset=options.offset===undefined?0:Number(options.offset);
  if(!['with-candidates','without-candidates'].includes(group)||!Number.isInteger(limit)||limit<30||limit>50||!Number.isInteger(offset)||offset<0)throw new Error('검토 그룹과 30~50개 단위의 정수 limit, 0 이상의 offset을 지정해주세요.');
  const groups=reviewGroups(raw,resolved,decisions),rows=group==='with-candidates'?groups.withCandidates:groups.withoutCandidates;
  return {schemaVersion:1,kind:'llm-review',group,offset,limit,total:rows.length,totals:{withCandidates:groups.withCandidates.length,withoutCandidates:groups.withoutCandidates.length},nextOffset:offset+limit<rows.length?offset+limit:null,snapshot:reviewSnapshot(groups),items:rows.slice(offset,offset+limit)};
}

function keys(value,allowed){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));}
function string(value,max){return typeof value==='string'&&value.trim().length>0&&value.length<=max;}
export function validateReviewResult(value){
  if(!keys(value,['schemaVersion','decisions'])||value.schemaVersion!==1||!Array.isArray(value.decisions)||value.decisions.length>50)throw new Error('schemaVersion: 1과 최대 50개의 decisions 배열이 필요합니다.');
  const seen=new Set();
  for(const d of value.decisions){
    if(!keys(d,['candidateId','decision','recordId','evidence','needsManualReview'])||!string(d.candidateId,300)||!['match','separate','defer'].includes(d.decision)||typeof d.needsManualReview!=='boolean'||!Array.isArray(d.evidence)||d.evidence.length>10)throw new Error('올바르지 않은 LLM 검토 항목입니다. 입력 스키마를 확인해주세요.');
    if(seen.has(d.candidateId))throw new Error('candidateId가 중복되었습니다.');seen.add(d.candidateId);
    if(d.decision==='match'?!string(d.recordId,300):d.recordId!==null)throw new Error('match에는 recordId가 필요하며 separate/defer에는 null을 사용하세요.');
    for(const e of d.evidence)if(!keys(e,['type','detail'])||!EVIDENCE_TYPES.includes(e.type)||!string(e.detail,1000))throw new Error('evidence에는 허용된 type과 1~1000자 detail이 필요합니다.');
  }
  return value;
}

export function planReviewImport(raw,store,resolved,decisions,value){
  validateReviewResult(value);
  const inputs=new Map(raw.papers.map(p=>[p.id,p])),catalog=metadataCatalog(Object.values(store.records||{}).filter(validRecord)),records=new Map(catalog.records.map(r=>[r.id,r])),groups=reviewGroups(raw,resolved,decisions),eligible=new Set([...groups.withCandidates,...groups.withoutCandidates].map(r=>r.candidateId)),suggestions=new Map(groups.withCandidates.map(row=>[row.candidateId,new Set(row.candidates.map(c=>c.recordId))]));
  const rows=value.decisions.map(d=>{
    const p=inputs.get(d.candidateId);if(!p)throw new Error('원본 candidateId를 찾지 못했습니다: '+d.candidateId);
    const target=d.decision==='match'?records.get(catalog.redirects.get(d.recordId)):null;
    if(d.decision==='match'&&(!validRecord(store.records?.[d.recordId])||!target))throw new Error('조회된 recordId를 찾지 못했습니다: '+d.recordId);
    let status='ready',reason='사용자 최종 승인 후 적용';
    if(decisions[d.candidateId]){status='preserved';reason='기존 수동 연결·분리 기록 보존';}
    else if(!eligible.has(d.candidateId)){status='needs-manual-review';reason='현재 미연결 검토 대상이 아닙니다.';}
    else if(d.decision==='defer'){status='deferred';reason='보류';}
    else if(d.needsManualReview||!d.evidence.length){status='needs-manual-review';reason='추가 수동 검토가 필요합니다.';}
    else if(target&&(!paperRecord(target)||target.identityConflict||!suggestions.get(p.id)?.has(target.id))){status='needs-manual-review';reason='현재 연결 후보가 아니거나 서지정보가 충돌합니다.';}
    else if(d.evidence.some(e=>['possible-work-version','insufficient-evidence','conflicting-identifiers'].includes(e.type))){status='needs-manual-review';reason='버전 관계·불충분한 근거·식별자 충돌은 별도 검토가 필요합니다.';}
    return {...d,title:p.title,recordTitle:target?.title||null,status,reason};
  });
  return {schemaVersion:1,rows,applicable:rows.filter(r=>r.status==='ready').length};
}
export function applyReviewPlan(plan,decisions,candidateIds,updatedAt=new Date().toISOString()){
  if(!Array.isArray(candidateIds)||!candidateIds.length||new Set(candidateIds).size!==candidateIds.length)throw new Error('최종 승인할 candidateId를 중복 없이 선택해주세요.');
  const next={...decisions};
  for(const id of candidateIds){const row=plan.rows.find(r=>r.candidateId===id);if(row?.status!=='ready'||decisions[id])throw new Error('적용할 수 없는 항목이 선택되었습니다. 미리보기를 다시 실행해주세요.');next[id]={action:row.decision,...(row.decision==='match'?{recordId:row.recordId}:{}),evidence:row.evidence,decisionSource:'llm-reviewed',updatedAt};}
  return next;
}
