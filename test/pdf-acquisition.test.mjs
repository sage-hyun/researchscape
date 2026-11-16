import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {fixture,paper,bytes,title} from './fixtures/pdf-acquisition.mjs';import {PdfAcquisition,acquisitionState} from '../lib/pdf-acquisition.mjs';import {downloadPdf} from '../lib/pdf-download.mjs';
import {scanLocalAPI} from '../lib/zotero-pdfs.mjs';
import {ZoteroClient} from '../lib/zotero-client.mjs';

test('acquisition states, project filters and user-count sorting retain internal state and distinguish network failure from absence',async()=>{
  const x=await fixture();try{
    assert.equal(x.manager.queue({projectId:'g-p-fixture-a'}).rows[0].paperId,paper.id);assert.equal(x.manager.queue({sort:'userCount'}).rows[0].paperId,'other');
    assert.equal(acquisitionState(x.media,paper).status,'download_available');x.media.state.outcomes[paper.id]={status:'needs-browser',httpStatus:403,cause:'access-restricted',error:'Access restricted'};assert.equal(acquisitionState(x.media,paper).status,'needs_browser');
    x.media.state.outcomes[paper.id]={status:'download-failed',cause:'network-error',error:'Network temporarily unavailable'};assert.equal(acquisitionState(x.media,paper).status,'download_available');
    x.media.state.outcomes[paper.id]={status:'download-failed',cause:'not-found',attempts:[{cause:'not-found'}]};assert.equal(acquisitionState(x.media,paper).status,'unavailable');
    assert.equal(acquisitionState(x.media,x.papers[1]).status,'needs_manual_upload');
  }finally{await x.cleanup();}
});

test('staged uploads require explicit identity approval, reject wrong PDFs and deduplicate bytes without changing thumbnails or reviews',async()=>{
  const x=await fixture();try{
    await fs.writeFile(path.join(x.dir,'reviews.json'),'preserved review');const wrong=await x.manager.stageUpload(paper,Buffer.from('%PDF-1.7 WRONG'),'wrong.pdf');assert.equal(wrong.validation.conflict,true);assert.equal(x.media.match(paper).status,'missing');await assert.rejects(x.manager.confirmUpload(paper,{planId:wrong.planId,approved:true,identityConfirmed:true,extract:false}),/식별자/);
    const staged=await x.manager.stageUpload(paper,bytes,'good.pdf');assert.equal(staged.validation.ok,true);assert.equal(x.media.match(paper).status,'missing');assert.throws(()=>x.media.choosePdf(paper,staged.pdfId),/검토/);await assert.rejects(x.manager.confirmUpload(paper,{planId:staged.planId}),/승인/);
    await x.manager.confirmUpload(paper,{planId:staged.planId,approved:true,extract:false});assert.equal(acquisitionState(x.media,paper).status,'downloaded_locally');assert.equal(x.manager.queue().total,1);
    const again=await x.manager.stageUpload(paper,bytes,'again.pdf');assert.equal(again.pdfId,staged.pdfId);assert.equal((await fs.readdir(path.join(x.media.directory,'pdfs'))).filter(f=>f===staged.pdfHash+'.pdf').length,1);assert.equal(await fs.readFile(path.join(x.dir,'reviews.json'),'utf8'),'preserved review');
  }finally{await x.cleanup();}
});

test('Connector recheck detects new PDFs and duplicate bibliographic parents without merging them',async()=>{
  const x=await fixture();try{
    const original=await x.addAttachment('PDF00001');x.manager.recheck(paper,{extract:false});await x.manager.promise;assert.equal(x.manager.job().status,'complete');assert.equal(acquisitionState(x.media,paper).status,'available_in_zotero');
    x.state.items.set('ITEM0002',{key:'ITEM0002',version:1,data:{itemType:'journalArticle',title,DOI:'10.1234/fixture',collections:['USER0002']}});await x.addAttachment('PDF00002',Buffer.from('%PDF-1.7 other version'),'ITEM0002');x.manager.recheck(paper,{extract:false});await x.manager.promise;assert.equal(x.manager.job().result.duplicates.length,2);assert.equal(x.media.match(paper).status,'needs-review');assert.equal(x.state.writes,0);assert.deepEqual(await fs.readFile(original),bytes);
  }finally{await x.cleanup();}
});

