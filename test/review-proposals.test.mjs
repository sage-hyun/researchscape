import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIndex,normalize} from '../lib/extract.mjs';
import {crossrefRecord,putRecord} from '../lib/bibliography.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';
import {reviewGroups} from '../lib/bibliography-review.mjs';
import {normalizeProposal,verifyProposals} from '../lib/review-proposals.mjs';

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const opts={delay:0,sleepFn:async()=>{},maxRetries:0,openalexApiKey:'',semanticScholarApiKey:''};
const fullTitle='Learning Stable Inertial Odometry from Noisy Wearable Motion Sensors',wrongTitle='Deep Reinforcement Learning for Autonomous Warehouse Robots';
const works={
  '10.1234/grace':{DOI:'10.1234/grace',title:['GraCE: Graph Contrastive Embeddings for Motion Learning'],author:[{given:'Ada',family:'Fixture'}],published:{'date-parts':[[2023]]}},
  '10.1234/stable':{DOI:'10.1234/stable',title:[fullTitle]},
  '10.1234/robots':{DOI:'10.1234/robots',title:[wrongTitle]},
  '10.1234/dataset':{DOI:'10.1234/dataset',title:['FROST: A Dataset Record for Frozen Motion Capture'],type:'dataset'},
  '10.1234/clipish':{DOI:'10.1234/clipish',title:['Contrastive Pretraining of Paired Motion and Language Encoders']}
};
const arxivEntry=(id,title)=>`<entry><id>http://arxiv.org/abs/${id}v2</id><title>${title}</title><published>2022-03-01T00:00:00Z</published><author><name>Ada Fixture</name></author></entry>`;
// Each test states which providers may answer; anything else fails the lookup like a real outage.
function provider(calls,{down=[],search={}}={}){
  return async input=>{
    const url=new URL(input);calls.push(url.href);
    if(down.includes(url.hostname))return json({},503);
    if(url.hostname==='api.crossref.org'&&url.pathname.startsWith('/works/')){const work=works[decodeURIComponent(url.pathname.slice(7))];return work?json({message:work}):json({},404);}
    if(url.hostname==='export.arxiv.org')return new Response(`<feed>${url.searchParams.get('id_list').split(',').filter(id=>id==='2203.01234').map(id=>arxivEntry(id,'NovaIMU: Neural Inertial Tracking in the Wild')).join('')}</feed>`);
    if(url.hostname==='api.crossref.org')return json({message:{items:search.crossref?.[url.searchParams.get('query.bibliographic')]||[]}});
    if(url.hostname==='api.openalex.org')return json({results:search.openalex?.[url.searchParams.get('search.title')]||[]});
    if(url.hostname==='api.semanticscholar.org')return json({},404);
    throw new Error('unexpected host '+url.hostname);
  };
}
const paperOf=(title,aliases=[title])=>({id:title.includes(' ')?'title:'+normalize(title):'name:'+normalize(title),title,aliases,identifiers:[],count:1});
const item=(title,proposal,extra={})=>({candidateId:paperOf(title).id,paper:paperOf(title),proposal:normalizeProposal(proposal),suggested:new Set(),...extra});

test('proposals are normalised to canonical identifiers and reject anything that is not a DOI, arXiv ID or title',()=>{
  assert.deepEqual(normalizeProposal({doi:'https://doi.org/10.1145/3411841'}),{identifiers:[{key:'doi:10.1145/3411841',kind:'doi',value:'10.1145/3411841',url:'https://doi.org/10.1145/3411841'}],doi:'10.1145/3411841'});
  assert.equal(normalizeProposal({doi:'DOI: 10.1145/3411841.'}).doi,'10.1145/3411841');
  assert.equal(normalizeProposal({arxiv:'arXiv:1703.03400v3'}).arxiv,'1703.03400');assert.equal(normalizeProposal({arxiv:'https://arxiv.org/pdf/1703.03400.pdf'}).identifiers[0].key,'arxiv:1703.03400');
  // An arXiv DOI is checked at arXiv; Crossref does not register it.
  const preprint=normalizeProposal({doi:'10.48550/arXiv.2103.00020'});assert.equal(preprint.doi,'10.48550/arxiv.2103.00020');assert.deepEqual(preprint.identifiers.map(i=>i.key),['arxiv:2103.00020']);
  const both=normalizeProposal({doi:'10.1234/x',arxiv:'2203.01234',title:'  A   Title  '});assert.deepEqual(both.identifiers.map(i=>i.key),['doi:10.1234/x','arxiv:2203.01234']);assert.equal(both.title,'A Title');
  assert.deepEqual(normalizeProposal({title:'Only a Title Proposed by the Reviewer'}).identifiers,[]);
  for(const bad of [null,[],{},{doi:''},{doi:'see the paper'},{arxiv:'cs.CV'},{title:'ab'},{doi:42},{pmid:'123'},{title:'x'.repeat(301)}])assert.ok(normalizeProposal(bad).error,JSON.stringify(bad));
});

