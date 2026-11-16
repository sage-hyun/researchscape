import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {activeMessages, buildIndex, graphEdges, hash, RULE_VERSION} from './lib/extract.mjs';
import {dateRange,filterIndex} from './lib/date-filter.mjs';
import {CATEGORIES,classifyConversation,sourceFilter,matchingConversations,projectCatalog,paperCategories} from './lib/projects.mjs';
import {synchronizeBibliography,validRecord} from './lib/bibliography.mjs';
import {reconcileIndex} from './lib/reconcile.mjs';
import {bibliographyDiagnostics} from './lib/bibliography-diagnostics.mjs';
import {saveJSON,loadJSON,storeVersion} from './lib/local-store.mjs';
import {storagePaths} from './lib/config.mjs';
import {FigureManager} from './lib/figure-manager.mjs';
import {publicRoutes,requestAccess} from './lib/request-access.mjs';
import {compactReviewExport,reviewBundleExport,reviewGroups,reviewSnapshot,reviewResultSchema,planReviewImport,applyReviewPlan} from './lib/bibliography-review.mjs';
import {ReviewImportManager} from './lib/review-import.mjs';
import {createReviewAPI} from './lib/review-api.mjs';
import {createZoteroAPI} from './lib/zotero-api.mjs';
import {createAnnotationAPI} from './lib/annotation-api.mjs';
import {createAcquisitionAPI} from './lib/acquisition-api.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const {data:DATA,state:LOCAL}=storagePaths(ROOT);
fs.mkdirSync(LOCAL,{recursive:true});
const access=loadJSON(LOCAL,'access.json',{publicUrls:[]});
const routes=publicRoutes(process.env.RESEARCHSCAPE_PUBLIC_URL?[process.env.RESEARCHSCAPE_PUBLIC_URL]:access.publicUrls);
const load=(name,fallback)=>loadJSON(LOCAL,name,fallback);
const save=(name,value)=>saveJSON(LOCAL,name,value);
let sources=load('sources.json',[]), reviews=load('reviews.json',{}), index, files=[], busy=false;
const projects=load('projects.json',{});
let conversationLabels=load('conversation-labels.json',{}),labelRevision=0;
let bibliography=load('bibliography.json',{records:{},lookups:{}}),bibDecisions=load('bibliography-decisions.json',{}),rawIndex;
let bibliographyJob=load('bibliography-job.json',{running:false}),bibStamp='';
let bibliographyController=null;
const reviewPlans=new Map();
const reviewStamp=()=>reviewSnapshot([rawIndex.signature,bibStamp]);
const bibliographyStamp=()=>['bibliography.json','bibliography-decisions.json'].map(name=>storeVersion(LOCAL,name)).join(':');
function applyBibliography(){index=reconcileIndex(rawIndex,bibliography,bibDecisions);bibStamp=bibliographyStamp();}
function refreshBibliography(){if(bibStamp!==bibliographyStamp()){bibliography=load('bibliography.json',{records:{},lookups:{}});bibDecisions=load('bibliography-decisions.json',{});applyBibliography();}}
const conversationFiles=new Map();
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function findFiles(dir) {
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?findFiles(path.join(dir,e.name)):/^conversations(?:-\d+)?\.json$/.test(e.name)?[path.join(dir,e.name)]:[]).sort();
}
function signature(list) {return hash(JSON.stringify({version:RULE_VERSION,files:list.map(f=>[path.relative(ROOT,f),fs.statSync(f).size,fs.statSync(f).mtimeMs]),sources}));}
function rebuild(force=false) {
  files=findFiles(DATA);
  const sig=signature(files), previous=load('index.json',null),cached=!force&&previous;
  if(cached?.signature===sig) {
    rawIndex=cached;applyBibliography();
    for(const [id,file] of cached.conversationFiles||[])conversationFiles.set(id,file);
    console.log(`Loaded local index: ${index.stats.papers} candidates, ${index.stats.mentions} mentions.`);
    return;
  }
  const cs=new Map(), warnings=[];
  conversationFiles.clear();
  for(const file of files) {
    const raw=readJSON(file);
    if(!Array.isArray(raw))throw new Error(`Conversation array expected: ${path.basename(file)}`);
    for(const c of raw) {
      const id=c.id||c.conversation_id;
      if(!id){warnings.push('ID가 없는 대화 1개 제외');continue;}
      if(cs.has(id)&&(cs.get(id).update_time||0)>(c.update_time||0))continue;
      if(!c.current_node || !c.mapping?.[c.current_node]) warnings.push(`선택 경로를 찾지 못한 대화: ${id}`);
      cs.set(id,{id,title:c.title,conversation_template_id:c.conversation_template_id,create_time:c.create_time,update_time:c.update_time,messages:activeMessages(c)});
      conversationFiles.set(id,path.relative(ROOT,file));
    }
  }
  for(const s of sources)cs.set(s.id,s);
  rawIndex={...buildIndex([...cs.values()],{sourceFiles:files.map(f=>path.relative(ROOT,f)),warnings,priorIndex:previous}),signature:sig,conversationFiles:[...conversationFiles]};
  save('index.json',rawIndex);applyBibliography();
  console.log(`Indexed ${index.stats.conversations} conversations / ${index.stats.messages} messages / ${index.stats.papers} candidates / ${index.stats.mentions} mentions.`);
}
rebuild(process.argv.includes('--index'));
if(process.argv.includes('--index'))process.exit(0);

