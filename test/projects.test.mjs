import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {classifyConversation,sourceFilter,matchingConversations,projectCatalog,paperCategories} from '../lib/projects.mjs';
import {buildIndex} from '../lib/extract.mjs';
import {filterIndex,dateRange} from '../lib/date-filter.mjs';

const research='g-p-fixture-research',course='g-p-fixture-course',unknown='g-p-fixture-unknown';
const projects={[research]:{name:'Research project',category:'research'},[course]:{name:'Course project',category:'coursework'}};
const metadata=[{id:'r',projectId:research},{id:'c',projectId:course},{id:'u',projectId:unknown},{id:'n',projectId:null}];
const filter=(category='all',project='')=>sourceFilter(new URLSearchParams({category,project}));

test('unmapped conversations stay unclassified, including in the coursework-excluded view',()=>{
  assert.equal(classifyConversation(metadata[0],projects).category,'research');
  assert.equal(classifyConversation(metadata[1],projects).category,'coursework');
  assert.equal(classifyConversation(metadata[2],projects).category,'unclassified');
  assert.equal(classifyConversation(metadata[3],projects).category,'unclassified');
  assert.deepEqual([...matchingConversations(metadata,filter('non-coursework'),projects)],['r','u','n']);
  assert.deepEqual([...matchingConversations(metadata,filter('research'),projects)],['r']);
  assert.deepEqual([...matchingConversations(metadata,filter('unclassified'),projects)],['u','n']);
  assert.deepEqual([...matchingConversations(metadata,filter('all','__none__'),projects)],['n']);
  assert.throws(()=>filter('not-a-category'));assert.throws(()=>filter('all','<script>'));
});

test('manual classification overrides category without inventing or moving project membership',()=>{
  const overrides={n:{category:'research'},c:{category:'unclassified'}};
  const manual=classifyConversation(metadata[3],projects,overrides);
  assert.equal(manual.category,'research');assert.equal(manual.projectId,null);assert.equal(manual.classificationSource,'manual');
  const courseOverride=classifyConversation(metadata[1],projects,overrides);
  assert.equal(courseOverride.category,'unclassified');assert.equal(courseOverride.projectId,course);assert.equal(courseOverride.inheritedCategory,'coursework');
  assert.deepEqual([...matchingConversations(metadata,filter('research'),projects,overrides)],['r','n']);
  assert.equal(projectCatalog(metadata,projects).find(p=>p.id===unknown).category,'unclassified');
});

test('mixed papers keep per-source counts and conversations with unknown dates remain usable',()=>{
  const index=buildIndex([
    {id:'r',conversation_template_id:research,messages:[{id:'r1',role:'user',text:'SlotFM 논문',date:1}]},
    {id:'c',conversation_template_id:course,messages:[{id:'c1',role:'user',text:'SlotFM 논문',date:2}]},
    {id:'u',conversation_template_id:unknown,messages:[{id:'u1',role:'assistant',text:'SlotFM 논문',date:null}]}
  ]);
  const labels=new Map(index.conversations.map(c=>[c.id,classifyConversation(c,projects)]));
  assert.deepEqual(paperCategories(index.mentions,labels).get('name:slotfm'),{research:1,coursework:1,unclassified:1});
  const ids=matchingConversations(index.conversations,filter('unclassified'),projects);
  const scoped=filterIndex(index,dateRange(new URLSearchParams()),ids);
  assert.equal(scoped.papers[0].count,1);assert.equal(scoped.papers[0].firstSeen,null);assert.equal(scoped.papers[0].lastSeen,null);
  assert.equal(scoped.stats.conversations,1);
});