test('three-phase Zotero upload creates only a new child, verifies SHA-256, preserves old PDFs and annotations and is idempotent',async()=>{
  const x=await fixture();try{
    const old=await x.addAttachment('OLDPDF01',Buffer.from('%PDF-1.7 User original PDF with annotations'));x.state.items.set('OLDANN01',{key:'OLDANN01',version:1,data:{itemType:'annotation',parentItem:'OLDPDF01',annotationComment:'User original annotation'}});await x.connect();const plan=await x.manager.preview(paper);assert.equal(plan.existing.length,1);assert.equal(x.state.writes,0);assert.throws(()=>x.manager.apply(paper,{planId:plan.planId}),/승인/);
    await x.client.authorize();x.manager.apply(paper,{planId:plan.planId,approved:true,extract:false});await x.manager.promise;assert.equal(x.manager.job().status,'complete',x.manager.job().error);const written=x.manager.job().result;assert.notEqual(written.attachmentKey,'OLDPDF01');assert.equal(x.state.filePosts,1);assert.equal((await fs.readFile(old)).toString(),'%PDF-1.7 User original PDF with annotations');assert.equal(x.state.items.get('OLDANN01').data.annotationComment,'User original annotation');assert.deepEqual(x.state.items.get('ITEM0001').data.collections,['MANUAL01']);assert.equal(acquisitionState(x.media,paper).status,'available_in_zotero');
    const count=x.state.writes,next=await x.manager.preview(paper);assert.equal(next.action,'already_saved');x.manager.apply(paper,{planId:next.planId,approved:true,extract:false});await x.manager.promise;assert.equal(x.manager.job().status,'complete',x.manager.job().error);assert.equal(x.state.writes,count);assert.ok(!(await fs.readFile(path.join(x.dir,'pdf-acquisition.json'),'utf8')).includes(x.state.key));
  }finally{await x.cleanup();}
});

test('single-use authorization and interruption resume the reserved attachment after a server restart',async()=>{
  const x=await fixture();try{
    await x.connect();x.state.remember=false;await x.client.authorize();const plan=await x.manager.preview(paper);x.manager.apply(paper,{planId:plan.planId,approved:true,extract:false});await x.manager.promise;assert.equal(x.manager.job().code,'AUTH_REQUIRED');assert.equal([...x.state.items.values()].filter(i=>i.data.itemType==='attachment').length,1);
    const restarted=new PdfAcquisition({state:x.dir,media:x.media,client:x.client,getIndex:x.getIndex});x.state.remember=true;await x.client.authorize();const next=await restarted.preview(paper);restarted.apply(paper,{planId:next.planId,approved:true,extract:false});await restarted.promise;assert.equal(restarted.job().status,'complete',restarted.job().error);assert.equal([...x.state.items.values()].filter(i=>i.data.itemType==='attachment').length,1);
    const stale=await restarted.preview(paper);x.state.serverId='other-database';restarted.apply(paper,{planId:stale.planId,approved:true,extract:false});await restarted.promise;assert.equal(restarted.job().status,'error');
  }finally{await x.cleanup();}
});

