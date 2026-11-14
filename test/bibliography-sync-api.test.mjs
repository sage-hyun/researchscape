import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {normalize} from '../lib/extract.mjs';
import {loadJSON} from '../lib/local-store.mjs';

test('the server stops an in-flight lookup, resumes provider checkpoints after restart, and preserves personal records',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-sync-api-'));
  const data=path.join(temp,'data'),state=path.join(temp,'state');await fs.mkdir(data);await fs.mkdir(state);
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),title='Novel Motion Representation Learning with Inertial Sensors',candidateId=`title:${normalize(title)}`;
  const text=`PRIVATE_CONTEXT_MUST_STAY_LOCAL **${title}** 논문`,project='g-p-fixture-research';
  const originals={
    [path.join(data,'conversations.json')]:[{id:'conversation',title:'PRIVATE_PROJECT_NAME',conversation_template_id:project,current_node:'message',mapping:{message:{parent:null,message:{id:'message',author:{role:'user'},create_time:123,content:{parts:[text]}}}}}],
    [path.join(state,'reviews.json')]:{[candidateId]:{status:'confirmed',itemKey:'LIBR1234',pdfKey:'TEST1234'}},
    [path.join(state,'projects.json')]:{[project]:{name:'Private research',category:'research'}},
    [path.join(state,'conversation-labels.json')]:{conversation:{category:'coursework'}},
    [path.join(state,'bibliography-decisions.json')]:{'name:fixture-unrelated':{action:'separate',updatedAt:'fixture'}}
  };
  for(const [file,value] of Object.entries(originals))await fs.writeFile(file,JSON.stringify(value));
  const originalBytes=await Promise.all(Object.keys(originals).map(file=>fs.readFile(file,'utf8')));
  // Isolate all outbound fetches inside the child. The first OpenAlex request waits for
  // cancellation; a marker enables the same request to succeed after the server restarts.
  const preload=path.join(temp,'provider-fixture.mjs');
  await fs.writeFile(preload,`
    import fs from 'node:fs';import path from 'node:path';
    const directory=process.env.RESEARCHSCAPE_PROVIDER_FIXTURE,title=${JSON.stringify(title)};
    globalThis.fetch=async(input,options={})=>{
      const u=new URL(input);fs.appendFileSync(path.join(directory,'requests.jsonl'),JSON.stringify({url:u.href})+'\\n');
      const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
      if(u.hostname==='api.crossref.org')return json({message:{items:[]}});
      if(u.hostname==='api.openalex.org'){
        if(!fs.existsSync(path.join(directory,'resume')))return new Promise((resolve,reject)=>{options.signal.throwIfAborted();options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
        return json({results:[{id:'https://openalex.org/Wfixture',doi:'https://doi.org/10.1234/novel',title,publication_year:2025,type:'article',authorships:[{author:{display_name:'Fixture Author'}}],primary_location:{landing_page_url:'https://publisher.example/paper',pdf_url:'https://publisher.example/paper.pdf'}}]});
      }
      throw new Error('Unexpected provider in fixture');
    };
  `);
  let child,url;
  async function start(){
    child=spawn(process.execPath,['--import',pathToFileURL(preload).href,path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state,RESEARCHSCAPE_PROVIDER_FIXTURE:temp,OPENALEX_API_KEY:'',SEMANTIC_SCHOLAR_API_KEY:''},stdio:['ignore','pipe','pipe']});
    let logs='';child.stderr.on('data',d=>logs+=d);
    url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs||'Server did not start')),10000);child.stdout.on('data',d=>{logs+=d;const match=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(match){clearTimeout(timer);resolve(match[1]);}});child.on('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(new Error(logs||'Server exited before startup'));});});
  }
  async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
  const get=async route=>(await fetch(url+route)).json();
  const post=(route,body={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const requests=async()=>{try{return (await fs.readFile(path.join(temp,'requests.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  const until=async predicate=>{const end=Date.now()+10000;while(Date.now()<end){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Fixture condition timed out');};
  try{
    await start();const initial=await get('/api/paper?id='+candidateId),mention=initial.mentions[0];
    assert.equal((await post('/api/bibliography/sync',{limit:1})).status,202);
    await until(async()=> (await requests()).some(r=>r.url.includes('api.openalex.org')));
    assert.equal((await post('/api/bibliography/stop')).status,200);
    const interrupted=await until(async()=>{const d=await get('/api/bibliography');return !d.job.running&&d;});
    assert.equal(interrupted.job.stage,'interrupted');
    const checkpoint=loadJSON(state,'bibliography.json',{}),titleKey=`title:${normalize(title)}`;
    assert.equal(checkpoint.providerLookups['crossref|'+titleKey].status,'not-found');assert.equal(checkpoint.providerLookups['openalex|'+titleKey],undefined);
    await stop();await fs.writeFile(path.join(temp,'resume'),'ready');await start();
    assert.equal((await post('/api/bibliography/sync',{limit:1})).status,202);
    const completed=await until(async()=>{const d=await get('/api/bibliography');return !d.job.running&&d;});
    assert.equal(completed.job.stage,'complete');assert.equal(completed.job.requests,1);
    const linked=await get('/api/paper?id='+candidateId);
    assert.equal(linked.paper.metadata.provider,'OpenAlex');assert.equal(linked.paper.title,title);assert.equal(linked.paper.count,1);
    assert.equal(linked.paper.status,'confirmed');assert.equal(linked.paper.itemKey,'LIBR1234');assert.equal(linked.paper.pdfKey,'TEST1234');assert.ok(linked.paper.links.pdf.length);
    for(const key of ['quote','excerpt','contentHash','date','role','conversationId','messageId','start','end'])assert.equal(linked.mentions[0][key],mention[key]);
    assert.equal(linked.mentions[0].category,'coursework');assert.equal(linked.mentions[0].projectId,project);
    const sent=await requests();assert.equal(sent.filter(r=>r.url.includes('crossref')).length,1);assert.equal(sent.filter(r=>r.url.includes('openalex')).length,2);
    assert.ok(!JSON.stringify(sent).includes('PRIVATE_CONTEXT'));assert.ok(!JSON.stringify(sent).includes('PRIVATE_PROJECT'));
    assert.equal((await post('/api/bibliography/sync',{limit:1})).status,202);
    const cached=await until(async()=>{const d=await get('/api/bibliography');return !d.job.running&&d;});assert.equal(cached.job.requests,0);assert.equal((await requests()).length,sent.length);
    for(const [i,file] of Object.keys(originals).entries())assert.equal(await fs.readFile(file,'utf8'),originalBytes[i]);
  }finally{await stop();const absolute=path.resolve(temp);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(absolute,{recursive:true,force:true});}
});
