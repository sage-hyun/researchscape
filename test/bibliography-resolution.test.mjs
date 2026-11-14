import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildIndex,discover,identifiers,normalize} from '../lib/extract.mjs';
import {candidatePolicy} from '../lib/bibliography-policy.mjs';
import {crossrefRecord,arxivRecords,putRecord} from '../lib/bibliography.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';
import {bibliographyDiagnostics} from '../lib/bibliography-diagnostics.mjs';

const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/bibliography-candidates.json',import.meta.url)));
const doc=(id,text)=>({id,title:id,projectId:'fixture-project',messages:[{id:`m-${id}`,text,role:'user',date:123}]});
function official(p){
  if(p.doi)return crossrefRecord({DOI:p.doi,title:[p.title]});
  return arxivRecords(`<feed><entry><id>https://arxiv.org/abs/${p.arxiv}v2</id><title>${p.title}</title></entry></feed>`,'https://export.arxiv.org/api/query')[0];
}
const storeOf=(...rs)=>({records:Object.fromEntries(rs.map(r=>[r.id,r])),lookups:{}});
const titleId=t=>`title:${normalize(t)}`;

test('MAML, CLIP, SMPL and IMUTube require the curated identifier AND official title',()=>{
  for(const p of fixtures.papers){
    const raw=buildIndex([doc('c',`${p.alias} 논문`)]),r=official(p);
    const good=reconcileIndex(raw,storeOf(r));assert.equal(good.papers.length,1);assert.equal(good.papers[0].metadata.id,r.id);assert.equal(good.papers[0].resolution.reason,'verified-alias-identifier');
    assert.ok(good.papers[0].resolution.evidence.some(e=>e.source==='verified-alias'));
    const wrong={...r,title:'Completely Different Learning Methods for Weather Prediction',alternateTitles:[]};
    assert.equal(reconcileIndex(raw,storeOf(wrong)).papers[0].metadata,null);
    const arbitrary={...r,id:'doi:10.1234/unrelated',identifiers:identifiers('10.1234/unrelated')};
    assert.equal(reconcileIndex(raw,storeOf(arbitrary)).papers[0].metadata,null,'a title alone cannot validate a standalone acronym');
  }
});

test('ZUPT, CHI, dataset names and document headings never auto-link from cached search results',()=>{
  for(const p of fixtures.nonPapers){
    assert.equal(candidatePolicy(p.title).kind,p.kind);
    const raw={papers:[{id:titleId(p.title),title:p.title,aliases:[],identifiers:[],count:1}],mentions:[{paperId:titleId(p.title),conversationId:'c',messageId:'m',start:0,end:p.title.length,quote:p.title,date:1}],stats:{},conversations:[]};
    const r=crossrefRecord({DOI:'10.1234/false-positive',title:[p.title]});
    const resolved=reconcileIndex(raw,storeOf(r));assert.equal(resolved.papers[0].metadata,null);assert.equal(resolved.resolutionQueue[0].reason,`candidate-type:${p.kind}`);
  }
  const extracted=buildIndex([doc('headings','논문 검토\n## Related Work on Human Motion Learning\n## Model Architecture for Inertial Motion Learning\n## Motion Learning: Key Idea and Architecture')]);
  assert.ok(reconcileIndex(extracted,storeOf()).papers.every(p=>p.resolution.status==='needs-review'));
});

test('a shared acronym does not merge papers across conversations; local expansions must cover all occurrences',()=>{
  const a='GraCE: Graph Contrastive Embeddings for Motion Learning',b='GraCE: General Reconstruction and Consistent Estimation';
  const ra=crossrefRecord({DOI:'10.1234/grace-a',title:[a]}),rb=crossrefRecord({DOI:'10.1234/grace-b',title:[b]}),store=storeOf(ra,rb);
  const same=buildIndex([doc('same',`**${a}** 논문. GraCE 논문 비교`)]);
  const resolved=reconcileIndex(same,store);assert.equal(resolved.papers.length,1);assert.equal(resolved.papers[0].count,2);
  const different=buildIndex([doc('a',`**${a}** 논문. GraCE 논문`),doc('b',`**${b}** 논문. GraCE 논문`)]);
  const conflict=reconcileIndex(different,store);assert.equal(conflict.papers.length,3);assert.equal(conflict.resolutionQueue.find(p=>p.id==='name:grace').reason,'conflicting-metadata');
  const uncovered=buildIndex([doc('a',`**${a}** 논문. GraCE 논문`),doc('c','GraCE 논문')]);
  assert.equal(reconcileIndex(uncovered,store).papers.find(p=>p.id==='name:grace').metadata,null);
  const id=buildIndex([doc('explicit','GraCE 논문 https://doi.org/10.1234/grace-a')]);
  assert.equal(reconcileIndex(id,store).papers.length,1,'a matching explicit ID and alias expansion in the same conversation are evidence');
});

