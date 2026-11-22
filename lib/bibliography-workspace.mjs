// A single human review queue. Provider verification proves a record exists;
// the explicit approval here is what connects an otherwise unverified acronym.
import {reviewContext,reviewSnapshot} from './bibliography-review.mjs';
import {validRecord} from './bibliography.mjs';
import {paperRecord} from './bibliography-catalog.mjs';
import {REVIEW_EVIDENCE,evidenceOrder} from './review-evidence.mjs';
import {titleIdentityKey} from './bibliography-policy.mjs';
import {duplicateSubject,duplicateSubjectHash} from './duplicate-review.mjs';

const fail=(status,message,code)=>Object.assign(new Error(message),{httpStatus:status,code});
const actions=['match','separate','dismiss','merge'];
const pending=['ready','needs-manual-review','deferred','stale'];
export const reviewStatusGroup=status=>pending.includes(status)?'pending':['preserved','applied'].includes(status)?'completed':'error';
const summary=r=>({recordId:r.id,title:r.title,authors:r.authors||[],year:r.year||null,doi:r.identifiers.filter(i=>i.kind==='doi').map(i=>i.value),arxiv:r.identifiers.filter(i=>i.kind==='arxiv').map(i=>i.value),url:r.url||null});

export class BibliographyWorkspace{
  constructor({context,imports,saveDecisions,saveReviews,refresh=()=>{},busy=()=>false}){Object.assign(this,{context,imports,saveDecisions,saveReviews,refresh,busy});}
  #rows(importId){
    const data=this.context(),ctx=reviewContext(data.raw,data.store,data.resolved,data.decisions),reviews=data.reviews||{};
    const libraryTargets=data.resolved.papers.flatMap(p=>{
      const record=p.metadata&&ctx.records.get(ctx.catalog.redirects.get(p.metadata.id)||p.metadata.id),members=p.sourceCandidateIds||[p.id];
      if(!record||!validRecord(record)||record.identityConflict||!paperRecord(record)||members.every(id=>reviews[id]?.status==='dismissed'))return [];
      const result={...summary(record),paperId:p.id,count:p.count,conversationCount:p.conversationCount,sourceCandidateIds:members,approved:members.some(id=>ctx.decisions[id]?.action==='match'||reviews[id]?.status==='confirmed')};
      return [{...result,token:reviewSnapshot([p.id,summary(record),[...members].sort()])}];
    }).sort((a,b)=>Number(b.approved)-Number(a.approved)||b.count-a.count||a.paperId.localeCompare(b.paperId));
    const targetsByKey=new Map(),addTarget=(key,t)=>{if(!targetsByKey.has(key))targetsByKey.set(key,new Set());targetsByKey.get(key).add(t.paperId);};
    for(const t of libraryTargets){addTarget(t.recordId,t);addTarget('title:'+titleIdentityKey(t.title),t);for(const id of t.doi)addTarget('doi:'+id,t);for(const id of t.arxiv)addTarget('arxiv:'+id,t);}
    const linkedById=new Map(libraryTargets.map(t=>[t.paperId,t]));
    const sourcePapers=new Map(data.resolved.papers.map(p=>[p.id,p]));
    const imported=importId?this.imports.reviewState(importId):null,byCandidate=new Map();
    for(const row of imported?.rows||[]){
      if(!row.candidateId)continue;
      if(!byCandidate.has(row.candidateId))byCandidate.set(row.candidateId,{...row,duplicates:0});
      else byCandidate.get(row.candidateId).duplicates++;
    }
    const duplicateNotes=new Map(),duplicateIds=new Set();let staleDuplicatePairs=0;
    for(const recommendation of imported?.duplicateRows||[]){
      if(!['proposed','applied'].includes(recommendation.status))continue;
      const papers=recommendation.paperIds.map(id=>sourcePapers.get(data.resolved.redirects?.[id]||id));
      const alreadyUnified=!!papers[0]&&papers[0]===papers[1];
      const stale=!alreadyUnified&&recommendation.subjects.some((s,i)=>!papers[i]||duplicateSubjectHash(duplicateSubject(papers[i]))!==duplicateSubjectHash(s));
      if(stale)staleDuplicatePairs++;
      for(const [i,p]of papers.entries()){
        if(!p)continue;
        const note={pairId:recommendation.pairId,decision:recommendation.decision,evidence:recommendation.evidence,identifiers:recommendation.identifiers,otherPaperId:papers[1-i]?.id||recommendation.paperIds[1-i],otherTitle:recommendation.subjects[1-i].title,stale,alreadyUnified,status:recommendation.status};
        if(!duplicateNotes.has(p.id))duplicateNotes.set(p.id,[]);duplicateNotes.get(p.id).push(note);
        for(const id of p.sourceCandidateIds||[p.id])duplicateIds.add(id);
      }
    }
    const ids=new Set([...ctx.items.keys(),...byCandidate.keys(),...duplicateIds,...Object.keys(ctx.decisions),...Object.keys(reviews).filter(id=>reviews[id]?.status==='dismissed')]),rows=[];
    for(const candidateId of ids){
      const p=ctx.inputs.get(candidateId),item=ctx.items.get(candidateId),r=byCandidate.get(candidateId),decision=ctx.decisions[candidateId],review=reviews[candidateId];
      if(!p){if(r)rows.push({candidateId,title:r.title||candidateId,count:0,status:'error',reason:r.reason||'원본 후보를 찾지 못했습니다.',selectable:false,token:'',candidates:[],defaultAction:'',recordId:null,evidence:r.evidence||[],verification:null,duplicates:r.duplicates||0});continue;}
      const targetIds=new Set((item?.candidates||[]).map(c=>c.recordId));
      const availableRecords=[...targetIds].map(id=>ctx.records.get(ctx.catalog.redirects.get(id)||id)).filter(record=>record&&validRecord(record));
      const candidates=availableRecords.filter(record=>paperRecord(record)&&!record.identityConflict);
      const options=[...new Map(candidates.map(record=>[record.id,summary(record)])).values()];
      const blockedCandidates=availableRecords.filter(record=>record.identityConflict||!paperRecord(record)).map(record=>({...summary(record),reason:record.identityConflict?'공식 서지 레코드 사이에 식별자·제목 충돌이 있어 연결을 보류했습니다.':'논문 이외의 자료 유형으로 분류된 서지 레코드입니다.',issues:record.identityIssues||[]}));
      const suggestedId=r?.recordId||r?.verification?.record?.recordId,suggested=suggestedId&&ctx.records.get(ctx.catalog.redirects.get(suggestedId)||suggestedId);
      const connectedPaper=linkedById.get(data.resolved.redirects?.[candidateId]||candidateId)||null;
      const sourcePaper=sourcePapers.get(data.resolved.redirects?.[candidateId]||candidateId),mergeSource=sourcePaper?{paperId:sourcePaper.id,title:sourcePaper.title,count:sourcePaper.count,conversationCount:sourcePaper.conversationCount,sourceCandidateIds:sourcePaper.sourceCandidateIds||[candidateId]}:null;
      const duplicateRecommendations=duplicateNotes.get(sourcePaper?.id)||[];
      if(suggested&&validRecord(suggested)&&!availableRecords.some(c=>c.id===suggested.id)&&connectedPaper?.recordId!==suggested.id)blockedCandidates.push({...summary(suggested),reason:'제안된 레코드는 존재하지만 현재 이 항목의 연결 후보로 등록되어 있지 않습니다.',issues:suggested.identityIssues||[]});
      let status=r?.status||'needs-manual-review',reason=r?.reason||item?.reason||'연결할 공식 서지 레코드를 선택하거나 후보 제외 여부를 검토하세요.';
      const appliedHere=!!importId&&(decision?.importId===importId||review?.bibliographyReview?.importId===importId);
      if(decision||review?.status==='dismissed'){
        status=appliedHere?'applied':'preserved';reason=appliedHere?'사용자 승인 후 적용됨':'기존 연결·분리·논문 검토 결정을 보존합니다.';
      }else if(!item){status='preserved';reason='이미 공식정보에 연결됐거나 현재 검토 대상이 아닙니다.';}
      const mergeOnly=(decision?.action==='match'||!item&&connectedPaper)&&review?.status!=='dismissed'&&libraryTargets.some(t=>t.paperId!==(data.resolved.redirects?.[candidateId]||candidateId));
      const selectable=(!!item&&!decision||mergeOnly)&&review?.status!=='dismissed'&&r?.status!=='error'&&r?.status!=='duplicate';
      const mergeKeys=[...(r?.recordId?[ctx.catalog.redirects.get(r.recordId)||r.recordId]:[]),...[p.title,...(p.aliases||[])].map(t=>'title:'+titleIdentityKey(t)),...(p.identifiers||[]).map(i=>i.key)];
      const mergeSuggestions=[...new Set(mergeKeys.flatMap(key=>[...(targetsByKey.get(key)||[])]))].filter(id=>id!==(data.resolved.redirects?.[candidateId]||candidateId));
      for(const d of duplicateRecommendations)if(d.decision==='same_paper'&&!d.stale&&!d.alreadyUnified&&linkedById.has(d.otherPaperId)&&!mergeSuggestions.includes(d.otherPaperId))mergeSuggestions.push(d.otherPaperId);
      // A version relationship is explicitly different from a duplicate-merge proposal.
      const versionTargets=new Set(duplicateRecommendations.filter(d=>d.decision!=='same_paper'&&!d.stale).map(d=>d.otherPaperId));
      for(let i=mergeSuggestions.length-1;i>=0;i--)if(versionTargets.has(mergeSuggestions[i]))mergeSuggestions.splice(i,1);
      if(selectable&&decision?.action!=='separate'&&duplicateRecommendations.some(d=>d.status==='proposed'&&d.decision==='same_paper'&&!d.alreadyUnified)){status='needs-manual-review';reason='LLM이 기존 논문과의 중복을 제안했습니다. 근거를 확인하고 직접 통합 대상을 선택하세요.';}
      const allowedActions=selectable?(mergeOnly?['merge']:['match','separate',...(libraryTargets.length?['merge']:[]),...(review?.status==='confirmed'?[]:['dismiss'])]):[];
      const preferred=options.find(o=>o.recordId===(r?.recordId||r?.verification?.record?.recordId));
      const defaultAction=mergeOnly?'':preferred||options.length===1?'match':r?.decision==='separate'?'separate':'';
      const recordId=preferred?.recordId||(options.length===1?options[0].recordId:null);
      // A token binds the displayed choices, metadata and existing decisions. Mention
      // counts changing alone do not invalidate a review. No private keys leave here.
      const mergeState=sourcePaper?[sourcePaper.id,sourcePaper.sourceCandidateIds,sourcePaper.memberIds,(sourcePaper.sourceCandidateIds||[]).map(id=>[id,ctx.decisions[id]||null,reviews[id]||null])]:null;
      const token=reviewSnapshot([candidateId,p.title,p.aliases,p.identifiers,options,blockedCandidates,decision||null,review||null,mergeState]);
      const snapshotNotice=r?.snapshotCheck==='changed'?'검토 JSON을 내려받은 뒤 연결 후보 목록이 바뀌었습니다. 현재 후보가 있으면 직접 확인해 선택하세요. 후보가 없으면 공식 서지정보 조회가 필요합니다. LLM 검토를 반드시 다시 받을 필요는 없습니다.':r?.snapshotCheck==='not-exported'?'내려받은 JSON에 없던 항목입니다. 현재 후보와 근거를 직접 확인한 뒤 선택해주세요.':null;
      const connectionMessage=mergeOnly?'이미 공식정보에 연결된 항목입니다. 다른 기존 논문과 통합할 수 있으며 기존 수동 승인 내용은 이력으로 보존합니다.':selectable&&!options.length?(blockedCandidates.length?'공식 레코드는 있지만 연결이 보류되어 있습니다. 아래에서 보류 사유를 확인하세요.':'현재 선택할 수 있는 공식 연결 후보가 없습니다. 제안된 근거 유형만으로는 연결할 수 없습니다.'):null;
      rows.push({candidateId,title:p.title,count:p.count||0,status,reason,selectable,allowedActions,token,candidates:options,blockedCandidates,connectionMessage,snapshotNotice,mergeSuggestions,mergeSource,connectedPaper,mergeOnly,defaultAction,recordId,duplicateRecommendations,
        evidence:r?.evidence||decision?.evidence||[],verification:r?.verification||null,duplicates:r?.duplicates||0,
        ...(review?.status==='dismissed'?{appliedAction:'dismiss'}:decision?{appliedAction:decision.mergeTargetPaperId?'merge':decision.action}:connectedPaper?{appliedAction:'match'}:{}),
        manualConfirmation:selectable&&defaultAction==='match'&&r?.status!=='ready'});
    }
    for(const r of imported?.rows||[])if(!r.candidateId)rows.push({candidateId:'invalid:'+r.index,title:'candidateId 없음',count:0,status:'error',reason:r.reason,selectable:false,token:'',candidates:[],defaultAction:'',recordId:null,evidence:[],verification:null,duplicates:0});
    rows.sort((a,b)=>b.count-a.count||a.candidateId.localeCompare(b.candidateId));
    return {data,ctx,rows,imported,libraryTargets,staleDuplicatePairs};
  }
  view({importId='',status='pending',evidence='',sort='count',search='',offset=0,limit=50,ids=''}={}){
    offset=Number(offset);limit=Number(limit);
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw fail(400,'올바른 검토 목록 범위를 지정해주세요.','INVALID_RANGE');
    if(!['pending','completed','all','ready','needs-manual-review','preserved','deferred','error','applied','stale'].includes(status))throw fail(400,'올바른 검토 상태를 선택해주세요.','INVALID_FILTER');
    if(evidence&&!['none',...REVIEW_EVIDENCE.map(e=>e.type)].includes(evidence))throw fail(400,'올바른 검토 근거를 선택해주세요.','INVALID_FILTER');
    if(!['count','evidence'].includes(sort))throw fail(400,'올바른 정렬 기준을 선택해주세요.','INVALID_SORT');
    const {rows,imported,libraryTargets,staleDuplicatePairs}=this.#rows(importId),counts={};for(const r of rows)counts[r.status]=(counts[r.status]||0)+1;
    for(const r of rows)Object.assign(r,evidenceOrder(r));
    const groups={pending:0,completed:0,error:0};for(const r of rows)groups[reviewStatusGroup(r.status)]++;
    // Internal statuses remain available to existing API callers and saved imports.
    const needle=String(search).trim().toLocaleLowerCase(),base=rows.filter(r=>(status==='all'||['pending','completed','error'].includes(status)&&reviewStatusGroup(r.status)===status||r.status===status)&&(!needle||[r.title,r.candidateId,...r.candidates.map(c=>c.title)].some(t=>t.toLocaleLowerCase().includes(needle))));
    const evidenceCounts=Object.fromEntries([...REVIEW_EVIDENCE.map(e=>e.type),'none'].map(type=>[type,base.filter(r=>type==='none'?!r.evidenceTypes.length:r.evidenceTypes.includes(type)).length]));
    const filtered=base.filter(r=>!evidence||evidence==='none'&&!r.evidenceTypes.length||r.evidenceTypes.includes(evidence));
    if(sort==='evidence')filtered.sort((a,b)=>a.evidencePriority-b.evidencePriority||b.count-a.count||a.candidateId.localeCompare(b.candidateId));
    return {rows:filtered.slice(offset,offset+limit).map(r=>({...r,statusGroup:reviewStatusGroup(r.status)})),total:filtered.length,counts,groups,libraryTargets,staleDuplicatePairs,evidenceCatalog:REVIEW_EVIDENCE,evidenceCounts,sort,offset,limit,running:!!imported?.running,requiresConfirmation:!!imported?.requiresConfirmation,
      ...(ids==='selectable'?{selections:filtered.filter(r=>r.selectable).map(r=>({candidateId:r.candidateId,token:r.token,action:r.defaultAction,recordId:r.recordId}))}:{})};
  }
  apply({importId='',approved=false,confirmSnapshot=false,selections}={}){
    if(approved!==true)throw fail(400,'사용자 최종 승인이 필요합니다.','APPROVAL_REQUIRED');
    if(this.busy())throw fail(409,'공식 조회·검증이 끝난 뒤 적용해주세요.','REVIEW_BUSY');
    if(!Array.isArray(selections)||!selections.length||selections.length>20000||selections.some(s=>!s||typeof s.candidateId!=='string'||!actions.includes(s.action)||typeof s.token!=='string'||s.action==='match'&&typeof s.recordId!=='string'||s.action==='merge'&&(typeof s.targetPaperId!=='string'||typeof s.targetToken!=='string'))||new Set(selections.map(s=>s.candidateId)).size!==selections.length)throw fail(400,'검토 동작과 논문을 중복 없이 선택해주세요.','INVALID_SELECTION');
    const {data,rows,imported,libraryTargets}=this.#rows(importId);
    if(imported?.running)throw fail(409,'가져온 결과 검증이 끝난 뒤 적용해주세요.','REVIEW_BUSY');
    if(imported?.requiresConfirmation&&confirmSnapshot!==true)throw fail(409,'다른 snapshot의 결과임을 확인한 뒤 적용해주세요.','SNAPSHOT_CONFIRMATION_REQUIRED');
    const current=new Map(rows.map(r=>[r.candidateId,r])),valid=[],skipped=[];
    for(const s of selections){
      const row=current.get(s.candidateId),target=s.action==='merge'?libraryTargets.find(t=>t.paperId===s.targetPaperId):null;
      const reason=!row?.selectable?'이미 처리됐거나 기존 수동 결정이 있어 보존했습니다.':s.token!==row.token?'미리보기 뒤 후보·공식정보가 바뀌었습니다. 목록을 새로 확인해주세요.':!row.allowedActions.includes(s.action)?'기존 검토 상태를 보존했습니다.':s.action==='match'&&!row.candidates.some(c=>c.recordId===s.recordId)?'현재 검증된 연결 후보가 아닙니다.':s.action==='merge'&&(!target||target.token!==s.targetToken||target.paperId===(data.resolved.redirects?.[s.candidateId]||s.candidateId)||target.sourceCandidateIds.some(id=>selections.some(v=>v.candidateId===id&&v.action==='merge')))?'통합 대상이 바뀌었거나 연쇄·자기 통합입니다. 안정된 대상 논문을 다시 선택해주세요.':null;
      const source=data.resolved.papers.find(p=>p.id===(data.resolved.redirects?.[s.candidateId]||s.candidateId)),sourceIds=source?.sourceCandidateIds||[s.candidateId];
      const sourceConflict=s.action==='merge'&&sourceIds.some(id=>data.decisions[id]?.action==='separate'||data.reviews?.[id]?.status==='dismissed'||selections.some(other=>other.candidateId===id&&other!==s&&(other.action!=='merge'||other.targetPaperId!==s.targetPaperId)));
      if(reason||sourceConflict)skipped.push({candidateId:s.candidateId,reason:reason||'통합할 논문 안에 분리·제외 기록 또는 서로 다른 동작이 있습니다. 해당 논문만 다시 검토해주세요.'});
      else valid.push({...s,...(target?{recordId:target.recordId,mergeTargetPaperId:target.paperId,mergeSourcePaperId:source?.id,mergeCandidateIds:sourceIds,mergeMemberIds:[...new Set([source?.id,...(source?.memberIds||[])].filter(Boolean))]}:{}),evidence:row.evidence});
    }
    const updatedAt=new Date().toISOString(),meta={decisionSource:'human-review',...(importId?{importId}:{}),updatedAt},written=[];
    try{
      const linking=[...new Map(valid.filter(s=>s.action!=='dismiss').flatMap(s=>(s.action==='merge'?s.mergeCandidateIds:[s.candidateId]).map(candidateId=>({...s,candidateId}))).map(s=>[s.candidateId,s])).values()];
      if(linking.length){const next={...data.decisions};for(const s of linking){const old=next[s.candidateId],{history:priorHistory=[],...previous}=old||{};next[s.candidateId]={action:s.action==='merge'?'match':s.action,...(['match','merge'].includes(s.action)?{recordId:s.recordId}:{}),...(s.action==='merge'?{mergeTargetPaperId:s.mergeTargetPaperId,mergeSourcePaperId:s.mergeSourcePaperId,mergeMemberIds:s.mergeMemberIds,...(old?{history:[...priorHistory,previous]}:{})}:{}),evidence:s.evidence,...meta};}this.saveDecisions(next);written.push(...linking);}
      const excluding=valid.filter(s=>s.action==='dismiss');
      if(excluding.length){const next={...data.reviews};for(const s of excluding)next[s.candidateId]={...next[s.candidateId],status:'dismissed',bibliographyReview:{action:'dismiss',...meta}};this.saveReviews(next);written.push(...excluding);}
      if(importId&&written.length)this.imports.recordManualApplications(importId,written,updatedAt);
    }catch(e){this.refresh();throw Object.assign(fail(500,`${written.length}건 저장 후 실패했습니다. 저장된 결정은 유지되며 목록을 갱신해 남은 항목을 다시 적용할 수 있습니다.`,'PARTIAL_APPLY'),{details:{applied:written.length}});}
    this.refresh();return {ok:true,applied:written.length,skipped,matched:written.filter(s=>s.action==='match').length,merged:new Set(written.filter(s=>s.action==='merge').map(s=>s.mergeSourcePaperId)).size,dismissed:written.filter(s=>s.action==='dismiss').length,separated:written.filter(s=>s.action==='separate').length};
  }
}
