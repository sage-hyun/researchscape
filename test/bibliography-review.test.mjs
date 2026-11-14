import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIndex,normalize} from '../lib/extract.mjs';
import {crossrefRecord,arxivRecords} from '../lib/bibliography.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';
import {bibliographyDiagnostics} from '../lib/bibliography-diagnostics.mjs';
import {VERIFIED_ALIASES} from '../lib/bibliography-policy.mjs';
import {workVersionProposals} from '../lib/work-versions.mjs';
import {compactReviewExport,reviewGroups,reviewResultSchema,validateReviewResult,planReviewImport,applyReviewPlan} from '../lib/bibliography-review.mjs';

const storeOf=(...rs)=>({records:Object.fromEntries(rs.map(r=>[r.id,r])),lookups:{}});
const doc=(messages)=>({id:'c',title:'Fixture',messages:messages.map((text,i)=>({id:'m'+i,text,role:'user',date:1}))});
const title='GraCE: Graph Contrastive Embeddings for Motion Learning';
const r=crossrefRecord({DOI:'10.1234/grace',title:[title]});

test('same-conversation alone is insufficient; local expansion must cover every acronym occurrence',()=>{
  const reconcile=messages=>reconcileIndex(buildIndex([doc(messages)]),storeOf(r));
  const same=reconcile([`**${title}** 논문. GraCE 논문`]);assert.equal(same.papers.length,1);assert.equal(same.papers[0].resolution.evidence[0].source,'explicit-alias-expansion');
  const adjacent=reconcile([`**${title}** 논문`,'GraCE 논문']);assert.equal(adjacent.papers.length,1);assert.ok(adjacent.papers[0].resolution.evidence.some(e=>e.source==='adjacent-message-expansion'));
  const far=reconcile([`**${title}** 논문`,'오늘은 다른 주제에 대해 이야기합니다.','GraCE 논문']);assert.equal(far.papers.find(p=>p.id==='name:grace').metadata,null);assert.equal(far.resolutionQueue.find(q=>q.id==='name:grace').reason,'insufficient-local-alias-evidence');
  const partial=reconcile([`**${title}** 논문`,'GraCE 논문','다른 주제','또 다른 주제','GraCE 논문']);assert.equal(partial.papers.find(p=>p.id==='name:grace').metadata,null);
  const raw=buildIndex([doc([`**${title}** 논문`,'GraCE 논문'])]);delete raw.activity;assert.equal(reconcileIndex(raw,storeOf(r)).papers.find(p=>p.id==='name:grace').metadata,null,'missing message order must not invent adjacency from dates');
  const identified=reconcile(['GraCE 논문 https://doi.org/10.1234/grace']);assert.equal(identified.papers.length,1);assert.ok(identified.papers[0].resolution.evidence.some(e=>e.source==='same-message-identifier'));
});

test('explicit parenthetical expansions work locally without treating an unrelated nearby title as an expansion',()=>{
  const full='Learning Consistent Inertial Representations Across Motion Domains',alias='LCIR',record=crossrefRecord({DOI:'10.1234/lcir',title:[full]}),pid='title:'+normalize(full);
  const raw={papers:[{id:pid,title:full,aliases:[],identifiers:[],count:1},{id:'name:lcir',title:alias,aliases:[],identifiers:[],count:1}],mentions:[{paperId:pid,conversationId:'c',messageId:'m',quote:full,excerpt:full+' (LCIR)',start:0,end:full.length},{paperId:'name:lcir',conversationId:'c',messageId:'m',quote:alias,excerpt:full+' (LCIR)',start:full.length+2,end:full.length+6}],stats:{},activity:[{conversationId:'c',messageId:'m'}]};
  assert.equal(reconcileIndex(raw,storeOf(record)).papers.length,1);
  raw.mentions.forEach(m=>m.excerpt=full+' and LCIR are different methods');assert.equal(reconcileIndex(raw,storeOf(record)).papers.find(p=>p.id==='name:lcir').metadata,null);
});

