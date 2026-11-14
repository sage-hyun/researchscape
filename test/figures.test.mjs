import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {FigureManager,FIGURE_SCHEMA_VERSION} from '../lib/figure-manager.mjs';
import {saveJSON,loadJSON} from '../lib/local-store.mjs';

const title='A Specific Motion Representation Learning Research Paper';
const paper={id:'title:fixture',title,aliases:[],identifiers:[],count:5,memberIds:['title:fixture','legacy:fixture']};
const option=(args,name)=>args[args.indexOf(name)+1];
const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64');
async function fixture(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-figures-')),source=path.join(dir,'original.pdf');await fs.writeFile(source,'%PDF-1.7\ncontrolled fixture');let extractionCalls=0,inspections=0;
  const record={id:'zotero:TEST1234',source:'zotero',attachmentKey:'TEST1234',itemKey:'ITEM1234',title,path:source,exists:true,size:26,mtime:1};
  const worker=async(root,script,args,{signal}={})=>{
    signal?.throwIfAborted();
    if(script==='zotero-library.py')return {records:[record],available:1,total:1,snapshotMode:'fixture'};
    if(args[0]==='inspect'){inspections++;return {pages:2,metadata:{Title:title},firstPageText:title,pageSizes:[[600,800],[600,800]]};}
    if(args[0]==='render'){await fs.writeFile(option(args,'--output'),webp);return {width:100,height:100,bbox:JSON.parse(option(args,'--bbox')||'[0,0,600,800]')};}
    extractionCalls++;const pdf=option(args,'--pdf'),hash=createHash('sha256').update(await fs.readFile(pdf)).digest('hex'),output=option(args,'--output');await fs.mkdir(output,{recursive:true});
    const figures=[{id:'figure-1-p1',number:'1',page:1,caption:'Figure 1. Pipeline',file:'figure-1.webp',kind:'figure'},{id:'figure-2-p2',number:'2',page:2,caption:'Figure 2. Results',file:'figure-2.webp',kind:'figure'},{id:'page-1',number:null,page:1,caption:'First page',file:'page-1.webp',kind:'page'}];
    for(const f of figures)await fs.writeFile(path.join(output,f.file),webp);
    return {version:FIGURE_SCHEMA_VERSION,pdfHash:hash,pages:2,pageSizes:[[600,800],[600,800]],figures,defaultFigureId:'figure-1-p1'};
  };
  const manager=new FigureManager({root:dir,state:dir,getPapers:()=>[paper],worker});await manager.scanZotero(dir);
  return {dir,source,manager,worker,calls:()=>({extractionCalls,inspections}),cleanup:async()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});}};
}
test('Figure 1 defaults, manual choice persistence, PDF hash caching and re-extraction work together',async()=>{
  const x=await fixture();try{
    const before=await fs.readFile(x.source);await x.manager.extract(paper);assert.equal(x.manager.summary(paper).thumbnail.figureId,'figure-1-p1');
    x.manager.chooseFigure(paper,'figure-2-p2');await x.manager.extract(paper);assert.equal(x.calls().extractionCalls,1);
    await x.manager.extract(paper,{force:true});assert.equal(x.calls().extractionCalls,2);assert.equal(x.manager.summary(paper).thumbnail.figureId,'figure-2-p2');
    const restarted=new FigureManager({root:x.dir,state:x.dir,getPapers:()=>[paper],worker:x.worker});assert.equal(restarted.detail(paper).thumbnail.mode,'manual');assert.equal(restarted.detail(paper).thumbnail.figureId,'figure-2-p2');
    restarted.chooseFigure(paper,null,{auto:true});assert.equal(restarted.summary(paper).thumbnail.figureId,'figure-1-p1');assert.deepEqual(await fs.readFile(x.source),before);
  }finally{await x.cleanup();}
});
test('manual crops survive parsing and conflicting inherited thumbnails never silently choose one',async()=>{
  const x=await fixture();try{
    await x.manager.extract(paper);const cropped=await x.manager.crop(paper,{page:2,rect:[.1,.2,.8,.9]});assert.equal(cropped.thumbnail.kind,'custom');const id=cropped.thumbnail.figureId;
    const custom=cropped.figures.find(f=>f.id===id);assert.deepEqual(custom.bbox,[60,79.99999999999999,480,640]);
    await x.manager.extract(paper,{force:true});assert.equal(x.manager.summary(paper).thumbnail.figureId,id);
    const hash=x.manager.match(paper).selected.hash;x.manager.state.figureChoices['legacy:fixture']={pdfHash:hash,mode:'manual',figureId:'figure-1-p1'};x.manager.save();
    assert.equal(x.manager.summary(paper).selectionConflict,true);assert.equal(x.manager.summary(paper).thumbnail,null);
    x.manager.chooseFigure(paper,'figure-2-p2');assert.equal(x.manager.summary(paper).selectionConflict,false);
    await assert.rejects(x.manager.crop(paper,{page:1,rect:[-.1,.1,.2,.2]}));assert.equal(x.manager.imagePath(hash,'../../private'),null);assert.equal(x.manager.imagePath('../../private',id),null);
  }finally{await x.cleanup();}
});
test('manual PDF uploads require PDF magic, preserve review files, and can reuse identical bytes',async()=>{
  const x=await fixture();try{
    const review={personal:{status:'confirmed',pdfKey:'KEEP1234'}},projects={fixture:{category:'research'}};saveJSON(x.dir,'reviews.json',review);saveJSON(x.dir,'projects.json',projects);
    await assert.rejects(x.manager.importPdf(paper,Buffer.from('<html>not a PDF</html>')),/PDF/);
    await x.manager.extract(paper);
    await x.manager.importPdf(paper,await fs.readFile(x.source),{filename:'downloaded.pdf'});assert.equal(x.manager.match(paper).mode,'manual');await x.manager.extract(paper);
    await x.manager.importPdf(paper,await fs.readFile(x.source),{filename:'same.pdf'});assert.equal(Object.keys(x.manager.state.pdfs).length,1);assert.equal(x.manager.summary(paper).status,'ready');
    assert.equal(x.manager.resetPdf(paper).pdf.source,'zotero','identical imported bytes do not make automatic matching ambiguous');
    assert.deepEqual(loadJSON(x.dir,'reviews.json',{}),review);assert.deepEqual(loadJSON(x.dir,'projects.json',{}),projects);
  }finally{await x.cleanup();}
});
test('jobs stop without discarding previous selections and resume using completed artifacts',async()=>{
  const x=await fixture();try{
    await x.manager.extract(paper);x.manager.chooseFigure(paper,'figure-2-p2');
    let entered;const enteredPromise=new Promise(r=>entered=r);
    const previousWorker=x.manager.worker;x.manager.worker=async(root,script,args,options)=>{if(args[0]==='extract'){entered();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}return previousWorker(root,script,args,options);};
    x.manager.start({mode:'paper',paperId:paper.id,force:true,limit:1});await enteredPromise;x.manager.stop();await x.manager.promise;
    assert.equal(x.manager.job.stage,'interrupted');assert.equal(x.manager.summary(paper).thumbnail.figureId,'figure-2-p2');
    const restarted=new FigureManager({root:x.dir,state:x.dir,getPapers:()=>[paper],worker:previousWorker});restarted.start({mode:'paper',paperId:paper.id,limit:1});await restarted.promise;assert.equal(restarted.job.total,0);assert.equal(restarted.job.stage,'complete');
  }finally{await x.cleanup();}
});
test('automatic downloads with unverifiable identities remain a confirmation candidate',async()=>{
  const x=await fixture();try{
    const unknown={...paper,id:'title:unknown',title:'Different Motion Understanding Research for Wearable Sensors',identifiers:[{key:'arxiv:2501.12345',kind:'arxiv',value:'2501.12345',url:'https://arxiv.org/abs/2501.12345'}]};
    x.manager.downloader=async()=>({path:x.source,hash:'a'.repeat(64),size:26,url:'https://arxiv.org/pdf/2501.12345',originalUrl:'https://arxiv.org/pdf/2501.12345'});
    assert.equal(await x.manager.acquire(unknown),false);assert.equal(x.manager.match(unknown).status,'missing');const detail=x.manager.detail(unknown);assert.equal(detail.outcome.status,'needs-pdf-review');assert.ok(detail.match.candidates.some(r=>r.id===detail.outcome.pdfId));
    x.manager.choosePdf(unknown,detail.outcome.pdfId);assert.equal(x.manager.match(unknown).mode,'manual');
  }finally{await x.cleanup();}
});

