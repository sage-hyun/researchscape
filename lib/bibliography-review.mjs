import {createHash} from 'node:crypto';
import {validRecord} from './bibliography.mjs';
import {metadataCatalog,paperRecord} from './bibliography-catalog.mjs';
import {exactTitle} from './bibliography-policy.mjs';
import {normalizeProposal} from './review-proposals.mjs';

export const EVIDENCE_TYPES=['identifier-match','exact-title','author-year-match','explicit-alias-expansion','same-message','adjacent-message','possible-work-version','insufficient-evidence','conflicting-identifiers','external-identifier'];
const RISKY_EVIDENCE=['possible-work-version','insufficient-evidence','conflicting-identifiers'];
const REQUIRED_ITEM_KEYS=['candidateId','decision','recordId','evidence','needsManualReview'];
const reviewItemProperties={
  candidateId:{type:'string',minLength:1,maxLength:300},
  decision:{enum:['match','separate','defer','propose']},
  recordId:{type:['string','null'],maxLength:300},
  evidence:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,required:['type','detail'],properties:{type:{enum:EVIDENCE_TYPES},detail:{type:'string',minLength:1,maxLength:1000}}}},
  needsManualReview:{type:'boolean'},
  // Only for decision "propose" (schemaVersion 2). The server looks every value up again before it becomes a link candidate.
  proposal:{type:'object',additionalProperties:false,minProperties:1,properties:{doi:{type:'string',maxLength:300},arxiv:{type:'string',maxLength:300},title:{type:'string',minLength:3,maxLength:300}}}
};
// One document may hold any subset of the exported candidates. Several documents can be
// imported together as a JSON array, so partial results never need manual merging.
export const reviewResultSchema={
  $schema:'https://json-schema.org/draft/2020-12/schema',title:'Researchscape LLM review result',
  type:'object',additionalProperties:false,required:['schemaVersion','decisions'],
  properties:{schemaVersion:{enum:[1,2]},snapshot:{type:'string',pattern:'^[a-f0-9]{64}$'},batchIds:{type:'array',maxItems:1000,items:{type:'string',maxLength:40}},decisions:{type:'array',items:{
    type:'object',additionalProperties:false,required:REQUIRED_ITEM_KEYS,properties:reviewItemProperties,
    allOf:[
      {if:{properties:{decision:{const:'match'}}},then:{properties:{recordId:{type:'string',minLength:1}}},else:{properties:{recordId:{type:'null'}}}},
      {if:{properties:{decision:{const:'propose'}}},then:{required:['proposal']},else:{not:{required:['proposal']}}}
    ]
  }}},
  allOf:[{if:{properties:{schemaVersion:{const:2}}},then:{required:['snapshot']}}]
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
export function compactReviewExport(raw,resolved,decisions={},options={},groups=reviewGroups(raw,resolved,decisions)){
  const group=options.group||'with-candidates',limit=options.limit===undefined?40:Number(options.limit),offset=options.offset===undefined?0:Number(options.offset);
  if(!['with-candidates','without-candidates'].includes(group)||!Number.isInteger(limit)||limit<30||limit>50||!Number.isInteger(offset)||offset<0)throw new Error('검토 그룹과 30~50개 단위의 정수 limit, 0 이상의 offset을 지정해주세요.');
  const rows=group==='with-candidates'?groups.withCandidates:groups.withoutCandidates;
  return {schemaVersion:1,kind:'llm-review',group,offset,limit,total:rows.length,totals:{withCandidates:groups.withCandidates.length,withoutCandidates:groups.withoutCandidates.length},nextOffset:offset+limit<rows.length?offset+limit:null,snapshot:reviewSnapshot(groups),items:rows.slice(offset,offset+limit)};
}

// A candidate's review context for conflict checks: its observed title and the link candidates an
// LLM saw. Mention counts and candidates registered from a verified LLM proposal are excluded, so
// re-indexing or importing an earlier partial result does not invalidate the remaining batches.
export const reviewItemHash=row=>reviewSnapshot([row.title,row.candidates.filter(c=>!c.evidenceTypes.includes('llm-proposal')).map(c=>c.recordId).sort()]).slice(0,16);
export function reviewManifest(groups,generatedAt=new Date().toISOString()){
  const rows=[...groups.withCandidates,...groups.withoutCandidates];
  return {schemaVersion:1,snapshot:reviewSnapshot(groups),generatedAt,total:rows.length,items:Object.fromEntries(rows.map(row=>[row.candidateId,reviewItemHash(row)]))};
}

export const BUNDLE_BATCH={min:50,max:100,default:80};
const bundleInstructions={
  task:'각 item은 대화에서 발견했지만 아직 공식 서지정보에 연결되지 않은 논문 후보입니다. 후보마다 decisions 항목을 하나씩 작성합니다.',
  batching:'items는 언급 수 내림차순입니다. 한 번에 전부 처리하지 말고 batches[]의 offset·count 구간(또는 각 item의 batchId)을 따라 한 배치씩 처리합니다. 처리한 배치만 담은 부분 결과도 그대로 가져올 수 있고, 여러 부분 결과는 decisions를 이어 붙이거나 결과 문서들의 JSON 배열로 한 번에 가져올 수 있습니다.',
  decisions:{
    match:'candidates 중 하나가 같은 논문일 때. recordId에 그 candidates[].recordId를 그대로 적습니다.',
    propose:'candidates에 맞는 논문이 없지만 DOI·arXiv ID·공식 제목을 알고 있을 때. recordId는 null, proposal에 {"doi","arxiv","title"} 중 아는 값만 적습니다. 서버가 Crossref·OpenAlex·arXiv에서 다시 조회해 실제로 확인된 레코드만 연결 후보로 등록합니다.',
    separate:'논문이 아니거나 어떤 후보와도 다른 대상일 때. recordId는 null입니다.',
    defer:'판단할 수 없을 때. recordId는 null입니다.'
  },
  rules:[
    'candidateId와 recordId는 이 파일의 값을 그대로 사용합니다.',
    '확실하지 않은 DOI·arXiv ID를 만들어 내지 않습니다. 모르면 defer를 쓰거나 needsManualReview를 true로 둡니다.',
    'propose에는 가능하면 식별자 하나와 공식 제목을 함께 적습니다. 제목과 식별자가 서로 다른 논문을 가리키면 수동 검토로 남습니다.',
    'evidence에는 허용된 type과 1~1000자 detail을 1개 이상 적습니다.',
    '결과의 snapshot에는 이 파일의 snapshot을 그대로 적습니다.'
  ],
  evidenceTypes:EVIDENCE_TYPES,
  resultSchema:'GET /api/bibliography/review-schema'
};
// One file for the whole review: both candidate groups, de-duplicated by candidateId, most mentioned
// first. Batches are logical ranges inside the same file, never separate downloads.
export function reviewBundleExport(raw,resolved,decisions={},options={},groups=reviewGroups(raw,resolved,decisions)){
  const batchSize=options.batchSize===undefined||options.batchSize===null||options.batchSize===''?BUNDLE_BATCH.default:Number(options.batchSize);
  if(!Number.isInteger(batchSize)||batchSize<BUNDLE_BATCH.min||batchSize>BUNDLE_BATCH.max)throw new Error(`LLM 배치 크기는 ${BUNDLE_BATCH.min}~${BUNDLE_BATCH.max} 사이의 정수로 지정해주세요.`);
  const unique=new Map();
  for(const [candidateStatus,rows] of [['with-candidates',groups.withCandidates],['without-candidates',groups.withoutCandidates]])for(const row of rows)if(!unique.has(row.candidateId))unique.set(row.candidateId,{...row,candidateStatus});
  const sorted=[...unique.values()].sort((a,b)=>b.count-a.count||a.candidateId.localeCompare(b.candidateId)),batches=[];
  const items=sorted.map((row,at)=>{
    if(at%batchSize===0)batches.push({batchId:'b'+String(batches.length+1).padStart(3,'0'),index:batches.length+1,offset:at,count:0,withCandidates:0,withoutCandidates:0});
    const batch=batches.at(-1);batch.count++;batch[row.candidateStatus==='with-candidates'?'withCandidates':'withoutCandidates']++;
    return {candidateId:row.candidateId,title:row.title,count:row.count,reason:row.reason,candidateStatus:row.candidateStatus,batchId:batch.batchId,candidates:row.candidates};
  });
  const snapshot=reviewSnapshot(groups);
  return {schemaVersion:2,kind:'llm-review-bundle',snapshot,generatedAt:options.generatedAt||new Date().toISOString(),total:items.length,totals:{withCandidates:groups.withCandidates.length,withoutCandidates:groups.withoutCandidates.length},batchSize,batches,instructions:bundleInstructions,resultTemplate:{schemaVersion:2,snapshot,batchIds:[],decisions:[]},items};
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

// The current review state, built once per validation chunk.
export function reviewContext(raw,store,resolved,decisions={}){
  const catalog=metadataCatalog(Object.values(store.records||{}).filter(validRecord)),groups=reviewGroups(raw,resolved,decisions);
  return {store,decisions,groups,catalog,inputs:new Map(raw.papers.map(p=>[p.id,p])),records:new Map(catalog.records.map(r=>[r.id,r])),items:new Map([...groups.withCandidates,...groups.withoutCandidates].map(row=>[row.candidateId,row])),snapshot:reviewSnapshot(groups)};
}
const recordOf=(ctx,recordId)=>validRecord(ctx.store.records?.[recordId])?ctx.records.get(ctx.catalog.redirects.get(recordId))||null:null;
function decisionStatus(ctx,d,target){
  if(ctx.decisions[d.candidateId])return ['preserved',ctx.decisions[d.candidateId].importId?'이전 LLM 검토 가져오기에서 승인한 결정 보존':'기존 수동 연결·분리 기록 보존'];
  const item=ctx.items.get(d.candidateId);
  if(!item)return ['needs-manual-review','현재 미연결 검토 대상이 아닙니다.'];
  if(d.decision==='defer')return ['deferred','보류'];
  if(d.needsManualReview||!d.evidence.length)return ['needs-manual-review','추가 수동 검토가 필요합니다.'];
  if(target&&(!paperRecord(target)||target.identityConflict||!item.candidates.some(c=>c.recordId===target.id)))return ['needs-manual-review','현재 연결 후보가 아니거나 서지정보가 충돌합니다.'];
  if(d.evidence.some(e=>RISKY_EVIDENCE.includes(e.type)))return ['needs-manual-review','버전 관계·불충분한 근거·식별자 충돌은 별도 검토가 필요합니다.'];
  return ['ready','사용자 최종 승인 후 적용'];
}

// Legacy strict import (at most 50 decisions held in memory): any invalid row rejects the request.
export function planReviewImport(raw,store,resolved,decisions,value){
  validateReviewResult(value);
  const ctx=reviewContext(raw,store,resolved,decisions);
  const rows=value.decisions.map(d=>{
    const p=ctx.inputs.get(d.candidateId);if(!p)throw new Error('원본 candidateId를 찾지 못했습니다: '+d.candidateId);
    const target=d.decision==='match'?recordOf(ctx,d.recordId):null;
    if(d.decision==='match'&&!target)throw new Error('조회된 recordId를 찾지 못했습니다: '+d.recordId);
    const [status,reason]=decisionStatus(ctx,d,target);
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

// ---- Bulk import: tolerant per-row validation, so one bad row never rejects a 1,000-row file ----
export const REVIEW_UPLOAD={maxDecisions:20000,maxDocuments:500};
const snapshotPattern=/^[a-f0-9]{64}$/;
// Accepts one result document or an array of partial result documents.
export function parseReviewUpload(value){
  const documents=Array.isArray(value)?value:[value];
  if(!documents.length||documents.length>REVIEW_UPLOAD.maxDocuments)throw new Error(`검토 결과 문서는 1~${REVIEW_UPLOAD.maxDocuments}개를 한 번에 가져올 수 있습니다.`);
  const parts=[],decisions=[],warnings=[];
  documents.forEach((doc,part)=>{
    const label=documents.length>1?` ${part+1}번째 문서:`:'';
    if(!doc||typeof doc!=='object'||Array.isArray(doc)||!Array.isArray(doc.decisions))throw new Error(`검토 결과${label} decisions 배열이 있는 JSON 객체가 필요합니다. 내려받은 검토 JSON이 아니라 LLM이 작성한 결과 JSON을 선택했는지 확인해주세요.`);
    if(![1,2].includes(doc.schemaVersion))throw new Error(`검토 결과${label} schemaVersion은 1 또는 2여야 합니다.`);
    if(doc.snapshot!==undefined&&(typeof doc.snapshot!=='string'||!snapshotPattern.test(doc.snapshot)))throw new Error(`검토 결과${label} snapshot은 내려받은 검토 JSON의 snapshot 값을 그대로 사용해야 합니다.`);
    if(doc.schemaVersion===2&&!doc.snapshot)throw new Error(`검토 결과${label} schemaVersion 2에는 내려받은 검토 JSON의 snapshot이 필요합니다.`);
    const unknown=Object.keys(doc).filter(k=>!['schemaVersion','snapshot','batchIds','decisions'].includes(k));
    if(unknown.length)warnings.push(`${label||'검토 결과:'} 알 수 없는 최상위 필드를 무시했습니다 (${unknown.slice(0,5).map(k=>k.slice(0,40)).join(', ')})`.trim());
    const batchIds=Array.isArray(doc.batchIds)?doc.batchIds.filter(b=>typeof b==='string'&&b.length<=40).slice(0,1000):[];
    parts.push({schemaVersion:doc.schemaVersion,snapshot:doc.snapshot||null,batchIds,count:doc.decisions.length});
    for(const item of doc.decisions)decisions.push({part,value:item});
  });
  if(!decisions.length)throw new Error('가져올 decisions가 없습니다.');
  if(decisions.length>REVIEW_UPLOAD.maxDecisions)throw new Error(`한 번에 ${REVIEW_UPLOAD.maxDecisions.toLocaleString('ko-KR')}개까지 가져올 수 있습니다. 배치별 부분 결과로 나누어주세요.`);
  // Repeated candidateIds: the first occurrence is reviewed, later ones are reported as duplicates.
  const first=new Map();
  decisions.forEach((entry,at)=>{
    const id=typeof entry.value?.candidateId==='string'?entry.value.candidateId:null;if(id===null)return;
    if(!first.has(id)){first.set(id,at);return;}
    entry.duplicateOf=first.get(id);
    if(JSON.stringify(entry.value)!==JSON.stringify(decisions[entry.duplicateOf].value))decisions[entry.duplicateOf].conflicting=true;
  });
  return {parts,decisions,warnings};
}
// Returns {value} for a well-formed decision, otherwise {error} for that row only.
export function normalizeDecision(d,schemaVersion=2){
  const candidateId=typeof d?.candidateId==='string'?d.candidateId.slice(0,300):null,fail=error=>({candidateId,error});
  if(!keys(d,[...REQUIRED_ITEM_KEYS,'proposal']))return fail('알 수 없는 필드가 있거나 객체가 아닙니다. 입력 스키마를 확인해주세요.');
  if(!string(d.candidateId,300))return fail('candidateId는 1~300자 문자열이어야 합니다.');
  if(!['match','separate','defer','propose'].includes(d.decision))return fail('decision은 match, propose, separate, defer 중 하나여야 합니다.');
  if(d.decision==='propose'&&schemaVersion!==2)return fail('propose는 schemaVersion 2 결과에서만 사용할 수 있습니다.');
  if(typeof d.needsManualReview!=='boolean')return fail('needsManualReview는 true 또는 false여야 합니다.');
  if(!Array.isArray(d.evidence)||d.evidence.length>10||d.evidence.some(e=>!keys(e,['type','detail'])||!EVIDENCE_TYPES.includes(e.type)||!string(e.detail,1000)))return fail('evidence에는 허용된 type과 1~1000자 detail을 최대 10개까지 적습니다.');
  if(d.decision==='match'?!string(d.recordId,300):d.recordId!==null)return fail('match에는 recordId가 필요하며 propose/separate/defer에는 null을 사용하세요.');
  if(d.decision!=='propose'&&d.proposal!==undefined)return fail('proposal은 decision이 propose일 때만 사용할 수 있습니다.');
  const value={candidateId:d.candidateId,decision:d.decision,recordId:d.recordId,evidence:d.evidence.map(e=>({type:e.type,detail:e.detail})),needsManualReview:d.needsManualReview};
  if(d.decision==='propose'){const proposal=normalizeProposal(d.proposal);if(proposal.error)return fail(proposal.error);value.proposal=proposal;}
  return {candidateId,value};
}
// Classifies one well-formed decision against the current state. `verified` is the canonical
// record ID confirmed by an external lookup for a propose decision.
export function planDecision(ctx,d,{verified=null}={}){
  const p=ctx.inputs.get(d.candidateId);
  if(!p)return {status:'error',reason:'원본 candidateId를 찾지 못했습니다.',title:null,recordTitle:null,targetId:null};
  const target=d.decision==='match'?recordOf(ctx,d.recordId):verified?recordOf(ctx,verified):null;
  if(d.decision==='match'&&!target)return {status:'error',reason:'조회된 recordId를 찾지 못했습니다. 새 식별자는 decision "propose"와 proposal로 제안하세요.',title:p.title,recordTitle:null,targetId:null};
  const [status,reason]=decisionStatus(ctx,d,target);
  return {status,reason,title:p.title,recordTitle:target?.title||null,targetId:target?.id||null};
}
