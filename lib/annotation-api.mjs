import {AnnotationManager} from './annotation-manager.mjs';
import {annotationOutputSchema,annotationPrompt} from './annotation-schema.mjs';
import {ZoteroNotes} from './zotero-notes.mjs';

export function createAnnotationAPI({root,state,media,getPaper,getContexts,client,json,body,asset}){
  const manager=new AnnotationManager({root,state,media,getPaper,getContexts}),notes=new ZoteroNotes({client,annotations:manager,media});
  const handle=async(req,res,url)=>{
    try{
      if(req.method==='GET'&&url.pathname==='/api/annotations/schema')return json(res,200,annotationOutputSchema);
      if(req.method==='GET'&&url.pathname==='/api/annotations/prompt')return json(res,200,{prompt:annotationPrompt});
      if(req.method==='GET'&&url.pathname==='/api/annotations/job')return json(res,200,manager.job());
      if(req.method==='GET'&&url.pathname==='/api/annotations/download'){const file=manager.exportFile(url.searchParams.get('exportId'));asset(res,file,{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="researchscape-annotations.pdf"','Cache-Control':'private, no-store'});return;}
      const data=req.method==='GET'?Object.fromEntries(url.searchParams):await body(req),paper=getPaper(data.paperId||data.id);
      if(req.method==='GET'&&url.pathname==='/api/annotations/paper')return json(res,200,await manager.detail(paper));
      if(req.method==='GET'&&url.pathname==='/api/annotations/contexts')return json(res,200,{paperId:paper.id,contexts:await getContexts(paper)});
      if(req.method==='GET'&&url.pathname==='/api/annotations/section'){const binding=await manager.binding(paper),section=manager.summary(binding.pdfHash)?.sections.find(s=>s.id===data.sectionId);if(!section)throw new Error('섹션을 찾지 못했습니다.');return json(res,200,section);}
      if(req.method==='GET'&&url.pathname==='/api/annotations/page'){const file=await manager.page(paper,Number(data.page));asset(res,file,{'Content-Type':'image/webp','Cache-Control':'private, max-age=3600'});return;}
      if(req.method==='POST'&&url.pathname==='/api/annotations/prepare')return json(res,202,manager.prepare(paper));
      if(req.method==='POST'&&url.pathname==='/api/annotations/export-input')return json(res,200,await manager.exportInput(paper,data));
      if(req.method==='POST'&&url.pathname==='/api/annotations/import')return json(res,200,await manager.importJSON(paper,data.payload));
      if(req.method==='POST'&&url.pathname==='/api/annotations/map')return json(res,202,manager.map(paper));
      if(req.method==='POST'&&url.pathname==='/api/annotations/review')return json(res,200,await manager.review(paper,data));
      if(req.method==='POST'&&url.pathname==='/api/annotations/resolve')return json(res,200,await manager.resolve(paper,data));
      if(req.method==='POST'&&url.pathname==='/api/annotations/export-pdf')return json(res,202,manager.exportPDF(paper));
      if(req.method==='POST'&&url.pathname==='/api/annotations/stop'){manager.stop();return json(res,200,{ok:true});}
      if(req.method==='POST'&&url.pathname==='/api/annotations/note/preview')return json(res,200,await notes.preview(paper,data));
      if(req.method==='POST'&&url.pathname==='/api/annotations/note/apply')return json(res,200,await notes.apply(paper,data));
      return json(res,404,{error:'알 수 없는 주석 작업입니다.'});
    }catch(e){return json(res,e.httpStatus||400,{error:e.message,code:e.code||'INVALID_REQUEST'});}
  };return {handle,manager,notes};
}
