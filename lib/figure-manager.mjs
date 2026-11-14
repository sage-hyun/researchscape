import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {loadJSON,saveJSON,storeVersion} from './local-store.mjs';
import {pythonWorker} from './python-worker.mjs';
import {prepareLibrary,matchLibrary,paperKeys,pdfDownloadCandidates,verifyPdfIdentity} from './pdf-library.mjs';
import {downloadPdf} from './pdf-download.mjs';
import {specificTitle,blockedCandidate} from './bibliography-policy.mjs';

const now=()=>new Date().toISOString();
export const FIGURE_SCHEMA_VERSION=2;
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const fileHash=async filename=>{const hash=createHash('sha256');for await(const chunk of fs.createReadStream(filename))hash.update(chunk);return hash.digest('hex');};
const exposedPdf=r=>r?{id:r.id,title:r.title,filename:path.basename(r.path||''),source:r.source,exists:r.exists,itemKey:r.itemKey,attachmentKey:r.attachmentKey}:null;
const blankState=()=>({pdfs:{},pdfChoices:{},figureChoices:{},artifacts:{},customFigures:{},outcomes:{},pdfOutcomes:{},settings:{},downloadCooldowns:{}});

export class FigureManager{
  constructor({root,state,getPapers,worker=pythonWorker,downloader=downloadPdf}){
    this.root=root;this.directory=path.join(state,'media');this.getPapers=getPapers;this.worker=worker;this.downloader=downloader;
    fs.mkdirSync(this.directory,{recursive:true});
    this.state={...blankState(),...loadJSON(this.directory,'state.json',{})};
    this.library=loadJSON(this.directory,'zotero.json',{records:[],available:0,total:0});
    this.testScope=loadJSON(this.directory,'test-scope.json',{enabled:false,pdfHashes:[],items:[]});
    this.job=loadJSON(this.directory,'job.json',{running:false});this.controller=null;this.stamp='';this.hostRequests=new Map();this.refreshRecords();
  }
  refreshRecords(){this.records=prepareLibrary([...this.library.records,...Object.values(this.state.pdfs)]);this.matchCache=new Map();}
  guardWrite(){const job=loadJSON(this.directory,'job.json',{});if(job.running&&job.ownerPid!==process.pid&&alive(job.ownerPid))throw new Error('PDF 작업을 실행 중인 서버에서 변경하거나 작업 완료 후 다시 시도해주세요.');}
  diskStamp(){return ['state.json','zotero.json','test-scope.json'].map(n=>storeVersion(this.directory,n)).join('|');}
  refresh(){const stamp=this.diskStamp();if(stamp!==this.stamp&&!this.controller){this.state={...blankState(),...loadJSON(this.directory,'state.json',{})};this.library=loadJSON(this.directory,'zotero.json',this.library);this.testScope=loadJSON(this.directory,'test-scope.json',this.testScope);this.refreshRecords();this.stamp=stamp;}}
  save(){saveJSON(this.directory,'state.json',this.state);this.stamp=this.diskStamp();}
  allowedHash(hash){return !this.testScope.enabled||this.testScope.pdfHashes.includes(hash);}
  assertTestScope(hash){if(!this.allowedHash(hash))throw new Error('현재 선택한 10편의 PDF만 시험하고 있습니다. 시험 대상 PDF를 선택해주세요.');}
  get zoteroRoot(){return this.state.settings.zoteroRoot||process.env.RESEARCHSCAPE_ZOTERO_DIR||path.join(os.homedir(),'Zotero');}
  match(p){const key=JSON.stringify([p.id,p.title,p.canonicalTitle,p.aliases,p.identifiers,p.itemKey,p.pdfKey,p.memberIds]);if(!this.matchCache.has(key))this.matchCache.set(key,matchLibrary(p,this.records,this.state.pdfChoices));return this.matchCache.get(key);}
  figures(hash){const artifact=this.state.artifacts[hash];return [...(artifact?.figures||[]),...(this.state.customFigures[hash]||[])];}
  selectedFigure(p,hash){
    const choices=[...new Map(paperKeys(p).map(key=>this.state.figureChoices[key]).filter(c=>c?.pdfHash===hash&&c.mode==='manual').map(c=>[c.figureId,c])).values()];
    const figures=this.figures(hash),valid=choices.filter(c=>figures.some(f=>f.id===c.figureId));
    if(valid.length>1)return {conflict:true,mode:'manual'};
    if(valid.length===1)return {...valid[0],figure:figures.find(f=>f.id===valid[0].figureId)};
    // A saved manual choice is retained even if a later parser version misses that region.
    if(choices.length)return {missing:true,mode:'manual',figureId:choices[0].figureId};
    const figure=figures.find(f=>f.id===this.state.artifacts[hash]?.defaultFigureId);return {mode:'auto',figure};
  }
  imageUrl(hash,id){return '/api/media/image?'+new URLSearchParams({pdf:hash,figure:id,v:String(this.state.artifacts[hash]?.extractedAt||this.state.artifacts[hash]?.version||1)});}
  artifactReady(hash){
    const artifact=this.state.artifacts[hash];
    return artifact?.version===FIGURE_SCHEMA_VERSION&&artifact.figures?.length>0&&artifact.figures.every(f=>/^[a-zA-Z0-9_.-]+\.webp$/.test(f.file)&&fs.existsSync(path.join(this.directory,'figures',hash,f.file)));
  }
  libraryStats(){
    const records=this.records.filter(r=>r.source==='zotero'&&r.exists),ready=records.filter(r=>r.hash&&this.artifactReady(r.hash));
    const failures=records.filter(r=>this.state.pdfOutcomes[r.id]?.status==='processing-failed');
    return {figureReady:ready.length,figurePending:records.length-ready.length,uniqueReady:new Set(ready.map(r=>r.hash)).size,failureCount:failures.length,failures:failures.slice(0,100).map(r=>({id:r.id,title:r.title,filename:path.basename(r.path||''),error:this.state.pdfOutcomes[r.id].error}))};
  }
  summary(p){
    const match=this.match(p),pdf=match.selected,hash=pdf?.hash,allowed=this.allowedHash(hash),artifact=allowed?this.state.artifacts[hash]:null,selected=hash&&allowed?this.selectedFigure(p,hash):null;
    return {status:pdf&&!allowed?'outside-pilot':artifact?.version===FIGURE_SCHEMA_VERSION?'ready':match.status==='matched'?'available':match.status,pdfId:pdf?.id,pdfSource:pdf?.source,figureCount:artifact?this.figures(hash).filter(f=>f.kind!=='page').length:0,thumbnail: selected?.figure?{url:this.imageUrl(hash,selected.figure.id),figureId:selected.figure.id,number:selected.figure.number,kind:selected.figure.kind,mode:selected.mode,needsReview:selected.figure.needsReview}:null,selectionConflict:!!selected?.conflict,selectionMissing:!!selected?.missing,testMode:this.testScope.enabled};
  }
  detail(p){
    this.refresh();const match=this.match(p),pdf=match.selected,hash=pdf?.hash,allowed=this.allowedHash(hash),artifact=allowed?this.state.artifacts[hash]:null,outcome=this.state.outcomes[p.id];
    if(outcome?.status==='needs-pdf-review'){const downloaded=this.records.find(r=>r.id===outcome.pdfId);if(downloaded&&!match.candidates.some(r=>r.id===downloaded.id))match.candidates=[downloaded,...match.candidates];}
    return {paperId:p.id,...this.summary(p),match:{status:match.status,reason:match.reason,mode:match.mode,candidates:match.candidates.map(exposedPdf)},pdf:exposedPdf(pdf),pdfHash:hash,pages:artifact?.pages||0,figures:hash&&allowed?this.figures(hash).map(f=>({...f,url:this.imageUrl(hash,f.id)})):[],selection:hash&&allowed?this.selectedFigure(p,hash):null,downloadCandidates:pdfDownloadCandidates(p),outcome:this.state.outcomes[p.id]||null};
  }
  overview(){
    this.refresh();let job=this.controller?this.job:loadJSON(this.directory,'job.json',this.job);if(job.running&&!alive(job.ownerPid))job={...job,running:false,stage:'interrupted',error:'앞선 PDF 작업이 중단됐습니다. 완료된 추출 결과에서 이어갈 수 있습니다.'};
    const papers=this.getPapers(),summary={ready:0,available:0,missing:0,review:0},queue=[];
    for(const p of papers){if(p.status==='dismissed')continue;const m=this.summary(p),outcome=this.state.outcomes[p.id];if(m.status==='ready')summary.ready++;else if(m.status==='available')summary.available++;else if(m.status==='needs-review')summary.review++;else summary.missing++;
      if(!p.metadata&&!p.identifiers?.length&&p.status!=='confirmed'&&!specificTitle(p.title)&&!['ready','available','needs-review'].includes(m.status)||blockedCandidate(p.title)&&p.status!=='confirmed'&&m.status==='missing')continue;
      if(m.status!=='ready'||m.selectionConflict||m.selectionMissing)queue.push({paperId:p.id,title:p.title,count:p.count,status:outcome?.status||m.status,reason:outcome?.error||this.match(p).reason,url:outcome?.url||pdfDownloadCandidates(p)[0]?.url,retryAt:outcome?.retryAt,hasDownloadLink:pdfDownloadCandidates(p).length>0});
    }
    return {job,summary,queue:this.testScope.enabled?[]:queue.sort((a,b)=>b.count-a.count),testScope:{...this.testScope,items:(this.testScope.items||[]).map(p=>({...p,figures:this.state.artifacts[p.pdfHash]?.figures.filter(f=>f.kind==='figure').length||0})),ready:(this.testScope.pdfHashes||[]).filter(h=>this.state.artifacts[h]?.version===FIGURE_SCHEMA_VERSION).length},zotero:{root:this.zoteroRoot,available:this.library.available,total:this.library.total,scannedAt:this.library.scannedAt,snapshotMode:this.library.snapshotMode,...this.libraryStats()},downloaded:Object.keys(this.state.pdfs).length};
  }
  async scanZotero(root=this.zoteroRoot,signal){
    const result=await this.worker(this.root,'zotero-library.py',['--root',path.resolve(root),'--cache',path.join(this.directory,'cache')],{signal,timeout:30000});
    const old=new Map(this.library.records.map(r=>[r.id,r]));
    result.records=result.records.map(r=>{const prior=old.get(r.id);return {...r,...(prior&&prior.mtime===r.mtime&&prior.size===r.size?{hash:prior.hash,hashStamp:prior.hashStamp}:{})};});
    this.library={...result,scannedAt:now()};this.state.settings.zoteroRoot=path.resolve(root);saveJSON(this.directory,'zotero.json',this.library);this.refreshRecords();this.save();return result;
  }
  async ensureHash(pdf){
    const stat=await fsp.stat(pdf.path);if(!stat.isFile()||stat.size>100*1024*1024)throw new Error('PDF 파일이 없거나 100MB를 초과합니다.');
    const stamp=`${stat.size}:${stat.mtimeMs}`;if(pdf.hash&&pdf.hashStamp===stamp)return pdf.hash;
    const digest=await fileHash(pdf.path);pdf.hash=digest;pdf.hashStamp=stamp;
    const entry=this.library.records.find(r=>r.id===pdf.id)||this.state.pdfs[pdf.id];if(entry){entry.hash=digest;entry.hashStamp=stamp;}
    saveJSON(this.directory,'zotero.json',this.library);this.save();return digest;
  }
  async extract(p,{force=false,signal}={}){
    const match=this.match(p);if(match.status!=='matched')throw new Error('먼저 사용할 PDF를 선택해주세요.');
    const result=await this.extractPdf(match.selected,{force,signal});
    this.state.outcomes[p.id]={status:'ready',pdfId:match.selected.id,updatedAt:now()};this.save();return result;
  }
  async extractPdf(pdf,{force=false,signal}={}){
    signal?.throwIfAborted();this.assertTestScope(pdf.hash);const hash=await this.ensureHash(pdf);signal?.throwIfAborted();this.assertTestScope(hash);const output=path.join(this.directory,'figures',hash);
    if(this.artifactReady(hash)&&!force)return {...this.state.artifacts[hash],cached:true};
    const result=await this.worker(this.root,'extract-figures.py',['extract','--pdf',pdf.path,'--output',output,...(force?['--force']:[])],{signal,timeout:180000});
    if(result.pdfHash!==hash)throw new Error('처리 중 PDF가 변경됐습니다. 다시 시도해주세요.');
    this.state.artifacts[hash]=result;this.save();return result;
  }
  choosePdf(p,pdfId){this.guardWrite();this.refresh();const pdf=this.records.find(r=>r.id===pdfId);if(!pdf?.exists)throw new Error('로컬 PDF 목록에서 파일을 선택해주세요.');this.state.pdfChoices[p.id]={pdfId,mode:'manual',updatedAt:now()};this.matchCache.clear();this.save();return this.detail(p);}
  resetPdf(p){this.guardWrite();this.refresh();for(const key of paperKeys(p))delete this.state.pdfChoices[key];this.matchCache.clear();this.save();return this.detail(p);}
  chooseFigure(p,figureId,{auto=false}={}){
    this.guardWrite();this.refresh();const match=this.match(p),hash=match.selected?.hash;if(!hash||!this.state.artifacts[hash])throw new Error('먼저 Figure를 추출해주세요.');
    this.assertTestScope(hash);
    if(auto){for(const key of paperKeys(p))delete this.state.figureChoices[key];}
    else {if(!this.figures(hash).some(f=>f.id===figureId))throw new Error('Figure를 찾지 못했습니다.');for(const key of paperKeys(p))delete this.state.figureChoices[key];this.state.figureChoices[p.id]={pdfHash:hash,figureId,mode:'manual',updatedAt:now()};}
    this.save();return this.detail(p);
  }
  imagePath(hash,figureId){
    this.refresh();if(!/^[a-f0-9]{64}$/.test(hash||'')||!this.allowedHash(hash))return null;
    const figure=this.figures(hash).find(f=>f.id===figureId);if(!figure||!/^[a-zA-Z0-9_.-]+\.webp$/.test(figure.file))return null;
    const file=path.join(this.directory,'figures',hash,figure.file);return fs.existsSync(file)?file:null;
  }
  async page(p,page,signal){
    const match=this.match(p),pdf=match.selected;if(!pdf||!Number.isInteger(page)||page<1)throw new Error('PDF와 페이지를 확인해주세요.');
    this.assertTestScope(pdf.hash);const hash=await this.ensureHash(pdf);this.assertTestScope(hash);const artifact=this.state.artifacts[hash];if(!artifact||page>artifact.pages)throw new Error('먼저 Figure를 추출해주세요.');
    const directory=path.join(this.directory,'figures',hash),file=path.join(directory,`page-preview-${page}.webp`);
    if(!fs.existsSync(file))await this.worker(this.root,'extract-figures.py',['render','--pdf',pdf.path,'--page',String(page),'--output',file],{signal});return file;
  }
  async crop(p,{page,rect},signal){
    this.guardWrite();
    if(!Array.isArray(rect)||rect.length!==4||!rect.every(v=>Number.isFinite(v)&&v>=0&&v<=1)||rect[2]-rect[0]<.01||rect[3]-rect[1]<.01)throw new Error('페이지 안에서 Figure 영역을 드래그해주세요.');
    const pdf=this.match(p).selected,hash=pdf?.hash,artifact=this.state.artifacts[hash],size=artifact?.pageSizes?.[page-1];
    this.assertTestScope(hash);
    if(!pdf||!Number.isInteger(page)||!size)throw new Error('유효한 PDF 페이지를 선택해주세요.');
    const [w,h]=size,bbox=[rect[0]*w,(1-rect[3])*h,rect[2]*w,(1-rect[1])*h],id='custom-'+randomUUID().slice(0,12),file=id+'.webp';
    const rendered=await this.worker(this.root,'extract-figures.py',['render','--pdf',pdf.path,'--page',String(page),'--bbox',JSON.stringify(bbox),'--output',path.join(this.directory,'figures',hash,file)],{signal});
    (this.state.customFigures[hash]??=[]).push({id,file,page,number:null,caption:`직접 선택한 영역 · ${page}페이지`,kind:'custom',method:'manual-crop',needsReview:false,...rendered});this.save();return this.chooseFigure(p,id);
  }
  async importPdf(p,buffer,{filename='paper.pdf',source='manual-upload'}={}){
    this.guardWrite();
    if(buffer.length>100*1024*1024||!buffer.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('100MB 이하의 PDF 파일을 선택해주세요.');
    const hash=createHash('sha256').update(buffer).digest('hex'),directory=path.join(this.directory,'pdfs');await fsp.mkdir(directory,{recursive:true});const file=path.join(directory,hash+'.pdf');
    this.assertTestScope(hash);
    if(!fs.existsSync(file))await fsp.writeFile(file,buffer,{flag:'wx'});
    const info=await this.worker(this.root,'extract-figures.py',['inspect','--pdf',file]);
    const id='pdf:'+hash;this.state.pdfs[id]={id,source,title:p.canonicalTitle||p.title,attachmentTitle:path.basename(filename),path:file,exists:true,size:buffer.length,hash,identifiers:p.identifiers||[],importedAt:now(),validation:{reason:'user-confirmed',pages:info.pages}};
    this.refreshRecords();this.save();this.choosePdf(p,id);return this.detail(p);
  }
  async acquire(p,signal){
    if(this.testScope.enabled)throw new Error('시험 기간에는 PDF 자동 수집을 실행하지 않습니다. 선택한 10편의 PDF로 검증해주세요.');
    const candidates=pdfDownloadCandidates(p);if(!candidates.length)throw new Error('원문 PDF 주소가 없습니다. 서지정보 조회 또는 직접 PDF 연결이 필요합니다.');
    let error,lastUrl;
    for(const candidate of candidates.slice(0,4)){
      lastUrl=candidate.url;
      try{
        const result=await this.downloader(candidate,path.join(this.directory,'pdfs'),{signal,onProgress:async url=>{
          const host=new URL(url).hostname,cooldown=this.state.downloadCooldowns[host];
          if(cooldown&&Date.parse(cooldown.retryAt)>Date.now()){const e=new Error(cooldown.error);Object.assign(e,cooldown,{hostname:host});throw e;}
          const pause=Math.max(0,(this.hostRequests.get(host)||0)+(host.endsWith('arxiv.org')?3000:1000)-Date.now());if(pause)await new Promise(resolve=>setTimeout(resolve,pause));signal?.throwIfAborted();this.hostRequests.set(host,Date.now());this.progress({stage:'downloading',current:p.title,url});
        }});
        const info=await this.worker(this.root,'extract-figures.py',['inspect','--pdf',result.path],{signal});
        const validation=verifyPdfIdentity(p,info),id='pdf:'+result.hash;
        this.state.pdfs[id]={id,source:'download',title:validation.ok?p.canonicalTitle||p.title:info.metadata?.Title||path.basename(result.path),path:result.path,hash:result.hash,exists:true,size:result.size,identifiers:validation.ok?p.identifiers:[],provenance:result,validation,downloadedAt:now()};this.refreshRecords();
        if(!validation.ok){this.state.outcomes[p.id]={status:'needs-pdf-review',pdfId:id,url:result.url,error:'받은 PDF가 이 논문인지 자동 확인하지 못했습니다. 파일을 검토해 연결해주세요.',updatedAt:now()};this.save();return false;}
        this.state.pdfChoices[p.id]={pdfId:id,mode:'auto',updatedAt:now()};this.save();return true;
      }catch(e){if(signal?.aborted)throw e;error=e;if(e.hostname&&[401,403,429].includes(e.httpStatus)){this.state.downloadCooldowns[e.hostname]={status:e.status,httpStatus:e.httpStatus,retryAt:e.retryAt,error:e.message};this.save();}}
    }
    this.state.outcomes[p.id]={status:error?.status||'download-failed',url:lastUrl,httpStatus:error?.httpStatus,error:error?.message||'PDF 다운로드 실패',retryAt:error?.retryAt||new Date(Date.now()+3600000).toISOString(),updatedAt:now()};this.save();return false;
  }
  progress(update){this.job={...this.job,...update};saveJSON(this.directory,'job.json',this.job);}
  stop(){if(!this.controller)throw new Error('이 서버에서 실행 중인 PDF 작업이 없습니다.');this.controller.abort(new Error('PDF 작업 중단 · 완료된 결과에서 이어갈 수 있습니다.'));}
  async extractZoteroLibrary({force=false,signal}){
    signal.throwIfAborted();
    // Explicit whole-library action expands the pilot, without enabling downloads
    // or assigning unmatched attachments to a conversation paper.
    if(this.testScope.enabled){this.testScope={...this.testScope,enabled:false,expandedAt:now(),expandedBy:'zotero-all'};saveJSON(this.directory,'test-scope.json',this.testScope);}
    const records=this.records.filter(r=>r.source==='zotero'&&r.exists),groups=new Map();let hashErrors=0,duplicates=0;
    this.progress({stage:'hashing',pdfCount:records.length,scanned:0,cached:0,extracted:0,duplicates:0});
    for(const [i,pdf] of records.entries()){
      signal.throwIfAborted();
      this.progress({current:pdf.title||path.basename(pdf.path)});
      try{const hash=await this.ensureHash(pdf);signal.throwIfAborted();if(groups.has(hash)){groups.get(hash).push(pdf);duplicates++;}else groups.set(hash,[pdf]);}
      catch(e){if(signal.aborted)throw e;this.state.pdfOutcomes[pdf.id]={status:'processing-failed',error:e.message,updatedAt:now()};this.save();hashErrors++;this.job.errors++;}
      this.progress({scanned:i+1,duplicates});
    }
    this.matchCache.clear();this.progress({total:groups.size+hashErrors,completed:hashErrors});
    for(const group of groups.values()){
      signal.throwIfAborted();const pdf=group[0];this.progress({stage:'extracting',current:pdf.title||path.basename(pdf.path)});
      try{
        const result=await this.extractPdf(pdf,{force,signal});signal.throwIfAborted();
        this.job[result.cached?'cached':'extracted']++;
        for(const r of group)this.state.pdfOutcomes[r.id]={status:'ready',pdfHash:result.pdfHash,updatedAt:now()};
      }catch(e){if(signal.aborted)throw e;this.job.errors++;for(const r of group)this.state.pdfOutcomes[r.id]={status:'processing-failed',error:e.message,updatedAt:now()};}
      this.save();this.progress({completed:this.job.completed+1});
    }
  }
  start({mode='local',limit=10,paperId,force=false,zoteroRoot}={}){
    this.refresh();
    if(!['scan','local','acquire','all','paper','zotero-all'].includes(mode)||!Number.isInteger(limit)||limit<1||limit>3000)throw new Error('올바른 PDF 작업과 처리 수를 지정해주세요.');
    if(mode==='zotero-all'&&paperId)throw new Error('Zotero 전체 추출에는 개별 논문 ID를 지정하지 않습니다.');
    if(this.testScope.enabled&&['acquire','all'].includes(mode))throw new Error('현재 10편 시험 모드입니다. 추가 PDF 자동 수집은 중지되어 있습니다.');
    if(this.testScope.enabled&&paperId){const paper=this.getPapers().find(p=>p.id===paperId);this.assertTestScope(paper&&this.match(paper).selected?.hash);}
    const old=loadJSON(this.directory,'job.json',{});if(this.controller||old.running&&alive(old.ownerPid))throw new Error('이미 PDF 작업이 실행 중입니다.');
    this.controller=new AbortController();const signal=this.controller.signal;this.job={running:true,ownerPid:process.pid,mode,completed:0,total:0,errors:0,startedAt:now(),stage:'starting'};this.progress({});
    this.promise=(async()=>{
      try{
        if(['scan','local','all','zotero-all'].includes(mode)){
          this.progress({stage:'scanning',current:'Zotero PDF 목록 확인'});
          try{await this.scanZotero(zoteroRoot||this.zoteroRoot,signal);}catch(e){if(mode!=='all'||signal.aborted)throw e;this.progress({warning:'Zotero 조회를 건너뛰었습니다: '+e.message});}
        }
        if(mode==='scan'){this.progress({stage:'complete'});return;}
        if(mode==='zotero-all'){await this.extractZoteroLibrary({force,signal});this.progress({stage:'complete'});return;}
        let papers=this.getPapers().filter(p=>paperId?p.id===paperId:p.status!=='dismissed').sort((a,b)=>b.count-a.count);
        if(paperId&&!papers.length)throw new Error('논문 후보를 찾지 못했습니다.');
        papers=papers.filter(p=>{
          const s=this.summary(p),prior=this.state.outcomes[p.id];if(s.status==='ready'&&!force)return false;
          if(this.testScope.enabled&&!this.allowedHash(this.match(p).selected?.hash))return false;
          if(mode!=='paper'&&!force&&prior?.retryAt&&Date.parse(prior.retryAt)>Date.now())return false;
          if(['local','paper'].includes(mode))return s.status==='available'||force&&s.status==='ready';
          return s.status!=='needs-review'&&(pdfDownloadCandidates(p).length>0||s.status==='available');
        });
        const unique=new Map();for(const p of papers){const key=this.match(p).selected?.hash||this.match(p).selected?.id||p.id;if(!unique.has(key))unique.set(key,p);}papers=[...unique.values()].slice(0,limit);
        this.progress({total:papers.length});
        for(const p of papers){
          signal.throwIfAborted();this.progress({stage:'processing',current:p.title});
          try{
            if(this.match(p).status!=='matched'&&!await this.acquire(p,signal))continue;
            this.progress({stage:'extracting',current:p.title});await this.extract(p,{force,signal});
          }catch(e){if(signal.aborted)throw e;this.state.outcomes[p.id]={status:'processing-failed',error:e.message,retryAt:new Date(Date.now()+1800000).toISOString(),updatedAt:now()};this.save();this.job.errors++;}
          finally{this.progress({completed:this.job.completed+1});}
          // One document at a time, avoiding concurrent JVM/PDFium memory spikes.
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        this.progress({stage:'complete'});
      }catch(e){this.progress({stage:signal.aborted?'interrupted':'error',error:e.message});}
      finally{this.controller=null;this.progress({running:false,finishedAt:now()});}
    })();return this.job;
  }
}