test('curated aliases do not override a conflicting expansion or absorb SMPL-X',()=>{
  const clip=official(fixtures.papers[1]),other=crossrefRecord({DOI:'10.1234/clip',title:['CLIP: Contrastive Learning for Inertial Prediction']});
  const raw=buildIndex([doc('c',`**${other.title}** 논문. CLIP 논문`)]),result=reconcileIndex(raw,storeOf(clip,other));
  assert.equal(result.papers.find(p=>p.id==='name:clip').metadata,null);assert.equal(result.resolutionQueue.find(p=>p.id==='name:clip').reason,'conflicting-metadata');
  const smpl=official(fixtures.papers[2]),separate=reconcileIndex(buildIndex([doc('c','SMPL 논문, SMPL-X 논문')]),storeOf(smpl));
  assert.equal(separate.papers.length,2);assert.equal(separate.papers.find(p=>p.id==='name:smplx').metadata,null);
});

test('shared identifiers unify provider duplicates without merging equal titles with different DOIs',()=>{
  const p=fixtures.papers[0],arxiv=official(p),doi=crossrefRecord({DOI:'10.1234/published',title:[p.title]});
  const bridge={...arxiv,id:'openalex:Wfixture',provider:'OpenAlex',identifiers:[...arxiv.identifiers,...doi.identifiers]};
  const raw=buildIndex([doc('a',`**${p.title}** 논문`),doc('b','https://arxiv.org/abs/1703.03400v3'),doc('c','https://doi.org/10.1234/published')]);
  const store=storeOf(arxiv,doi,bridge),before=structuredClone(store),resolved=reconcileIndex(raw,store);
  assert.equal(resolved.papers.length,1);assert.equal(resolved.papers[0].count,3);assert.deepEqual(store,before,'catalog consolidation must not delete persistent record IDs');
  const other=crossrefRecord({DOI:'10.1234/different-edition',title:[p.title]});
  const conflict=reconcileIndex(raw,storeOf(arxiv,doi,bridge,other));
  assert.equal(conflict.papers.find(p=>p.sourceCandidateIds.includes(titleId(p.title))).metadata,null);
  const contradiction={...bridge,identifiers:[...bridge.identifiers,...other.identifiers]};
  assert.ok(reconcileIndex(raw,storeOf(arxiv,doi,contradiction)).resolutionQueue.some(q=>q.reason==='conflicting-metadata'));
});

test('an explicit identifier selects its edition even when another DOI has the same full title',()=>{
  const title=fixtures.papers[2].title,a=crossrefRecord({DOI:'10.1234/edition-a',title:[title]}),b=crossrefRecord({DOI:'10.1234/edition-b',title:[title]});
  const identified=buildIndex([doc('c',`[${title}](https://doi.org/10.1234/edition-a) 논문`)]);
  assert.equal(reconcileIndex(identified,storeOf(a,b)).papers[0].metadata.id,a.id);
  const unlinked=buildIndex([doc('c',`**${title}** 논문`)]);assert.equal(reconcileIndex(unlinked,storeOf(a,b)).papers[0].metadata,null);
  const conflict='Another Inertial Motion Representation Learning Method';
  const other=crossrefRecord({DOI:'10.1234/other',title:[conflict]});
  const mixed=structuredClone(identified);mixed.papers[0].aliases.push(conflict);
  assert.equal(reconcileIndex(mixed,storeOf(a,b,other)).papers[0].metadata,null);
});

test('manual separation cannot collide with a canonical DOI group; manual match and raw evidence survive',()=>{
  const p=fixtures.papers[2],r=official(p),raw=buildIndex([doc('a',`**${p.title}** 논문`),doc('b',`https://doi.org/${p.doi}`)]);
  const before=structuredClone(raw),decisions={[r.id]:{action:'separate',updatedAt:'fixture'}};
  const result=reconcileIndex(raw,storeOf(r),decisions);assert.equal(result.papers.length,2);assert.equal(result.papers.find(p=>p.sourceCandidateIds.includes(r.id)).metadata,null);
  assert.deepEqual(raw,before);assert.deepEqual(decisions,{[r.id]:{action:'separate',updatedAt:'fixture'}});
  for(const m of result.mentions){const old=raw.mentions.find(x=>x.messageId===m.messageId&&x.start===m.start);for(const key of ['quote','excerpt','excerptStart','excerptEnd','contentHash','conversationId','date','role'])assert.equal(m[key],old[key]);}
});

test('conflicting provider identifiers stay reviewable, and putRecord retains URL types and provenance',()=>{
  const p=fixtures.papers[2],r=official(p),store=storeOf(r);
  putRecord(store,{...r,provider:'OpenAlex',sourceUrl:'https://api.openalex.org/works?search.title=SMPL',links:{landing:[{url:'https://publisher.example/paper',provider:'OpenAlex',sourceUrl:'https://api.openalex.org/works'}],pdf:[{url:'https://publisher.example/paper.pdf',provider:'OpenAlex',sourceUrl:'https://api.openalex.org/works'}]}});
  assert.equal(store.records[r.id].provider,'Crossref');assert.ok(store.records[r.id].links.doi.length);assert.ok(store.records[r.id].links.pdf.length);assert.ok(store.records[r.id].links.landing.length);assert.equal(store.records[r.id].sources.length,2);
  const raw=buildIndex([doc('pdf','https://arxiv.org/pdf/1703.03400v2.pdf')]);
  assert.ok(raw.papers[0].links.pdf.some(l=>l.url.includes('v2.pdf')),'the observed PDF URL is retained alongside canonical IDs');
});

