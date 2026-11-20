// Durable import jobs for LLM review results.
// An upload of any size becomes a job on disk. Validation runs in small chunks with a checkpoint
// after each one, so a stopped server or a failed provider lookup never discards finished rows.
// Nothing is linked until a person approves selected rows; approval is re-checked against the
// current state row by row instead of expiring the whole preview.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {loadJSON,saveJSON} from './local-store.mjs';
import {paperRecord} from './bibliography-catalog.mjs';
import {validRecord} from './bibliography.mjs';
import {parseReviewUpload,normalizeDecision,planDecision,reviewContext,reviewItemHash,reviewManifest} from './bibliography-review.mjs';
import {verifyProposals} from './review-proposals.mjs';

const now=()=>new Date().toISOString();
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,snapshotPattern=/^[a-f0-9]{64}$/;
const fail=(httpStatus,message,code,details)=>Object.assign(new Error(message),{httpStatus,code,details});
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
export const ROW_STATUSES=['ready','needs-manual-review','preserved','deferred','duplicate','error','applied','stale'];
const countKeys={ready:'ready','needs-manual-review':'needsManualReview',preserved:'preserved',deferred:'deferred',duplicate:'duplicate',error:'error',applied:'applied',stale:'stale'};

export class ReviewImportManager{
  // context() returns the current {raw,store,resolved,decisions}; saveStore/saveDecisions persist and
  // adopt a new value; refresh() re-reconciles after either changed.
  constructor({state,context,saveStore,saveDecisions,refresh=()=>{},syncRunning=()=>false,verify=verifyProposals,lookup={},chunkSize=100,applyChunkSize=200,keep=20,keepExports=12}){
    Object.assign(this,{context,saveStore,saveDecisions,refresh,syncRunning,verify,lookup,chunkSize,applyChunkSize,keep,keepExports});
    this.directory=path.join(state,'review-imports');this.exports=path.join(state,'review-exports');
    this.jobs=new Map();this.manifests=new Map();this.active=null;this.verifying=false;this.cached=null;
    this.#entries();
    // A job left in "validating" by a stopped server continues from its last checkpoint on request.
    for(const entry of this.index.imports)if(entry.status==='validating'){
      const job=this.#read(entry.id);
      if(job&&(job.ownerPid===process.pid||!alive(job.ownerPid)))this.#interrupt(job,'서버가 중단되어 검증이 멈췄습니다. 완료된 결과에서 이어서 검증할 수 있습니다.');
    }
  }

