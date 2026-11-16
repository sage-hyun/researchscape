// Identifiers and titles proposed by an LLM are claims, never metadata. Each one is looked up again
// through the regular Crossref / OpenAlex / arXiv pipeline; only records that those providers
// actually returned can become link candidates, and nothing the LLM wrote is stored as official data.
import {identifiers,normalize} from './extract.mjs';
import {synchronizeBibliography,lookupKey,validRecord} from './bibliography.mjs';
import {metadataCatalog,paperRecord} from './bibliography-catalog.mjs';
import {specificTitle,exactTitle} from './bibliography-policy.mjs';
import {titleSimilarity} from './paper-links.mjs';

const clean=value=>value.normalize('NFKC').replace(/\s+/g,' ').trim();
const plainId=({key,kind,value,url})=>({key,kind,value,url});
export function normalizeProposal(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).every(k=>['doi','arxiv','title'].includes(k)))return {error:'propose에는 doi, arxiv, title만 담은 proposal 객체가 필요합니다.'};
  const text={};
  for(const key of ['doi','arxiv','title']){
    if(value[key]===undefined||value[key]===null)continue;
    if(typeof value[key]!=='string'||value[key].length>300)return {error:`proposal.${key}는 300자 이하 문자열이어야 합니다.`};
    if(clean(value[key]))text[key]=clean(value[key]);
  }
  const result={identifiers:[]},add=id=>{if(!result.identifiers.some(i=>i.key===id.key))result.identifiers.push(plainId(id));};
  if(text.doi){
    const found=identifiers('https://doi.org/'+text.doi.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i,'')).filter(i=>i.kind==='doi');
    if(found.length!==1)return {error:'proposal.doi가 DOI 형식이 아닙니다. 예: 10.1145/3411841'};
    result.doi=found[0].value;
    // arXiv DOIs are registered with DataCite, not Crossref. Verify them through arXiv itself.
    const preprint=/^10\.48550\/arxiv\.(.+)$/.exec(result.doi)?.[1];
    if(preprint){const id=identifiers('arxiv:'+preprint).find(i=>i.kind==='arxiv');if(!id)return {error:'proposal.doi의 arXiv DOI 형식이 올바르지 않습니다.'};add(id);}
    else add(found[0]);
  }
  if(text.arxiv){
    const found=identifiers('arxiv:'+text.arxiv.replace(/^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/|arxiv:\s*)/i,'').replace(/\.pdf$/i,'')).filter(i=>i.kind==='arxiv');
    if(found.length!==1)return {error:'proposal.arxiv가 arXiv ID 형식이 아닙니다. 예: 1703.03400'};
    result.arxiv=found[0].value;add(found[0]);
  }
  if(text.title){if(text.title.length<3)return {error:'proposal.title은 3자 이상이어야 합니다.'};result.title=text.title;}
  if(!result.identifiers.length&&!result.title)return {error:'proposal에 doi, arxiv, title 중 하나 이상이 필요합니다.'};
  return result;
}

const official=r=>[r.title,...(r.alternateTitles||[])];
const similarity=(title,r)=>official(r).some(t=>exactTitle(title,t))?1:Math.max(...official(r).map(t=>titleSimilarity(title,t)));
const escaped=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const acronymLike=alias=>(alias.match(/\p{Lu}/gu)||[]).length>=2||/\d/.test(alias);
// "RoNIN: Robust Neural Inertial Navigation" names RoNIN. A common word inside a title names nothing.
const namedBy=(alias,r)=>official(r).some(t=>normalize(/^([A-Za-z][A-Za-z0-9+._-]{2,30})\s*[:：]/.exec(t)?.[1]||'')===normalize(alias)||acronymLike(alias)&&new RegExp(`(?<![\\p{L}\\p{N}])${escaped(alias)}(?![\\p{L}\\p{N}])`,'u').test(t));
// Bulk approval needs near-identical titles; a clearly different title means a different paper.
const SAME_TITLE=.9,RELATED_TITLE=.45,CLAIM_TITLE=.6;
export const officialSummary=r=>({recordId:r.id,title:r.title,authors:(r.authors||[]).slice(0,8),year:r.year||null,doi:r.identifiers.filter(i=>i.kind==='doi').map(i=>i.value),arxiv:r.identifiers.filter(i=>i.kind==='arxiv').map(i=>i.value),provider:r.provider||''});

