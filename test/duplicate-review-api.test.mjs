import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {crossrefRecord} from '../lib/bibliography.mjs';

test('HTTP duplicate download, partial import, restart and explicit merge preserve personal state and original mentions',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rs-duplicate-api-')),data=path.join(directory,'data'),state=path.join(directory,'state');await fs.mkdir(data);await fs.mkdir(state);
  const title='An Inertial Motion Foundation Model for Human Activity Recognition',records=['alpha','beta'].map((n,i)=>crossrefRecord({DOI:'10.4242/'+n,title:[title+(i?' Revisited':'')],author:[{given:'Synthetic',family:'Author'}]}));
  const source=JSON.stringify([{id:'synthetic-conversation',title:'PRIVATE_CONVERSATION',current_node:'b',mapping:{a:{parent:null,message:{id:'a',author:{role:'user'},create_time:1,content:{parts:[`**${records[0].title}** https://doi.org/10.4242/alpha PRIVATE_CHAT`]}}},b:{parent:'a',message:{id:'b',author:{role:'assistant'},create_time:2,content:{parts:[`**${records[1].title}** https://doi.org/10.4242/beta`]}}}}}]);
  const originals={'reviews.json':JSON.stringify({'doi:10.4242/alpha':{status:'confirmed',itemKey:'KEEP0001',pdfKey:'KEEP0002'}}),'projects.json':JSON.stringify({synthetic:{name:'PRIVATE_PROJECT'}}),'bibliography.json':JSON.stringify({records:Object.fromEntries(records.map(r=>[r.id,r])),lookups:{}})};
  await fs.writeFile(path.join(data,'conversations.json'),source);for(const [name,text]of Object.entries(originals))await fs.writeFile(path.join(state,name),text);
  await fs.mkdir(path.join(state,'media'));const media=JSON.stringify({figureChoices:{'doi:10.4242/alpha':{figureId:'manual-crop',mode:'manual'}},customFigures:{synthetic:[{id:'manual-crop'}]}});await fs.writeFile(path.join(state,'media/state.json'),media);
  let child,url;const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  async function start(){child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state},stdio:['ignore','pipe','pipe']});let logs='';child.stderr.on('data',b=>logs+=b);url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);child.stdout.on('data',b=>{logs+=b;const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('error',reject);});}
  async function stop(){if(child?.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
  const get=async route=>(await fetch(url+route)).json(),post=async(route,body)=>{const response=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {httpStatus:response.status,...await response.json()};};
  async function ready(id){for(let n=0;n<100;n++){const job=await get('/api/bibliography/review/import?id='+id);if(!job.running)return job;await new Promise(r=>setTimeout(r,20));}throw Error('Import did not finish');}
  try{
    await start();const before=await get('/api/overview'),bundle=await get('/api/bibliography/export?format=bundle');
    assert.equal(bundle.total,0);assert.equal(bundle.duplicateReview.pairs.length,1);assert.deepEqual(Object.keys(bundle.instructions.duplicateReview.decisions),['same_paper','same_work_different_version','different','uncertain']);
    const text=JSON.stringify(bundle);for(const secret of ['PRIVATE_CHAT','PRIVATE_CONVERSATION','PRIVATE_PROJECT','KEEP0001','KEEP0002'])assert.equal(text.includes(secret),false);
    const pair=bundle.duplicateReview.pairs[0],originalMentions=(await Promise.all(pair.paperIds.map(id=>get('/api/paper?id='+encodeURIComponent(id))))).flatMap(p=>p.mentions),value={...bundle.resultTemplate,duplicateSuggestions:[{pairId:pair.pairId,paperIds:pair.paperIds,decision:'same_paper',evidence:[{type:'author-year-match',detail:'Synthetic test suggestion only.'}],identifiers:{doi:bundle.duplicateReview.subjects.flatMap(s=>s.doi),arxiv:[]},needsManualReview:true}]};
    const imported=await post('/api/bibliography/review/import',value);assert.equal(imported.httpStatus,202);const id=imported.job.id;
    assert.equal((await ready(id)).duplicateReview.proposed,1);assert.equal(await fs.readFile(path.join(state,'bibliography-decisions.json'),'utf8').catch(()=>null),null,'import must not approve a merge');
    await stop();await start();assert.equal((await get('/api/bibliography')).reviewImport.id,id);
    const q=await get('/api/bibliography/review/queue?'+new URLSearchParams({importId:id,status:'pending'})),row=q.rows.find(r=>r.mergeSource.paperId===pair.paperIds[0]),target=q.libraryTargets.find(t=>t.paperId===pair.paperIds[1]);
    assert.ok(row.mergeSuggestions.includes(target.paperId));assert.equal(row.defaultAction,'');
    const selection={candidateId:row.candidateId,token:row.token,action:'merge',targetPaperId:target.paperId,targetToken:target.token};
    assert.equal((await post('/api/bibliography/review/queue/apply',{importId:id,selections:[selection]})).httpStatus,400);
    assert.equal((await post('/api/bibliography/review/queue/apply',{importId:id,approved:true,selections:[selection]})).merged,1);
    assert.equal((await get('/api/bibliography/review/import?id='+id)).duplicateReview.applied,1);
    const combined=await get('/api/paper?id='+encodeURIComponent(pair.paperIds[0]));assert.equal(combined.paper.id,target.paperId);assert.ok(combined.mentions.every(m=>m.excerpt&&m.quote));
    for(const m of originalMentions)assert.ok(combined.mentions.some(v=>v.conversationId===m.conversationId&&v.messageId===m.messageId&&v.start<=m.start&&v.end>=m.end),'all original evidence is covered; overlapping same-span mentions are deduplicated');
    assert.equal((await get('/api/overview')).stats.conversations,before.stats.conversations);assert.equal((await post('/api/bibliography/review/import',value)).duplicate,true);
    for(const [name,text]of Object.entries(originals))assert.equal(await fs.readFile(path.join(state,name),'utf8'),text);
    assert.equal(await fs.readFile(path.join(data,'conversations.json'),'utf8'),source);assert.equal(await fs.readFile(path.join(state,'media/state.json'),'utf8'),media);
    assert.equal((await post('/api/bibliography/review/queue/apply',{importId:id,approved:true,selections:[selection]})).applied,0);
  }finally{await stop();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});}
});