test('pilot mode limits extraction and displayed assets while preserving larger existing caches',async()=>{
  const x=await fixture();try{
    await x.manager.extract(paper);const allowed=x.manager.match(paper).selected.hash;
    const otherHash='b'.repeat(64),otherPaper={...paper,id:'title:outside',memberIds:[],title:'Another Specific Inertial Motion Estimation Research Paper'},otherPdf=path.join(x.dir,'outside.pdf');await fs.writeFile(otherPdf,'%PDF-other-existing-cache');
    const directory=path.join(x.manager.directory,'figures',otherHash);await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'figure-1.webp'),webp);
    x.manager.state.pdfs.outside={id:'outside',title:otherPaper.title,path:otherPdf,hash:otherHash,exists:true,source:'download',identifiers:[]};x.manager.state.artifacts[otherHash]={...x.manager.state.artifacts[allowed],pdfHash:otherHash};x.manager.save();
    saveJSON(x.manager.directory,'test-scope.json',{enabled:true,pdfHashes:[allowed],items:[{paperId:paper.id,title:paper.title,pdfHash:allowed}]});x.manager.refresh();
    assert.equal(x.manager.summary(paper).status,'ready');assert.equal(x.manager.summary(otherPaper).status,'outside-pilot');assert.equal(x.manager.detail(otherPaper).figures.length,0);assert.equal(x.manager.imagePath(otherHash,'figure-1-p1'),null);
    const calls=x.calls().extractionCalls;await assert.rejects(x.manager.extract(otherPaper),/시험/);await assert.rejects(x.manager.acquire(otherPaper),/시험/);assert.equal(x.calls().extractionCalls,calls);
    assert.throws(()=>x.manager.start({mode:'all'}),/시험/);assert.throws(()=>x.manager.start({mode:'paper',paperId:otherPaper.id}),/시험/);
    assert.equal(Object.keys(x.manager.state.artifacts).length,2);assert.deepEqual(await fs.readFile(path.join(directory,'figure-1.webp')),webp);assert.equal(x.manager.overview().testScope.ready,1);
  }finally{await x.cleanup();}
});

