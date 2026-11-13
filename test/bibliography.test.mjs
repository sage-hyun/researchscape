import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIndex,activeMessages,identifiers} from '../lib/extract.mjs';
import {publisherLink} from '../lib/paper-links.mjs';
import {crossrefRecord,arxivRecords,synchronizeBibliography} from '../lib/bibliography.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';

const title='SMPL: A Skinned Multi-Person Linear Model';
const record=(doi='10.1234/smpl',name=title)=>crossrefRecord({DOI:doi,title:[name],author:[{given:'First',family:'Author'}],published:{'date-parts':[[2015]]},'container-title':['Test Venue']});
const doc=(id,text)=>({id,title:id,messages:[{id,role:'user',text,date:1}]});

test('export citation metadata restores a paper link only when that paper is named in visible text',()=>{
  const c={id:'c',current_node:'m',mapping:{m:{parent:null,message:{id:'m',author:{role:'assistant'},content:{parts:[`**${title}** 논문을 보자.`]},metadata:{content_references:[{type:'grouped_webpages',items:[{title,url:'https://doi.org/10.1234/smpl',supporting_websites:[{title:'A Completely Different Paper about Robotics',url:'https://arxiv.org/abs/2501.99999'}]}]}],search_result_groups:[{entries:[{title,url:'https://arxiv.org/abs/2501.11111'}]}]}}}}};
  const messages=activeMessages(c);assert.equal(messages[0].references.length,2);
  const index=buildIndex([c]);assert.equal(index.papers.length,1);assert.equal(index.papers[0].id,'doi:10.1234/smpl');assert.ok(index.papers[0].linkEvidence.length);assert.equal(index.stats.recoveredCitationPapers,1);
  assert.equal(index.mentions[0].quote,title);assert.equal(index.papers[0].count,1);
});
test('publisher PDF/HTML forms canonicalize without treating general webpages as papers',()=>{
  assert.equal(publisherLink('https://aclanthology.org/2025.naacl-long.173.pdf?utm_source=test').url,'https://aclanthology.org/2025.naacl-long.173/');
  const a=publisherLink('https://openaccess.thecvf.com/content/CVPR2025/papers/Example_Test_paper.pdf');
  const b=publisherLink('https://openaccess.thecvf.com/content/CVPR2025/html/Example_Test_paper.html');assert.equal(a.key,b.key);
  assert.equal(publisherLink('https://example.com/a-blog-about-SMPL'),null);
  assert.equal(identifiers('https://aclanthology.org/2025.naacl-long.173.pdf').length,1);
  assert.equal(identifiers('(https://doi.org/10.1145/3594738.3611361)n')[0].key,'doi:10.1145/3594738.3611361');
  const migrated=buildIndex([doc('legacy','https://doi.org/10.1145/3594738.3611361)n')]);
  assert.ok(migrated.papers[0].memberIds.includes('doi:10.1145/3594738.3611361)n'));
  assert.equal(identifiers('https://doi.org/10.1234/foo(bar)')[0].key,'doi:10.1234/foo(bar)');
});
test('exact official titles and identifiers merge while preserving observed names and mention provenance',()=>{
  const raw=buildIndex([doc('title',`**${title}** 논문`),doc('id','https://doi.org/10.1234/smpl')]);
  assert.equal(raw.papers.length,2);
  const r=record(),store={records:{[r.id]:r},lookups:{}};
  const resolved=reconcileIndex(raw,store);assert.equal(resolved.papers.length,1);assert.equal(resolved.papers[0].title,title);assert.equal(resolved.papers[0].metadata.provider,'Crossref');assert.equal(resolved.papers[0].sourceCandidateIds.length,2);
  assert.equal(resolved.papers[0].count,2);assert.equal(resolved.papers[0].conversationCount,2);assert.equal(resolved.stats.mergedCandidates,1);assert.ok(resolved.papers[0].aliases.includes('SMPL'));
  assert.ok(resolved.mentions.every(m=>raw.papers.some(p=>p.id===m.sourcePaperId)));
  const separated=reconcileIndex(raw,store,Object.fromEntries(raw.papers.map(p=>[p.id,{action:'separate'}])));assert.equal(separated.papers.length,2);
});
test('conflicting titles and acronym-only matches remain proposals instead of automatic merges',()=>{
  const raw=buildIndex([doc('c',`**${title}** 논문`),doc('d','GraCE 논문')]);
  const a=record(),b=record('10.1234/other'),grace=record('10.1234/grace','GraCE: Graph Contrastive Embeddings for Motion Learning');
  const resolved=reconcileIndex(raw,{records:{[a.id]:a,[b.id]:b,[grace.id]:grace},lookups:{}});
  assert.ok(resolved.papers.every(p=>!p.metadata));assert.equal(resolved.resolutionQueue.length,2);
  assert.equal(resolved.resolutionQueue.find(q=>q.title===title).reason,'conflicting-metadata');
  const manual=reconcileIndex(raw,{records:{[grace.id]:grace},lookups:{}},{'name:grace':{action:'match',recordId:grace.id}});
  assert.equal(manual.papers.find(p=>p.id===grace.id).resolution.reason,'user-confirmed');
});
test('official response parsers preserve author/year, arXiv versions and published DOI identity',()=>{
  assert.equal(crossrefRecord({DOI:'10.1234/subtitle',title:['SMPL'],subtitle:['A Skinned Multi-Person Linear Model']}).title,title);
  const xml='<feed><entry><id>http://arxiv.org/abs/2410.17127v3</id><title>PAPILLON: Privacy &amp; Learning</title><published>2024-10-01T00:00:00Z</published><author><name>Some Author</name></author><arxiv:doi>10.1234/Paper</arxiv:doi></entry></feed>';
  const r=arxivRecords(xml,'https://export.arxiv.org/api/query')[0];assert.equal(r.id,'doi:10.1234/paper');assert.equal(r.title,'PAPILLON: Privacy & Learning');assert.equal(r.year,2024);assert.ok(r.identifiers.some(i=>i.key==='arxiv:2410.17127'));assert.deepEqual(r.authors,['Some Author']);
});
test('a conflicting observed title is not silently replaced by the DOI target',()=>{
  const other='Completely Unrelated: Learning Weather Forecasts from Satellite Images';
  const raw=buildIndex([doc('wrong',`[${other}](https://doi.org/10.1234/smpl) 논문`)]);
  const r=record(),resolved=reconcileIndex(raw,{records:{[r.id]:r},lookups:{}});
  assert.equal(resolved.papers[0].metadata,null);assert.equal(resolved.resolutionQueue[0].reason,'identifier-title-conflict');
});
test('metadata requests are cached, send no message bodies, and do not bypass OpenReview challenges',async()=>{
  const raw=buildIndex([doc('a','PRIVATE_MESSAGE_BODY_DO_NOT_SEND https://doi.org/10.1234/smpl'),doc('b','https://openreview.net/forum?id=first https://openreview.net/forum?id=second')]);
  const store={records:{},lookups:{}},requests=[];
  const mock=async url=>{requests.push(url);if(url.includes('openreview'))return new Response('{}',{status:403});return new Response(JSON.stringify({message:{DOI:'10.1234/smpl',title:[title]}}),{headers:{'Content-Type':'application/json'}});};
  await synchronizeBibliography(raw,store,{fetchFn:mock,delay:0,limit:1});
  assert.equal(requests.filter(u=>u.includes('openreview')).length,1);
  assert.ok(requests.every(u=>!u.includes('PRIVATE_MESSAGE_BODY_DO_NOT_SEND')&&!u.includes('conversation')));
  const first=requests.length;await synchronizeBibliography(raw,store,{fetchFn:mock,delay:0,limit:1});assert.equal(requests.length,first);assert.ok(store.records['doi:10.1234/smpl']);
});