function catalogView(store){
  const catalog=metadataCatalog(Object.values(store.records||{}).filter(validRecord)),byIdentifier=new Map();
  for(const r of catalog.records)for(const i of r.identifiers){if(!byIdentifier.has(i.key))byIdentifier.set(i.key,new Set());byIdentifier.get(i.key).add(r.id);}
  return {records:new Map(catalog.records.map(r=>[r.id,r])),redirects:catalog.redirects,byIdentifier};
}
function identifierState(view,store,proposal){
  const found=new Set(),failed=[],missing=[];
  for(const id of proposal.identifiers){
    const ids=view.byIdentifier.get(id.key);
    if(ids?.size){for(const recordId of ids)found.add(recordId);continue;}
    const entry=store.lookups?.[id.key];
    // A provider that answered "not indexed" is definitive; errors and cooldowns can be retried.
    (!entry||entry.status==='error'?failed:missing).push(id.key);
  }
  return {found,failed,missing};
}
const titleEntries=(store,title)=>{const key=lookupKey({title});return [store.lookups?.[key],...['crossref','openalex','semantic-scholar'].map(p=>store.providerLookups?.[`${p}|${key}`])].filter(Boolean);};

// Pure judgement over the lookup cache. `register` lists the records that were really retrieved and
// are worth showing to a person; `status: 'verified'` is the only outcome that may be approved in bulk.
export function evaluateProposal(view,store,paper,proposal){
  const ids=identifierState(view,store,proposal);
  let records=[...ids.found].map(id=>view.records.get(id)).filter(Boolean),via='identifier';
  if(!records.length){
    if(ids.failed.length)return {status:'lookup-failed',register:[],detail:'공식 서지 조회에 실패했습니다. 완료된 결과는 보존되며 다시 검증하면 이 항목만 재시도합니다.'};
    if(!proposal.title||!specificTitle(proposal.title))return {status:'not-found',register:[],detail:proposal.identifiers.length?'제안한 식별자를 Crossref·arXiv에서 찾지 못했습니다. 직접 확인해주세요.':'식별자 없이 약칭이나 짧은 제목만으로는 공식 조회를 할 수 없습니다. 정식 제목 전체나 식별자가 필요합니다.'};
    const entries=titleEntries(store,proposal.title),seen=new Set(entries.flatMap(e=>e.recordIds||[]).map(id=>view.redirects.get(id)||id));
    records=[...seen].map(id=>view.records.get(id)).filter(r=>r&&official(r).some(t=>exactTitle(t,proposal.title)));via='title';
    if(!records.length)return !entries.length||entries.some(e=>e.status==='error')?{status:'lookup-failed',register:[],detail:'제목 조회에 실패했습니다. 완료된 결과는 보존되며 다시 검증하면 이 항목만 재시도합니다.'}:{status:'not-found',register:[],detail:'제안한 제목과 정확히 일치하는 공식 레코드를 찾지 못했습니다. 직접 확인해주세요.'};
  }
  const usable=records.filter(r=>!r.identityConflict&&paperRecord(r));
  if(!usable.length)return {status:'conflict',register:[],record:officialSummary(records[0]),detail:'조회된 서지정보가 서로 충돌하거나 논문 유형이 아닙니다. 직접 확인해주세요.'};
  if(records.length>1)return {status:'ambiguous',register:usable.slice(0,3).map(r=>r.id),detail:via==='title'?'같은 제목의 공식 레코드가 여러 개입니다. 연결 후보로 등록했으니 직접 선택해주세요.':'제안한 식별자들이 서로 다른 공식 레코드를 가리킵니다. 연결 후보로 등록했으니 직접 선택해주세요.'};
  const record=records[0],summary=officialSummary(record);
  // A real DOI attached to the wrong paper is the typical hallucination: compare what the LLM claimed.
  if(via==='identifier'&&proposal.title&&similarity(proposal.title,record)<CLAIM_TITLE&&(specificTitle(proposal.title)||!namedBy(proposal.title,record)))return {status:'title-mismatch',register:[],record:summary,detail:'제안한 식별자의 공식 제목이 LLM이 적은 제목과 다릅니다. 다른 논문의 식별자일 수 있어 연결 후보로 등록하지 않았습니다.'};
  const observed=[...new Set([paper.title,...(paper.aliases||[])])],specific=observed.filter(specificTitle);
  if(specific.length){
    const best=Math.max(...specific.map(t=>similarity(t,record)));
    if(best<RELATED_TITLE)return {status:'candidate-mismatch',register:[],record:summary,detail:'조회된 공식 제목이 대화에서 발견한 제목과 크게 다릅니다. 연결 후보로 등록하지 않았습니다.'};
    if(best<SAME_TITLE)return {status:'weak-link',register:[record.id],record:summary,detail:'조회된 공식 제목이 대화에서 발견한 제목과 일부만 일치합니다. 연결 후보로 등록했으니 직접 확인해주세요.'};
  // Without an observed full title, the paper's own identifier or its name in the official title ties them together.
  }else if(!(paper.identifiers||[]).some(a=>record.identifiers.some(b=>a.key===b.key))&&!observed.some(alias=>namedBy(alias,record)))return {status:'weak-link',register:[record.id],record:summary,detail:'공식 레코드는 확인했지만 약칭과 공식 제목의 관계를 자동으로 확인할 수 없습니다. 연결 후보로 등록했으니 직접 확인해주세요.'};
  if(via==='title'&&ids.missing.length)return {status:'unconfirmed-identifier',register:[record.id],record:summary,detail:'제안한 식별자는 확인되지 않았고 같은 제목의 공식 레코드만 찾았습니다. 연결 후보로 등록했으니 직접 확인해주세요.'};
  return {status:'verified',register:[record.id],recordId:record.id,record:summary,detail:via==='title'?'제안한 정식 제목과 정확히 일치하는 공식 레코드 1건을 확인했습니다.':'제안한 식별자를 공식 조회로 확인했습니다.'};
}