test('a mismatched link label and conflicting provider title cannot validate an acronym indirectly',()=>{
  const r=crossrefRecord({DOI:'10.1234/wrong',title:['Other: Weather Prediction from Satellite Images']});
  const raw=buildIndex([doc('c','[SMPL](https://doi.org/10.1234/wrong) 논문')]);
  const result=reconcileIndex(raw,storeOf(r));assert.ok(result.papers.every(p=>!p.metadata));assert.equal(result.resolutionQueue[0].reason,'identifier-title-conflict');
  const grace=crossrefRecord({DOI:'10.1234/grace',title:['GraCE: Graph Contrastive Embeddings for Motion Learning']});
  const wrong=buildIndex([doc('c','[GraCE: General Weather Prediction from Satellite Images](https://doi.org/10.1234/grace) 논문. GraCE 논문')]);
  assert.ok(reconcileIndex(wrong,storeOf(grace)).papers.every(p=>!p.metadata),'a conflicting long-title citation cannot supply context evidence');
  const store=storeOf(grace);putRecord(store,{...grace,provider:'OpenAlex',title:'Completely Unrelated Satellite Image Weather Forecasting Research'});
  assert.ok(store.records[grace.id].metadataConflicts.length);
  assert.ok(reconcileIndex(buildIndex([doc('c','https://doi.org/10.1234/grace')]),store).papers.every(p=>!p.metadata));
});

test('legacy log diagnostics separate access failure, search miss and matching failure without message text',()=>{
  const titles=['A Unique Study of Human Motion Estimation','A Different Study of Sensor Motion Learning','An Unmatched Study of Inertial Motion Tracking'];
  const raw=buildIndex(titles.map((t,i)=>doc(`c${i}`,`PRIVATE_CONTEXT **${t}** 논문`))),r=crossrefRecord({DOI:'10.1234/other',title:['Other Learning Models for Virtual Motion']});
  const lookups={
    [titleId(titles[0])]:{status:'error',error:'HTTP 403 · api.crossref.org',recordIds:[]},
    [titleId(titles[1])]:{status:'not-found',recordIds:[]},
    [titleId(titles[2])]:{status:'ok',recordIds:[r.id]}
  },store={...storeOf(r),lookups};
  const d=bibliographyDiagnostics(raw,store,reconcileIndex(raw,store));
  assert.equal(d.summary['lookup-failed'],1);assert.equal(d.summary['search-miss'],1);assert.equal(d.summary['matching-failed'],1);assert.equal(d.lookupSummary['access-denied'],1);assert.ok(!JSON.stringify(d).includes('PRIVATE_CONTEXT'));
});

test('nearby and truncated citation metadata cannot supply a new automatic identifier match',()=>{
  const title='A Comprehensive Framework for Learning Human Motion Representations from Wearable Inertial Sensors';
  for(const refTitle of [title.replace('Wearable','Mobile'),title.slice(0,75)+'…']){
    const found=discover(`**${title}** 논문`,[{title:refTitle,url:'https://doi.org/10.1234/citation'}]);
    assert.ok(found.every(d=>d.kind!=='doi'));
  }
  const wrong=title.replace('Wearable','Mobile'),raw=buildIndex([doc('c',`**${title}** 논문`)]),r=crossrefRecord({DOI:'10.1234/citation',title:[wrong]});
  raw.papers[0].identifiers=r.identifiers;raw.papers[0].linkEvidence=[{title:wrong,url:r.url,source:'export-citation'}];
  const result=reconcileIndex(raw,storeOf(r));assert.equal(result.papers[0].metadata,null);assert.equal(result.resolutionQueue[0].reason,'citation-title-conflict');
  const known=crossrefRecord({DOI:'10.1234/citation',title:[title]});assert.ok(reconcileIndex(raw,storeOf(known)).papers[0].metadata,'an independent exact official title can still prove the identity');
});

test('identifier-only candidate diagnostics distinguish a provider 404 from an HTTP access failure',()=>{
  const raw=buildIndex([doc('a','https://doi.org/10.1234/missing'),doc('b','https://openreview.net/forum?id=restricted')]);
  const store={records:{},lookups:{'doi:10.1234/missing':{status:'error',error:'HTTP 404 · api.crossref.org',recordIds:[]},'openreview:restricted':{status:'error',error:'HTTP 403 · api2.openreview.net',recordIds:[]}}};
  const d=bibliographyDiagnostics(raw,store,reconcileIndex(raw,store));assert.equal(d.summary['search-miss'],1);assert.equal(d.summary['lookup-failed'],1);assert.equal(d.lookupSummary['identifier-not-indexed'],1);assert.equal(d.lookupSummary['access-denied'],1);
});