test('project filters, date intersections and manual labels persist across reindex and restart',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-projects-'));
  const data=path.join(temp,'data'),state=path.join(temp,'state');await fs.mkdir(data);await fs.mkdir(state);
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const make=(id,project,date,text='SlotFM 논문과 RoNIN 논문')=>({id,title:id,conversation_template_id:project,create_time:Date.parse(date)/1000,current_node:id,mapping:{[id]:{parent:null,message:{id,author:{role:'user'},create_time:Date.parse(date)/1000,content:{parts:[text]}}}}});
  const raw=JSON.stringify([
    make('r',research,'2026-11-01T12:00:00+09:00'),make('c',course,'2026-11-01T12:00:00+09:00'),
    make('u',unknown,'2026-11-02T12:00:00+09:00'),make('n',null,'2026-11-01T12:00:00+09:00','SlotFM 논문'),
    make('g','g-customGPT','2026-11-01T12:00:00+09:00','SlotFM 논문')
  ]);
  await fs.writeFile(path.join(data,'conversations.json'),raw);await fs.writeFile(path.join(state,'projects.json'),JSON.stringify(projects));
  let child,url;
  async function start(){
    child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state},stdio:['ignore','pipe','pipe']});
    let logs='';child.stderr.on('data',d=>logs+=d);
    url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout '+logs)),10000);child.stdout.on('data',d=>{logs+=d;const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('error',reject);});
  }
  async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
  const get=async route=>(await fetch(url+route)).json();
  const post=(route,body={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    await start();
    const all=await get('/api/overview');assert.equal(all.stats.mentions,8);assert.equal(all.projects.length,3);assert.deepEqual(all.categoryCounts,{research:2,coursework:2,unclassified:4});
    assert.deepEqual(all.papers.find(p=>p.id==='name:slotfm').categoryCounts,{research:1,coursework:1,unclassified:3});
    const excluded=await get('/api/overview?category=non-coursework');assert.equal(excluded.stats.mentions,6);assert.equal(excluded.stats.conversations,4);assert.equal(excluded.categoryCounts.unclassified,4);
    const direct=await get('/api/overview?category=research');assert.equal(direct.stats.mentions,2);assert.equal(direct.stats.conversations,1);
    const combined=await get('/api/overview?category=non-coursework&from=2026-11-01&to=2026-11-01');assert.equal(combined.stats.mentions,4);assert.equal(combined.stats.conversations,3);
    assert.equal((await get('/api/overview?project='+course)).stats.mentions,2);
    assert.equal((await get('/api/overview?project=__none__')).stats.mentions,2);
    assert.equal((await get('/api/paper?id=name:slotfm&category=coursework')).mentions[0].projectName,'Course project');
    assert.equal((await get('/api/graph?id=name:slotfm&id=name:ronin&category=non-coursework'))[0].weight,2);
    assert.equal((await get('/api/paper?id=name:slotfm&category=research')).total,1);
    assert.equal((await fetch(url+'/api/overview?category=bogus')).status,400);
    assert.equal((await post('/api/conversation-label',{conversationId:'n',category:'research'})).status,200);
    assert.equal((await get('/api/overview?category=research')).stats.mentions,3);
    const manual=await get('/api/paper?id=name:slotfm&category=research&project=__none__');assert.equal(manual.total,1);assert.equal(manual.mentions[0].projectId,null);assert.equal(manual.mentions[0].classificationSource,'manual');
    assert.equal((await post('/api/conversation-label',{conversationId:'missing',category:'research'})).status,404);
    assert.equal((await post('/api/conversation-label',{conversationId:'n',category:'bogus'})).status,400);
    assert.equal((await post('/api/reindex')).status,200);assert.equal((await get('/api/overview?category=research')).stats.mentions,3);
    await stop();await start();assert.equal((await get('/api/overview?category=research')).stats.mentions,3);
    assert.equal((await post('/api/conversation-label',{conversationId:'n',category:'inherit'})).status,200);
    assert.equal((await get('/api/overview?category=research')).stats.mentions,2);
    assert.equal((await get('/api/overview?category=unclassified')).stats.mentions,4);
    assert.equal(await fs.readFile(path.join(data,'conversations.json'),'utf8'),raw,'source export must remain unchanged');
  }finally{await stop();await fs.rm(temp,{recursive:true,force:true});}
});