const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const localAsset=(res,file,headers)=>{res.writeHead(200,headers);const stream=fs.createReadStream(file);stream.on('error',()=>{if(!res.headersSent)json(res,404,{error:'로컬 파일을 읽지 못했습니다.'});else res.destroy();});res.once('close',()=>stream.destroy());stream.pipe(res);};
const media=new FigureManager({root:ROOT,state:LOCAL,getPapers:()=>enriched(index.papers,false)});
async function body(req) {
  let chunks=[],size=0;
  for await(const chunk of req){size+=chunk.length;if(size>2_000_000)throw new Error('입력은 2MB 이하로 줄여주세요.');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
const enriched=(papers=index.papers,includeMedia=true)=>papers.map(p=>{
  const memberReviews=(p.memberIds||[p.id]).filter(id=>reviews[id]).map(id=>({id,...reviews[id]}));
  const allDismissed=(p.sourceCandidateIds||[p.id]).every(id=>reviews[id]?.status==='dismissed');
  const inherited={status:memberReviews.some(r=>r.status==='confirmed')?'confirmed':allDismissed?'dismissed':'unreviewed'};
  for(const key of ['itemKey','pdfKey']){const values=[...new Set(memberReviews.map(r=>r[key]).filter(Boolean))];if(values.length===1)inherited[key]=values[0];}
  const explicit=reviews[p.id]?.resolutionMemberIds||(p.sourceCandidateIds||[p.id]).length<=1;
  const result={...p,...inherited,...(explicit?reviews[p.id]:{}),memberReviews,reviewConflict:new Set(memberReviews.map(r=>r.status)).size>1};
  return {...result,...(includeMedia?{media:media.summary(result)}:{})};
});
const resolvePaperId=id=>index.papers.some(p=>p.id===id)?id:index.redirects?.[id]||id;
let lastScope=null;
function scope(url) {
  refreshBibliography();
  media.refresh();
  const range=dateRange(url.searchParams),filters=sourceFilter(url.searchParams),key=JSON.stringify([range.from,range.to,filters.category,filters.project,labelRevision]);
  if(lastScope?.index!==index||lastScope.key!==key){
    const labels=new Map(index.conversations.map(c=>[c.id,classifyConversation(c,projects,conversationLabels)]));
    const ids=filters.active?matchingConversations(index.conversations,filters,projects,conversationLabels):null;
    const data=filterIndex(index,range,ids),breakdown=paperCategories(data.mentions,labels);
    data.papers=data.papers.map(p=>({...p,categoryCounts:breakdown.get(p.id)}));
    const categoryCounts={research:0,coursework:0,unclassified:0};
    for(const m of data.mentions)categoryCounts[labels.get(m.conversationId)?.category||'unclassified']++;
    lastScope={index,key,data:{...data,labels,categoryCounts}};
  }
  return {...lastScope.data,range:{from:range.from,to:range.to,active:range.active},filters};
}
let contextFile=null, contextConversations=[];
function context(cid,mid) {
  const source=sources.find(s=>s.id===cid);
  let messages;
  if(source)messages=source.messages;
  else {
    const file=conversationFiles.get(cid);
    if(!file)return null;
    if(contextFile!==file){contextConversations=readJSON(path.join(ROOT,file));contextFile=file;}
    const c=contextConversations.find(c=>(c.id||c.conversation_id)===cid);
    if(!c)return null;
    messages=activeMessages(c);
  }
  const at=messages.findIndex(m=>m.id===mid);
  if(at<0)return null;
  return messages.slice(Math.max(0,at-1),at+2).map(m=>({...m,target:m.id===mid,text:m.text.slice(0,24000),truncated:m.text.length>24000}));
}
const researchPaper=id=>{const p=enriched(index.papers,false).find(p=>p.id===resolvePaperId(id));if(!p)throw new Error('논문을 찾지 못했습니다.');return p;};
const researchIndex=()=>({papers:enriched(index.papers,false),mentions:index.mentions,conversations:index.conversations,projects:projectCatalog(index.conversations,projects)});
const researchContexts=async paper=>{
  const conversations=new Map(index.conversations.map(c=>[c.id,c]));
  return index.mentions.filter(m=>m.paperId===paper.id).sort((a,b)=>(b.date||0)-(a.date||0)).slice(0,200).map(m=>{
    const label=classifyConversation(conversations.get(m.conversationId),projects,conversationLabels),url=m.url||(/^[a-zA-Z0-9-]+$/.test(m.conversationId)&&m.source!=='paste'?`https://chatgpt.com/c/${encodeURIComponent(m.conversationId)}`:null);
    return {mentionId:m.id,paperId:paper.id,conversationId:m.conversationId,messageId:m.messageId,projectId:label.projectId,projectName:label.projectName,conversationTitle:m.conversationTitle,quote:m.quote,text:m.excerpt,url};
  });
};
const zoteroAPI=createZoteroAPI({state:LOCAL,media,getIndex:researchIndex,json,body});
const annotationAPI=createAnnotationAPI({root:ROOT,state:LOCAL,media,getPaper:researchPaper,getContexts:researchContexts,client:zoteroAPI.client,json,body,asset:localAsset});
const acquisitionAPI=createAcquisitionAPI({state:LOCAL,media,client:zoteroAPI.client,getIndex:researchIndex,getPaper:researchPaper,json,body});
// A sync in this or another server process owns the lookup cache while it runs.
const syncRunning=()=>{
  if(bibliographyController)return true;
  const job=load('bibliography-job.json',{});if(!job.running||!job.ownerPid||job.ownerPid===process.pid)return false;
  try{process.kill(job.ownerPid,0);return true;}catch{return false;}
};
const reviewImports=new ReviewImportManager({
  state:LOCAL,syncRunning,refresh:applyBibliography,
  context:()=>{refreshBibliography();return {raw:rawIndex,store:bibliography,resolved:index,decisions:bibDecisions};},
  saveStore:value=>{bibliography=value;save('bibliography.json',value);},
  saveDecisions:value=>{save('bibliography-decisions.json',value);bibDecisions=value;}
});
const reviewAPI=createReviewAPI({manager:reviewImports,json,body});
const publicFiles=new Set(['index.html','style.css','app.js','media.js','bibliography-review.js','zotero.js','annotations.js','acquisition.js']);
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    const access=requestAccess(req,routes);
    if(access.status)return json(res,access.status,{error:access.error});
    const pdfUpload=req.method==='POST'&&['/api/media/upload','/api/acquisition/upload'].includes(url.pathname);
    if(req.method!=='GET' && !String(req.headers['content-type']).startsWith(pdfUpload?'application/pdf':'application/json'))return json(res,415,{error:pdfUpload?'PDF required':'JSON required'});
    if(url.pathname.startsWith('/api/zotero/')){refreshBibliography();media.refresh();return zoteroAPI.handle(req,res,url);}
    if(url.pathname.startsWith('/api/annotations/')){refreshBibliography();media.refresh();return annotationAPI.handle(req,res,url);}
    if(url.pathname.startsWith('/api/acquisition')){refreshBibliography();media.refresh();return acquisitionAPI.handle(req,res,url);}
    if(url.pathname===reviewAPI.prefix||url.pathname.startsWith(reviewAPI.prefix+'/'))return reviewAPI.handle(req,res,url);
    if(url.pathname.startsWith('/api/media')){
      refreshBibliography();media.refresh();
      const getMediaPaper=id=>{const p=enriched(index.papers,false).find(p=>p.id===resolvePaperId(id));if(!p)throw new Error('논문 후보를 찾지 못했습니다.');return p;};
      if(req.method==='GET'&&url.pathname==='/api/media')return json(res,200,media.overview());
      if(req.method==='GET'&&url.pathname==='/api/media/paper')return json(res,200,media.detail(getMediaPaper(url.searchParams.get('id'))));
      if(req.method==='GET'&&url.pathname==='/api/media/library'){
        const query=(url.searchParams.get('q')||'').trim().toLowerCase();
        return json(res,200,{records:media.records.filter(r=>r.exists&&(!query||[r.title,r.attachmentTitle,r.itemKey,r.attachmentKey].some(t=>t?.toLowerCase().includes(query)))).slice(0,100).map(r=>({id:r.id,title:r.title,filename:path.basename(r.path||''),source:r.source,itemKey:r.itemKey,attachmentKey:r.attachmentKey}))});
      }
      if(req.method==='GET'&&url.pathname==='/api/media/pdf'){
        const record=media.records.find(r=>r.id===url.searchParams.get('pdf'));if(!record?.exists||!fs.existsSync(record.path))return json(res,404,{error:'등록된 PDF를 찾지 못했습니다.'});
        localAsset(res,record.path,{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="paper.pdf"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/media/image'){
        const file=media.imagePath(url.searchParams.get('pdf'),url.searchParams.get('figure'));if(!file)return json(res,404,{error:'이미지를 찾지 못했습니다.'});
        localAsset(res,file,{'Content-Type':'image/webp','Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/media/page'){
        const file=await media.page(getMediaPaper(url.searchParams.get('id')),Number(url.searchParams.get('page')));localAsset(res,file,{'Content-Type':'image/webp','Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/media/job'){
        const data=await body(req);if(data.paperId)data.paperId=getMediaPaper(data.paperId).id;media.start(data);return json(res,202,{ok:true});
      }
      if(req.method==='POST'&&url.pathname==='/api/media/stop'){media.stop();return json(res,200,{ok:true});}
      if(req.method==='POST'&&url.pathname==='/api/media/pdf-choice'){const d=await body(req),p=getMediaPaper(d.paperId);return json(res,200,d.auto===true?media.resetPdf(p):media.choosePdf(p,d.pdfId));}
      if(req.method==='POST'&&url.pathname==='/api/media/thumbnail'){const d=await body(req);return json(res,200,media.chooseFigure(getMediaPaper(d.paperId),d.figureId,{auto:d.auto===true}));}
      if(req.method==='POST'&&url.pathname==='/api/media/crop'){const d=await body(req);return json(res,200,await media.crop(getMediaPaper(d.paperId),d));}
      if(pdfUpload){
        const p=getMediaPaper(url.searchParams.get('id')),chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>100*1024*1024)throw new Error('PDF는 100MB 이하만 지원합니다.');chunks.push(chunk);}
        return json(res,200,await media.importPdf(p,Buffer.concat(chunks),{filename:url.searchParams.get('filename')||'paper.pdf'}));
      }
      return json(res,404,{error:'알 수 없는 PDF 작업입니다.'});
    }
    if(req.method==='GET'&&url.pathname==='/api/overview') {
      const selected=scope(url);
      return json(res,200,{generatedAt:index.generatedAt,stats:selected.stats,papers:enriched(selected.papers),range:selected.range,filters:selected.filters,categoryCounts:selected.categoryCounts,projects:projectCatalog(index.conversations,projects),sourceFiles:index.sourceFiles,busy});
    }
    if(req.method==='GET'&&url.pathname==='/api/graph') {
      const selected=scope(url);
      const ids=new Set(url.searchParams.getAll('id').slice(0,160).map(resolvePaperId));
      return json(res,200,graphEdges(selected.papers.filter(p=>ids.has(p.id)),selected.mentions));
    }
    if(req.method==='GET'&&url.pathname==='/api/paper') {
      const selected=scope(url);
      const requested=url.searchParams.get('id'),id=resolvePaperId(requested), paper=enriched(selected.papers).find(p=>p.id===id);
      if(!paper)return json(res,404,{error:'논문 후보를 찾지 못했습니다.'});
      const role=url.searchParams.get('role'), offset=Math.max(0,parseInt(url.searchParams.get('offset'))||0);
      const mentions=selected.mentions.filter(m=>m.paperId===id&&(!role||m.role===role)).sort((a,b)=>(b.date||0)-(a.date||0));
      return json(res,200,{paper,total:mentions.length,mentions:mentions.slice(offset,offset+30).map(m=>({...m,...selected.labels.get(m.conversationId)}))});
    }
    if(req.method==='GET'&&url.pathname==='/api/context')return json(res,200,{messages:context(url.searchParams.get('cid'),url.searchParams.get('mid'))||[]});
    if(req.method==='GET'&&url.pathname==='/api/bibliography'){
      refreshBibliography();
      const job=bibliographyJob.ownerPid===process.pid?bibliographyJob:load('bibliography-job.json',bibliographyJob);
      if(job.running&&job.ownerPid){try{process.kill(job.ownerPid,0);}catch{job.running=false;job.stage='interrupted';job.error='앞선 조회가 중단됐습니다. 저장된 캐시를 사용해 다시 시작할 수 있습니다.';}}
      const diagnostics=bibliographyDiagnostics(rawIndex,bibliography,index);
      const lookupErrors=Object.entries(diagnostics.lookupSummary).filter(([kind])=>!['retrieved','no-match','identifier-not-indexed'].includes(kind)).reduce((sum,[,n])=>sum+n,0);
      const groups=reviewGroups(rawIndex,index,bibDecisions);
      return json(res,200,{job,recordCount:Object.keys(bibliography.records||{}).length,stats:index.stats,queue:index.resolutionQueue,lookupErrors,diagnostics,reviewTotals:{withCandidates:groups.withCandidates.length,withoutCandidates:groups.withoutCandidates.length},reviewImport:reviewImports.latest()});
    }
    if(req.method==='GET'&&url.pathname==='/api/bibliography/export'){
      refreshBibliography();
      const format=url.searchParams.get('format')||'full';if(!['bundle','compact','full'].includes(format))throw new Error('bundle, compact 또는 full 형식을 선택해주세요.');
      let exported,filename='diagnostics';
      if(format!=='full'){
        // bundle: the whole review in one file. compact: the earlier page-by-page export, kept for compatibility.
        const groups=reviewGroups(rawIndex,index,bibDecisions);
        exported=format==='bundle'?reviewBundleExport(rawIndex,index,bibDecisions,{batchSize:url.searchParams.get('batchSize')},groups):compactReviewExport(rawIndex,index,bibDecisions,Object.fromEntries(url.searchParams),groups);
        // Remember what this snapshot showed, so results that arrive later are compared per candidate.
        reviewImports.recordExport(groups,exported.generatedAt);
        filename=format==='bundle'?'llm-review-'+exported.snapshot.slice(0,8):'llm-review';
      }else {
        const queued=new Set(index.resolutionQueue.map(q=>q.id)),groups=reviewGroups(rawIndex,index,bibDecisions),wanted=new Set(groups.withoutCandidates.map(p=>p.candidateId));
        exported={schemaVersion:2,kind:'diagnostics',queue:index.resolutionQueue,unresolved:rawIndex.papers.filter(p=>wanted.has(p.id)&&!queued.has(p.id)).map(p=>({id:p.id,title:p.title,observedTitles:[...new Set([p.title,...(p.aliases||[])])].map(text=>({text,sourceId:p.id})),identifiers:p.identifiers,count:p.count})),reviewTotals:{withCandidates:groups.withCandidates.length,withoutCandidates:groups.withoutCandidates.length},diagnostics:bibliographyDiagnostics(rawIndex,bibliography,index),records:bibliography.records,lookups:bibliography.lookups,providerLookups:bibliography.providerLookups||{},proposedLinks:bibliography.proposedLinks||{}};
      }
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="researchscape-${filename}.json"`,'Cache-Control':'no-store'});
      return res.end(JSON.stringify(exported));
    }
    if(req.method==='GET'&&url.pathname==='/api/bibliography/review-schema')return json(res,200,reviewResultSchema);
    if(req.method==='POST'&&url.pathname==='/api/bibliography/review/dry-run'){
      const value=await body(req);refreshBibliography();const plan=planReviewImport(rawIndex,bibliography,index,bibDecisions,value),expiresAt=Date.now()+10*60000;
      for(const [id,entry] of reviewPlans)if(entry.expiresAt<Date.now())reviewPlans.delete(id);
      if(reviewPlans.size>=20)reviewPlans.delete(reviewPlans.keys().next().value);
      const dryRunId=randomUUID();reviewPlans.set(dryRunId,{plan,stamp:reviewStamp(),expiresAt});
      return json(res,200,{...plan,dryRunId,expiresAt:new Date(expiresAt).toISOString(),writes:0});
    }
    if(req.method==='POST'&&url.pathname==='/api/bibliography/review/apply'){
      const data=await body(req);refreshBibliography();const entry=reviewPlans.get(data.dryRunId);
      if(data.approved!==true)throw new Error('사용자 최종 승인이 필요합니다.');
      if(!entry||entry.expiresAt<Date.now()||entry.stamp!==reviewStamp())return json(res,409,{error:'미리보기가 만료되었거나 서지정보·수동 결정이 변경되었습니다. dry-run을 다시 실행해주세요.'});
      const next=applyReviewPlan(entry.plan,bibDecisions,data.candidateIds);
      save('bibliography-decisions.json',next);bibDecisions=next;applyBibliography();reviewPlans.delete(data.dryRunId);
      return json(res,200,{ok:true,applied:data.candidateIds.length});
    }
    if(req.method==='POST'&&url.pathname==='/api/bibliography/sync'){
      const data=await body(req),limit=data.limit===undefined?80:Number(data.limit);
      if(!Number.isInteger(limit)||limit<1||limit>300)throw new Error('제목 조회 수는 1~300개로 지정해주세요.');
      const existing=load('bibliography-job.json',{});
      if(existing.running&&existing.ownerPid){try{process.kill(existing.ownerPid,0);return json(res,409,{error:'이미 서지정보를 조회하고 있습니다.'});}catch{}}
      if(reviewImports.verifying)return json(res,409,{error:'LLM 검토 결과의 제안 식별자를 조회하고 있습니다. 검증이 끝난 뒤 다시 시도해주세요.'});
      bibliographyJob={running:true,ownerPid:process.pid,startedAt:new Date().toISOString(),completed:0,total:0,stage:'starting'};save('bibliography-job.json',bibliographyJob);
      bibliographyController=new AbortController();
      json(res,202,{ok:true});
      setImmediate(async()=>{
        try{
          refreshBibliography();
          const counts=await synchronizeBibliography(rawIndex,bibliography,{limit,signal:bibliographyController.signal,onSave:value=>{bibliography=value;save('bibliography.json',value);},onProgress:progress=>{bibliographyJob={...bibliographyJob,...progress};save('bibliography-job.json',bibliographyJob);}});
          applyBibliography();bibliographyJob={...bibliographyJob,...counts,running:false,finishedAt:new Date().toISOString(),stage:'complete'};
        }catch(e){applyBibliography();bibliographyJob={...bibliographyJob,running:false,stage:bibliographyController?.signal.aborted?'interrupted':'error',error:e.message};}
        bibliographyController=null;
        try{save('bibliography-job.json',bibliographyJob);}catch(e){console.error('서지 작업 상태 저장 실패:',e.message);}
      });return;
    }
    if(req.method==='POST'&&url.pathname==='/api/bibliography/stop'){
      if(!bibliographyController)return json(res,409,{error:'이 서버에서 실행 중인 서지 조회가 없습니다.'});
      bibliographyController.abort(new Error('조회 중단 · 저장된 제공자별 캐시에서 다시 시작할 수 있습니다.'));return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/bibliography/decision'){
      const data=await body(req);refreshBibliography();
      if(!['match','separate','reset'].includes(data.action))throw new Error('올바른 서지 검토 동작을 선택해주세요.');
      let candidates=data.candidateId?[data.candidateId]:index.papers.find(p=>p.id===data.paperId)?.memberIds||[];
      candidates=candidates.filter(id=>rawIndex.papers.some(p=>p.id===id));
      if(!candidates.length)return json(res,404,{error:'원본 후보를 찾지 못했습니다.'});
      if(data.action==='match'&&!validRecord(bibliography.records?.[data.recordId]))throw new Error('조회된 공식 서지정보를 선택해주세요.');
      const next={...bibDecisions};
      for(const id of candidates){if(data.action==='reset')delete next[id];else next[id]={action:data.action,...(data.recordId?{recordId:data.recordId}:{}),updatedAt:new Date().toISOString()};}
      save('bibliography-decisions.json',next);bibDecisions=next;applyBibliography();return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/conversation-label'){
      const data=await body(req);
      if(!index.conversations.some(c=>c.id===data.conversationId))return json(res,404,{error:'대화를 찾지 못했습니다.'});
      if(data.category!=='inherit'&&!CATEGORIES.includes(data.category))throw new Error('올바른 대화 분류를 선택해주세요.');
      const next={...conversationLabels};
      if(data.category==='inherit')delete next[data.conversationId];else next[data.conversationId]={category:data.category};
      save('conversation-labels.json',next);conversationLabels=next;labelRevision++;
      return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/review') {
      const data=await body(req);
      refreshBibliography();data.id=resolvePaperId(data.id);
      if(!index.papers.some(p=>p.id===data.id))return json(res,404,{error:'Unknown candidate'});
      if(!['unreviewed','confirmed','dismissed'].includes(data.status))throw new Error('올바른 검토 상태를 선택해주세요.');
      for(const key of ['itemKey','pdfKey'])if(data[key]&&!/^[A-Z0-9]{8}$/.test(data[key]))throw new Error('Zotero Key는 영문 대문자·숫자 8자리입니다.');
      reviews[data.id]={status:data.status,itemKey:data.itemKey||'',pdfKey:data.pdfKey||'',resolutionMemberIds:index.papers.find(p=>p.id===data.id)?.memberIds||[data.id]};save('reviews.json',reviews);
      return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/import') {
      if(busy)return json(res,409,{error:'색인 중입니다.'});
      const data=await body(req), text=String(data.text||'').trim(), title=String(data.title||'붙여넣은 대화').slice(0,200);
      if(text.length<10)throw new Error('대화 내용을 10자 이상 입력해주세요.');
      const id=`paste:${hash(text)}`;
      if(sources.some(s=>s.id===id))return json(res,200,{duplicate:true});
      let sourceUrl=null;
      if(data.url) {const u=new URL(data.url);if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||!/^\/c\/[a-zA-Z0-9-]+\/?$/.test(u.pathname))throw new Error('https://chatgpt.com/c/… 형태의 원본 대화 주소를 입력해주세요.');sourceUrl=u.href;}
      sources.push({id,title,source:'paste',url:sourceUrl,messages:[{id,role:'user',date:Date.now()/1000,text}]});
      save('sources.json',sources);busy=true;
      try {rebuild(true);}finally{busy=false;}
      return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/reindex') {
      if(busy)return json(res,409,{error:'색인 중입니다.'});
      busy=true;
      try{contextFile=null;rebuild(true);}finally{busy=false;}
      return json(res,200,{ok:true,stats:index.stats});
    }
    if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!publicFiles.has(name))return json(res,404,{error:'Not found'});
    const mime=name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html';
    res.writeHead(200,{'Content-Type':`${mime}; charset=utf-8`,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'Referrer-Policy':'no-referrer'});
    const content=fs.readFileSync(path.join(ROOT,'public',name));
    // Serve strips the mount path. Restore it in page links and script URLs;
    // the client resolves its API/PDF/image URLs relative to app.js.
    res.end(name==='index.html'&&access.basePath?content.toString('utf8').replace(/\b(href|src)="\/(?!\/)/g,`$1="${access.basePath}/`):content);
  }catch(e){console.error(e.message);json(res,400,{error:e.message});}
});
const port=process.env.PORT===undefined?4317:Number(process.env.PORT);
server.listen(port,'127.0.0.1',()=>console.log(`Researchscape ready at http://127.0.0.1:${server.address().port}`));
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
