// Bibliographic projections only. Pair suggestions are never merge decisions.
import {createHash} from 'node:crypto';
import {titleIdentityKey,specificTitle,blockedCandidate,aliasIdentity} from './bibliography-policy.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DUPLICATE_RELATIONS=['same_paper','same_work_different_version','different','uncertain'];
const words=t=>[...new Set(String(t).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[])].filter(w=>w.length>2);
const unique=values=>[...new Set(values)].sort();
export function duplicateSubject(p){
  const metadata=p.metadata,identifiers=metadata?.identityIdentifiers||metadata?.identifiers||p.identifiers||[];
  return {paperId:p.id,title:metadata?.title||p.title,aliases:unique([p.title,...(p.aliases||[]),...(p.observedTitles||[]).map(t=>t.text)].filter(t=>typeof t==='string'&&t!==metadata?.title)).slice(0,12),authors:(metadata?.authors||[]).slice(0,30),year:metadata?.year||null,doi:unique(identifiers.filter(i=>i.kind==='doi').map(i=>i.value)),arxiv:unique(identifiers.filter(i=>i.kind==='arxiv').map(i=>i.value)),count:p.count||0};
}
export const duplicateSubjectHash=({count,...subject})=>hash(subject);
export const duplicatePairId=paperIds=>'pair:'+hash([...paperIds].sort()).slice(0,24);

export function duplicateReviewExport(resolved,{maxPairs=1500,maxPerPaper=6}={}){
  const subjects=[...new Map(resolved.papers.filter(p=>p.status!=='dismissed'&&!blockedCandidate(p.title)&&!p.metadata?.identityConflict).map(p=>[p.id,duplicateSubject(p)])).values()].sort((a,b)=>a.paperId.localeCompare(b.paperId));
  const byId=new Map(subjects.map(s=>[s.paperId,s])),buckets=new Map(),tokens=new Map(),postings=new Map();
  const add=(map,key,id)=>{if(!map.has(key))map.set(key,new Set());map.get(key).add(id);};
  for(const s of subjects){
    const names=unique([s.title,...s.aliases]),full=names.filter(specificTitle);
    tokens.set(s.paperId,new Set(full.flatMap(words)));
    for(const id of [...s.doi.map(v=>'doi:'+v),...s.arxiv.map(v=>'arxiv:'+v)])add(buckets,id,s.paperId);
    for(const title of full)add(buckets,'title:'+titleIdentityKey(title),s.paperId);
    for(const name of names){const alias=aliasIdentity(name);if(alias)add(buckets,'title:'+titleIdentityKey(alias.title),s.paperId);}
    for(const w of tokens.get(s.paperId))add(postings,w,s.paperId);
  }
  // At most three uncommon title tokens per paper. Large buckets are deliberately skipped;
  // generic words and lone acronyms must not cause an all-pairs comparison.
  for(const s of subjects){const rare=[...tokens.get(s.paperId)].filter(w=>postings.get(w).size>1&&postings.get(w).size<=50).sort((a,b)=>postings.get(a).size-postings.get(b).size||a.localeCompare(b)).slice(0,3);for(const w of rare)for(const id of postings.get(w))add(buckets,'word:'+w,id);}
  const pairs=new Map(),addPair=(paperIds,reason)=>{paperIds=[...paperIds].sort();if(paperIds[0]===paperIds[1])return;const id=duplicatePairId(paperIds);if(!pairs.has(id))pairs.set(id,{pairId:id,paperIds,reasons:[]});const pair=pairs.get(id);if(!pair.reasons.includes(reason))pair.reasons.push(reason);};let skippedBuckets=0;
  // A record already suggested by the bibliography resolver can point an unresolved
  // acronym toward a linked paper. This merely asks the LLM to review the relationship.
  const sourceIds=new Map(),recordTargets=new Map();
  for(const p of resolved.papers){if(!byId.has(p.id))continue;for(const id of [p.id,...(p.sourceCandidateIds||[])])sourceIds.set(id,p.id);if(p.metadata)for(const id of [p.metadata.id,p.id,...(p.memberIds||[])])recordTargets.set(id,p.id);}
  for(const q of resolved.resolutionQueue||[]){const source=sourceIds.get(q.id);if(!source)continue;for(const s of q.suggestions||[]){const target=recordTargets.get(s.recordId);if(target&&byId.has(target))addPair([source,target],'shared-record-candidate');}}
  for(const [key,ids]of buckets){
    if(ids.size>60){skippedBuckets++;continue;}
    const list=[...ids].sort();
    for(let a=0;a<list.length;a++)for(let b=a+1;b<list.length;b++){
      const paperIds=[list[a],list[b]],left=byId.get(list[a]),right=byId.get(list[b]);
      let reason=key.startsWith('word:')?'similar-specific-title':key.startsWith('title:')?'full-title-or-curated-alias':'shared-identifier';
      if(reason==='similar-specific-title'){
        const l=tokens.get(left.paperId),r=tokens.get(right.paperId),shared=[...l].filter(w=>r.has(w)).length;
        if(shared<4||shared/Math.max(l.size,r.size)<0.65)continue;
      }
      addPair(paperIds,reason);
    }
  }
  const ranked=[...pairs.values()].sort((a,b)=>{
    const rank=p=>p.reasons.includes('shared-identifier')?0:p.reasons.includes('full-title-or-curated-alias')?1:p.reasons.includes('shared-record-candidate')?2:3;
    return rank(a)-rank(b)||b.paperIds.reduce((n,id)=>n+byId.get(id).count,0)-a.paperIds.reduce((n,id)=>n+byId.get(id).count,0)||a.pairId.localeCompare(b.pairId);
  }),counts=new Map(),selected=[];
  for(const pair of ranked){if(selected.length>=maxPairs)break;if(pair.paperIds.some(id=>(counts.get(id)||0)>=maxPerPaper))continue;selected.push({...pair,reasons:pair.reasons.sort()});for(const id of pair.paperIds)counts.set(id,(counts.get(id)||0)+1);}
  const included=subjects.filter(s=>counts.has(s.paperId)),snapshot=hash([included.map(s=>[s.paperId,duplicateSubjectHash(s)]),selected]);
  return {snapshot,subjects:included,pairs:selected,coverage:{papersScanned:subjects.length,candidatePairs:ranked.length,exportedPairs:selected.length,truncated:selected.length<ranked.length,skippedLargeBuckets:skippedBuckets,maxPairs,maxPerPaper},scope:'제목·식별자로 좁힌 후보 쌍만 검토합니다. 목록에 없는 쌍은 중복이 아니라는 뜻이 아닙니다.'};
}

