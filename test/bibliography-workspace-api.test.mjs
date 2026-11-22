import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {crossrefRecord} from '../lib/bibliography.mjs';

test('unified HTTP review approves weak identifiers and excludes selected non-papers without altering original evidence or Zotero keys',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rs-workspace-api-')),data=path.join(directory,'data'),state=path.join(directory,'state');await fs.mkdir(data);await fs.mkdir(state);
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),record=crossrefRecord({DOI:'10.1234/coma',title:['Generating 3D Faces using Convolutional Mesh Autoencoders'],author:[{given:'Fixture',family:'Author'}]});record.provisional='llm-proposal';
  const body='CoMA 논문 ResNet 논문 Video-to-IMU 논문 NMAL 논문 '+Array.from({length:72},(_,i)=>`MotionFixture${i} 논문`).join(' '),conversation=[{id:'fixture-conversation',title:'Fixture',current_node:'m',mapping:{m:{parent:null,message:{id:'m',author:{role:'user'},create_time:1,content:{parts:[body]}}}}}];
  const source=JSON.stringify(conversation),originalReview={'name:coma':{status:'unreviewed',itemKey:'KEEP0001',pdfKey:'KEEP0002',note:'preserve'},'name:nmal':{status:'unreviewed',itemKey:'KEEP0003',pdfKey:'KEEP0004',note:'preserve source'}},projects={fixture:{name:'Fixture project',category:'research'}};
  await fs.writeFile(path.join(data,'conversations.json'),source);await fs.writeFile(path.join(state,'bibliography.json'),JSON.stringify({records:{[record.id]:record},lookups:{}}));await fs.writeFile(path.join(state,'reviews.json'),JSON.stringify(originalReview));await fs.writeFile(path.join(state,'projects.json'),JSON.stringify(projects));
  const mediaState=JSON.stringify({pdfChoices:{'name:nmal':{pdfId:'fixture-pdf',mode:'manual'}},figureChoices:{'name:nmal':{pdfHash:'a'.repeat(64),figureId:'manual-crop',mode:'manual'}},customFigures:{['a'.repeat(64)]:[{id:'manual-crop',kind:'custom',file:'crop.webp'}]}});await fs.mkdir(path.join(state,'media'));await fs.writeFile(path.join(state,'media/state.json'),mediaState);
  let child,url;
  async function start(){child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state},stdio:['ignore','pipe','pipe']});let logs='';child.stderr.on('data',b=>logs+=b);url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);child.stdout.on('data',b=>{logs+=b;const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('error',reject);});}
  async function stop(){if(child?.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
  const get=async route=>(await fetch(url+route)).json(),post=async(route,body)=>{const r=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,...await r.json()};},queue=(params={})=>get('/api/bibliography/review/queue?'+new URLSearchParams(params));
  try{
    await start();const before=await get('/api/overview'),html=await(await fetch(url+'/')).text();assert.equal(html.includes('id="bibQueue"'),false);assert.ok(html.includes('id="bibBulkAction"'));
    const first=await queue({limit:50,ids:'selectable'});assert.ok(first.total>60);assert.equal(first.selections.length,first.total);assert.equal((await queue({offset:60,limit:50})).rows.length,first.total-60);
    const bundle=await get('/api/bibliography/export?format=bundle');
    const imported=await post('/api/bibliography/review/import',{schemaVersion:2,snapshot:bundle.snapshot,decisions:[{candidateId:'name:coma',decision:'propose',recordId:null,proposal:{doi:'10.1234/coma'},evidence:[{type:'external-identifier',detail:'The paper that introduced CoMA.'}],needsManualReview:false},{candidateId:'name:videotoimu',decision:'separate',recordId:null,evidence:[{type:'insufficient-evidence',detail:'A research direction rather than a paper title.'}],needsManualReview:true},{candidateId:'name:nmal',decision:'defer',recordId:null,evidence:[],needsManualReview:true}]});
    assert.equal(imported.status,202);const importId=imported.job.id;
    for(let i=0;i<100;i++){if(!(await get('/api/bibliography/review/import?id='+importId)).running)break;await new Promise(r=>setTimeout(r,20));}
    const rows=await queue({importId,status:'needs-manual-review',evidence:'external-identifier'});assert.equal(rows.total,1);const row=rows.rows[0];assert.equal(row.selectable,true);assert.equal(row.manualConfirmation,true);assert.equal(row.recordId,record.id);assert.equal(row.verification.status,'weak-link');assert.equal(JSON.stringify(rows).includes('KEEP0001'),false);
    assert.equal(rows.evidenceCatalog.length,10);assert.equal(rows.evidenceCounts['external-identifier'],1);assert.equal(row.evidencePriority,5);
    const ordered=await queue({importId,sort:'evidence'});assert.ok(ordered.rows.every((r,i)=>!i||ordered.rows[i-1].evidencePriority<=r.evidencePriority));
    assert.equal((await get('/api/paper?id=name%3Acoma')).paper.metadata,null);
    const selection={candidateId:row.candidateId,token:row.token,action:'match',recordId:row.recordId};
    assert.equal((await post('/api/bibliography/review/queue/apply',{importId,selections:[selection]})).status,400);
    const applied=await post('/api/bibliography/review/queue/apply',{importId,approved:true,selections:[selection]});assert.equal(applied.matched,1);assert.equal(applied.status,200);
    const paper=await get('/api/paper?id=name%3Acoma');assert.equal(paper.paper.metadata.title,record.title);assert.equal(paper.paper.itemKey,'KEEP0001');assert.equal(paper.paper.pdfKey,'KEEP0002');
    const mergeView=await queue({importId,search:'NMAL'}),sourceRow=mergeView.rows[0],target=mergeView.libraryTargets.find(t=>t.paperId===record.id),mergeSelection={candidateId:sourceRow.candidateId,token:sourceRow.token,action:'merge',targetPaperId:target.paperId,targetToken:target.token};
    const merged=await post('/api/bibliography/review/queue/apply',{importId,approved:true,selections:[mergeSelection]});assert.equal(merged.merged,1);
    const combined=await get('/api/paper?id=name%3Anmal');assert.equal(combined.paper.id,record.id);assert.equal(combined.paper.count,2);assert.ok(combined.paper.memberIds.includes('name:coma'));assert.ok(combined.paper.memberIds.includes('name:nmal'));assert.equal(combined.paper.itemKey,undefined,'conflicting user keys are not silently chosen');assert.deepEqual(new Set(combined.paper.memberReviews.map(r=>r.itemKey)),new Set(['KEEP0001','KEEP0003']));
    assert.equal(combined.mentions.length,2);assert.ok(combined.mentions.every(m=>m.quote&&m.excerpt&&m.conversationId==='fixture-conversation'));
    const remaining=await queue({importId,evidence:'insufficient-evidence'});assert.equal(remaining.total,1);const nonpaper=remaining.rows[0];assert.equal(nonpaper.defaultAction,'separate');
    const dismissed=await post('/api/bibliography/review/queue/apply',{importId,approved:true,selections:[{candidateId:nonpaper.candidateId,token:nonpaper.token,action:'dismiss'}]});assert.equal(dismissed.dismissed,1);assert.equal((await get('/api/paper?id=name%3Avideotoimu')).paper.status,'dismissed');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(state,'reviews.json'),'utf8'))['name:coma'],originalReview['name:coma']);assert.deepEqual(JSON.parse(await fs.readFile(path.join(state,'projects.json'),'utf8')),projects);assert.equal(await fs.readFile(path.join(data,'conversations.json'),'utf8'),source);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(state,'reviews.json'),'utf8'))['name:nmal'],originalReview['name:nmal']);assert.equal(await fs.readFile(path.join(state,'media/state.json'),'utf8'),mediaState);
    const after=await get('/api/overview');assert.equal(after.stats.mentions,before.stats.mentions);assert.equal(after.stats.conversations,before.stats.conversations);
    await stop();await start();assert.equal((await post('/api/bibliography/review/queue/apply',{importId,approved:true,selections:[selection]})).applied,0);assert.equal((await get('/api/bibliography/review/import?id='+importId)).counts.applied,3);assert.equal((await get('/api/paper?id=name%3Anmal')).paper.id,record.id);
  }finally{await stop();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});}
});