test('only records a provider really returned become link candidates; LLM text is never stored as metadata',async()=>{
  const store={records:{},lookups:{}},calls=[];
  const items=[
    item('GraCE',{doi:'10.1234/grace',title:'GraCE: Graph Contrastive Embeddings for Motion Learning LLM_ONLY_WORD'}),
    item('NovaIMU',{arxiv:'2203.01234'}),
    item(fullTitle,{doi:'10.1234/stable'}),
    item('Ghost',{doi:'10.1234/does-not-exist'}),
    item('Mixup',{doi:'10.1234/robots',title:'Mixup: Interpolating Wearable Sensor Windows'}),
    item('Learning Stable Inertial Odometry from Raw Motion Sensors',{doi:'10.1234/stable'}),
    item('Planning Collision-Free Paths for Quadruped Legged Locomotion',{doi:'10.1234/robots'}),
    item('CLIPish',{doi:'10.1234/clipish'}),
    item('FROST',{doi:'10.1234/dataset'})
  ];
  const outcomes=await verifyProposals(items,{...opts,store,importId:'fixture-import',fetchFn:provider(calls)});
  const status=title=>outcomes.get(paperOf(title).id).status;
  assert.equal(status('GraCE'),'verified');assert.equal(outcomes.get('name:grace').recordId,'doi:10.1234/grace');assert.deepEqual(outcomes.get('name:grace').record.authors,['Ada Fixture']);
  assert.equal(status('NovaIMU'),'verified');assert.equal(outcomes.get('name:novaimu').record.title,'NovaIMU: Neural Inertial Tracking in the Wild');
  assert.equal(status(fullTitle),'verified');
  assert.equal(status('Ghost'),'not-found');
  assert.equal(status('Mixup'),'title-mismatch','a real DOI that belongs to another paper');
  assert.equal(status('Learning Stable Inertial Odometry from Raw Motion Sensors'),'weak-link');
  assert.equal(status('Planning Collision-Free Paths for Quadruped Legged Locomotion'),'candidate-mismatch');
  assert.equal(status('CLIPish'),'weak-link','the acronym does not appear in the official title');
  assert.equal(status('FROST'),'conflict','datasets are not papers');
  // Registered: verified and weak links. Not registered: mismatches, conflicts, misses.
  assert.deepEqual(Object.keys(store.proposedLinks).sort(),['name:clipish','name:grace','name:novaimu','title:'+normalize(fullTitle),'title:'+normalize('Learning Stable Inertial Odometry from Raw Motion Sensors')].sort());
  assert.deepEqual(store.proposedLinks['name:grace'],{recordIds:['doi:10.1234/grace'],source:'llm-review',importId:'fixture-import',verifiedAt:store.proposedLinks['name:grace'].verifiedAt});
  assert.ok(!JSON.stringify(store).includes('LLM_ONLY_WORD'),'the title an LLM wrote is compared, never saved');
  assert.equal(store.records['doi:10.1234/grace'].provider,'Crossref');assert.equal(store.records['arxiv:2203.01234'].provider,'arXiv');
  // Requests carry identifiers only, arXiv IDs go out as one batch, and nothing is searched by title here.
  assert.equal(calls.filter(u=>u.includes('export.arxiv.org')).length,1);assert.ok(calls.every(u=>!u.includes('query.bibliographic')&&!u.includes('search.title')));
  const sent=calls.length;await verifyProposals(items,{...opts,store,fetchFn:async()=>{throw new Error('cached lookups must be reused');}});assert.equal(calls.length,sent);
  // A registered record is a suggestion in the review queue, never an automatic link.
  const raw=buildIndex([{id:'c',messages:[{id:'m',role:'user',date:1,text:'GraCE 논문과 CLIPish 논문'}]}]),resolved=reconcileIndex(raw,store);
  assert.equal(resolved.papers.find(p=>p.id==='name:clipish').metadata,null);assert.equal(resolved.papers.find(p=>p.id==='name:grace').metadata,null);
  const queued=resolved.resolutionQueue.find(q=>q.id==='name:clipish');assert.equal(queued.suggestions[0].recordId,'doi:10.1234/clipish');assert.ok(queued.evidence.some(e=>e.source==='llm-proposal'));
  assert.deepEqual(reviewGroups(raw,resolved,{}).withCandidates.find(r=>r.candidateId==='name:clipish').candidates[0].evidenceTypes,['llm-proposal']);
  // Without the registration the same record would not be suggested for an unrelated acronym.
  const {proposedLinks,...plain}=store;assert.equal(reconcileIndex(raw,plain).resolutionQueue.find(q=>q.id==='name:clipish').suggestions.length,0);
});

