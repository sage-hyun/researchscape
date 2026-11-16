import {PdfAcquisition} from './pdf-acquisition.mjs';

export function createAcquisitionAPI({state,media,client,getIndex,getPaper,json,body}){
  const manager=new PdfAcquisition({state,media,client,getIndex});
  const handle=async(req,res,url)=>{try{
    if(req.method==='GET'&&url.pathname==='/api/acquisition'){
      const p=url.searchParams,offset=Number(p.get('offset')||0),limit=Number(p.get('limit')||40);
      if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('올바른 목록 범위를 선택해주세요.');
      return json(res,200,manager.queue({projectId:p.get('projectId')||'',missingOnly:p.get('missingOnly')!=='false',status:p.get('status')||'',sort:p.get('sort')||'count',offset,limit}));
    }
    if(req.method==='GET'&&url.pathname==='/api/acquisition/job')return json(res,200,manager.job());
    if(req.method==='POST'&&url.pathname==='/api/acquisition/upload'){
      const paper=getPaper(url.searchParams.get('paperId')),chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>100*1024*1024)throw new Error('PDF는 100MB 이하만 지원합니다.');chunks.push(chunk);}
      return json(res,200,await manager.stageUpload(paper,Buffer.concat(chunks),url.searchParams.get('filename')||'paper.pdf'));
    }
    const data=await body(req);
    if(req.method==='POST'&&url.pathname==='/api/acquisition/collect')return json(res,202,manager.collect(data));
    if(req.method==='POST'&&url.pathname==='/api/acquisition/stop'){manager.stop();return json(res,200,{ok:true});}
    const paper=getPaper(data.paperId);
    if(req.method==='POST'&&url.pathname==='/api/acquisition/upload/confirm')return json(res,200,await manager.confirmUpload(paper,data));
    if(req.method==='POST'&&url.pathname==='/api/acquisition/recheck')return json(res,202,manager.recheck(paper,data));
    if(req.method==='POST'&&url.pathname==='/api/acquisition/zotero/preview')return json(res,200,await manager.preview(paper,data));
    if(req.method==='POST'&&url.pathname==='/api/acquisition/zotero/apply')return json(res,202,manager.apply(paper,data));
    return json(res,404,{error:'알 수 없는 PDF 수집 작업입니다.'});
  }catch(e){return json(res,e.httpStatus||400,{error:e.message,code:e.code||'INVALID_REQUEST'});}};
  return {handle,manager};
}
