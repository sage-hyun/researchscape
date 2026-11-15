import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {AnnotationManager} from '../lib/annotation-manager.mjs';import {ANNOTATION_COLORS,validateAnnotationJSON} from '../lib/annotation-schema.mjs';import {figurePython} from '../lib/python-worker.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),python=figurePython(root),available=spawnSync(python,['-c','import pypdf,pypdfium2'],{windowsHide:true}).status===0;
const paper={id:'title:fixture',title:'Synthetic Scientific Paper',memberIds:['title:legacy']};
const proposal=(id,quote,extra={})=>({id,type:'highlight',quote,pageHint:1,category:'method',color:ANNOTATION_COLORS.method,comment:'AI interpretation, separate from the source quotation.',reason:'Important method detail.',origin:'llm',status:'proposed',...extra});
async function fixture(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rs-annotations-')),pdf=path.join(dir,'source.pdf');const made=spawnSync(python,[path.join(root,'test/fixtures/make-annotation-pdf.py'),pdf],{encoding:'utf8',windowsHide:true});assert.equal(made.status,0,made.stderr);
  const hash=createHash('sha256').update(await fs.readFile(pdf)).digest('hex'),media={refresh(){},match(){return {status:'matched',selected:{path:pdf,hash,exists:true,itemKey:'ITEM0001',attachmentKey:'PDF00001',source:'zotero'}};},assertTestScope(value){assert.equal(value,hash,'pilot boundary preserved');}};
  const context={mentionId:'mention-fixture',paperId:paper.id,conversationId:'fixture-conversation',messageId:'fixture-message',projectId:'g-p-fixture',projectName:'Video-to-IMU',conversationTitle:'Fixture context',text:'PRIVATE_PREFIX selected research possibility PRIVATE_SUFFIX',quote:'DO_NOT_EXPORT_UNSELECTED_QUOTE',url:'https://chatgpt.com/c/fixture-conversation'};
  const manager=new AnnotationManager({root,state:dir,media,getPaper:()=>paper,getContexts:async()=>[context]});
  const header={schemaVersion:1,paperId:paper.id,zoteroItemKey:'ITEM0001',zoteroAttachmentKey:'PDF00001',pdfHash:hash};
  return {dir,pdf,hash,manager,media,header,context,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('schema reports individual invalid annotations and forbids forged approvals',()=>{
  const value={schemaVersion:1,paperId:'fixture',pdfHash:'a'.repeat(64),zoteroItemKey:null,zoteroAttachmentKey:null,annotations:[proposal('one','A real source sentence.'),proposal('bad','invented',{status:'approved'})]};
  const result=validateAnnotationJSON(value);assert.equal(result.valid.length,1);assert.equal(result.errors[0].index,1);
});
test('selected exports, JSON dedup, PDF matching, approval, editing and separate Highlight copies preserve original data',{skip:!available},async()=>{
  const x=await fixture();try{
    const original=await fs.readFile(x.pdf);await fs.mkdir(path.join(x.dir,'media'));await fs.writeFile(path.join(x.dir,'media/state.json'),'KEEP_CROP_AND_THUMBNAIL');
    x.manager.prepare(paper);await x.manager.promise;assert.equal(x.manager.job().status,'complete',x.manager.job().error);const detail=await x.manager.detail(paper);assert.equal(detail.pages.length,2);
    const packet=await x.manager.exportInput(paper,{sectionIds:[detail.sections[0].id]});assert.equal(packet.contexts.length,0);assert.ok(!JSON.stringify(packet).includes('PRIVATE_'));
    const selected=await x.manager.exportInput(paper,{sectionIds:[detail.sections[0].id],mode:'research-context',contextSelections:[{mentionId:x.context.mentionId,start:15,end:45}]});assert.equal(selected.contexts[0].text,x.context.text.slice(15,45));assert.ok(!JSON.stringify(selected).includes('PRIVATE_PREFIX'));assert.ok(!JSON.stringify(selected).includes('DO_NOT_EXPORT_UNSELECTED_QUOTE'));
    const payload={...x.header,annotations:[proposal('unique','We study robust wearable motion learning.'),proposal('multiline','Our model transfers international knowledge across sensor domains.'),proposal('repeat','Repeated statement for ambiguity.'),proposal('unmatched','This fabricated quote is not present in the document.'),proposal('rotated','This rotated page keeps the original coordinates.',{pageHint:2})]};
    assert.equal((await x.manager.importJSON(paper,payload)).imported,5);x.manager.map(paper);await x.manager.promise;assert.equal(x.manager.job().status,'complete',x.manager.job().error);
    let entries=(await x.manager.detail(paper)).annotations;const find=id=>entries.find(a=>a.sourceId===id);
    assert.equal(find('unique').match.status,'matched');assert.equal(find('multiline').match.status,'matched');assert.equal(find('multiline').match.selected.quads.length,2);assert.equal(find('repeat').match.status,'ambiguous');assert.equal(find('repeat').match.locations.length,2);assert.equal(find('unmatched').match.status,'unmatched');
    assert.equal(find('rotated').match.status,'matched');assert.equal(find('rotated').match.selected.page,2);assert.ok(find('rotated').match.selected.rects.every(r=>r.every(v=>v>=0&&v<=1)));
    await assert.rejects(x.manager.review(paper,{id:find('repeat').id,status:'approved'}),/matched/);
    const repeat=find('repeat'),location=repeat.match.locations[0],rs=location.rects,rect=[Math.min(...rs.map(r=>r[0]))-.001,Math.min(...rs.map(r=>r[1]))-.001,Math.max(...rs.map(r=>r[2]))+.001,Math.max(...rs.map(r=>r[3]))+.001];await x.manager.resolve(paper,{id:repeat.id,page:1,rect});
    for(const id of ['unique','multiline','repeat'])await x.manager.review(paper,{id:find(id).id,status:'approved'});
    assert.equal((await x.manager.importJSON(paper,payload)).duplicates,5);entries=(await x.manager.detail(paper)).annotations;assert.equal(find('unique').status,'approved');
    const stableId=find('unique').id;await x.manager.review(paper,{id:stableId,comment:'Edited by the user.'});assert.equal((await x.manager.detail(paper)).annotations.find(a=>a.id===stableId).status,'proposed');await x.manager.review(paper,{id:stableId,status:'approved'});
    x.manager.exportPDF(paper);await x.manager.promise;assert.equal(x.manager.job().status,'complete',x.manager.job().error);const exported=(await x.manager.detail(paper)).exports[0],file=x.manager.exportFile(exported.id);assert.equal(exported.added,3);
    const verify=spawnSync(python,['-c',`from pypdf import PdfReader;import sys,json\nr=PdfReader(sys.argv[1]);items=[a.get_object() for p in r.pages for a in p.get('/Annots',[])];print(json.dumps({'pages':len(r.pages),'original':sum(a.get('/Contents')=='Existing fixture annotation' for a in items),'highlights':sum(a.get('/Subtype')=='/Highlight' for a in items),'quadCounts':[len(a['/QuadPoints']) for a in items if a.get('/Subtype')=='/Highlight']}))`,file],{encoding:'utf8',windowsHide:true});assert.equal(verify.status,0,verify.stderr);const checked=JSON.parse(verify.stdout);assert.equal(checked.pages,2);assert.equal(checked.original,1);assert.equal(checked.highlights,3);assert.ok(checked.quadCounts.every(n=>n%8===0));
    const before=await fs.stat(file);x.manager.exportPDF(paper);await x.manager.promise;assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs);
    assert.deepEqual(await fs.readFile(x.pdf),original);assert.equal(await fs.readFile(path.join(x.dir,'media/state.json'),'utf8'),'KEEP_CROP_AND_THUMBNAIL');
    const mismatch=await x.manager.importJSON(paper,{...payload,pdfHash:'b'.repeat(64)});assert.equal(mismatch.pdfMismatch,true);assert.equal(mismatch.imported,0);
    const restarted=new AnnotationManager({root,state:x.dir,media:x.media,getPaper:()=>paper,getContexts:async()=>[x.context]});assert.equal((await restarted.detail(paper)).annotations.find(a=>a.id===stableId).status,'approved');
  }finally{await x.cleanup();}
});
test('ligature and line-hyphen normalization keep a verifiable mapping back to original character indices',{skip:!available},()=>{
  const code=`import importlib.util,sys\nspec=importlib.util.spec_from_file_location('annotation_pdf',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nglyphs=[[c,None,0] for c in 'of\uFB01ce'];text,mapping=m.normalized(glyphs);assert text=='office';assert mapping[2]==mapping[3]==2\nglyphs=[[c,None,0] for c in 'inter-\\nnational'];assert m.normalized(glyphs,True)[0]=='international';assert m.normalized(glyphs,False)[0]=='inter-national'\nprint('verified')`;
  const result=spawnSync(python,['-c',code,path.join(root,'scripts/annotation-pdf.py')],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
});
test('interrupted annotation preparation resumes from cached PDF data after restart',{skip:!available},async()=>{
  const x=await fixture();try{
    x.manager.prepare(paper);await x.manager.promise;const layout=path.join(x.dir,'annotation-layout',x.hash,'pdfium-v2.json'),before=await fs.readFile(layout);const worker=x.manager.worker;let entered;const ready=new Promise(r=>entered=r);
    x.manager.worker=async(root,script,args,{signal})=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};x.manager.prepare(paper);await ready;x.manager.stop();await x.manager.promise;assert.equal(x.manager.job().status,'interrupted');
    const restarted=new AnnotationManager({root,state:x.dir,media:x.media,getPaper:()=>paper,getContexts:async()=>[],worker});restarted.prepare(paper);await restarted.promise;assert.equal(restarted.job().status,'complete');assert.deepEqual(await fs.readFile(layout),before);
  }finally{await x.cleanup();}
});
test('context notes need exported sources, and changed PDFs invalidate annotations',{skip:!available},async()=>{
  const x=await fixture();try{
    x.manager.prepare(paper);await x.manager.promise;const detail=await x.manager.detail(paper),packet=await x.manager.exportInput(paper,{sectionIds:[detail.sections[0].id],mode:'research-context',contextSelections:[{mentionId:x.context.mentionId,start:0,end:20}]});
    const note=proposal('context-note','',{type:'note',scope:'research-context',contextRefs:[x.context.mentionId]});assert.equal((await x.manager.importJSON(paper,{...x.header,annotations:[note]})).imported,0);
    const imported=await x.manager.importJSON(paper,{...x.header,requestId:packet.requestId,annotations:[note]});assert.equal(imported.imported,1);const a=(await x.manager.detail(paper)).annotations[0];await x.manager.review(paper,{id:a.id,status:'approved'});assert.equal((await x.manager.approved(paper)).annotations.length,1);
    x.media.assertTestScope=()=>{};await fs.appendFile(x.pdf,'\n% changed fixture version');assert.equal((await x.manager.detail(paper)).annotations[0].match.status,'pdf_mismatch');await assert.rejects(x.manager.review(paper,{id:a.id,status:'approved'}),/pdf_mismatch/);
  }finally{await x.cleanup();}
});
