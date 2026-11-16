import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {normalize} from '../lib/extract.mjs';
import {FIGURE_SCHEMA_VERSION} from '../lib/figure-manager.mjs';

test('PDF/Figure APIs display cached images and preserve manual thumbnails, reviews and provenance across restart',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-media-api-')),data=path.join(temp,'data'),state=path.join(temp,'state'),media=path.join(state,'media');await fs.mkdir(data);await fs.mkdir(media,{recursive:true});
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),title='A Specific Motion Representation Learning Research Paper',id='title:'+normalize(title),pdf=Buffer.from('%PDF-1.7\ncontrolled fixture'),hash=createHash('sha256').update(pdf).digest('hex'),pdfFile=path.join(temp,'source.pdf'),imageDir=path.join(media,'figures',hash);await fs.writeFile(pdfFile,pdf);await fs.mkdir(imageDir,{recursive:true});
  const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64');
  const figures=[{id:'figure-1-p1',number:'1',kind:'figure',page:1,file:'one.webp',caption:'Figure 1. Pipeline'},{id:'figure-2-p2',number:'2',kind:'figure',page:2,file:'two.webp',caption:'Figure 2. Results'}];for(const f of figures)await fs.writeFile(path.join(imageDir,f.file),webp);await fs.writeFile(path.join(imageDir,'page-preview-2.webp'),webp);
  const originals={
    [path.join(data,'conversations.json')]:[{id:'fixture-conversation',title:'Fixture',current_node:'m',mapping:{m:{parent:null,message:{id:'m',author:{role:'user'},create_time:123,content:{parts:[`**${title}** 논문`]}}}}}],
    [path.join(state,'reviews.json')]:{[id]:{status:'confirmed',itemKey:'ITEM1234',pdfKey:'TEST1234'}},
    [path.join(state,'projects.json')]:{'g-p-fixture-project':{name:'Fixture research',category:'research'}}
  };for(const [file,value] of Object.entries(originals))await fs.writeFile(file,JSON.stringify(value));
  await fs.writeFile(path.join(media,'zotero.json'),JSON.stringify({records:[{id:'zotero:TEST1234',attachmentKey:'TEST1234',itemKey:'ITEM1234',source:'zotero',title,path:pdfFile,exists:true,hash}],available:1,total:1}));
  await fs.writeFile(path.join(media,'state.json'),JSON.stringify({artifacts:{[hash]:{version:FIGURE_SCHEMA_VERSION,pdfHash:hash,pages:2,pageSizes:[[600,800],[600,800]],figures,defaultFigureId:'figure-1-p1'}}}));
  const legacyPilot=JSON.stringify({enabled:true,pdfHashes:[],items:[]});await fs.writeFile(path.join(media,'test-scope.json'),legacyPilot);
  const before=await Promise.all(Object.keys(originals).map(file=>fs.readFile(file,'utf8')));let child,url;
  async function start(){child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state,RESEARCHSCAPE_FIGURE_PYTHON:path.join(temp,'not-needed-python')},stdio:['ignore','pipe','pipe']});let logs='';child.stderr.on('data',d=>logs+=d);url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),10000);child.stdout.on('data',d=>{logs+=d;const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('error',e=>{clearTimeout(timer);reject(e);});});}
  async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
  const get=async route=>(await fetch(url+route)).json(),post=(route,d={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
  try{
    await start();const overview=await get('/api/overview'),p=overview.papers[0];assert.equal(p.media.thumbnail.figureId,'figure-1-p1');assert.equal(p.status,'confirmed');assert.equal(p.pdfKey,'TEST1234');
    assert.equal((await get('/api/media')).testScope.enabled,false);assert.equal((await get('/api/acquisition')).testMode,false);assert.equal((await get('/api/media')).job.running,false);
    const image=await fetch(url+p.media.thumbnail.url);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/webp');assert.deepEqual(Buffer.from(await image.arrayBuffer()),webp);
    assert.equal((await fetch(url+'/api/media/image?pdf=../../private&figure=one')).status,404);
    const library=await get('/api/media/library');assert.equal(library.records.length,1);assert.ok(!JSON.stringify(library).includes(temp));
    assert.equal((await fetch(url+'/api/media/pdf?pdf='+encodeURIComponent('zotero:TEST1234'))).headers.get('content-type'),'application/pdf');
    assert.equal((await fetch(url+'/api/media/page?'+new URLSearchParams({id,page:2}))).status,200);assert.equal((await fetch(url+'/api/media/page?'+new URLSearchParams({id,page:99}))).status,400);
    const picked=await post('/api/media/thumbnail',{paperId:id,figureId:'figure-2-p2'});assert.equal(picked.status,200);assert.equal((await picked.json()).thumbnail.mode,'manual');
    assert.equal((await post('/api/media/crop',{paperId:id,page:2,rect:[-1,0,1,1]})).status,400);
    assert.equal((await fetch(url+'/api/media/upload?'+new URLSearchParams({id}),{method:'POST',headers:{'Content-Type':'application/pdf'},body:'<html>not pdf</html>'})).status,400);
    assert.equal((await post('/api/media/thumbnail',{paperId:id,figureId:'figure-1-p1'})).status,200);
    assert.equal((await fetch(url+'/api/media/thumbnail',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://outside.example'},body:JSON.stringify({paperId:id,auto:true})})).status,403);
    await post('/api/media/thumbnail',{paperId:id,figureId:'figure-2-p2'});await stop();await start();
    const detail=await get('/api/media/paper?'+new URLSearchParams({id}));assert.equal(detail.thumbnail.figureId,'figure-2-p2');assert.equal(detail.thumbnail.mode,'manual');assert.equal(detail.figures.length,2);
    assert.equal((await post('/api/media/job',{mode:'paper',paperId:id,limit:1})).status,202);
    for(let n=0;n<50;n++){const d=await get('/api/media');if(!d.job.running){assert.equal(d.job.stage,'complete');assert.equal(d.job.total,0);break;}await new Promise(r=>setTimeout(r,20));}
    const after=await get('/api/paper?'+new URLSearchParams({id}));assert.equal(after.paper.count,1);assert.equal(after.paper.itemKey,'ITEM1234');assert.equal(after.paper.pdfKey,'TEST1234');assert.equal(after.paper.media.thumbnail.figureId,'figure-2-p2');
    for(const [i,file] of Object.keys(originals).entries())assert.equal(await fs.readFile(file,'utf8'),before[i]);
    assert.equal(await fs.readFile(path.join(media,'test-scope.json'),'utf8'),legacyPilot);
  }finally{await stop();assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temp,{recursive:true,force:true});}
});