  // ---- storage ----
  // The list of imports is small and re-read before each use: a second server on the same state
  // folder may have added to it.
  #entries(){this.index=loadJSON(this.directory,'index.json',{version:1,imports:[]});return this.index.imports;}
  #dir(id){if(!idPattern.test(String(id)))throw fail(400,'올바른 가져오기 ID가 아닙니다.','INVALID_IMPORT');return path.join(this.directory,id);}
  #read(id){
    if(this.jobs.has(id))return this.jobs.get(id);
    const job=loadJSON(this.#dir(id),'job.json',null);if(!job)return null;
    this.jobs.set(id,job);for(const key of [...this.jobs.keys()].slice(0,-4))if(key!==this.active?.id)this.jobs.delete(key);
    return job;
  }
  #job(id){
    const job=this.#read(id);if(!job||job.status==='discarded')throw fail(404,'가져오기 작업을 찾지 못했습니다. 결과 JSON을 다시 가져와주세요.','IMPORT_NOT_FOUND');
    if(job.status==='validating'&&this.active?.id!==id&&(job.ownerPid===process.pid||!alive(job.ownerPid)))this.#interrupt(job,'검증이 중단되었습니다. 완료된 결과에서 이어서 검증할 수 있습니다.');
    return job;
  }
  #save(job){
    job.updatedAt=now();job.counts=this.#counts(job);saveJSON(this.#dir(job.id),'job.json',job);
    const entry=this.#entries().find(e=>e.id===job.id);
    if(entry)Object.assign(entry,{status:job.status,updatedAt:job.updatedAt,total:job.total,processed:job.processed,applied:job.counts.applied,ready:job.counts.ready});
    saveJSON(this.directory,'index.json',this.index);
  }
  #interrupt(job,message){job.status='interrupted';job.error=message;job.progress=null;this.#save(job);}
  #input(id){const input=loadJSON(this.#dir(id),'input.json',null);if(!input)throw fail(409,'가져온 원본을 찾지 못했습니다. 결과 JSON을 다시 가져와주세요.','IMPORT_INPUT_MISSING');return input;}
  #counts(job){
    const counts=Object.fromEntries(Object.values(countKeys).map(key=>[key,0]));counts.lookupFailed=0;counts.registered=0;
    for(const row of job.rows){counts[countKeys[row.status]]++;if(row.verification?.status==='lookup-failed')counts.lookupFailed++;if(row.verification?.registered)counts.registered++;}
    return counts;
  }
  #remove(id){const target=path.resolve(this.#dir(id));if(target.startsWith(path.resolve(this.directory)+path.sep))fs.rmSync(target,{recursive:true,force:true});this.jobs.delete(id);}
  #prune(){
    const stored=this.index.imports.filter(e=>!e.archived&&e.status!=='discarded');
    for(const entry of stored.slice(0,Math.max(0,stored.length-this.keep))){if(entry.id===this.active?.id)continue;this.#remove(entry.id);entry.archived=true;}
    // Hashes of pruned imports stay listed so the same file is still recognised.
    this.index.imports=this.index.imports.slice(-200);
  }

  // ---- export manifests: what each downloaded review file contained ----
  recordExport(groups,generatedAt){
    const manifest=reviewManifest(groups,generatedAt);
    try{
      fs.mkdirSync(this.exports,{recursive:true});saveJSON(this.exports,manifest.snapshot+'.json',manifest);this.manifests.set(manifest.snapshot,manifest);
      const files=fs.readdirSync(this.exports).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>({name,time:fs.statSync(path.join(this.exports,name)).mtimeMs})).sort((a,b)=>b.time-a.time);
      for(const old of files.slice(this.keepExports))fs.unlinkSync(path.join(this.exports,old.name));
    }catch(e){console.error('검토 내보내기 기록 저장 실패:',e.message);}
    return manifest;
  }
  #manifest(snapshot){
    if(!snapshotPattern.test(String(snapshot)))return null;
    if(!this.manifests.has(snapshot)){const manifest=loadJSON(this.exports,snapshot+'.json',null);if(!manifest)return null;if(this.manifests.size>=8)this.manifests.clear();this.manifests.set(snapshot,manifest);}
    return this.manifests.get(snapshot);
  }

  // ---- create ----
  create(value,{fileName=''}={}){
    const input=parseReviewUpload(value);
    const contentHash=createHash('sha256').update(JSON.stringify([input.parts.map(p=>[p.schemaVersion,p.snapshot]),input.decisions.map(d=>d.value)])).digest('hex');
    const same=this.#entries().findLast(e=>e.contentHash===contentHash&&e.status!=='discarded');
    if(same){
      // The same result file is never imported twice; the earlier job is reopened instead.
      if(same.archived)return {duplicate:true,job:{id:same.id,status:'archived',fileName:same.fileName,createdAt:same.createdAt,updatedAt:same.updatedAt,total:same.total,processed:same.processed,counts:{applied:same.applied||0},rows:[],rowsTotal:0}};
      return {duplicate:true,job:this.view(same.id)};
    }
    if(this.active)throw fail(409,'다른 LLM 검토 결과를 검증하고 있습니다. 끝나거나 중단한 뒤 다시 가져와주세요.','IMPORT_BUSY');
    const ctx=this.#context(),id=randomUUID(),createdAt=now();
    const parts=input.parts.map(part=>{
      let status='none';
      if(part.snapshot){
        // The file being imported right now is the newest export: remember its items for later chunks.
        if(part.snapshot===ctx.snapshot&&!this.#manifest(part.snapshot))this.recordExport(ctx.groups,createdAt);
        status=part.snapshot===ctx.snapshot?'current':this.#manifest(part.snapshot)?'known':'unknown';
      }
      return {...part,status};
    });
    const job={id,status:'validating',createdAt,updatedAt:createdAt,fileName:String(fileName).replace(/[\u0000-\u001f]/g,'').slice(0,200),contentHash,total:input.decisions.length,processed:0,rows:[],parts,warnings:input.warnings.slice(0,20),snapshot:{current:ctx.snapshot,requiresConfirmation:parts.some(p=>p.status==='unknown')},error:null,ownerPid:process.pid,progress:null};
    fs.mkdirSync(this.#dir(id),{recursive:true});
    saveJSON(this.#dir(id),'input.json',{parts,decisions:input.decisions});
    this.index.imports.push({id,contentHash,createdAt,updatedAt:createdAt,fileName:job.fileName,status:job.status,total:job.total,processed:0,applied:0,ready:0});
    saveJSON(this.directory,'index.json',this.index);
    this.jobs.set(id,job);this.#save(job);this.#prune();saveJSON(this.directory,'index.json',this.index);
    this.#start(job);
    return {duplicate:false,job:this.view(id)};
  }

  // ---- validation ----
  // Rebuilt only when the index, lookup cache or decisions were replaced since the last chunk.
  #context(){
    const {raw,store,resolved,decisions}=this.context(),prior=this.cached;
    if(prior&&prior.raw===raw&&prior.store===store&&prior.resolved===resolved&&prior.decisions===decisions)return prior;
    return this.cached={...reviewContext(raw,store,resolved,decisions),raw,resolved};
  }
  #start(job){
    const controller=new AbortController();job.status='validating';job.error=null;job.ownerPid=process.pid;
    const active={id:job.id,controller};this.active=active;
    active.promise=this.#run(job,controller.signal).catch(e=>{
      // The last checkpoint is already on disk; a failure to record the interruption must not escape.
      try{this.#interrupt(job,controller.signal.aborted?'검증을 중단했습니다. 완료된 결과는 보존되며 이어서 검증할 수 있습니다.':`검증 중 오류가 발생했습니다: ${e.message} · 완료된 결과는 보존되며 이어서 검증할 수 있습니다.`);}
      catch(error){console.error('검토 결과 가져오기 상태 저장 실패:',error.message);}
    }).finally(()=>{if(this.active===active)this.active=null;this.verifying=false;});
  }
  async #run(job,signal){
    const input=this.#input(job.id);
    // Rows an earlier run left retryable (failed lookup, state changed since the preview). Rows
    // that fail during this run wait for the next resume instead of being asked again at once.
    const retry=job.rows.filter(row=>row.status==='stale'||row.verification?.status==='lookup-failed').map(row=>row.index);
    this.#save(job);
    while(job.processed<input.decisions.length){
      // Yield first: the upload response is sent before any validation work starts.
      await tick();signal.throwIfAborted();
      const at=job.processed,entries=input.decisions.slice(at,at+this.chunkSize).map((entry,i)=>({...entry,index:at+i}));
      const rows=await this.#validate(job,input,entries,signal);
      // Checkpoint: finished rows and the cursor are saved together.
      job.rows.push(...rows);job.processed=at+entries.length;job.progress=null;this.#save(job);
    }
    // Retried in place; every other finished row is kept as it is.
    for(let at=0;at<retry.length;at+=this.chunkSize){
      await tick();signal.throwIfAborted();
      const rows=await this.#validate(job,input,retry.slice(at,at+this.chunkSize).map(index=>({...input.decisions[index],index})),signal);
      for(const row of rows)job.rows[row.index]=row;
      job.progress=null;this.#save(job);
    }
    job.status=job.rows.some(row=>row.status==='ready')||!job.rows.some(row=>row.status==='applied')?'ready':'completed';job.error=null;job.validatedAt=now();this.#save(job);
  }
  async #validate(job,input,entries,signal){
    let ctx=this.#context();
    const rows=[],lookups=[];
    for(const entry of entries){
      const part=input.parts[entry.part],base={index:entry.index,part:entry.part},parsed=normalizeDecision(entry.value,part.schemaVersion);
      if(parsed.error){rows.push({...base,candidateId:parsed.candidateId,status:'error',reason:parsed.error});continue;}
      const d=parsed.value,row={...base,...d,title:ctx.inputs.get(d.candidateId)?.title||null,recordTitle:null};rows.push(row);
      if(d.proposal)row.proposal={...(d.proposal.doi?{doi:d.proposal.doi}:{}),...(d.proposal.arxiv?{arxiv:d.proposal.arxiv}:{}),...(d.proposal.title?{title:d.proposal.title}:{})};
      if(entry.duplicateOf!==undefined){Object.assign(row,{status:'duplicate',reason:`같은 candidateId가 ${entry.duplicateOf+1}번째 항목에 이미 있습니다. 첫 항목만 검토합니다.`});continue;}
      const paper=ctx.inputs.get(d.candidateId);
      if(!paper){Object.assign(row,{status:'error',reason:'원본 candidateId를 찾지 못했습니다.'});continue;}
      if(entry.conflicting){Object.assign(row,{status:'needs-manual-review',reason:'같은 candidateId에 서로 다른 결정이 여러 번 들어 있습니다.'});continue;}
      const item=ctx.items.get(d.candidateId);
      if(item)row.itemHash=reviewItemHash(item);
      // Compare with what the downloaded file showed for this candidate, not with the whole snapshot.
      if(item&&part.snapshot&&part.status!=='unknown'){
        const exported=this.#manifest(part.snapshot)?.items?.[d.candidateId];
        if(exported===undefined)row.snapshotCheck='not-exported';else if(exported!==row.itemHash)row.snapshotCheck='changed';
      }
      const blocked=ctx.decisions[d.candidateId]||!item||row.snapshotCheck;
      if(d.decision==='propose'&&!blocked)lookups.push({candidateId:d.candidateId,paper,proposal:d.proposal,suggested:new Set(item.candidates.map(c=>c.recordId))});
    }
    let outcomes=new Map();
    if(lookups.length){
      if(this.syncRunning())throw new Error('공식 서지정보 조회가 실행 중입니다. 조회가 끝난 뒤 이어서 검증해주세요.');
      this.verifying=true;
      try{
        outcomes=await this.verify(lookups,{...this.lookup,store:ctx.store,importId:job.id,signal,onSave:store=>this.saveStore(store),onProgress:progress=>{job.progress={stage:'lookup',current:String(progress.current||'').slice(0,200)};}});
      }finally{this.verifying=false;}
      // Looked-up records and registered candidates are saved before the rows that depend on them.
      this.saveStore(ctx.store);this.refresh();this.cached=null;ctx=this.#context();
    }
    for(const row of rows){
      if(row.status)continue;
      const outcome=outcomes.get(row.candidateId),d={candidateId:row.candidateId,decision:row.decision,recordId:row.recordId,evidence:row.evidence,needsManualReview:row.needsManualReview};
      const plan=planDecision(ctx,d,{verified:outcome?.status==='verified'?outcome.recordId:null});
      Object.assign(row,{status:plan.status,reason:plan.reason,title:plan.title??row.title,recordTitle:plan.recordTitle});
      if(outcome){
        row.verification={status:outcome.status,detail:outcome.detail,registered:outcome.register.length>0,...(outcome.record?{record:outcome.record}:{})};
        if(outcome.status==='verified'){row.recordId=plan.targetId;}
        else if(!['preserved','deferred'].includes(row.status)){row.status='needs-manual-review';row.reason=outcome.detail;row.recordTitle=outcome.record?.title||null;}
      }
      if(row.snapshotCheck&&['ready','deferred','needs-manual-review'].includes(row.status)){
        row.status='needs-manual-review';
        row.reason=row.snapshotCheck==='changed'?'검토 JSON을 내려받은 뒤 이 후보의 연결 후보가 바뀌었습니다. 최신 검토 JSON으로 다시 검토해주세요.':'내려받은 검토 JSON에 없던 후보입니다. 최신 검토 JSON으로 다시 검토해주세요.';
      }
      // A proposal is approvable only with a record that a provider lookup confirmed.
      if(row.decision==='propose'&&row.status==='ready'&&outcome?.status!=='verified'){row.status='needs-manual-review';row.reason='제안한 식별자를 공식 조회로 확인하지 못했습니다.';}
    }
    return rows;
  }

  // ---- job control ----
  resume(id){
    const job=this.#job(id);
    if(this.active)throw fail(409,this.active.id===id?'이미 검증하고 있습니다.':'다른 LLM 검토 결과를 검증하고 있습니다.','IMPORT_BUSY');
    this.#start(job);return this.view(id);
  }
  stop(id){
    if(this.active?.id!==id)throw fail(409,'이 서버에서 검증 중인 가져오기가 아닙니다.','IMPORT_NOT_RUNNING');
    this.active.controller.abort(new Error('검증 중단'));return {ok:true};
  }
  discard(id){
    const job=this.#job(id);
    if(this.active?.id===id)throw fail(409,'검증을 먼저 중단해주세요.','IMPORT_BUSY');
    // Approved decisions stay; only the preview and its uploaded copy are removed.
    const entry=this.#entries().find(e=>e.id===id);if(entry)entry.status='discarded';
    job.status='discarded';this.#remove(id);saveJSON(this.directory,'index.json',this.index);return {ok:true};
  }
  idle(){return this.active?.promise||Promise.resolve();}

  // ---- approval ----
  apply(id,{approved,candidateIds,confirmSnapshot}={}){
    const job=this.#job(id);
    if(approved!==true)throw fail(400,'사용자 최종 승인이 필요합니다.','APPROVAL_REQUIRED');
    if(this.active?.id===id)throw fail(409,'검증이 끝나거나 중단된 뒤 적용할 수 있습니다.','IMPORT_BUSY');
    if(!Array.isArray(candidateIds)||!candidateIds.length||candidateIds.some(value=>typeof value!=='string')||new Set(candidateIds).size!==candidateIds.length)throw fail(400,'최종 승인할 candidateId를 중복 없이 선택해주세요.','INVALID_SELECTION');
    if(job.snapshot.requiresConfirmation&&confirmSnapshot!==true)throw fail(409,'이 결과는 현재 서버가 내보낸 기록이 없는 snapshot으로 작성되었습니다. 미리보기를 확인한 뒤 다른 snapshot의 결과임을 확인해주세요.','SNAPSHOT_CONFIRMATION_REQUIRED');
    const rows=new Map(job.rows.filter(row=>['ready','applied'].includes(row.status)).map(row=>[row.candidateId,row]));
    if(candidateIds.some(candidateId=>!rows.has(candidateId)))throw fail(400,'적용할 수 없는 항목이 선택되었습니다. 미리보기를 새로 고친 뒤 다시 선택해주세요.','INVALID_SELECTION');
    const ctx=this.#context(),valid=[],skipped=[];
    for(const candidateId of candidateIds){
      const row=rows.get(candidateId);if(row.status==='applied')continue;
      const existing=ctx.decisions[candidateId];
      // A decision this job already wrote (the job file was not saved afterwards) is simply acknowledged.
      if(existing?.importId===job.id){Object.assign(row,{status:'applied',appliedAt:existing.updatedAt,reason:'최종 승인 후 적용됨'});continue;}
      const reason=this.#recheck(ctx,row,existing);
      if(!reason){valid.push(row);continue;}
      Object.assign(row,{status:existing?'preserved':'stale',reason});skipped.push({candidateId,reason});
    }
    let next=ctx.decisions,applied=0;const updatedAt=now();
    try{
      for(let at=0;at<valid.length;at+=this.applyChunkSize){
        const chunk=valid.slice(at,at+this.applyChunkSize);next={...next};
        for(const row of chunk)next[row.candidateId]={action:row.decision==='separate'?'separate':'match',...(row.decision==='separate'?{}:{recordId:row.recordId}),evidence:row.evidence,decisionSource:'llm-reviewed',...(row.decision==='propose'?{verification:'provider-lookup'}:{}),importId:job.id,updatedAt};
        this.saveDecisions(next);
        // Checkpoint: these rows are recorded as applied before the next chunk is written.
        for(const row of chunk)Object.assign(row,{status:'applied',appliedAt:updatedAt,reason:'최종 승인 후 적용됨'});
        applied+=chunk.length;this.#save(job);
      }
    }catch(e){
      try{this.#save(job);}catch{}
      this.refresh();
      throw fail(500,`${applied.toLocaleString('ko-KR')}건을 적용한 뒤 저장에 실패했습니다: ${e.message} · 적용된 항목은 보존되며 남은 항목은 다시 적용할 수 있습니다.`,'PARTIAL_APPLY',{applied,remaining:valid.length-applied});
    }
    if(job.processed>=job.total&&job.status!=='interrupted'&&!job.rows.some(row=>row.status==='ready'))job.status='completed';
    this.#save(job);this.refresh();
    return {ok:true,applied,skipped,remaining:job.counts.ready};
  }
  // Returns why a previewed row can no longer be applied, or null when it still holds.
  #recheck(ctx,row,existing){
    if(existing)return '미리보기 뒤에 추가된 수동 결정을 보존했습니다.';
    const item=ctx.items.get(row.candidateId);
    if(!item)return '미리보기 뒤에 이미 연결되었거나 검토 대상에서 빠졌습니다.';
    if(reviewItemHash(item)!==row.itemHash)return '미리보기 뒤에 이 후보의 연결 후보가 바뀌었습니다. 다시 검증해주세요.';
    if(row.decision==='separate')return null;
    const target=validRecord(ctx.store.records?.[row.recordId])?ctx.records.get(ctx.catalog.redirects.get(row.recordId)):null;
    if(!target||target.identityConflict||!paperRecord(target)||!item.candidates.some(c=>c.recordId===target.id))return '미리보기 뒤에 서지 레코드가 바뀌었습니다. 다시 검증해주세요.';
    return null;
  }

  // ---- views ----
  // Internal workspace adapter. Original LLM input and evidence remain unchanged.
  reviewState(id){const job=this.#job(id);return {rows:job.rows,running:job.status==='validating',requiresConfirmation:job.snapshot.requiresConfirmation};}
  recordManualApplications(id,selections,updatedAt){
    const job=this.#job(id),byId=new Map(selections.map(s=>[s.candidateId,s]));
    for(const row of job.rows){const s=byId.get(row.candidateId);if(!s||['duplicate','error'].includes(row.status))continue;Object.assign(row,{status:'applied',appliedAction:s.action,appliedRecordId:s.action==='match'?s.recordId:null,appliedAt:updatedAt,reason:'사용자 검토 후 최종 승인됨'});}
    if(job.processed>=job.total&&!job.rows.some(r=>r.status==='ready'))job.status='completed';
    this.#save(job);
  }
  // The newest import, while something is left to do with it: the dialog reopens it after a reload.
  latest(){
    const entry=this.#entries().findLast(e=>!e.archived&&e.status!=='discarded');
    if(!entry||!(this.active?.id===entry.id||['validating','interrupted'].includes(entry.status)||entry.ready>0||this.#job(entry.id).rows.some(r=>['needs-manual-review','stale'].includes(r.status))))return null;
    return {id:entry.id,status:this.active?.id===entry.id?'validating':entry.status,total:entry.total,processed:entry.processed};
  }
  list(){return {imports:this.#entries().filter(e=>e.status!=='discarded').slice(-this.keep).reverse().map(({contentHash,...entry})=>entry),active:this.active?.id||null};}
  view(id,{offset=0,limit=50,status='all',ids=''}={}){
    const job=this.#job(id);
    offset=Number(offset);limit=Number(limit);
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw fail(400,'올바른 목록 범위를 선택해주세요.','INVALID_RANGE');
    if(status!=='all'&&status!=='lookup-failed'&&!ROW_STATUSES.includes(status))throw fail(400,'올바른 상태 필터를 선택해주세요.','INVALID_FILTER');
    const running=this.active?.id===id,filtered=status==='all'?job.rows:job.rows.filter(row=>status==='lookup-failed'?row.verification?.status==='lookup-failed':row.status===status),counts=this.#counts(job);
    return {
      id:job.id,status:job.status,running,fileName:job.fileName,createdAt:job.createdAt,updatedAt:job.updatedAt,total:job.total,processed:job.processed,
      counts,applicable:counts.ready,
      // Finished chunks of an interrupted job can already be approved; the rest can be resumed.
      resumable:!running&&(job.processed<job.total||counts.lookupFailed>0||counts.stale>0),
      snapshot:{...job.snapshot,provided:[...new Set(job.parts.map(p=>p.snapshot).filter(Boolean))],status:job.parts.some(p=>p.status==='unknown')?'unknown':job.parts.some(p=>p.status==='known')?'known':job.parts.some(p=>p.status==='current')?'current':'none',changed:job.rows.filter(row=>row.snapshotCheck).length},
      parts:job.parts.length,warnings:job.warnings,error:job.error,progress:running?job.progress:null,
      filter:status,offset,limit,rowsTotal:filtered.length,rows:filtered.slice(offset,offset+limit).map(({itemHash,...row})=>row),
      ...(ids==='ready'?{readyIds:job.rows.filter(row=>row.status==='ready').map(row=>row.candidateId)}:{})
    };
  }
}