test('equal titles and authors create arXiv/published Version proposals without merging identifiers',()=>{
  const full='Learning Robust Motion Representations Across Wearable Sensor Domains',a=arxivRecords(`<feed><entry><id>https://arxiv.org/abs/2501.12345</id><title>${full}</title><author><name>Alice Smith</name></author><author><name>Bob Jones</name></author></entry></feed>`,'https://export.arxiv.org/api/query')[0],b=crossrefRecord({DOI:'10.1234/published',title:[full],author:[{given:'Bob',family:'Jones'},{given:'Alice',family:'Smith'}]});
  const proposals=workVersionProposals([a,b]);assert.equal(proposals.length,1);assert.equal(proposals[0].reason,'possible-work-versions');assert.equal(proposals[0].needsManualReview,true);
  const raw=buildIndex([doc([`**${full}** 논문`])]),store=storeOf(a,b),before=structuredClone(store),resolved=reconcileIndex(raw,store);assert.equal(resolved.papers[0].metadata,null);assert.equal(resolved.resolutionQueue[0].suggestions.length,2);assert.deepEqual(store,before);
  assert.equal(workVersionProposals([a,{...b,authors:[]}])[0].reason,'insufficient-version-evidence');assert.equal(workVersionProposals([a,{...b,authors:['Different Author']}]).length,0);
  assert.equal(workVersionProposals([{...a,id:'doi:10.48550/arxiv.2501.12345',identifiers:[{key:'doi:10.48550/arxiv.2501.12345',kind:'doi',value:'10.48550/arxiv.2501.12345'}]},b]).length,1,'arXiv DOI-only records also receive a version proposal');
  assert.equal(workVersionProposals([a,{...b,identifiers:[...b.identifiers,...a.identifiers]}]).length,0,'shared identifiers already establish identity in the catalog');
});

test('compact exports whitelist fields, remove duplicates, split missing candidates and paginate deterministically',()=>{
  const record={...r,sources:[{sourceUrl:'BATCH_API_URL_PRIVATE',fetchedAt:'FETCHED_MARKER'}],links:{pdf:[{url:'LONG_LINK_MARKER'}]}};
  const raw={papers:Array.from({length:92},(_,i)=>({id:'candidate:'+i,title:'Observed Motion Research Candidate '+i,aliases:[],identifiers:[],count:100-i})),mentions:[{excerpt:'PRIVATE_CHAT'}]};raw.papers.push(raw.papers[0]);
  const resolved={papers:raw.papers.slice(0,92).map(p=>({...p,metadata:null,resolution:{reason:'unresolved'}})),redirects:{},resolutionQueue:raw.papers.slice(0,60).map(p=>({...p,reason:'similar-title-or-alias',suggestions:[{recordId:r.id,record,score:.99}],evidence:[{source:'same-conversation',recordId:r.id,conversationId:'PRIVATE_CONVERSATION'}]}))};resolved.resolutionQueue.push({...raw.papers[80],suggestions:[]});
  const decisions={'candidate:90':{action:'separate'}},before=JSON.stringify([raw,resolved,decisions]);
  const groups=reviewGroups(raw,resolved,decisions);assert.equal(groups.withCandidates.length,60);assert.equal(groups.withoutCandidates.length,31);
  const first=compactReviewExport(raw,resolved,decisions,{limit:30}),second=compactReviewExport(raw,resolved,decisions,{limit:30,offset:30}),missing=compactReviewExport(raw,resolved,decisions,{group:'without-candidates',limit:50});
  assert.equal(first.items.length,30);assert.equal(first.nextOffset,30);assert.equal(second.nextOffset,null);assert.equal(missing.items.length,31);assert.equal(first.snapshot,second.snapshot);
  const ids=[...first.items,...second.items,...missing.items].map(p=>p.candidateId);assert.equal(new Set(ids).size,91);
  assert.deepEqual(Object.keys(first.items[0]),['candidateId','title','count','reason','candidates']);assert.deepEqual(Object.keys(first.items[0].candidates[0]),['recordId','title','authors','year','doi','arxiv','evidenceTypes']);
  const text=JSON.stringify(first);for(const forbidden of ['sourceUrl','fetchedAt','BATCH_API','LONG_LINK','PRIVATE_','links','sources','score'])assert.ok(!text.includes(forbidden));
  for(const options of [{limit:29},{limit:51},{offset:-1},{offset:1.2},{group:'all'}])assert.throws(()=>compactReviewExport(raw,resolved,decisions,options));
  assert.equal(JSON.stringify([raw,resolved,decisions]),before);
});

