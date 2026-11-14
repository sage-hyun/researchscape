import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIndex,normalize} from '../lib/extract.mjs';
import {crossrefRecord,synchronizeBibliography,fetchMetadata,lookupKey,providerLookupKey,openalexRecord,semanticScholarRecord} from '../lib/bibliography.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';

const title='Novel Motion Representation Learning with Inertial Sensors';
const rawTitle=(name=title)=>buildIndex([{id:'fixture',title:'private project',messages:[{id:'message',role:'user',date:1,text:`SECRET_CONVERSATION_BODY **${name}** 논문`}]}]);
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const empty=()=>({records:{},lookups:{}});
const opts={delay:0,sleepFn:async()=>{},maxRetries:0,openalexApiKey:'',semanticScholarApiKey:''};
const s2=(name=title)=>({paperId:'fixture-paper',title:name,externalIds:{DOI:'10.1234/novel',ArXiv:'2501.12345'},url:'https://www.semanticscholar.org/paper/fixture-paper',authors:[{name:'Test Author'}],year:2025,openAccessPdf:{url:'https://example.org/novel.pdf'}});

test('legacy Crossref near-misses fall back through OpenAlex search.title and S2 match; only exact full titles link',async()=>{
  const raw=rawTitle(),key=lookupKey(raw.papers[0]),near=crossrefRecord({DOI:'10.1234/near',title:['Novel Representation Learning for Different Motion Sensors']});
  const store={records:{[near.id]:near},lookups:{[key]:{status:'ok',recordIds:[near.id],updatedAt:new Date().toISOString(),method:'title-search'}}},calls=[];
  const fetchFn=async(value,options)=>{
    const url=new URL(value);calls.push(url);assert.ok(!value.includes('SECRET_CONVERSATION_BODY'));assert.ok(!value.includes('private+project'));
    if(url.hostname==='api.openalex.org'){assert.equal(url.searchParams.get('search.title'),title);assert.equal(url.searchParams.get('api_key'),'PRIVATE_API_KEY');return json({results:[]});}
    assert.equal(url.pathname,'/graph/v1/paper/search/match');assert.equal(url.searchParams.get('query'),title);assert.equal(options.headers['x-api-key'],'PRIVATE_S2_KEY');return json({data:[s2()]});
  };
  await synchronizeBibliography(raw,store,{...opts,fetchFn,openalexApiKey:'PRIVATE_API_KEY',semanticScholarApiKey:'PRIVATE_S2_KEY'});
  assert.equal(calls.length,2);assert.equal(reconcileIndex(raw,store).papers[0].metadata.title,title);assert.ok(store.lookups[key].recordIds.includes(near.id));
  assert.equal(store.providerLookups[providerLookupKey('crossref',key)].recordIds[0],near.id);
  assert.ok(!JSON.stringify(store).includes('PRIVATE_API_KEY'));assert.ok(!JSON.stringify(store).includes('PRIVATE_S2_KEY'));
  await synchronizeBibliography(raw,store,{...opts,fetchFn});assert.equal(calls.length,2,'successful stages are reused');
});

test('OpenAlex locations and S2 external IDs retain separate landing, DOI, preprint and PDF links',()=>{
  const a=openalexRecord({id:'https://openalex.org/Wfixture',title,doi:'https://doi.org/10.1234/novel',publication_year:2025,type:'article',authorships:[{author:{display_name:'Test Author'}}],primary_location:{landing_page_url:'https://publisher.example/paper',pdf_url:'https://publisher.example/paper.pdf'},locations:[{landing_page_url:'https://arxiv.org/abs/2501.12345'}]},'https://api.openalex.org/works');
  assert.ok(a.identifiers.some(i=>i.key==='arxiv:2501.12345'));for(const kind of ['landing','doi','preprint','pdf'])assert.ok(a.links[kind].length,kind);
  for(const links of Object.values(a.links))for(const link of links){assert.equal(link.provider,'OpenAlex');assert.equal(link.sourceUrl,'https://api.openalex.org/works');}
  const b=semanticScholarRecord(s2(),'https://api.semanticscholar.org/graph/v1/paper/search/match');
  assert.equal(b.id,'doi:10.1234/novel');assert.ok(b.links.pdf.some(l=>l.url.endsWith('novel.pdf')));assert.ok(b.links.preprint.length);
  const crossref=crossrefRecord({DOI:'10.1234/pdf',title:[title],resource:{primary:{URL:'https://publisher.example/landing'}},link:[{URL:'https://publisher.example/download?id=fixture','content-type':'application/pdf'}]});
  assert.ok(crossref.links.pdf.some(l=>l.url.includes('/download?')));assert.ok(crossref.links.landing.some(l=>l.url.endsWith('/landing')));
});

test('similar title search results are suggestions even if S2 returns a high matchScore',async()=>{
  const raw=rawTitle(),store=empty();
  await synchronizeBibliography(raw,store,{...opts,fetchFn:async url=>url.includes('crossref')?json({message:{items:[]}}):url.includes('openalex')?json({results:[]}):json({data:[{...s2('Novel Motion Representation Learning with Visual Sensors'),matchScore:999}]})});
  const resolved=reconcileIndex(raw,store);assert.equal(resolved.papers[0].metadata,null);assert.equal(resolved.resolutionQueue.length,1);assert.equal(store.lookups[lookupKey(raw.papers[0])].outcome,'matching-failed');
});