export const duplicateSuggestionSchema={type:'object',additionalProperties:false,required:['pairId','paperIds','decision','evidence','identifiers','needsManualReview'],properties:{
  pairId:{type:'string',pattern:'^pair:[a-f0-9]{24}$'},paperIds:{type:'array',minItems:2,maxItems:2,uniqueItems:true,items:{type:'string',minLength:1,maxLength:300}},decision:{enum:DUPLICATE_RELATIONS},
  evidence:{type:'array',minItems:1,maxItems:10,items:{type:'object',additionalProperties:false,required:['type','detail'],properties:{type:{enum:['identifier-match','exact-title','author-year-match','explicit-alias-expansion','possible-work-version','insufficient-evidence','conflicting-identifiers','external-identifier']},detail:{type:'string',minLength:1,maxLength:1000}}}},
  identifiers:{type:'object',additionalProperties:false,required:['doi','arxiv'],properties:{doi:{type:'array',maxItems:30,items:{type:'string',minLength:1,maxLength:300}},arxiv:{type:'array',maxItems:30,items:{type:'string',minLength:1,maxLength:300}}}},needsManualReview:{const:true}
}};
const object=(v,fields)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>fields.includes(k));
export function validateDuplicateSuggestion(value,manifest){
  const fail=reason=>({status:'error',reason,pairId:typeof value?.pairId==='string'?value.pairId.slice(0,100):null});
  if(!object(value,Object.keys(duplicateSuggestionSchema.properties))||!DUPLICATE_RELATIONS.includes(value.decision)||value.needsManualReview!==true)return fail('중복 제안의 필드·관계 유형을 확인하고 needsManualReview를 true로 지정해주세요.');
  if(!Array.isArray(value.paperIds)||value.paperIds.length!==2||value.paperIds.some(id=>typeof id!=='string'||!id||id.length>300)||new Set(value.paperIds).size!==2||value.pairId!==duplicatePairId(value.paperIds))return fail('중복 후보의 pairId와 서로 다른 paperIds 두 개를 그대로 사용해주세요.');
  if(!Array.isArray(value.evidence)||!value.evidence.length||value.evidence.length>10||value.evidence.some(e=>!object(e,['type','detail'])||!duplicateSuggestionSchema.properties.evidence.items.properties.type.enum.includes(e.type)||typeof e.detail!=='string'||!e.detail.trim()||e.detail.length>1000))return fail('중복 제안의 evidence 유형과 1~1000자 detail을 확인해주세요.');
  if(!object(value.identifiers,['doi','arxiv'])||['doi','arxiv'].some(k=>!Array.isArray(value.identifiers[k])||value.identifiers[k].length>30||value.identifiers[k].some(v=>typeof v!=='string'||!v||v.length>300)))return fail('identifiers에 doi·arxiv 배열이 필요합니다. 모르는 값은 빈 배열로 둡니다.');
  if(!manifest)return fail('이 중복 snapshot의 내보내기 기록이 없습니다. 새 검토 JSON으로 중복 검토를 진행해주세요.');
  const pair=manifest.pairs.find(p=>p.pairId===value.pairId);
  if(!pair||JSON.stringify([...pair.paperIds].sort())!==JSON.stringify([...value.paperIds].sort()))return fail('내보낸 중복 후보 쌍에 없는 paperIds입니다.');
  const subjects=pair.paperIds.map(id=>manifest.subjects.find(s=>s.paperId===id));
  if(subjects.some(s=>!s)||['doi','arxiv'].some(k=>value.identifiers[k].some(v=>!subjects.some(s=>s[k].includes(v)))))return fail('중복 식별자는 해당 후보 쌍에 제공된 값만 복사해주세요. 새 식별자는 서지 propose로 검증해야 합니다.');
  return {...value,paperIds:[...pair.paperIds],subjects,status:'proposed',reason:'LLM 관계 제안입니다. 자동 병합하지 않으며 사용자가 확인해야 합니다.'};
}
