import path from 'node:path';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadJSON,saveJSON} from './local-store.mjs';
import {pdfDownloadCandidates,matchLibrary,prepareLibrary} from './pdf-library.mjs';
import {specificTitle} from './bibliography-policy.mjs';
import {matchZoteroItem,zoteroKey} from './zotero-sync.mjs';
import {zoteroLibrary} from './zotero-client.mjs';
import {pdfDigests,attachmentFile,scanLocalAPI} from './zotero-pdfs.mjs';

const now=()=>new Date().toISOString(),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const topItems=items=>items.filter(i=>!['attachment','note','annotation'].includes(i.data.itemType));
const success=r=>r?.successful?.['0']||r?.success?.['0']||r?.unchanged?.['0'];
const shownItem=i=>({key:i.key,title:i.data.title||'',doi:i.data.DOI||'',year:i.data.date||''});

export function acquisitionState(media,paper){
  const match=media.match(paper),selected=match.selected,outcome=media.state.outcomes[paper.id]||{},routes=pdfDownloadCandidates(paper);
  const held=outcome.status==='needs-pdf-review'||match.status==='needs-review';
  const inZotero=selected?.exists&&(selected.source==='zotero'||selected.hash&&media.records.some(r=>r.source==='zotero'&&r.exists&&r.hash===selected.hash));
  let status=inZotero?'available_in_zotero':selected?.exists?'downloaded_locally':held?'needs_identity_review':outcome.status==='needs-browser'?'needs_browser':outcome.cause==='not-found'&&outcome.attempts?.every(a=>a.cause==='not-found')?'unavailable':routes.length?'download_available':'needs_manual_upload';
  if(outcome.status==='rate-limited'&&!selected?.exists)status='download_available';
  return {status,hasPdf:!!selected?.exists,reason:outcome.error||(!selected?match.reason:null),cause:outcome.cause,httpStatus:outcome.httpStatus,retryAt:outcome.retryAt,attempts:outcome.attempts||[],routes,pdfId:selected?.id,pdfHash:selected?.hash};
}

