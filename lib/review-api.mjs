// HTTP routes for durable LLM review imports. Ordinary JSON requests keep the 2MB limit; only the
// result upload accepts a larger body, bounded and parsed once before it is stored as a job.
export const REVIEW_UPLOAD_LIMIT=16*1024*1024;
const prefix='/api/bibliography/review/import';
const fail=(httpStatus,message,code)=>Object.assign(new Error(message),{httpStatus,code});

async function readUpload(req,limit){
  const declared=Number(req.headers['content-length']),chunks=[];
  let size=0,tooLarge=Number.isFinite(declared)&&declared>limit;
  for await(const chunk of req){
    size+=chunk.length;if(size>limit)tooLarge=true;
    // Keep reading (without storing) so the client receives the explanation instead of a reset.
    if(!tooLarge)chunks.push(chunk);else if(size>limit*4){req.destroy();break;}
  }
  if(tooLarge)throw fail(413,`검토 결과 JSON은 ${Math.round(limit/1024/1024)}MB 이하만 가져올 수 있습니다. 배치별 부분 결과로 나누어 가져와주세요.`,'UPLOAD_TOO_LARGE');
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw fail(400,'JSON 형식이 올바르지 않습니다. LLM 응답에서 JSON 부분만 저장했는지 확인해주세요.','INVALID_JSON');}
}

export function createReviewAPI({manager,json,body,limit=REVIEW_UPLOAD_LIMIT}){
  const handle=async(req,res,url)=>{
    try{
      const route=url.pathname.slice(prefix.length),query=url.searchParams;
      if(req.method==='GET'&&route===''){
        if(!query.get('id'))return json(res,200,manager.list());
        return json(res,200,manager.view(query.get('id'),{offset:query.get('offset')??0,limit:query.get('limit')??50,status:query.get('status')||'all',ids:query.get('ids')||''}));
      }
      if(req.method==='POST'&&route===''){
        const result=manager.create(await readUpload(req,limit),{fileName:query.get('filename')||''});
        return json(res,result.duplicate?200:202,result);
      }
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      const data=await body(req);
      if(route==='/resume')return json(res,202,manager.resume(data.importId));
      if(route==='/stop')return json(res,200,manager.stop(data.importId));
      if(route==='/apply')return json(res,200,manager.apply(data.importId,data));
      if(route==='/discard')return json(res,200,manager.discard(data.importId));
      return json(res,404,{error:'알 수 없는 검토 결과 가져오기 작업입니다.'});
    }catch(e){
      if(!e.httpStatus)console.error(e.message);
      return json(res,e.httpStatus||400,{error:e.message,code:e.code||'INVALID_REQUEST',...(e.details||{})});
    }
  };
  return {handle,prefix};
}