test('curated aliases diagnose successful application, transport failure, search miss and identity conflict separately',()=>{
  const raw=buildIndex([doc(VERIFIED_ALIASES.map(a=>a.alias+' 논문'))]),records=VERIFIED_ALIASES.map(a=>({id:a.identifiers[0],title:a.title,url:a.source,identifiers:a.identifiers.map(key=>({key,kind:key.split(':')[0],value:key.slice(key.indexOf(':')+1)})),authors:[],provider:'Fixture'}));
  const store=storeOf(...records);store.lookups=Object.fromEntries(records.map(r=>[r.id,{status:'ok',recordIds:[r.id],provider:'Fixture',method:'identifier'}]));
  const initial=bibliographyDiagnostics(raw,store,reconcileIndex(raw,store));assert.ok(initial.curatedAliases.every(a=>a.lookupStatus==='retrieved'&&a.applicationStatus==='applied'));
  const maml=records[0],clip=records[1],smpl=records[2];delete store.records[maml.id];store.lookups[maml.id]={status:'error',httpStatus:403,recordIds:[]};delete store.records[clip.id];store.lookups[clip.id]={status:'not-found',recordIds:[]};store.records[smpl.id]={...smpl,title:'A Completely Different Article about Weather Forecasting'};
  const d=bibliographyDiagnostics(raw,store,reconcileIndex(raw,store));assert.equal(d.curatedAliases[0].applicationStatus,'lookup-failed');assert.equal(d.curatedAliases[1].applicationStatus,'search-miss');assert.equal(d.curatedAliases[2].identityStatus,'matching-failed');assert.equal(d.curatedAliases[2].applicationStatus,'matching-failed');
  assert.equal(d.candidates.find(p=>p.id==='name:maml').cause,'lookup-failed');assert.equal(d.candidates.find(p=>p.id==='name:clip').cause,'search-miss');
});

const review=(candidateId='name:grace',changes={})=>({candidateId,decision:'match',recordId:r.id,evidence:[{type:'exact-title',detail:'The candidate expansion matches this official title.'}],needsManualReview:false,...changes});
test('import schema and dry-run preserve manual decisions and only apply explicitly selected safe proposals',()=>{
  const raw=buildIndex([doc(['GraCE 논문','FROST 논문'])]),store=storeOf(r),decisions={'name:frost':{action:'separate',updatedAt:'old',note:'preserve'}},resolved=reconcileIndex(raw,store,decisions),before=JSON.stringify([raw,store,decisions]);
  const value={schemaVersion:1,decisions:[review(),review('name:frost',{decision:'separate',recordId:null})]},plan=planReviewImport(raw,store,resolved,decisions,value);
  assert.equal(plan.applicable,1);assert.equal(plan.rows[1].status,'preserved');assert.equal(JSON.stringify([raw,store,decisions]),before,'dry-run must not write any decisions or metadata');
  const applied=applyReviewPlan(plan,decisions,['name:grace'],'new');assert.equal(applied['name:grace'].action,'match');assert.deepEqual(applied['name:frost'],decisions['name:frost']);assert.equal(applied['name:grace'].decisionSource,'llm-reviewed');
  for(const changes of [{needsManualReview:true},{evidence:[]},{evidence:[{type:'possible-work-version',detail:'Same authors but different version IDs'}]}])assert.equal(planReviewImport(raw,store,resolved,decisions,{schemaVersion:1,decisions:[review('name:grace',changes)]}).applicable,0);
  assert.throws(()=>applyReviewPlan(plan,decisions,[]));assert.throws(()=>applyReviewPlan(plan,decisions,['name:frost']));assert.throws(()=>applyReviewPlan(plan,decisions,['name:grace','name:grace']));
  for(const value of [{schemaVersion:2,decisions:[]},{schemaVersion:1,decisions:[review(),review()]},{schemaVersion:1,decisions:[review('unknown')]},{schemaVersion:1,decisions:[review('name:grace',{recordId:'doi:10.1234/unknown'})]},{schemaVersion:1,decisions:[review('name:grace',{extra:true})]}])assert.throws(()=>planReviewImport(raw,store,resolved,decisions,value));
  assert.deepEqual(reviewResultSchema.properties.decisions.items.required,['candidateId','decision','recordId','evidence','needsManualReview']);assert.equal(validateReviewResult(value),value);
});
