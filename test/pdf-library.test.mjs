import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareLibrary,matchLibrary,pdfDownloadCandidates,verifyPdfIdentity} from '../lib/pdf-library.mjs';
import {downloadPdf,publicAddress,publicUrl,citationPdfUrl} from '../lib/pdf-download.mjs';
import {identifiers} from '../lib/extract.mjs';

const title='IMUTube: Automatic Extraction of Virtual on-body Accelerometry from Video for Human Activity Recognition';
const paper={id:'fixture-paper',title,canonicalTitle:title,aliases:['IMUTube'],identifiers:identifiers('10.1145/3411841')};
const record=(id='zotero:TEST1234',extra={})=>({id,title,doi:'10.1145/3411841',exists:true,path:'/fixture/main.pdf',source:'zotero',itemKey:'ITEM1234',attachmentKey:'TEST1234',...extra});

test('Zotero identities use DOI/arXiv and exact full titles; filenames alone cannot match',()=>{
  const records=prepareLibrary([record()]);assert.equal(matchLibrary(paper,records).selected.id,records[0].id);
  assert.equal(matchLibrary({...paper,identifiers:[]},records).reason,'exact-title');
  assert.equal(matchLibrary({...paper,title:'Unknown',canonicalTitle:null,aliases:[],identifiers:[]},prepareLibrary([record('other',{title:'Unknown Other Motion Learning Research',path:'/fixture/IMUTube.pdf'})])).status,'missing');
  const arxiv=prepareLibrary([record('a',{doi:'',archiveId:'2103.00020v2'})]);assert.ok(arxiv[0].identifiers.some(i=>i.key==='arxiv:2103.00020'));
});
test('short names need a verified alias identity or explicit human confirmation',()=>{
  const short={id:'name:imutube',title:'IMUTube',aliases:[],identifiers:[]};
  assert.equal(matchLibrary(short,prepareLibrary([record()])).reason,'verified-alias');
  assert.equal(matchLibrary(short,prepareLibrary([record('wrong',{doi:'10.1234/other'})])).status,'needs-review');
  const grace={id:'name:grace',title:'GraCE',aliases:[],identifiers:[]},r=prepareLibrary([record('grace',{title:'GraCE: Graph Contrastive Motion Representation Learning',doi:'10.1234/grace'})]);
  assert.equal(matchLibrary(grace,r).status,'needs-review');assert.equal(matchLibrary(grace,r,{[grace.id]:{pdfId:'grace'}}).mode,'manual');
});
test('multiple PDF versions stay reviewable while supplements and missing files do not displace a unique full text',()=>{
  const main=record(),other=record('zotero:OTHER123',{path:'/fixture/other.pdf',attachmentKey:'OTHER123'});
  assert.equal(matchLibrary(paper,prepareLibrary([main,other])).status,'needs-review');
  assert.equal(matchLibrary(paper,prepareLibrary([main,{...other,attachmentTitle:'Supplementary Material'}])).selected.id,main.id);
  assert.equal(matchLibrary(paper,prepareLibrary([main,{...other,exists:false}])).selected.id,main.id);
  assert.equal(matchLibrary({...paper,pdfKey:'OTHER123'},prepareLibrary([main,other])).selected.id,other.id);
  assert.equal(matchLibrary({...paper,pdfKey:'OTHER123',itemKey:'ITEM1234'},prepareLibrary([main,other])).selected.id,other.id);
  assert.equal(matchLibrary({...paper,pdfKey:'OTHER123',itemKey:'WRONG123'},prepareLibrary([main,other])).reason,'zotero-key-conflict');
  const merged={...paper,memberIds:['legacy-a','legacy-b']};
  assert.equal(matchLibrary(merged,prepareLibrary([main,other]),{'legacy-a':{pdfId:main.id},'legacy-b':{pdfId:other.id}}).reason,'conflicting-manual-pdfs');
});
test('identifier/title conflicts and unverified downloaded documents cannot auto-link',()=>{
  const records=prepareLibrary([record('wrong',{title:'An Entirely Different Weather Prediction Learning Method'})]);assert.equal(matchLibrary(paper,records).reason,'identifier-title-conflict');
  assert.equal(verifyPdfIdentity(paper,{firstPageText:'Unrelated paper about weather'}).ok,false);
  assert.equal(verifyPdfIdentity(paper,{firstPageText:title.replace('Virtual on-body','Virtual\non-body')}).ok,true);
  assert.equal(verifyPdfIdentity(paper,{firstPageText:'DOI: 10.1145/3411841'}).reason,'pdf-first-page-identifier');
  assert.equal(matchLibrary({...paper,title:'ACM',canonicalTitle:null,aliases:[]},prepareLibrary([record()])).reason,'candidate-type-review');
});
test('download routes prefer real PDF URLs and known preprint/publisher forms',()=>{
  const candidates=pdfDownloadCandidates({...paper,links:{pdf:[{url:'https://publisher.example/full.pdf',provider:'Fixture'}]},identifiers:[...identifiers('arxiv:2103.00020'),{kind:'publisher',url:'https://aclanthology.org/2020.acl-main.1/',key:'fixture'}]});
  assert.equal(candidates[0].kind,'pdf');assert.ok(candidates.some(c=>c.url==='https://arxiv.org/pdf/2103.00020'));assert.ok(candidates.some(c=>c.url.endsWith('2020.acl-main.1.pdf')));
  assert.equal(citationPdfUrl('<meta content="/paper.pdf?a=1&amp;b=2" name="citation_pdf_url">','https://example.org/article'),'https://example.org/paper.pdf?a=1&b=2');
});
test('download redirects cannot reach private IPs, credentials or local files',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.2','172.20.1.1','169.254.1.1','::1','fe80::1','::ffff:127.0.0.1'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);
  for(const url of ['file:///private.pdf','http://user:secret@example.org/paper.pdf','http://localhost/paper.pdf'])await assert.rejects(publicUrl(url));
  await assert.rejects(publicUrl('https://example.org/pdf',{lookupFn:async()=>[{address:'127.0.0.1'}]}),/사설/);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-download-'));
  try{
    let requests=0;
    await assert.rejects(downloadPdf({url:'https://example.org/paper'},temp,{lookupFn:async host=>[{address:host==='example.org'?'8.8.8.8':'127.0.0.1'}],fetchFn:async()=>{requests++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}}),/사설/);assert.equal(requests,1);
  }finally{assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temp,{recursive:true,force:true});}
});
test('HTML/challenges never become PDFs; streamed PDFs are content-addressed and preserve provenance',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-download-')),lookupFn=async()=>[{address:'8.8.8.8'}];
  try{
    const source={url:'https://example.org/paper',source:'Fixture'};let calls=0;
    const fetchFn=async url=>{calls++;return url.endsWith('/paper')?new Response('<meta name="citation_pdf_url" content="/full.pdf">',{headers:{'Content-Type':'text/html'}}):new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('%P'));c.enqueue(Buffer.from('DF-1.7\nfixture'));c.close();}}));};
    const result=await downloadPdf(source,temp,{lookupFn,fetchFn});assert.equal(calls,2);assert.match(result.hash,/^[a-f0-9]{64}$/);assert.equal(result.originalUrl,source.url);assert.equal(result.url,'https://example.org/full.pdf');assert.ok((await fs.readFile(result.path)).toString().startsWith('%PDF-'));
    await assert.rejects(downloadPdf(source,temp,{lookupFn,fetchFn:async()=>new Response('<html>Check you are human</html>')}),e=>e.status==='needs-browser');
    await assert.rejects(downloadPdf(source,temp,{lookupFn,fetchFn:async()=>new Response('',{status:429,headers:{'Retry-After':'60'}})}),e=>e.status==='rate-limited'&&Date.parse(e.retryAt)>Date.now());
    assert.ok((await fs.readdir(temp)).every(name=>name.endsWith('.pdf')),'partial and HTML files are cleaned up');
  }finally{assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temp,{recursive:true,force:true});}
});