test('explicit Zotero library jobs include unmatched PDFs, deduplicate content, reuse cache and retry failures without changing user choices',async()=>{
  const x=await fixture();try{
    await x.manager.extract(paper);x.manager.chooseFigure(paper,'figure-2-p2');
    const original=await fs.readFile(x.source),existing=x.manager.match(paper).selected,baseWorker=x.worker;
    const extraPath=path.join(x.dir,'unmatched.pdf'),badPath=path.join(x.dir,'temporarily-failing.pdf');
    await fs.writeFile(extraPath,'%PDF-1.7\nnew unrelated Zotero paper');await fs.writeFile(badPath,'%PDF-1.7\ncontrolled failure');
    const records=[existing,{...existing,id:'zotero:DUPL1234',attachmentKey:'DUPL1234'},
      {id:'zotero:MORE1234',source:'zotero',title:'An Unmatched Research Document Outside the Chat Export',path:extraPath,exists:true},
      {id:'zotero:FAIL1234',source:'zotero',title:'Another Unmatched Zotero Document',path:badPath,exists:true},
      {id:'zotero:GONE1234',source:'zotero',title:'Not Downloaded Attachment',path:path.join(x.dir,'missing.pdf'),exists:false}];
    let fail=true,downloadCalls=0;
    const worker=async(root,script,args,options)=>{
      if(script==='zotero-library.py')return {records,available:4,total:5};
      if(fail&&args[0]==='extract'&&option(args,'--pdf')===badPath)throw new Error('Controlled PDF parser failure');
      return baseWorker(root,script,args,options);
    };
    x.manager.worker=worker;x.manager.downloader=async()=>{downloadCalls++;throw new Error('Downloads forbidden in this fixture');};
    const protectedFiles={'reviews.json':{keep:{status:'confirmed',itemKey:'KEEP1234'}},'projects.json':{fixture:{category:'research'}},'bibliography-decisions.json':{fixture:{action:'separate'}}};
    for(const [file,value] of Object.entries(protectedFiles))saveJSON(x.dir,file,value);
    saveJSON(x.manager.directory,'test-scope.json',{enabled:true,pdfHashes:[existing.hash],items:[]});x.manager.refresh();assert.equal(x.manager.testScope.enabled,true);
    x.manager.start({mode:'zotero-all'});await x.manager.promise;
    assert.equal(x.manager.testScope.enabled,false);assert.equal(x.manager.testScope.expandedBy,'zotero-all');
    assert.equal(x.manager.job.stage,'complete');assert.equal(x.manager.job.pdfCount,4);assert.equal(x.manager.job.total,3);assert.equal(x.manager.job.completed,3);
    assert.equal(x.manager.job.cached,1);assert.equal(x.manager.job.extracted,1);assert.equal(x.manager.job.duplicates,1);assert.equal(x.manager.job.errors,1);
    assert.equal(x.manager.overview().zotero.figureReady,3);assert.equal(x.manager.overview().zotero.failureCount,1);assert.equal(downloadCalls,0);
    assert.equal(x.manager.summary(paper).thumbnail.figureId,'figure-2-p2');assert.equal(x.manager.getPapers().length,1,'unmatched PDFs are cached without inventing new paper matches');
    fail=false;const restarted=new FigureManager({root:x.dir,state:x.dir,getPapers:()=>[paper],worker});
    restarted.start({mode:'zotero-all'});await restarted.promise;
    assert.equal(restarted.job.cached,2);assert.equal(restarted.job.extracted,1);assert.equal(restarted.job.errors,0);assert.equal(restarted.overview().zotero.figureReady,4);assert.equal(restarted.overview().zotero.failureCount,0);
    assert.equal(restarted.summary(paper).thumbnail.figureId,'figure-2-p2');assert.deepEqual(await fs.readFile(x.source),original);
    for(const [file,value] of Object.entries(protectedFiles))assert.deepEqual(loadJSON(x.dir,file,{}),value);
  }finally{await x.cleanup();}
});

