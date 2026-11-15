import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {ZoteroClient} from '../lib/zotero-client.mjs';import {ZoteroSync,matchZoteroItem} from '../lib/zotero-sync.mjs';

const title='Learning Robust Motion Representations for Wearable Sensors',paper={id:'doi:10.1234/fixture',title,aliases:[],identifiers:[],metadata:{title,identifiers:[{key:'doi:10.1234/fixture',kind:'doi',value:'10.1234/fixture'}]},count:4};
function mockZotero(){
  const state={serverId:'fixture-server',remember:true,key:'K'.repeat(32),collections:new Map(),items:new Map([['PAPER001',{key:'PAPER001',version:1,data:{itemType:'journalArticle',title,DOI:'10.1234/fixture',collections:['USERCOL1']}}]]),writes:[],conflict:false};
  const fetchFn=async(url,options={})=>{
    const u=new URL(url),route=u.pathname.slice('/api/'.length),method=options.method||'GET',headers=options.headers||{},response=(value,status=200)=>new Response(status===204?null:JSON.stringify(value),{status,headers:{'Zotero-Server-ID':state.serverId,'Zotero-API-Version':'3'}});
    if(!route)return response({});if(route==='local/authorize')return state.deny?response({denied:true},403):response({key:state.key,remember:state.remember});
    if(headers['Zotero-Server-ID']!==state.serverId)return response({},412);
    if(method==='GET'){
      if(route==='users/0/groups')return response([]);if(route==='users/0/items')return response([...state.items.values()]);if(route==='users/0/collections')return response([...state.collections.values()]);
      const key=route.split('/').at(-1),entry=route.includes('/collections/')?state.collections.get(key):state.items.get(key);return response(entry||{},entry?200:404);
    }
    if(headers['Zotero-API-Key']!==state.key)return response({},401);state.writes.push({route,method,body:JSON.parse(options.body)});
    if(route==='users/0/collections'){const data=JSON.parse(options.body)[0];state.collections.set(data.key,{key:data.key,version:1,data});return response({successful:{0:{key:data.key}}});}
    if(method==='PATCH'){
      const item=state.items.get(route.split('/').at(-1));if(state.conflict){state.conflict=false;item.version++;item.data.collections.push('RECENT01');return response({},412);}
      assert.equal(headers['If-Unmodified-Since-Version'],String(item.version));Object.assign(item.data,JSON.parse(options.body));item.version++;return response(null,204);
    }return response({},400);
  };return {state,client:new ZoteroClient({fetchFn})};
}
const index=()=>({papers:[paper,{...paper,id:'missing',count:2,metadata:{title:'Another Specific Motion Estimation Research Paper',identifiers:[]}}],conversations:[{id:'a',projectId:'g-p-fixture-a'},{id:'b',projectId:'g-p-fixture-b'}],mentions:[{paperId:paper.id,conversationId:'a'},{paperId:paper.id,conversationId:'b'},{paperId:'missing',conversationId:'a'}],projects:[{id:'g-p-fixture-a',name:'Motion'},{id:'g-p-fixture-b',name:'IMU'}]});

