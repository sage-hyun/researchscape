// A single human review queue. Provider verification proves a record exists;
// the explicit approval here is what connects an otherwise unverified acronym.
import {reviewContext,reviewSnapshot} from './bibliography-review.mjs';
import {validRecord} from './bibliography.mjs';
import {paperRecord} from './bibliography-catalog.mjs';

const fail=(status,message,code)=>Object.assign(new Error(message),{httpStatus:status,code});
const actions=['match','separate','dismiss'];
const pending=['ready','needs-manual-review','deferred','stale'];
export const reviewStatusGroup=status=>pending.includes(status)?'pending':['preserved','applied'].includes(status)?'completed':'error';
const summary=r=>({recordId:r.id,title:r.title,authors:r.authors||[],year:r.year||null,doi:r.identifiers.filter(i=>i.kind==='doi').map(i=>i.value),arxiv:r.identifiers.filter(i=>i.kind==='arxiv').map(i=>i.value),url:r.url||null});

export class BibliographyWorkspace{
  constructor({context,imports,saveDecisions,saveReviews,refresh=()=>{},busy=()=>false}){Object.assign(this,{context,imports,saveDecisions,saveReviews,refresh,busy});}
  #rows(importId){
    const data=this.context(),ctx=reviewContext(data.raw,data.store,data.resolved,data.decisions),reviews=data.reviews||{};
    const imported=importId?this.imports.reviewState(importId):null,byCandidate=new Map();
    for(const row of imported?.rows||[]){
      if(!row.candidateId)continue;
      if(!byCandidate.has(row.candidateId))byCandidate.set(row.candidateId,{...row,duplicates:0});
      else byCandidate.get(row.candidateId).duplicates++;
    }
    const ids=new Set([...ctx.items.keys(),...byCandidate.keys(),...Object.keys(ctx.decisions),...Object.keys(reviews).filter(id=>reviews[id]?.status==='dismissed')]),rows=[];
    for(const candidateId of ids){
      const p=ctx.inputs.get(candidateId),item=ctx.items.get(candidateId),r=byCandidate.get(candidateId),decision=ctx.decisions[candidateId],review=reviews[candidateId];
      if(!p){if(r)rows.push({candidateId,title:r.title||candidateId,count:0,status:'error',reason:r.reason||'원본 후보를 찾지 못했습니다.',selectable:false,token:'',candidates:[],defaultAction:'',recordId:null,evidence:r.evidence||[],verification:null,duplicates:r.duplicates||0});continue;}
      const targetIds=new Set((item?.candidates||[]).map(c=>c.recordId));
      const candidates=[...targetIds].map(id=>ctx.records.get(ctx.catalog.redirects.get(id)||id)).filter(record=>record&&validRecord(record)&&paperRecord(record)&&!record.identityConflict);
      const options=[...new Map(candidates.map(record=>[record.id,summary(record)])).values()];
      let status=r?.status||'needs-manual-review',reason=r?.reason||item?.reason||'연결할 공식 서지 레코드를 선택하거나 후보 제외 여부를 검토하세요.';
      const appliedHere=!!importId&&(decision?.importId===importId||review?.bibliographyReview?.importId===importId);
      if(decision||review?.status==='dismissed'){
        status=appliedHere?'applied':'preserved';reason=appliedHere?'사용자 승인 후 적용됨':'기존 연결·분리·논문 검토 결정을 보존합니다.';
      }else if(!item){status='preserved';reason='이미 공식정보에 연결됐거나 현재 검토 대상이 아닙니다.';}
      const selectable=!!item&&!decision&&review?.status!=='dismissed'&&r?.status!=='error'&&r?.status!=='duplicate';
      const allowedActions=selectable?['match','separate',...(review?.status==='confirmed'?[]:['dismiss'])]:[];
      const preferred=options.find(o=>o.recordId===(r?.recordId||r?.verification?.record?.recordId));
      const defaultAction=preferred||options.length===1?'match':r?.decision==='separate'?'separate':'';
      const recordId=preferred?.recordId||(options.length===1?options[0].recordId:null);
      // A token binds the displayed choices, metadata and existing decisions. Mention
      // counts changing alone do not invalidate a review. No private keys leave here.
      const token=reviewSnapshot([candidateId,p.title,p.aliases,p.identifiers,options,decision||null,review||null]);
      rows.push({candidateId,title:p.title,count:p.count||0,status,reason,selectable,allowedActions,token,candidates:options,defaultAction,recordId,
        evidence:r?.evidence||[],verification:r?.verification||null,duplicates:r?.duplicates||0,
        ...(review?.status==='dismissed'?{appliedAction:'dismiss'}:decision?{appliedAction:decision.action}:{}),
        manualConfirmation:selectable&&defaultAction==='match'&&r?.status!=='ready'});
    }
    for(const r of imported?.rows||[])if(!r.candidateId)rows.push({candidateId:'invalid:'+r.index,title:'candidateId 없음',count:0,status:'error',reason:r.reason,selectable:false,token:'',candidates:[],defaultAction:'',recordId:null,evidence:[],verification:null,duplicates:0});
    rows.sort((a,b)=>b.count-a.count||a.candidateId.localeCompare(b.candidateId));
    return {data,ctx,rows,imported};
  }
  view({importId='',status='pending',evidence='',search='',offset=0,limit=50,ids=''}={}){
    offset=Number(offset);limit=Number(limit);
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw fail(400,'올바른 검토 목록 범위를 지정해주세요.','INVALID_RANGE');
    if(!['pending','completed','all','ready','needs-manual-review','preserved','deferred','error','applied','stale'].includes(status))throw fail(400,'올바른 검토 상태를 선택해주세요.','INVALID_FILTER');
    const {rows,imported}=this.#rows(importId),counts={};for(const r of rows)counts[r.status]=(counts[r.status]||0)+1;
    const groups={pending:0,completed:0,error:0};for(const r of rows)groups[reviewStatusGroup(r.status)]++;
    // Internal statuses remain available to existing API callers and saved imports.
    const needle=String(search).trim().toLocaleLowerCase(),filtered=rows.filter(r=>(status==='all'||['pending','completed','error'].includes(status)&&reviewStatusGroup(r.status)===status||r.status===status)&&(!evidence||r.evidence.some(e=>e.type===evidence))&&(!needle||[r.title,r.candidateId,...r.candidates.map(c=>c.title)].some(t=>t.toLocaleLowerCase().includes(needle))));
    return {rows:filtered.slice(offset,offset+limit).map(r=>({...r,statusGroup:reviewStatusGroup(r.status)})),total:filtered.length,counts,groups,offset,limit,running:!!imported?.running,requiresConfirmation:!!imported?.requiresConfirmation,
      ...(ids==='selectable'?{selections:filtered.filter(r=>r.selectable).map(r=>({candidateId:r.candidateId,token:r.token,action:r.defaultAction,recordId:r.recordId}))}:{})};
  }
  apply({importId='',approved=false,confirmSnapshot=false,selections}={}){
    if(approved!==true)throw fail(400,'사용자 최종 승인이 필요합니다.','APPROVAL_REQUIRED');
    if(this.busy())throw fail(409,'공식 조회·검증이 끝난 뒤 적용해주세요.','REVIEW_BUSY');
    if(!Array.isArray(selections)||!selections.length||selections.length>20000||selections.some(s=>!s||typeof s.candidateId!=='string'||!actions.includes(s.action)||typeof s.token!=='string'||s.action==='match'&&typeof s.recordId!=='string')||new Set(selections.map(s=>s.candidateId)).size!==selections.length)throw fail(400,'검토 동작과 논문을 중복 없이 선택해주세요.','INVALID_SELECTION');
    const {data,rows,imported}=this.#rows(importId);
    if(imported?.running)throw fail(409,'가져온 결과 검증이 끝난 뒤 적용해주세요.','REVIEW_BUSY');
    if(imported?.requiresConfirmation&&confirmSnapshot!==true)throw fail(409,'다른 snapshot의 결과임을 확인한 뒤 적용해주세요.','SNAPSHOT_CONFIRMATION_REQUIRED');
    const current=new Map(rows.map(r=>[r.candidateId,r])),valid=[],skipped=[];
    for(const s of selections){
      const row=current.get(s.candidateId);
      const reason=!row?.selectable?'이미 처리됐거나 기존 수동 결정이 있어 보존했습니다.':s.token!==row.token?'미리보기 뒤 후보·공식정보가 바뀌었습니다. 목록을 새로 확인해주세요.':!row.allowedActions.includes(s.action)?'기존에 논문임을 확인한 검토 상태를 보존했습니다.':s.action==='match'&&!row.candidates.some(c=>c.recordId===s.recordId)?'현재 검증된 연결 후보가 아닙니다.':null;
      if(reason)skipped.push({candidateId:s.candidateId,reason});else valid.push({...s,evidence:row.evidence});
    }
    const updatedAt=new Date().toISOString(),meta={decisionSource:'human-review',...(importId?{importId}:{}),updatedAt},written=[];
    try{
      const linking=valid.filter(s=>s.action!=='dismiss');
      if(linking.length){const next={...data.decisions};for(const s of linking)next[s.candidateId]={action:s.action,...(s.action==='match'?{recordId:s.recordId}:{}),evidence:s.evidence,...meta};this.saveDecisions(next);written.push(...linking);}
      const excluding=valid.filter(s=>s.action==='dismiss');
      if(excluding.length){const next={...data.reviews};for(const s of excluding)next[s.candidateId]={...next[s.candidateId],status:'dismissed',bibliographyReview:{action:'dismiss',...meta}};this.saveReviews(next);written.push(...excluding);}
      if(importId&&written.length)this.imports.recordManualApplications(importId,written,updatedAt);
    }catch(e){this.refresh();throw Object.assign(fail(500,`${written.length}건 저장 후 실패했습니다. 저장된 결정은 유지되며 목록을 갱신해 남은 항목을 다시 적용할 수 있습니다.`,'PARTIAL_APPLY'),{details:{applied:written.length}});}
    this.refresh();return {ok:true,applied:written.length,skipped,matched:written.filter(s=>s.action==='match').length,dismissed:written.filter(s=>s.action==='dismiss').length,separated:written.filter(s=>s.action==='separate').length};
  }
}
