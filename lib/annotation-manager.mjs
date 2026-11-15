import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {loadJSON,saveJSON} from './local-store.mjs';import {pythonWorker} from './python-worker.mjs';import {paperKeys} from './pdf-library.mjs';
import {validateAnnotationJSON,annotationFingerprint,annotationOutputSchema,annotationPrompt,ANNOTATION_COLORS} from './annotation-schema.mjs';

const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
export class AnnotationManager{
  constructor({root,state,media,getPaper,getContexts,worker=pythonWorker}){this.root=root;this.directory=state;this.media=media;this.getPaper=getPaper;this.getContexts=getContexts;this.worker=worker;this.controller=null;this.promise=null;}
  read(){return loadJSON(this.directory,'annotations.json',{schemaVersion:1,annotations:{},packets:{},exports:{},applications:{}});}
  save(value){saveJSON(this.directory,'annotations.json',value);}
  guard(){const job=loadJSON(this.directory,'annotation-jobs.json',{});if(this.controller||this.externalWrite||job.running&&alive(job.ownerPid))throw new Error('AI 주석 작업이 실행 중입니다. 완료 또는 중단 후 다시 시도해주세요.');}
  lockExternal(kind,paper){this.guard();this.externalWrite=true;const job={running:true,cancellable:false,status:'running',kind,paperId:paper.id,ownerPid:process.pid,startedAt:now()};saveJSON(this.directory,'annotation-jobs.json',job);return error=>{this.externalWrite=false;saveJSON(this.directory,'annotation-jobs.json',{...job,running:false,status:error?'error':'complete',...(error?{error:error.message}:{}),finishedAt:now()});};}
  job(){const value=loadJSON(this.directory,'annotation-jobs.json',{running:false});return value.running&&!alive(value.ownerPid)?{...value,running:false,status:'interrupted',error:'앞선 작업이 중단되었습니다. 완료된 캐시를 재사용해 다시 실행하세요.'}:value;}
  async binding(paper){
    this.media.refresh();const match=this.media.match(paper),pdf=match.selected;if(match.status!=='matched'||!pdf?.exists)throw new Error('먼저 사용할 로컬 PDF를 연결해주세요.');
    this.media.assertTestScope(pdf.hash);const before=await fsp.stat(pdf.path);if(!before.isFile()||before.size>100*1024*1024)throw new Error('100MB 이하의 PDF 파일이 필요합니다.');
    const hash=createHash('sha256');for await(const chunk of fs.createReadStream(pdf.path))hash.update(chunk);const pdfHash=hash.digest('hex'),after=await fsp.stat(pdf.path);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('검사 중 PDF가 변경되었습니다. 다시 시도해주세요.');this.media.assertTestScope(pdfHash);
    return {path:pdf.path,pdfHash,itemKey:paper.itemKey||pdf.itemKey||null,attachmentKey:pdf.attachmentKey||paper.pdfKey||null,source:pdf.source};
  }
  summary(hash){return loadJSON(path.join(this.directory,'annotation-layout',hash),'summary-v2.json',null);}
  entries(paper,data=this.read()){const ids=paperKeys(paper);return Object.values(data.annotations).filter(a=>ids.includes(a.paperId));}
  async detail(paper){
    let binding,error;try{binding=await this.binding(paper);}catch(e){error=e.message;}
    const data=this.read(),layout=binding&&this.summary(binding.pdfHash),annotations=this.entries(paper,data).map(a=>binding?.pdfHash===a.pdfHash?a:{...a,match:{status:'pdf_mismatch',locations:[]},canApprove:false});
    return {paperId:paper.id,error,binding:binding?{pdfHash:binding.pdfHash,zoteroItemKey:binding.itemKey,zoteroAttachmentKey:binding.attachmentKey}:null,parserVersion:layout?.parserVersion,pages:layout?.pages||[],sections:(layout?.sections||[]).map(s=>({id:s.id,title:s.title,pageStart:s.pageStart,pageEnd:s.pageEnd,characters:s.text.length,preview:s.text.slice(0,1500)})),annotations,job:this.job(),exports:Object.values(data.exports).filter(e=>paperKeys(paper).includes(e.paperId)),colors:ANNOTATION_COLORS};
  }
  start(kind,paper,work){
    this.guard();this.controller=new AbortController();const signal=this.controller.signal,job={running:true,status:'running',kind,paperId:paper.id,ownerPid:process.pid,startedAt:now()};saveJSON(this.directory,'annotation-jobs.json',job);
    this.promise=(async()=>{try{await work(signal);saveJSON(this.directory,'annotation-jobs.json',{...job,running:false,status:'complete',finishedAt:now()});}catch(e){saveJSON(this.directory,'annotation-jobs.json',{...job,running:false,status:signal.aborted?'interrupted':'error',error:e.message,finishedAt:now()});}finally{this.controller=null;}})();return job;
  }
  stop(){if(!this.controller)throw new Error('이 서버에서 실행 중인 AI 주석 작업이 없습니다.');this.controller.abort(new Error('사용자가 AI 주석 작업을 중단했습니다.'));}
  prepare(paper){return this.start('prepare',paper,async signal=>{const binding=await this.binding(paper),result=await this.worker(this.root,'annotation-pdf.py',['layout','--pdf',binding.path,'--cache',path.join(this.directory,'annotation-layout')],{signal});if(result.pdfHash!==binding.pdfHash)throw new Error('pdf_mismatch');const dir=path.join(this.directory,'annotation-layout',binding.pdfHash);fs.mkdirSync(dir,{recursive:true});saveJSON(dir,'summary-v2.json',result);});}
  async exportInput(paper,{sectionIds=[],annotationLimit=8,mode='paper',contextSelections=[]}={}){
    this.guard();const binding=await this.binding(paper),layout=this.summary(binding.pdfHash);if(!layout)throw new Error('먼저 PDF 텍스트·위치를 준비해주세요.');
    if(!Array.isArray(sectionIds)||!sectionIds.length||sectionIds.length>30||new Set(sectionIds).size!==sectionIds.length||!Number.isInteger(annotationLimit)||annotationLimit<1||annotationLimit>20||!['paper','research-context'].includes(mode)||!Array.isArray(contextSelections)||contextSelections.length>10||mode==='paper'&&contextSelections.length)throw new Error('섹션과 1~20개의 주석 수를 선택하세요. 개인 맥락은 별도 모드에서만 내보낼 수 있습니다.');
    const sections=sectionIds.map(id=>{const s=layout.sections.find(s=>s.id===id);if(!s)throw new Error('섹션을 찾지 못했습니다.');return s;});if(sections.reduce((n,s)=>n+s.text.length,0)>150000)throw new Error('내보낼 원문을 150,000자 이하로 줄여주세요.');
    const contexts=[];if(mode==='research-context'){
      const available=await this.getContexts(paper),seen=new Set();for(const choice of contextSelections){const context=available.find(c=>c.mentionId===choice.mentionId);if(!context||seen.has(context.mentionId)||!Number.isInteger(choice.start)||!Number.isInteger(choice.end)||choice.start<0||choice.end>context.text.length||choice.end<=choice.start)throw new Error('전달할 대화와 텍스트 범위를 명시적으로 선택해주세요.');seen.add(context.mentionId);contexts.push({...Object.fromEntries(['mentionId','paperId','conversationId','messageId','projectId','projectName','conversationTitle','url'].map(key=>[key,context[key]])),text:context.text.slice(choice.start,choice.end),range:{start:choice.start,end:choice.end}});}
    }
    const requestId=randomUUID(),data=this.read(),createdAt=now();data.packets[requestId]={paperId:paper.id,pdfHash:binding.pdfHash,contexts,sectionIds,annotationLimit,createdAt};while(Object.keys(data.packets).length>30)delete data.packets[Object.keys(data.packets)[0]];this.save(data);
    return {schemaVersion:1,requestId,paperId:paper.id,zoteroItemKey:binding.itemKey,zoteroAttachmentKey:binding.attachmentKey,pdfHash:binding.pdfHash,annotationLimit,mode,sections,contexts,colors:ANNOTATION_COLORS,prompt:annotationPrompt,outputSchema:annotationOutputSchema};
  }
  async importJSON(paper,value){
    this.guard();const validated=validateAnnotationJSON(value);if(validated.errors.some(e=>e.index===null))return {imported:0,duplicates:0,errors:validated.errors};
    const binding=await this.binding(paper),data=this.read(),packet=value.requestId&&data.packets[value.requestId];
    if(!paperKeys(paper).includes(value.paperId)||value.pdfHash!==binding.pdfHash||value.zoteroItemKey!==binding.itemKey||value.zoteroAttachmentKey!==binding.attachmentKey)return {imported:0,duplicates:0,pdfMismatch:value.pdfHash!==binding.pdfHash,errors:[{index:null,path:'header',message:'paperId, Zotero Key 또는 pdfHash가 현재 연결된 PDF와 다릅니다.'}]};
    if(value.requestId&&(!packet||packet.pdfHash!==binding.pdfHash||!paperKeys(paper).includes(packet.paperId)))return {imported:0,duplicates:0,errors:[{index:null,path:'requestId',message:'분석용 내보내기가 만료되었거나 다른 PDF입니다.'}]};
    if(packet&&value.annotations.length>packet.annotationLimit)return {imported:0,duplicates:0,errors:[{index:null,path:'annotations',message:'선택한 주석 수를 초과했습니다.'}]};
    let imported=0,duplicates=0;const errors=[...validated.errors];
    for(const a of validated.valid){
      const sources=a.contextRefs.map(id=>packet?.contexts.find(c=>c.mentionId===id));if(a.scope==='research-context'&&(!packet||sources.some(s=>!s))){errors.push({id:a.id,path:'contextRefs',message:'명시적으로 내보낸 대화만 참조할 수 있습니다.'});continue;}
      const fingerprint=annotationFingerprint(binding.pdfHash,a),existing=Object.values(data.annotations).find(x=>x.fingerprints.includes(fingerprint));if(existing){duplicates++;continue;}
      const id='ann-'+fingerprint.slice(0,32);data.annotations[id]={...a,id,sourceId:a.id,paperId:paper.id,pdfHash:binding.pdfHash,zoteroItemKey:binding.itemKey,zoteroAttachmentKey:binding.attachmentKey,contextSources:sources,fingerprints:[fingerprint],createdAt:now(),updatedAt:now(),status:'proposed',match:{status:'unmatched',locations:[]}};imported++;
    }
    if(imported)this.save(data);return {imported,duplicates,errors};
  }
  map(paper){return this.start('mapping',paper,async signal=>{
    const binding=await this.binding(paper),data=this.read(),entries=this.entries(paper,data).filter(a=>a.pdfHash===binding.pdfHash&&a.status!=='excluded'&&a.quote);
    const dir=path.join(this.directory,'annotation-layout',binding.pdfHash);fs.mkdirSync(dir,{recursive:true});const input=path.join(dir,'search-'+randomUUID()+'.json');await fsp.writeFile(input,JSON.stringify(entries));
    try{const result=await this.worker(this.root,'annotation-pdf.py',['search','--pdf',binding.path,'--cache',path.join(this.directory,'annotation-layout'),'--input',input],{signal});if(result.pdfHash!==binding.pdfHash)throw new Error('pdf_mismatch');const current=this.read();for(const match of result.annotations){const a=current.annotations[match.id];if(!a)continue;const previous=a.match?.selected,selected=previous&&match.locations.find(l=>l.locationId===previous.locationId);a.match=selected?{...match,status:'matched',selected}: {...match,...(match.status==='matched'?{selected:match.locations[0]}:{})};if(a.status==='approved'&&a.match.status!=='matched')a.status='proposed';}this.save(current);}finally{await fsp.unlink(input).catch(()=>{});}
  });}
  async review(paper,{id,status,quote,comment,reason,category,color,type}={}){
    this.guard();const binding=await this.binding(paper),data=this.read(),a=data.annotations[id];if(!a||!this.entries(paper,data).some(x=>x.id===id))throw new Error('주석을 찾지 못했습니다.');if(a.pdfHash!==binding.pdfHash)throw new Error('pdf_mismatch');
    const edited=[quote,comment,reason,category,color,type].some(v=>v!==undefined);
    if(edited){const next={...a,...Object.fromEntries(Object.entries({quote,comment,reason,category,color,type}).filter(([,v])=>v!==undefined))};const check=validateAnnotationJSON({schemaVersion:1,paperId:paper.id,zoteroItemKey:binding.itemKey,zoteroAttachmentKey:binding.attachmentKey,pdfHash:binding.pdfHash,annotations:[Object.fromEntries(Object.keys(annotationOutputSchema.properties.annotations.items.properties).filter(k=>next[k]!==undefined).map(k=>[k,k==='status'?'proposed':next[k]]))]});if(check.errors.length)throw new Error(check.errors[0].message);if(next.quote!==a.quote||next.type!==a.type)next.match={status:'unmatched',locations:[]};Object.assign(a,next,{status:'proposed'});a.fingerprints=[...new Set([...a.fingerprints,annotationFingerprint(a.pdfHash,a)])];}
    if(status!==undefined){if(!['approved','excluded','proposed'].includes(status))throw new Error('올바른 승인 상태를 선택해주세요.');if(status==='approved'&&!(a.match.status==='matched'||a.type==='note'&&a.scope==='research-context'&&!a.quote&&a.contextSources.length))throw new Error('원문 위치가 matched인 주석만 승인할 수 있습니다. 위치 없는 연구 맥락은 노트로 저장하세요.');a.status=status;}
    a.updatedAt=now();this.save(data);return a;
  }
  async resolve(paper,{id,locationId,page,rect}={}){
    this.guard();const binding=await this.binding(paper),data=this.read(),a=data.annotations[id];if(!a||!this.entries(paper,data).some(x=>x.id===id)||a.pdfHash!==binding.pdfHash)throw new Error('pdf_mismatch');
    let selected;if(locationId)selected=a.match.locations.find(l=>l.locationId===locationId);
    else if(Number.isInteger(page)&&Array.isArray(rect)&&rect.length===4&&rect.every(v=>Number.isFinite(v)&&v>=0&&v<=1)&&rect[2]>rect[0]&&rect[3]>rect[1]){const candidates=a.match.locations.filter(l=>l.page===page&&l.rects.length&&l.rects.every(r=>{const x=(r[0]+r[2])/2,y=(r[1]+r[3])/2;return x>=rect[0]&&x<=rect[2]&&y>=rect[1]&&y<=rect[3];}));if(candidates.length===1)selected=candidates[0];}
    if(!selected?.geometryVerified)throw new Error('선택한 페이지·영역에서 유일하고 검증된 인용 위치를 찾지 못했습니다.');a.match={...a.match,status:'matched',selected};a.status='proposed';a.updatedAt=now();this.save(data);return a;
  }
  async page(paper,page){
    const binding=await this.binding(paper),layout=this.summary(binding.pdfHash);if(!layout||!Number.isInteger(page)||page<1||page>layout.pages.length)throw new Error('PDF 준비와 페이지 번호를 확인해주세요.');const dir=path.join(this.directory,'annotation-layout',binding.pdfHash),file=path.join(dir,'page-'+page+'.webp');if(!fs.existsSync(file))await this.worker(this.root,'annotation-pdf.py',['render','--pdf',binding.path,'--page',String(page),'--output',file]);return file;
  }
  async approved(paper,{highlightsOnly=false}={}){const binding=await this.binding(paper),annotations=this.entries(paper).filter(a=>a.pdfHash===binding.pdfHash&&a.status==='approved'&&(!highlightsOnly||a.type==='highlight'&&a.match.status==='matched'));if(!annotations.length)throw new Error('승인된 주석이 없습니다.');return {binding,annotations,signature:digest(annotations.map(a=>({id:a.id,quote:a.quote,comment:a.comment,reason:a.reason,category:a.category,color:a.color,type:a.type,scope:a.scope,match:a.match.selected,sources:a.contextSources})))};}
  exportPDF(paper){return this.start('pdf-export',paper,async signal=>{
    const approved=await this.approved(paper,{highlightsOnly:true}),data=this.read(),directory=path.join(this.directory,'annotation-exports');fs.mkdirSync(directory,{recursive:true});
    const prior=Object.values(data.exports).find(e=>e.pdfHash===approved.binding.pdfHash&&e.signature===approved.signature&&fs.existsSync(path.join(directory,e.id+'.pdf')));if(prior)return;
    let id=digest([approved.binding.pdfHash,approved.signature]),file=path.join(directory,id+'.pdf');if(fs.existsSync(file)){id=digest([id,randomUUID()]);file=path.join(directory,id+'.pdf');}
    const input=path.join(directory,'request-'+randomUUID()+'.json');await fsp.writeFile(input,JSON.stringify({pdfHash:approved.binding.pdfHash,annotations:approved.annotations}));
    try{const result=await this.worker(this.root,'annotation-pdf.py',['export','--pdf',approved.binding.path,'--input',input,'--output',file],{signal});const current=this.read();current.exports[id]={id,paperId:paper.id,pdfHash:approved.binding.pdfHash,annotationIds:approved.annotations.map(a=>a.id),signature:approved.signature,createdAt:now(),...result};this.save(current);}finally{await fsp.unlink(input).catch(()=>{});}
  });}
  exportFile(id){if(!/^[a-f0-9]{64}$/.test(id||'')||!this.read().exports[id])throw new Error('내보낸 PDF를 찾지 못했습니다.');this.media.assertTestScope(this.read().exports[id].pdfHash);return path.join(this.directory,'annotation-exports',id+'.pdf');}
}
