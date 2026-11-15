import {ZoteroClient} from './zotero-client.mjs';
import {ZoteroSync} from './zotero-sync.mjs';
import {loadJSON} from './local-store.mjs';

export function createZoteroAPI({state,media,getIndex,json,body,client}){
  client??=new ZoteroClient({base:process.env.RESEARCHSCAPE_ZOTERO_API_URL||'http://127.0.0.1:23119/api/',serverId:loadJSON(state,'zotero-sync.json',{}).lastServerId});
  const sync=new ZoteroSync({state,client,media,getIndex});
  const handle=async(req,res,url)=>{
    try{
      if(req.method==='GET'&&url.pathname==='/api/zotero/status')return json(res,200,await sync.status());
      if(req.method==='GET'&&url.pathname==='/api/zotero/projects')return json(res,200,{projects:getIndex().projects});
      if(req.method==='POST'&&url.pathname==='/api/zotero/authorize')return json(res,200,await client.authorize());
      if(req.method==='POST'&&url.pathname==='/api/zotero/forget'){client.forget();return json(res,200,{ok:true});}
      if(req.method==='POST'&&url.pathname==='/api/zotero/sync/preview')return json(res,200,await sync.preview(await body(req)));
      if(req.method==='POST'&&url.pathname==='/api/zotero/sync/apply')return json(res,200,await sync.apply(await body(req)));
      return json(res,404,{error:'알 수 없는 Zotero 작업입니다.'});
    }catch(e){return json(res,e.httpStatus||400,{error:e.message,code:e.code||'INVALID_REQUEST'});}
  };
  return {handle,client,sync};
}
