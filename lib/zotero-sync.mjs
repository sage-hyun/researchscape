import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {loadJSON,saveJSON} from './local-store.mjs';
import {prepareLibrary,matchLibrary,paperKeys} from './pdf-library.mjs';
import {aliasIdentity} from './bibliography-policy.mjs';
import {zoteroLibrary,ZoteroError} from './zotero-client.mjs';

export const zoteroKey=()=>{const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';return [...randomBytes(8)].map(b=>alphabet[b%alphabet.length]).join('');};
const stamp=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function matchZoteroItem(paper,items,media){
  if(!paper.itemKey&&new Set((paper.memberReviews||[]).map(r=>r.itemKey).filter(Boolean)).size>1||!paper.pdfKey&&new Set((paper.memberReviews||[]).map(r=>r.pdfKey).filter(Boolean)).size>1)return {status:'needs-review',reason:'conflicting-manual-keys'};
  if(paper.reviewConflict&&!paper.itemKey)return {status:'needs-review',reason:'conflicting-manual-keys'};
  const manual=media?.match(paper);const selected=manual?.mode==='manual'&&manual.selected?.source==='zotero'?manual.selected.itemKey:null;
  const attachment=paper.pdfKey?items.find(i=>i.key===paper.pdfKey&&i.data.itemType==='attachment'):null;
  const explicit=paper.itemKey||selected||attachment?.data.parentItem;
  if(paper.itemKey&&selected&&paper.itemKey!==selected||paper.itemKey&&attachment?.data.parentItem&&paper.itemKey!==attachment.data.parentItem)return {status:'needs-review',reason:'conflicting-manual-keys'};
  const records=prepareLibrary(items.filter(i=>!['note','annotation','attachment'].includes(i.data.itemType)).map(i=>({id:i.key,itemKey:i.key,title:i.data.title||'',doi:i.data.DOI,url:i.data.url,extra:i.data.extra,archiveId:i.data.archiveID,exists:true,source:'zotero',path:'',attachmentTitle:''})));
  if(explicit&&!records.some(r=>r.itemKey===explicit))return {status:'needs-review',reason:'missing-explicit-zotero-item'};
  if(paper.pdfKey&&!attachment&&!explicit)return {status:'needs-review',reason:'missing-explicit-zotero-attachment'};
  if(!explicit&&!paper.metadata&&!aliasIdentity(paper.title))return {status:'needs-review',reason:'unverified-bibliography'};
  const probe={...paper,itemKey:explicit,pdfKey:undefined,title:paper.metadata?.title||paper.title,canonicalTitle:paper.metadata?.title,aliases:paper.metadata?[paper.metadata.title]:[],identifiers:paper.metadata?.identifiers||[]};
  const result=matchLibrary(probe,records);
  if(!explicit&&result.selected&&['doi','arxiv'].some(kind=>{const left=probe.identifiers.filter(i=>i.kind===kind),right=result.selected.identifiers.filter(i=>i.kind===kind);return left.length&&right.length&&!left.some(a=>right.some(b=>a.key===b.key));}))return {status:'needs-review',reason:'conflicting-identifiers'};
  const reason=result.reason==='no-local-pdf'?(explicit?'missing-explicit-zotero-item':'no-zotero-item'):result.reason==='multiple-pdfs'?'multiple-zotero-items':result.reason;
  return {status:result.status,reason,itemKey:result.selected?.itemKey,candidates:result.candidates?.map(r=>r.itemKey)||[]};
}
export class ZoteroSync{
  constructor({state,client,getIndex,media}){this.stateDirectory=state;this.client=client;this.getIndex=getIndex;this.media=media;this.plans=new Map();this.busy=false;}
  read(){return loadJSON(this.stateDirectory,'zotero-sync.json',{schemaVersion:1,servers:{}});}
  save(value){saveJSON(this.stateDirectory,'zotero-sync.json',value);}
  async status(){const result=await this.client.probe(),data=this.read(),serverChanged=!!data.lastServerId&&data.lastServerId!==result.serverId;data.lastServerId=result.serverId;this.save(data);return {...result,serverChanged:serverChanged||result.serverChanged,libraries:await this.client.libraries()};}
  async preview({library='users/0',projectIds=[],paperLimit=3}={}){
    zoteroLibrary(library);if(!Array.isArray(projectIds)||!projectIds.length||projectIds.length>100||!Number.isInteger(paperLimit)||paperLimit<1||paperLimit>3000)throw new Error('프로젝트와 1~3000편의 처리 한도를 선택해주세요.');
    const connection=await this.client.probe(),serverId=connection.serverId,snapshot=this.getIndex(),projects=new Map(snapshot.projects.map(p=>[p.id,p]));for(const id of projectIds)if(!projects.has(id))throw new Error('현재 프로젝트를 다시 선택해주세요.');
    const [items,existing]=await Promise.all([this.client.get(library+'/items'),this.client.get(library+'/collections')]);
    const stored=this.read().servers[serverId]?.libraries?.[library]||{},byKey=new Map(existing.map(c=>[c.key,c])),collections=[],skipped=[];
    const choose=(id,name,parentKey,mapped)=>{
      if(mapped&&byKey.has(mapped))return {projectId:id,key:mapped,name:byKey.get(mapped).data.name,parentKey:byKey.get(mapped).data.parentCollection||false,action:'reuse'};
      if(mapped&&!stored.pending?.includes(mapped))throw new ZoteroError('MAPPING_MISSING','이전 매핑의 Collection이 삭제되었습니다. 자동으로 재생성하지 않습니다. 매핑을 확인해주세요.');
      const same=existing.filter(c=>c.data.name===name&&(c.data.parentCollection||false)===(parentKey||false));
      const duplicatedName=id&&projectIds.some(other=>other!==id&&projects.get(other).name===name);
      if(same.length>1&&!mapped)throw new ZoteroError('AMBIGUOUS_COLLECTION','이름이 같은 Collection이 여러 개입니다. 기존 Collection을 정리하거나 명시적으로 매핑해주세요.');
      return {projectId:id,key:mapped||(!duplicatedName&&same[0]?.key)||zoteroKey(),name:duplicatedName?name+' · '+id.slice(-8):name,parentKey:parentKey||false,action:!mapped&&!duplicatedName&&same[0]?'reuse':'create'};
    };
    const root=choose(null,'Researchscape',false,stored.rootKey);collections.push(root);
    for(const id of [...new Set(projectIds)])collections.push(choose(id,projects.get(id).name,root.key,stored.projects?.[id]?.collectionKey));
    const convo=new Map(snapshot.conversations.map(c=>[c.id,c])),memberships=new Map();
    for(const m of snapshot.mentions){const id=convo.get(m.conversationId)?.projectId;if(projectIds.includes(id)){if(!memberships.has(m.paperId))memberships.set(m.paperId,new Set());memberships.get(m.paperId).add(id);}}
    const candidates=snapshot.papers.filter(p=>p.status!=='dismissed'&&memberships.has(p.id)).sort((a,b)=>b.count-a.count).slice(0,paperLimit),rows=[];
    for(const p of candidates){const match=matchZoteroItem(p,items,this.media);if(match.status!=='matched'){skipped.push({paperId:p.id,title:p.title,reason:match.reason});continue;}const item=items.find(i=>i.key===match.itemKey);
      for(const projectId of memberships.get(p.id)){const collection=collections.find(c=>c.projectId===projectId);rows.push({paperId:p.id,title:p.title,itemKey:match.itemKey,projectId,collectionKey:collection.key,status:item.data.collections?.includes(collection.key)?'already-included':'add'});}}
    const plan={schemaVersion:1,serverId,library,collections,rows,skipped,paperLimit,sourceStamp:stamp(snapshot),createdAt:new Date().toISOString()},planId=randomUUID();this.plans.set(planId,{plan,expires:Date.now()+10*60000});while(this.plans.size>20)this.plans.delete(this.plans.keys().next().value);
    return {...plan,planId,writes:0};
  }
  async apply({planId,approved=false}={}){
    if(approved!==true)throw new Error('Zotero 변경 내용을 확인하고 명시적으로 적용해주세요.');if(this.busy)throw new ZoteroError('SYNC_BUSY','Zotero 동기화가 실행 중입니다.');const entry=this.plans.get(planId);if(!entry||entry.expires<Date.now())throw new ZoteroError('STALE_PLAN','동기화 미리보기를 다시 실행해주세요.');
    this.busy=true;let state;
    try{
      const plan=entry.plan,connection=await this.client.probe();if(connection.serverId!==plan.serverId||stamp(this.getIndex())!==plan.sourceStamp)throw new ZoteroError('STALE_PLAN','Zotero 서버나 논문·프로젝트 상태가 변경되었습니다. 미리보기를 다시 실행해주세요.');
      const latestItems=await this.client.get(plan.library+'/items'),latestPapers=this.getIndex().papers;
      for(const row of plan.rows){const paper=latestPapers.find(p=>p.id===row.paperId);if(!paper||matchZoteroItem(paper,latestItems,this.media).itemKey!==row.itemKey)throw new ZoteroError('STALE_PLAN','논문과 Zotero 항목의 연결이 변경되었습니다. 미리보기를 다시 실행해주세요.');}
      state=this.read();state.servers[plan.serverId]??={libraries:{}};const partition=state.servers[plan.serverId].libraries[plan.library]??={projects:{},pending:[]};
      partition.rootKey=plan.collections[0].key;for(const c of plan.collections)if(c.projectId)partition.projects[c.projectId]={collectionKey:c.key,name:c.name};
      partition.pending=[...new Set([...(partition.pending||[]),...plan.collections.filter(c=>c.action==='create').map(c=>c.key)])];state.lastServerId=plan.serverId;state.job={status:'running',serverId:plan.serverId,library:plan.library,completed:0,startedAt:new Date().toISOString()};this.save(state);
      for(const collection of plan.collections){
        let present;try{present=await this.client.get(`${plan.library}/collections/${collection.key}`);}catch(e){if(e.httpStatus!==404)throw e;}
        if(!present){if(collection.action!=='create')throw new ZoteroError('COLLECTION_CHANGED','재사용할 Collection이 삭제되었습니다. 다시 미리보기해주세요.');const response=await this.client.write(plan.library+'/collections','POST',[{key:collection.key,name:collection.name,parentCollection:collection.parentKey}],{'Zotero-Write-Token':randomBytes(16).toString('hex')});if(!response.successful?.['0']&&!response.success?.['0']&&!response.unchanged?.['0'])throw new ZoteroError('WRITE_FAILED','Collection 생성 결과를 확인하지 못했습니다.');}
        partition.pending=partition.pending.filter(k=>k!==collection.key);this.save(state);
      }
      const additions=new Map();for(const row of plan.rows){if(!additions.has(row.itemKey))additions.set(row.itemKey,new Set());additions.get(row.itemKey).add(row.collectionKey);}
      for(const [key,keys] of additions){await this.client.addCollections(plan.library,key,[...keys]);state.job.completed++;this.save(state);}
      state.job.status='complete';state.job.finishedAt=new Date().toISOString();this.save(state);this.plans.delete(planId);return {ok:true,completed:state.job.completed,serverId:plan.serverId};
    }catch(e){if(state){state.job={...state.job,status:'interrupted',error:e.message};this.save(state);}throw e;}finally{this.busy=false;}
  }
}