export class PdfAcquisition{
  constructor({state,media,client,getIndex}){this.directory=state;this.media=media;this.client=client;this.getIndex=getIndex;this.plans=new Map();this.uploadPlans=new Map();this.controller=null;}
  read(){return loadJSON(this.directory,'pdf-acquisition.json',{schemaVersion:1,servers:{}});}
  save(value){saveJSON(this.directory,'pdf-acquisition.json',value);}
  job(){const job=loadJSON(this.directory,'pdf-acquisition-job.json',{running:false});return job.running&&!alive(job.ownerPid)?{...job,running:false,status:'interrupted',error:'중단된 작업입니다. 다시 확인·미리보기 후 같은 첨부파일에서 재개하세요.'}:job;}
  guard(){const job=this.job();if(this.controller||job.running||this.media.controller)throw new Error('PDF 수집·저장 작업이 실행 중입니다. 완료 또는 중단 후 다시 시도해주세요.');this.media.guardWrite();}
  progress(update){this.currentJob={...this.currentJob,...update};saveJSON(this.directory,'pdf-acquisition-job.json',this.currentJob);}
  start(kind,paper,work){
    this.guard();this.controller=new AbortController();const signal=this.controller.signal;
    this.currentJob={running:true,ownerPid:process.pid,kind,paperId:paper.id,status:'running',stage:'starting',startedAt:now()};this.progress({});
    this.promise=(async()=>{let followup;try{followup=await work(signal);this.progress({status:'complete',result:followup});}catch(e){this.progress({status:signal.aborted?'interrupted':'error',error:e.message,code:e.code});}finally{this.controller=null;this.progress({running:false,finishedAt:now()});}
      if(followup?.linkPdfId){this.media.choosePdf(paper,followup.linkPdfId);}
      if(followup?.extract&&this.media.match(paper).status==='matched'&&this.media.allowedHash(this.media.match(paper).selected?.hash))try{this.media.start({mode:'paper',paperId:paper.id,limit:1});}catch(e){this.progress({warning:e.message});}
    })().catch(e=>this.progress({running:false,status:'error',error:e.message}));return this.currentJob;
  }
  stop(){if(!this.controller)throw new Error('이 서버에서 실행 중인 PDF 저장 작업이 없습니다.');this.controller.abort(new Error('사용자가 중단했습니다. 저장된 단계에서 재개할 수 있습니다.'));}
  queue({projectId='',missingOnly=true,status='',sort='count',offset=0,limit=40}={}){
    this.media.refresh();const index=this.getIndex(),conversations=new Map(index.conversations.map(c=>[c.id,c])),projects=new Map();
    for(const m of index.mentions){const project=conversations.get(m.conversationId)?.projectId;if(project)(projects.get(m.paperId)||projects.set(m.paperId,new Set()).get(m.paperId)).add(project);}
    let rows=index.papers.filter(p=>p.status!=='dismissed'&&(!projectId||projects.get(p.id)?.has(projectId))).map(p=>({paperId:p.id,title:p.title,count:p.count||0,userCount:p.userCount||0,projectIds:[...(projects.get(p.id)||[])],...acquisitionState(this.media,p)}));
    const totals={};for(const row of rows)totals[row.status]=(totals[row.status]||0)+1;
    rows=rows.filter(r=>(!missingOnly||!r.hasPdf)&&(!status||r.status===status));rows.sort((a,b)=>(b[sort==='userCount'?'userCount':'count']-a[sort==='userCount'?'userCount':'count'])||a.paperId.localeCompare(b.paperId));
    return {rows:rows.slice(offset,offset+limit),total:rows.length,totals,paperIds:rows.map(r=>r.paperId),projects:index.projects,job:this.job(),mediaJob:this.media.overview().job,testMode:this.media.testScope.enabled,filters:{projectId,missingOnly,status,sort}};
  }
  collect({projectId='',status='',sort='count',limit=10,paperId,resume=false}={}){
    this.guard();let paperIds,mode=paperId?'acquire':'all';if(resume){const previous=loadJSON(this.media.directory,'job.json',{});if(!['acquire','all'].includes(previous.mode))throw new Error('이어서 실행할 자동 수집 작업이 없습니다.');paperIds=previous.paperIds;paperId=previous.paperId;sort=previous.sort;limit=previous.limit||limit;mode=previous.mode;}
    else if(!paperId)paperIds=this.queue({projectId,status,sort,missingOnly:true,limit:1}).paperIds;
    if(paperIds&&!paperIds.length)throw new Error('선택한 범위에 PDF 미확보 논문이 없습니다.');
    return this.media.start({mode,paperId,paperIds,sort,limit});
  }
  async stageUpload(paper,buffer,filename){
    this.guard();const staged=await this.media.importPdf(paper,buffer,{filename,stageOnly:true}),planId=randomUUID();this.uploadPlans.set(planId,{...staged,paperId:paper.id,expires:Date.now()+30*60000});while(this.uploadPlans.size>30)this.uploadPlans.delete(this.uploadPlans.keys().next().value);if(this.media.match(paper).status!=='matched'){this.media.state.outcomes[paper.id]={status:'needs-pdf-review',pdfId:staged.pdfId,error:staged.validation.conflict?'업로드한 PDF 식별자가 충돌합니다. 올바른 논문 PDF가 필요합니다.':'업로드한 PDF의 식별 결과를 확인하고 연결을 승인해주세요.',updatedAt:now()};this.media.save();}return {...staged,planId,connected:false};
  }
  async confirmUpload(paper,{planId,approved=false,identityConfirmed=false,extract=true}={}){
    this.guard();const plan=this.uploadPlans.get(planId);if(!plan||plan.paperId!==paper.id||plan.expires<Date.now())throw new Error('PDF를 다시 업로드해 식별 결과를 확인해주세요.');
    if(!approved||!plan.validation.ok&&!identityConfirmed)throw new Error('원문 식별 결과를 확인한 뒤 연결을 승인해주세요.');
    if(plan.validation.conflict)throw new Error('PDF의 명시적 식별자가 충돌합니다. 올바른 논문 PDF를 선택해주세요.');
    const record=this.media.state.pdfs[plan.pdfId];if(!record||(await pdfDigests(record.path)).sha256!==plan.pdfHash)throw new Error('업로드한 PDF가 변경됐습니다.');
    if(record.pendingIdentity){Object.assign(record,{pendingIdentity:false,title:paper.canonicalTitle||paper.title,identifiers:paper.identifiers||[],validation:{...plan.validation,userConfirmed:true}});this.media.refreshRecords();this.media.save();}
    this.media.state.outcomes[paper.id]={status:'available',pdfId:plan.pdfId,updatedAt:now()};this.media.save();const result=this.media.choosePdf(paper,plan.pdfId);this.uploadPlans.delete(planId);
    if(extract)this.media.start({mode:'paper',paperId:paper.id,limit:1});return result;
  }
  async refreshLibrary(paper,library,signal){
    const result=await scanLocalAPI(this.media,this.client,library,signal),candidates=matchLibrary(paper,prepareLibrary(result.records)).candidates;
    for(const candidate of candidates.filter(r=>r.exists)){signal?.throwIfAborted();await this.media.ensureHash(this.media.library.records.find(r=>r.id===candidate.id));}
    this.media.refreshRecords();return result;
  }
  recheck(paper,{library='users/0',extract=true}={}){zoteroLibrary(library);return this.start('zotero-recheck',paper,async signal=>{const result=await this.refreshLibrary(paper,library,signal),records=prepareLibrary(topItems(result.items).map(i=>({id:i.key,itemKey:i.key,title:i.data.title||'',doi:i.data.DOI,extra:i.data.extra,url:i.data.url,exists:true}))),possible=matchLibrary({...paper,itemKey:undefined,pdfKey:undefined},records).candidates,duplicates=possible.length>1?possible.map(r=>shownItem(result.items.find(i=>i.key===r.itemKey))):[];return {match:this.media.detail(paper).match,duplicates,acquisition:acquisitionState(this.media,paper),extract};});}
  async localPDF(paper){
    this.media.refresh();const match=this.media.match(paper),record=match.selected;
    if(match.status!=='matched'||!record?.exists||record.pendingIdentity)throw new Error('먼저 이 논문의 PDF를 검증하고 연결해주세요.');
    const digest=await pdfDigests(record.path);this.media.assertTestScope(digest.sha256);return {record,...digest};
  }
  partition(data,serverId,library){data.servers[serverId]??={libraries:{}};return data.servers[serverId].libraries[library]??={uploads:{},parents:{}};}
  async existingFiles(library,itemKey,pdf){
    const children=await this.client.get(`${library}/items/${itemKey}/children`),files=[];
    for(const child of children.filter(i=>i.data.itemType==='attachment'&&i.data.contentType==='application/pdf')){
      let filename=null,digest=null;if(['imported_file','imported_url'].includes(child.data.linkMode))filename=await attachmentFile(this.client,library,child.key,this.media.zoteroRoot);
      if(filename)digest=await pdfDigests(filename);
      files.push({key:child.key,title:child.data.title||'',sha256:digest?.sha256||null,samePDF:digest?.sha256===pdf.sha256,potentialDuplicate:!digest&&child.data.md5===pdf.md5});
    }return files;
  }
  async preview(paper,{library='users/0',itemKey,createItem=false}={}){
    this.guard();zoteroLibrary(library);const connection=await this.client.probe(),pdf=await this.localPDF(paper),items=await this.client.get(library+'/items'),data=this.read(),partition=this.partition(data,connection.serverId,library),matched=matchZoteroItem(paper,items,this.media);
    if(itemKey&&!/^[A-Z0-9]{8}$/.test(itemKey))throw new Error('올바른 기존 Zotero 항목을 선택해주세요.');
    if(itemKey&&paper.itemKey&&paper.itemKey!==itemKey)throw new Error('기존 수동 Zotero 연결과 충돌합니다. 논문 상세에서 연결을 먼저 확인해주세요.');
    let parent=topItems(items).find(i=>i.key===(itemKey||matched.itemKey)),newItem=null;
    if(itemKey&&!parent)throw new Error('선택한 Zotero 논문 항목이 없습니다. 기존 항목 목록을 다시 확인해주세요.');
    if(!parent&&createItem){
      if(!paper.metadata||!specificTitle(paper.metadata.title)||!paper.metadata.identifiers?.some(i=>['doi','arxiv'].includes(i.kind)))throw new Error('검증된 정식 제목과 DOI/arXiv 서지정보가 있어야 새 항목을 만들 수 있습니다.');
      if(matched.status==='needs-review'&&matched.candidates?.length)throw new Error('Zotero 중복·충돌 후보를 먼저 검토해주세요.');
      const reserved=partition.parents[paper.id];const doi=paper.metadata.identifiers.find(i=>i.kind==='doi'),arxiv=paper.metadata.identifiers.find(i=>i.kind==='arxiv');
      newItem={key:reserved||zoteroKey(),version:0,itemType:'journalArticle',title:paper.metadata.title,creators:(paper.metadata.authors||[]).map(a=>({creatorType:'author',name:typeof a==='string'?a:a.name||[a.given,a.family].filter(Boolean).join(' ')})),date:String(paper.metadata.year||''),DOI:doi?.value||'',url:doi?.url||arxiv?.url||'',extra:arxiv?'arXiv: '+arxiv.value:'',tags:[],collections:[],relations:{}};parent={key:newItem.key,data:newItem};
    }
    const choices=topItems(items).map(shownItem);if(!parent)return {needsItemSelection:true,reason:matched.reason,choices,canCreate:!!paper.metadata?.identifiers?.some(i=>['doi','arxiv'].includes(i.kind)),writes:0};
    const existing=newItem?[]:await this.existingFiles(library,parent.key,pdf),already=existing.find(f=>f.samePDF),blocked=existing.some(f=>f.potentialDuplicate)?'동일한 MD5의 기존 첨부파일을 읽지 못했습니다. Zotero에서 파일을 내려받은 뒤 재확인해주세요.':null;
    const slot=hash([paper.id,pdf.sha256,parent.key]),prior=partition.uploads[slot];
    const plan={paperId:paper.id,serverId:connection.serverId,library,parent:shownItem(parent),newItem,pdfHash:pdf.sha256,pdfId:pdf.record.id,filename:pdf.record.attachmentTitle||'researchscape.pdf',size:pdf.size,slot,attachmentKey:already?.key||prior?.attachmentKey||zoteroKey(),existing,action:already?'already_saved':'attach',blocked,parentStamp:hash(parent.data),createdAt:now()},planId=randomUUID();
    this.plans.set(planId,{plan,expires:Date.now()+10*60000});while(this.plans.size>20)this.plans.delete(this.plans.keys().next().value);return {...plan,planId,writes:0};
  }
  apply(paper,{planId,approved=false,extract=true}={}){
    const entry=this.plans.get(planId);if(!approved||!entry||entry.expires<Date.now()||entry.plan.paperId!==paper.id)throw new Error('Zotero 저장 미리보기를 확인하고 최종 승인해주세요.');
    if(entry.plan.blocked)throw new Error(entry.plan.blocked);const plan=entry.plan;
    return this.start('zotero-upload',paper,async signal=>{
      const connection=await this.client.probe(),pdf=await this.localPDF(paper);if(connection.serverId!==plan.serverId||pdf.sha256!==plan.pdfHash)throw new Error('Zotero 서버 또는 PDF가 변경됐습니다. 다시 미리보기해주세요.');
      if(paper.itemKey&&paper.itemKey!==plan.parent.key)throw new Error('수동 Zotero 연결이 변경됐습니다. 다시 미리보기해주세요.');
      const data=this.read(),partition=this.partition(data,plan.serverId,plan.library),target=`${plan.library}/items/${plan.parent.key}`;
      let parent;try{parent=await this.client.get(target);}catch(e){if(e.httpStatus!==404)throw e;}
      if(!parent&&!plan.newItem)throw new Error('대상 Zotero 논문 항목이 삭제됐습니다.');
      if(parent&&hash(parent.data)!==plan.parentStamp)throw new Error('대상 Zotero 항목이 변경됐습니다. 다시 미리보기해주세요.');
      if(!parent){partition.parents[paper.id]=plan.parent.key;this.save(data);this.progress({stage:'creating-item'});const result=await this.client.write(plan.library+'/items','POST',[plan.newItem],{'Zotero-Write-Token':randomBytes(16).toString('hex')},signal);if(!success(result))throw new Error('새 Zotero 항목 생성 결과를 확인하지 못했습니다.');}
      const existing=await this.existingFiles(plan.library,plan.parent.key,pdf),same=existing.find(f=>f.samePDF);if(existing.some(f=>f.potentialDuplicate))throw new Error('기존 PDF 파일의 중복 여부를 확인하지 못했습니다. Zotero에서 재확인해주세요.');
      let attachmentKey=same?.key;
      if(!attachmentKey){
        const pending=partition.uploads[plan.slot];attachmentKey=pending?.attachmentKey||plan.attachmentKey;
        partition.uploads[plan.slot]={paperId:paper.id,pdfHash:pdf.sha256,itemKey:plan.parent.key,attachmentKey,status:'pending',updatedAt:now()};this.save(data);
        const route=`${plan.library}/items/${attachmentKey}`,marker='Researchscape PDF '+pdf.sha256;let remote;try{remote=await this.client.get(route);}catch(e){if(e.httpStatus!==404)throw e;}
        if(remote&&(!pending||remote.data.itemType!=='attachment'||remote.data.parentItem!==plan.parent.key||!remote.data.note?.includes(marker)))throw new Error('예약된 첨부파일 Key가 다른 항목과 충돌합니다. 기존 파일을 변경하지 않습니다.');
        if(!remote){this.progress({stage:'creating-attachment'});const result=await this.client.write(plan.library+'/items','POST',[{key:attachmentKey,version:0,itemType:'attachment',parentItem:plan.parent.key,linkMode:'imported_file',title:'Researchscape PDF',contentType:'application/pdf',filename:'researchscape.pdf',note:marker,tags:[],relations:{}}],{'Zotero-Write-Token':randomBytes(16).toString('hex')},signal);if(!success(result))throw new Error('PDF 자식 첨부파일 생성 결과를 확인하지 못했습니다.');}
        this.progress({stage:'upload-authorization'});const fileRoute=route+'/file',headers={'If-None-Match':'*'},authorization=await this.client.form(fileRoute,{md5:pdf.md5,filename:'researchscape.pdf',filesize:String(pdf.size),mtime:String(pdf.mtime)},headers,signal);
        if(!authorization.exists){
          if(!authorization.uploadKey||authorization.prefix||authorization.suffix)throw new Error('지원되지 않는 Zotero 로컬 업로드 응답입니다. Connector 또는 수동 첨부를 이용해주세요.');
          this.progress({stage:'uploading'});await this.client.uploadFile(authorization.url,pdf.bytes,authorization.contentType,signal);
          this.progress({stage:'registering'});await this.client.form(fileRoute,{upload:authorization.uploadKey},headers,signal);
        }
      }
      signal.throwIfAborted();this.progress({stage:'verifying'});
      const written=await this.client.get(`${plan.library}/items/${attachmentKey}`),filename=await attachmentFile(this.client,plan.library,attachmentKey,this.media.zoteroRoot);
      if(written.data.parentItem!==plan.parent.key||!filename||(await pdfDigests(filename)).sha256!==pdf.sha256)throw new Error('Zotero에 저장된 PDF의 SHA-256을 확인하지 못했습니다. 원본은 보존됐으며 다시 확인할 수 있습니다.');
      partition.uploads[plan.slot]={...partition.uploads[plan.slot],paperId:paper.id,pdfHash:pdf.sha256,itemKey:plan.parent.key,attachmentKey,status:'complete',updatedAt:now()};this.save(data);
      await this.refreshLibrary(paper,plan.library,signal);const record=this.media.library.records.find(r=>r.attachmentKey===attachmentKey&&r.apiLibrary===plan.library);if(record){await this.media.ensureHash(record);this.media.refreshRecords();}
      this.plans.delete(planId);return {itemKey:plan.parent.key,attachmentKey,pdfHash:pdf.sha256,alreadySaved:!!same,linkPdfId:record?.id,extract};
    });
  }
}