// items: [{candidateId, paper, proposal, suggested}] where proposal came from normalizeProposal and
// suggested is the set of record IDs that already are link candidates of that paper.
// Mutates the lookup cache exactly like a regular bibliography sync (records, per-provider
// checkpoints, cooldowns) and registers confirmed records under store.proposedLinks.
export async function verifyProposals(items,{store,importId='',sync=synchronizeBibliography,onSave=()=>{},onProgress=()=>{},signal,...lookup}={}){
  store.records??={};store.lookups??={};
  // Everything these lookups add to the cache is provisional: usable as a link candidate, but not
  // as automatic evidence until a person approves a link to it or a regular lookup returns it too.
  const known=new Set(Object.keys(store.records)),provisional=new Set(Object.values(store.records).filter(r=>r.provisional).map(r=>r.id));
  const mark=()=>{for(const record of Object.values(store.records))if(!known.has(record.id)||provisional.has(record.id))record.provisional='llm-proposal';};
  const run=async papers=>{if(papers.length)await sync({papers,bibliographyHints:[]},store,{...lookup,limit:papers.length,signal,onSave:value=>{mark();onSave(value);},onProgress});mark();};
  // Identifier lookups first. An empty title keeps the pipeline from searching by title here.
  await run(items.filter(item=>item.proposal.identifiers.length).map(item=>({id:'proposal:'+item.candidateId,title:'',aliases:[],identifiers:item.proposal.identifiers,count:1})));
  let view=catalogView(store);
  // Title search only where no identifier produced a record and no identifier lookup is still retryable.
  const byTitle=items.filter(item=>{
    if(!item.proposal.title||!specificTitle(item.proposal.title))return false;
    const state=identifierState(view,store,item.proposal);return !state.found.size&&!state.failed.length;
  });
  if(byTitle.length){await run([...new Map(byTitle.map(item=>[lookupKey(item.proposal),{id:'proposal-title:'+item.candidateId,title:item.proposal.title,aliases:[],identifiers:[],count:1}])).values()]);view=catalogView(store);}
  const outcomes=new Map(),verifiedAt=new Date().toISOString();
  for(const item of items){
    const outcome=evaluateProposal(view,store,item.paper,item.proposal);outcomes.set(item.candidateId,outcome);
    // Records that already are candidates keep their existing evidence; only new ones are registered.
    const added=outcome.register.filter(id=>!item.suggested?.has(id));
    if(!added.length)continue;
    store.proposedLinks??={};
    const prior=store.proposedLinks[item.candidateId];
    store.proposedLinks[item.candidateId]={recordIds:[...new Set([...added,...(prior?.recordIds||[])])].slice(0,3),source:'llm-review',importId,verifiedAt};
  }
  return outcomes;
}
