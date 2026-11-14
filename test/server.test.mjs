import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {request} from 'node:http';

test('local import, review, context, reindex and access boundaries work together',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-test-'));
  const data=path.join(temp,'data'),state=path.join(temp,'state');await fs.mkdir(data);
  await fs.mkdir(state);await fs.writeFile(path.join(state,'access.json'),JSON.stringify({publicUrls:['https://fixture.tailnet.ts.net/rs/']}));
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const conv=(text,update_time=1)=>({id:'c1',title:'Fixture conversation',create_time:1,update_time,current_node:'m1',mapping:{m1:{parent:null,message:{id:'m1',author:{role:'user'},create_time:1,content:{parts:[text]}}}}});
  await fs.writeFile(path.join(data,'conversations.json'),JSON.stringify([conv('SlotFM 논문과 RoNIN 논문을 비교하자.')]));
  const child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state},stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',d=>logs+=d);
  try{
    const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout '+logs)),10000);child.stdout.on('data',d=>{logs+=d;const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('error',reject);});
    const get=async route=>(await fetch(url+route)).json();
    const post=(route,body,extra={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
    const overview=await get('/api/overview');assert.equal(overview.stats.conversations,1);assert.equal(overview.stats.mentions,2);
    const id=overview.papers.find(p=>p.title==='SlotFM').id;
    const paper=await get('/api/paper?id='+encodeURIComponent(id));assert.equal(paper.total,1);
    const context=await get('/api/context?cid=c1&mid=m1');assert.equal(context.messages[0].text,'SlotFM 논문과 RoNIN 논문을 비교하자.');
    assert.equal((await post('/api/review',{id,status:'confirmed',pdfKey:'ABCD1234'})).status,200);
    assert.equal((await post('/api/review',{id,status:'confirmed',pdfKey:'<script>'})).status,400);
    assert.equal((await post('/api/reindex',{}, {Origin:'https://external.example'})).status,403);
    const proxy={Host:'fixture.tailnet.ts.net'};
    // fetch/Undici may ignore Host overrides. Use actual HTTP Host headers.
    const proxyRequest=(route,headers=proxy,data)=>new Promise((resolve,reject)=>{
      const req=request(url+route,{method:data?'POST':'GET',headers:{...headers,...(data?{'Content-Type':'application/json'}:{})}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text:async()=>text}));});
      req.on('error',reject);req.end(data?JSON.stringify(data):undefined);
    });
    const page=await proxyRequest('/');assert.equal(page.status,200);
    const html=await page.text();
    for(const path of ['/rs/app.js','/rs/media.js','/rs/style.css','/rs/api/bibliography/export'])assert.ok(html.includes(path),`Missing ${path}: ${html.slice(0,600)}`);
    assert.equal((await proxyRequest('/app.js')).status,200);
    assert.equal((await proxyRequest('/api/overview')).status,200);
    assert.equal((await proxyRequest('/api/review',{...proxy,Origin:'https://fixture.tailnet.ts.net'},{id,status:'confirmed',pdfKey:'ABCD1234'})).status,200);
    assert.equal((await proxyRequest('/api/review',{...proxy,Origin:'https://outside.example'},{id,status:'dismissed'})).status,403);
    assert.equal((await proxyRequest('/',{Host:'other.tailnet.ts.net'})).status,403);
    assert.equal((await fetch(url+'/data/conversations.json')).status,404);
    const pasted={title:'Added source',text:'SlotFM 논문을 추가로 검토해보자.'};
    assert.equal((await post('/api/import',pasted)).status,200);
    assert.equal((await (await post('/api/import',pasted)).json()).duplicate,true);
    const before=await get('/api/overview');assert.equal(before.stats.conversations,2);assert.equal(before.stats.mentions,3);
    assert.equal((await post('/api/reindex',{})).status,200);
    assert.equal((await get('/api/overview')).stats.mentions,3);
    await fs.writeFile(path.join(data,'conversations.json'),JSON.stringify([conv('SlotFM 논문만 남겼다.',2)]));
    assert.equal((await post('/api/reindex',{})).status,200);
    const after=await get('/api/overview');assert.equal(after.stats.mentions,2);assert.equal(after.papers.length,1);assert.equal(after.papers[0].status,'confirmed');assert.equal(after.papers[0].pdfKey,'ABCD1234');
  }finally{const done=once(child,'exit');child.kill();await done;await fs.rm(temp,{recursive:true,force:true});}
});

test('date-scoped overview, graph and paginated details share the same message interval',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-dates-'));
  const data=path.join(temp,'data'),state=path.join(temp,'state');await fs.mkdir(data);
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const ts=s=>Date.parse(s)/1000;
  function conversation(id,entries){const mapping={};entries.forEach(([text,date,role='user'],i)=>mapping[id+i]={parent:i?id+(i-1):null,message:{id:id+i,author:{role},create_time:ts(date),content:{parts:[text]}}});return {id,title:id,create_time:ts(entries[0][1]),current_node:id+(entries.length-1),mapping};}
  await fs.writeFile(path.join(data,'conversations.json'),JSON.stringify([
    conversation('old-thread',[
      ['SlotFM 논문','2026-10-31T23:59:59+09:00'],
      ['SlotFM 논문','2026-11-01T00:00:00+09:00','assistant'],
      ['RoNIN 논문','2026-11-01T23:59:59.999+09:00'],
      ['SlotFM 논문','2026-11-02T00:00:00+09:00']]),
    conversation('outside', [['SlotFM 논문과 RoNIN 논문','2026-11-02T12:00:00+09:00']]),
    conversation('plain', [['일반 대화 내용','2026-11-01T12:00:00+09:00']])
  ]));
  const child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state},stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',d=>logs+=d);
  try{
    const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout '+logs)),10000);child.stdout.on('data',d=>{logs+=d;const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('error',reject);});
    const query='from=2026-11-01&to=2026-11-01';
    const get=async route=>(await fetch(url+route)).json();
    const scoped=await get('/api/overview?'+query);
    assert.equal(scoped.stats.conversations,2);assert.equal(scoped.stats.messages,3);assert.equal(scoped.stats.mentions,2);assert.equal(scoped.stats.papers,2);
    const slot=scoped.papers.find(p=>p.title==='SlotFM');assert.equal(slot.count,1);assert.equal(slot.userCount,0);assert.equal(slot.assistantCount,1);
    const paper=await get('/api/paper?id=name:slotfm&'+query);assert.equal(paper.total,1);assert.equal(paper.mentions[0].messageId,'old-thread1');
    assert.equal((await get('/api/paper?id=name:slotfm&role=user&'+query)).total,0);
    assert.equal((await get('/api/paper?id=name:slotfm&offset=1&'+query)).mentions.length,0);
    const links='/api/graph?id=name:slotfm&id=name:ronin';
    assert.equal((await get(links+'&'+query))[0].weight,1);assert.equal((await get(links))[0].weight,2);
    assert.equal((await get('/api/overview?from=2026-11-02')).stats.mentions,3);
    assert.equal((await get('/api/overview?to=2026-11-01')).stats.mentions,3);
    assert.equal((await get('/api/overview?from=2030-01-01')).stats.mentions,0);
    assert.deepEqual(await get(links+'&from=2030-01-01'),[]);
    assert.equal((await fetch(url+'/api/overview?from=2026-02-30')).status,400);
    assert.equal((await fetch(url+'/api/overview?from=2026-11-02&to=2026-11-01')).status,400);
    assert.equal((await get('/api/overview')).stats.mentions,6);
  }finally{const done=once(child,'exit');child.kill();await done;await fs.rm(temp,{recursive:true,force:true});}
});