test('Zotero local credentials stay in memory; single use, denial, expiry and server changes are explicit',async()=>{
  const {state,client}=mockZotero();assert.equal((await client.probe()).serverId,state.serverId);state.deny=true;await assert.rejects(client.authorize(),e=>e.httpStatus===403);state.deny=false;state.remember=false;
  const auth=await client.authorize();assert.ok(!JSON.stringify(auth).includes(state.key));await client.write('users/0/collections','POST',[{key:'FIRST001',name:'Fixture'}]);assert.equal(client.credentials().authorized,false);await assert.rejects(client.write('users/0/collections','POST',[]),e=>e.httpStatus===401);
  state.remember=true;await client.authorize();state.serverId='different-server';assert.equal((await client.probe()).serverChanged,true);assert.equal(client.credentials().authorized,false);
  await client.authorize();state.key='J'.repeat(32);await assert.rejects(client.write('users/0/collections','POST',[]),e=>e.httpStatus===401);assert.equal(client.credentials().authorized,false);
  assert.throws(()=>new ZoteroClient({base:'https://outside.example/api/'}));
});
test('project dry-run, additive collections, multiple projects, 412 retries and repeat sync preserve manual collections',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rs-sync-'));try{
    const {state,client}=mockZotero(),sync=new ZoteroSync({state:dir,client,getIndex:index}),input={projectIds:index().projects.map(p=>p.id),paperLimit:3};
    const plan=await sync.preview(input);assert.equal(state.writes.length,0);assert.equal(plan.rows.length,2);assert.equal(plan.skipped.length,1);assert.equal(plan.collections.length,3);assert.equal(plan.rows[0].itemKey,'PAPER001','PDF absence does not prevent a bibliographic item match');
    await assert.rejects(sync.apply({planId:plan.planId}),/명시적/);await client.authorize();state.conflict=true;await sync.apply({planId:plan.planId,approved:true});
    assert.equal(state.collections.size,3);assert.deepEqual(new Set(state.items.get('PAPER001').data.collections),new Set(['USERCOL1','RECENT01',...plan.rows.map(r=>r.collectionKey)]));
    const second=await sync.preview(input),before=state.writes.length;assert.ok(second.rows.every(r=>r.status==='already-included'));await sync.apply({planId:second.planId,approved:true});assert.equal(state.writes.length,before);
    const saved=await fs.readFile(path.join(dir,'zotero-sync.json'),'utf8');assert.ok(!saved.includes(state.key));assert.ok(JSON.parse(saved).servers[state.serverId].libraries['users/0'].projects['g-p-fixture-a']);
    const stale=await sync.preview(input);state.serverId='new-database';await assert.rejects(sync.apply({planId:stale.planId,approved:true}),e=>e.code==='STALE_PLAN');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('matching skips title/identifier conflicts and unverified acronyms; explicit item keys take precedence',()=>{
  assert.equal(matchZoteroItem(paper,[]).reason,'no-zotero-item');assert.equal(matchZoteroItem({...paper,itemKey:'ABSENT01'},[]).reason,'missing-explicit-zotero-item');
  const {state}=mockZotero(),items=[...state.items.values()];assert.equal(matchZoteroItem({...paper,metadata:{...paper.metadata,title:'Completely Different Weather Forecasting Research Methods'}},items).reason,'identifier-title-conflict');
  assert.equal(matchZoteroItem({...paper,itemKey:'ABSENT01'},items).reason,'missing-explicit-zotero-item','a missing explicit key must not fall back to a title match');
  assert.equal(matchZoteroItem({...paper,title:'ABC',metadata:null},items).status,'needs-review');assert.equal(matchZoteroItem({...paper,itemKey:'PAPER001',metadata:null},items).itemKey,'PAPER001');
  assert.equal(matchZoteroItem({...paper,metadata:{title,identifiers:[{key:'doi:10.1234/other-edition',kind:'doi',value:'10.1234/other-edition'}]}},items).reason,'conflicting-identifiers');
});
test('partial single-use authorization can resume after restart without duplicate collections',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rs-resume-'));try{
    const {state,client}=mockZotero();state.remember=false;const input={projectIds:['g-p-fixture-a']};const sync=new ZoteroSync({state:dir,client,getIndex:index}),plan=await sync.preview(input);await client.authorize();await assert.rejects(sync.apply({planId:plan.planId,approved:true}),e=>e.code==='AUTH_REQUIRED');assert.equal(state.collections.size,1);
    state.remember=true;await client.authorize();const restarted=new ZoteroSync({state:dir,client,getIndex:index}),next=await restarted.preview(input);await restarted.apply({planId:next.planId,approved:true});assert.equal(state.collections.size,2);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