test('HTTP failures, provider no-match and malformed responses remain distinct and resumable',async()=>{
  const raw=rawTitle(),store=empty(),calls=[];
  await synchronizeBibliography(raw,store,{...opts,fetchFn:async url=>{calls.push(url);return url.includes('crossref')?new Response('{}',{status:503}):url.includes('openalex')?json({results:[]}):new Response('{}',{status:404});}});
  const key=lookupKey(raw.papers[0]);assert.equal(store.lookups[key].status,'error');assert.equal(store.providerLookups[providerLookupKey('crossref',key)].outcome,'http-error');assert.equal(store.providerLookups[providerLookupKey('semantic-scholar',key)].outcome,'no-match');
  const n=calls.length;await synchronizeBibliography(raw,store,{...opts,fetchFn:async url=>{calls.push(url);throw new Error('should use negative cache');}});assert.equal(calls.length,n);
  const broken=empty();await synchronizeBibliography(raw,broken,{...opts,fetchFn:async()=>json({unexpected:true})});
  assert.equal(broken.providerLookups[providerLookupKey('openalex',key)].outcome,'invalid-response');assert.equal(broken.lookups[key].status,'error');
});

test('429 uses Retry-After, counts every attempt, and persists a long cooldown without an early retry',async()=>{
  let n=0;const waits=[],retries=[];
  await fetchMetadata('https://api.crossref.org/works',{delay:0,sleepFn:async ms=>waits.push(ms),onRetry:e=>retries.push(e),fetchFn:async()=>++n===1?new Response('{}',{status:429,headers:{'Retry-After':'3'}}):json({message:{items:[]}})});
  assert.equal(n,2);assert.deepEqual(waits,[3000]);assert.equal(retries[0].status,429);
  const store=empty(),raw=rawTitle();let alexCalls=0;
  const fetchFn=async url=>{if(url.includes('openalex')){alexCalls++;return new Response('{}',{status:429,headers:{'Retry-After':'120'}});}return url.includes('crossref')?json({message:{items:[]}}):new Response('{}',{status:404});};
  await synchronizeBibliography(raw,store,{...opts,maxRetries:2,fetchFn});assert.equal(alexCalls,1);assert.ok(Date.parse(store.providerCooldowns.openalex.retryAt)>Date.now()+60000);
  await synchronizeBibliography(rawTitle('Another Novel Motion Representation Learning with Sensors'),store,{...opts,maxRetries:2,fetchFn});assert.equal(alexCalls,1,'cooldown applies to other titles and subsequent jobs');
});

test('interrupted fallback jobs save each stage and resume at the uncompleted provider',async()=>{
  const raw=rawTitle(),store=empty(),controller=new AbortController(),first=[];
  const fetchFn=async url=>{first.push(new URL(url).hostname);return url.includes('crossref')?json({message:{items:[]}}):url.includes('openalex')?json({results:[]}):json({data:[s2()]});};
  await assert.rejects(synchronizeBibliography(raw,store,{...opts,fetchFn,signal:controller.signal,onSave:s=>{if(s.providerLookups[providerLookupKey('openalex',lookupKey(raw.papers[0]))])controller.abort(new Error('fixture-stop'));}}),/fixture-stop/);
  assert.deepEqual(first,['api.crossref.org','api.openalex.org']);assert.equal(store.providerLookups[providerLookupKey('semantic-scholar',lookupKey(raw.papers[0]))],undefined);
  const second=[];await synchronizeBibliography(raw,store,{...opts,fetchFn:async url=>{second.push(new URL(url).hostname);return json({data:[s2()]});}});
  assert.deepEqual(second,['api.semanticscholar.org']);assert.equal(reconcileIndex(raw,store).papers[0].metadata.title,title);
});

test('title limits advance through uncached candidates and acronym lookup sends curated identifiers only',async()=>{
  const titles=[title,'Another Motion Representation Learning with Inertial Sensors'],raw=buildIndex(titles.map((t,i)=>({id:`c${i}`,messages:[{id:`m${i}`,role:'user',date:1,text:`**${t}** 논문`}]}))),store=empty(),queries=[];
  const fetchFn=async url=>{const t=new URL(url).searchParams.get('query.bibliographic');queries.push(t);return json({message:{items:[{DOI:`10.1234/${normalize(t)}`,title:[t]}]}});};
  await synchronizeBibliography(raw,store,{...opts,limit:1,fetchFn});await synchronizeBibliography(raw,store,{...opts,limit:1,fetchFn});assert.deepEqual(queries,titles);
  const acronym=buildIndex([{id:'c',messages:[{id:'m',role:'user',text:'MAML 논문, CLIP 논문, IMUTube 논문, SMPL 논문, GraCE 논문, ZUPT 논문, CHI 논문'}]}]);
  const urls=[];await synchronizeBibliography(acronym,empty(),{...opts,fetchFn:async url=>{urls.push(url);return url.includes('arxiv')?new Response('<feed></feed>'):json({message:{DOI:decodeURIComponent(new URL(url).pathname.split('/').at(-1)),title:['Official Metadata for the Fixture Paper']}});}});
  assert.ok(urls.every(u=>!u.includes('search')&&!u.includes('query.bibliographic')&&!u.includes('GraCE')&&!u.includes('ZUPT')&&!u.includes('CHI')));
  assert.ok(urls.some(u=>u.includes('1703.03400')));assert.ok(urls.some(u=>u.includes('3411841')));
});