test('missing Zotero parents offer verified creation or explicit selection; no item is created without final approval',async()=>{
  const x=await fixture();try{
    x.state.items.clear();await x.connect();const missing=await x.manager.preview(paper);assert.equal(missing.needsItemSelection,true);assert.equal(x.state.writes,0);
    await assert.rejects(x.manager.preview({...paper,metadata:null},{createItem:true}),/검증된/);const plan=await x.manager.preview(paper,{createItem:true});assert.equal(x.state.items.size,0);await x.client.authorize();x.manager.apply(paper,{planId:plan.planId,approved:true,extract:false});await x.manager.promise;assert.equal(x.manager.job().status,'complete',x.manager.job().error);assert.equal([...x.state.items.values()].filter(i=>i.data.itemType==='journalArticle').length,1);
  }finally{await x.cleanup();}
});

test('403 is access restriction without a CAPTCHA claim, 429 persists Retry-After, HTML login and arXiv success are distinct',async()=>{
  const x=await fixture(),lookupFn=async()=>[{address:'8.8.8.8'}],dir=path.join(x.dir,'downloads');try{
    for(const status of [401,403,429])await assert.rejects(downloadPdf({url:'https://publisher.example/paper'},dir,{lookupFn,fetchFn:async()=>new Response('',{status,headers:{'Retry-After':'invalid'}})}),e=>e.httpStatus===status&&Number.isFinite(Date.parse(e.retryAt))&&(status!==403||e.causeCode==='access-restricted'&&!e.message.includes('CAPTCHA')));
    await assert.rejects(downloadPdf({url:'https://publisher.example/paper'},dir,{lookupFn,fetchFn:async()=>new Response('<html>Please sign in with institutional access</html>',{headers:{'Content-Type':'text/html'}})}),e=>e.causeCode==='login-page');
    const downloaded=await downloadPdf({url:'https://arxiv.org/pdf/1703.03400',source:'arXiv'},dir,{lookupFn,fetchFn:async()=>new Response(bytes,{headers:{'Content-Type':'application/pdf'}})});assert.deepEqual(await fs.readFile(downloaded.path),bytes);assert.equal(downloaded.source,'arXiv');
  }finally{await x.cleanup();}
});

test('project-scoped collection, cached Figure reuse and resume retain the selected scope and provider cooldown',async()=>{
  const x=await fixture();try{
    let fetched=0;x.media.downloader=async(candidate,directory,{onProgress})=>{await onProgress(candidate.url);fetched++;const filename=path.join(x.dir,'download.pdf');await fs.writeFile(filename,bytes);return {path:filename,hash:(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),size:bytes.length,url:candidate.url};};
    x.manager.collect({projectId:'g-p-fixture-a',limit:10});await x.media.promise;assert.equal(x.media.job.stage,'complete');assert.equal(fetched,1);assert.deepEqual(x.media.job.paperIds,[paper.id]);assert.equal(x.state.extracts,1);assert.equal(x.media.match(x.papers[1]).status,'missing');
    x.manager.collect({resume:true});await x.media.promise;assert.equal(fetched,1);assert.equal(x.state.extracts,1);assert.deepEqual(x.media.job.paperIds,[paper.id]);
    const y=await fixture();try{let network=0;y.media.downloader=async(candidate,directory,{onProgress})=>{await onProgress(candidate.url);network++;throw Error('must not reach network');};y.media.state.downloadCooldowns['doi.org']={httpStatus:429,status:'rate-limited',causeCode:'rate-limit',retryAt:new Date(Date.now()+600000).toISOString(),error:'Provider cooldown'};await y.media.acquire(paper);assert.equal(network,0);assert.equal(y.media.state.outcomes[paper.id].httpStatus,429);}finally{await y.cleanup();}
  }finally{await x.cleanup();}
});