test('title-only proposals need one exact official title; several matches and outages stay manual',async()=>{
  const exact='Robust Sensor Fusion for Wearable Human Motion Capture',twin='Unified Motion Tokenization for Wearable Foundation Models';
  const search={
    crossref:{[exact]:[{DOI:'10.1234/fusion',title:[exact]},{DOI:'10.1234/near',title:['Robust Sensor Fusion for Wearable Human Activity Capture']}],[twin]:[{DOI:'10.1234/twin-a',title:[twin],author:[{family:'First'}]},{DOI:'10.1234/twin-b',title:[twin],author:[{family:'Second'}]}]},
    openalex:{'Calibrated Uncertainty for Inertial Pose Estimation Networks':[{id:'https://openalex.org/W1',doi:'https://doi.org/10.1234/calibrated',title:'Calibrated Uncertainty for Inertial Pose Estimation Networks',publication_year:2024,type:'article'}]}
  };
  const store={records:{},lookups:{}},calls=[];
  const items=[item('Fusion',{title:exact}),item('Twin',{title:twin}),item('Calib',{title:'Calibrated Uncertainty for Inertial Pose Estimation Networks'}),item('Nowhere',{title:'A Title That No Provider Has Ever Indexed Anywhere'}),item('Short',{title:'Fusion'}),item('Typo',{doi:'10.1234/typo',title:exact})];
  const outcomes=await verifyProposals(items,{...opts,store,fetchFn:provider(calls,{search})});
  // The acronym candidates cannot be tied to these titles automatically, so a person confirms them.
  assert.equal(outcomes.get('name:fusion').status,'weak-link');assert.deepEqual(outcomes.get('name:fusion').register,['doi:10.1234/fusion']);
  assert.equal(outcomes.get('name:twin').status,'ambiguous');assert.deepEqual(outcomes.get('name:twin').register.sort(),['doi:10.1234/twin-a','doi:10.1234/twin-b']);
  assert.equal(outcomes.get('name:calib').status,'weak-link','found through the OpenAlex fallback');assert.equal(outcomes.get('name:calib').record.provider,'OpenAlex');
  assert.equal(outcomes.get('name:nowhere').status,'not-found');assert.equal(outcomes.get('name:short').status,'not-found','short names are never searched');
  assert.equal(outcomes.get('name:typo').status,'weak-link');
  assert.ok(calls.every(u=>!u.includes('Fusion')||u.includes('Robust')),'only full proposed titles are searched');
  // A candidate whose observed full title matches gets a bulk-approvable result from a title-only proposal.
  const observed=item(exact,{title:exact});assert.equal((await verifyProposals([observed],{...opts,store,fetchFn:provider(calls,{search})})).get(observed.candidateId).status,'verified');
  // The proposed DOI was not confirmed, so even an exact title stays manual.
  const unconfirmed=item(exact,{doi:'10.1234/typo',title:exact});assert.equal((await verifyProposals([unconfirmed],{...opts,store,fetchFn:provider(calls,{search})})).get(unconfirmed.candidateId).status,'unconfirmed-identifier');

  const outage={records:{},lookups:{}},failed=await verifyProposals([item('GraCE',{doi:'10.1234/grace'}),item('NovaIMU',{arxiv:'2203.01234'})],{...opts,store:outage,fetchFn:provider([],{down:['api.crossref.org']})});
  assert.equal(failed.get('name:grace').status,'lookup-failed');assert.equal(failed.get('name:novaimu').status,'verified','other providers still complete');assert.equal(outage.proposedLinks['name:grace'],undefined);
  // Already-suggested records keep their evidence instead of being re-registered.
  const known={records:{},lookups:{}},record=crossrefRecord(works['10.1234/grace']);known.records[record.id]=record;
  const again=await verifyProposals([item('GraCE',{doi:'10.1234/grace'},{suggested:new Set([record.id])})],{...opts,store:known,fetchFn:provider([])});
  assert.equal(again.get('name:grace').status,'verified');assert.equal(known.proposedLinks,undefined);
});