test('whole Zotero library extraction can stop mid-PDF and resume after a server restart',async()=>{
  const x=await fixture();try{
    await x.manager.extract(paper);x.manager.chooseFigure(paper,'figure-2-p2');
    const second=path.join(x.dir,'second.pdf');await fs.writeFile(second,'%PDF-1.7\nsecond unmatched document');
    const records=[x.manager.match(paper).selected,{id:'zotero:NEXT1234',title:'A Second Unmatched Research Document',source:'zotero',path:second,exists:true}];
    let entered;const ready=new Promise(resolve=>entered=resolve),baseWorker=x.worker;
    const resumedWorker=(root,script,args,options)=>script==='zotero-library.py'?Promise.resolve({records,available:2,total:2}):baseWorker(root,script,args,options);
    x.manager.worker=async(root,script,args,options)=>{
      if(args[0]==='extract'&&option(args,'--pdf')===second){entered();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}
      return resumedWorker(root,script,args,options);
    };
    x.manager.start({mode:'zotero-all'});await Promise.race([ready,x.manager.promise.then(()=>{throw new Error('Job stopped before reaching the controlled PDF: '+x.manager.job.error);})]);
    assert.throws(()=>x.manager.start({mode:'zotero-all'}),/이미/);
    x.manager.stop();await x.manager.promise;assert.equal(x.manager.job.stage,'interrupted');assert.equal(x.manager.job.cached,1);assert.equal(x.manager.job.completed,1);
    const restarted=new FigureManager({root:x.dir,state:x.dir,getPapers:()=>[paper],worker:resumedWorker});restarted.start({mode:'zotero-all'});await restarted.promise;
    assert.equal(restarted.job.stage,'complete');assert.equal(restarted.job.cached,1);assert.equal(restarted.job.extracted,1);assert.equal(restarted.overview().zotero.figureReady,2);assert.equal(restarted.summary(paper).thumbnail.figureId,'figure-2-p2');
  }finally{await x.cleanup();}
});