test('stopping binary upload and restarting resumes one pending attachment and does not start another media job',async()=>{
  const x=await fixture();try{
    await x.connect();await x.client.authorize();const original=x.client.uploadFile.bind(x.client);let entered;const ready=new Promise(resolve=>entered=resolve);
    x.client.uploadFile=async(url,buffer,type,signal)=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};const plan=await x.manager.preview(paper);x.manager.apply(paper,{planId:plan.planId,approved:true,extract:false});await ready;assert.throws(()=>x.media.start({mode:'paper',paperId:paper.id}),/실행 중/);x.manager.stop();await x.manager.promise;assert.equal(x.manager.job().status,'interrupted');
    x.client.uploadFile=original;const restarted=new PdfAcquisition({state:x.dir,media:x.media,client:x.client,getIndex:x.getIndex}),next=await restarted.preview(paper);restarted.apply(paper,{planId:next.planId,approved:true,extract:false});await restarted.promise;assert.equal(restarted.job().status,'complete',restarted.job().error);assert.equal([...x.state.items.values()].filter(i=>i.data.itemType==='attachment').length,1);
  }finally{await x.cleanup();}
});

test('a matching existing SHA-256 PDF needs no write authorization; denied permission never writes',async()=>{
  const x=await fixture();try{
    await x.connect();await x.addAttachment('EXISTS01');const plan=await x.manager.preview(paper);assert.equal(plan.action,'already_saved');x.manager.apply(paper,{planId:plan.planId,approved:true,extract:false});await x.manager.promise;assert.equal(x.manager.job().status,'complete',x.manager.job().error);assert.equal(x.state.writes,0);
    x.state.deny=true;await assert.rejects(x.client.authorize(),e=>e.httpStatus===403);assert.equal(x.state.writes,0);await assert.rejects(x.client.uploadFile('https://external.example/upload/secret',bytes,'application/pdf'),e=>e.code==='INVALID_UPLOAD');
  }finally{await x.cleanup();}
});

test('API recheck retains unrelated cached hashes and manual crops from the SQLite inventory',async()=>{
  const x=await fixture();try{
    const filename=await x.addAttachment('CACHE001');x.state.items.set('OTHER001',{key:'OTHER001',version:1,data:{itemType:'journalArticle',title:'A Different Wearable Sensor Representation Research Paper'}});const other=await x.addAttachment('CACHE002',Buffer.from('%PDF-1.7 other'),'OTHER001'),stat=await fs.stat(other);
    x.media.library.records=[{id:'zotero:CACHE002',itemKey:'OTHER001',attachmentKey:'CACHE002',source:'zotero',title:'A Different Wearable Sensor Representation Research Paper',path:other,exists:true,size:stat.size,hash:'f'.repeat(64),hashStamp:`${stat.size}:${stat.mtimeMs}`}];x.media.state.figureChoices.fixture={mode:'manual',pdfHash:'f'.repeat(64),figureId:'custom-fixture'};x.media.state.customFigures['f'.repeat(64)]=[{id:'custom-fixture',kind:'custom'}];x.media.save();
    await scanLocalAPI(x.media,x.client);assert.equal(x.media.library.records.find(r=>r.id==='zotero:CACHE002').hash,'f'.repeat(64));assert.equal(x.media.state.figureChoices.fixture.figureId,'custom-fixture');assert.equal(x.media.state.customFigures['f'.repeat(64)].length,1);assert.deepEqual(await fs.readFile(filename),bytes);
  }finally{await x.cleanup();}
});

test('malformed authorization responses never echo credentials and a denied replacement drops the old memory key',async()=>{
  const secret='X'.repeat(32),client=new ZoteroClient({fetchFn:async url=>new Response(new URL(url).pathname==='/api/'?'{}':'{"key":"'+secret+'", malformed',{headers:{'Zotero-Server-ID':'fixture-server','Zotero-API-Version':'3'}})});
  await assert.rejects(client.authorize(),e=>e.code==='INVALID_RESPONSE'&&!e.message.includes(secret));assert.equal(client.credentials().authorized,false);
  const x=await fixture();try{await x.client.authorize();assert.equal(x.client.credentials().authorized,true);x.state.deny=true;await assert.rejects(x.client.authorize(),e=>e.httpStatus===403);assert.equal(x.client.credentials().authorized,false);}finally{await x.cleanup();}
});