test('records fetched for a proposal link nothing by themselves until a person approves or a regular lookup returns them',async()=>{
  const maml='Model-Agnostic Meta-Learning for Fast Adaptation of Deep Networks',titleId='title:'+normalize(fullTitle);
  const raw=buildIndex([{id:'c',messages:[{id:'m1',role:'user',date:1,text:`**${fullTitle}** 논문`},{id:'m2',role:'user',date:2,text:'GraCE 논문 https://doi.org/10.1234/grace'},{id:'m3',role:'user',date:3,text:'MAML 논문'}]}]);
  const fetchFn=async input=>{
    const url=new URL(input);
    if(url.hostname==='export.arxiv.org')return new Response(`<feed>${arxivEntry('1703.03400',maml)}</feed>`);
    const work=works[decodeURIComponent(url.pathname.slice(7))];return work?json({message:work}):json({},404);
  };
  const papers=new Map(raw.papers.map(p=>[p.id,p])),store={records:{},lookups:{}};
  const items=[[titleId,{doi:'10.1234/stable'}],['doi:10.1234/grace',{doi:'10.1234/grace'}],['name:maml',{arxiv:'1703.03400'}]].map(([id,proposal])=>({candidateId:id,paper:papers.get(id),proposal:normalizeProposal(proposal),suggested:new Set()}));
  const outcomes=await verifyProposals(items,{...opts,store,fetchFn});
  assert.equal(outcomes.get(titleId).status,'verified');assert.equal(outcomes.get('doi:10.1234/grace').status,'verified','the paper itself carries this DOI');assert.equal(outcomes.get('name:maml').status,'weak-link');
  assert.deepEqual(Object.values(store.records).map(r=>r.provisional),['llm-proposal','llm-proposal','llm-proposal']);
  // Exact title, same identifier, same-message acronym and the curated alias would all link on
  // their own with regular records. Here every candidate only gains a suggestion.
  let resolved=reconcileIndex(raw,store);
  assert.equal(resolved.stats.metadataVerified,0);assert.equal(resolved.papers.length,4);
  for(const id of [titleId,'doi:10.1234/grace','name:maml'])assert.deepEqual(resolved.resolutionQueue.find(q=>q.id===id).evidence.filter(e=>e.source==='llm-proposal').length,1,id);
  assert.equal(resolved.resolutionQueue.find(q=>q.id==='name:grace').suggestions.length,0,'no candidate was registered for the acronym');
  // Approval links the approved candidate; the record then behaves like any other.
  resolved=reconcileIndex(raw,store,{'doi:10.1234/grace':{action:'match',recordId:'doi:10.1234/grace'}});
  assert.equal(resolved.papers.find(p=>p.id==='doi:10.1234/grace').resolution.reason,'user-confirmed');
  assert.equal(resolved.redirects['name:grace'],'doi:10.1234/grace','the acronym in the same message now follows the regular rule');assert.equal(resolved.papers.find(p=>p.id===titleId).metadata,null);
  resolved=reconcileIndex(raw,store,{'name:maml':{action:'match',recordId:'arxiv:1703.03400'}});assert.equal(resolved.papers.find(p=>p.id==='arxiv:1703.03400').metadata.title,maml);
  // Checking another proposal later keeps earlier provisional records provisional.
  for(const entry of Object.values(store.lookups))entry.updatedAt=new Date(Date.now()-40*86400000).toISOString();
  await verifyProposals(items.slice(0,1),{...opts,store,fetchFn});assert.equal(store.records['doi:10.1234/stable'].provisional,'llm-proposal');
  // A regular lookup that returns the same record makes it ordinary evidence.
  putRecord(store,crossrefRecord(works['10.1234/stable']));assert.equal(store.records['doi:10.1234/stable'].provisional,undefined);
  resolved=reconcileIndex(raw,store);assert.equal(resolved.papers.find(p=>p.id==='doi:10.1234/stable').resolution.reason,'exact-official-title');assert.equal(resolved.stats.metadataVerified,1);
});
