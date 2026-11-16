import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {zoteroLibrary,ZoteroError} from './zotero-client.mjs';
import {matchZoteroItem,zoteroKey} from './zotero-sync.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function readingNoteHTML(paper,annotations,marker){
  const bodies=annotations.map(a=>`<h2>${esc(a.scope==='research-context'?'Research Context Annotation':'Paper Annotation')} — ${esc(a.category)}</h2><p>AI 제안 / AI 분석 · ${esc(a.createdAt)} · Annotation ${esc(a.id)}</p>${a.quote?`<blockquote>${esc(a.quote)}</blockquote><p>Page ${esc(a.match?.selected?.page||a.pageHint||'unanchored')}</p>`:'<p>특정 PDF 문장에 연결하지 않은 개인 연구 맥락 노트</p>'}<p><strong>AI comment</strong>: ${esc(a.comment)}</p><p><strong>Reason</strong>: ${esc(a.reason)}</p>${(a.contextSources||[]).map(s=>`<h3>출처: ChatGPT 연구 대화 · ${esc(s.projectName||'프로젝트 미분류')}</h3><p>${esc(s.conversationTitle)}</p><blockquote>${esc(s.text)}</blockquote><p>Mention ${esc(s.mentionId)} · Conversation ${esc(s.conversationId)} · Message ${esc(s.messageId)} · Project ${esc(s.projectId||'none')}</p>${/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(s.url||'')?`<p><a href="${esc(s.url)}">해당 대화 열기</a></p>`:''}`).join('')}`).join('');
  return `<div><h1>Researchscape AI Reading Notes</h1><p>AI가 생성하고 사용자가 승인한 주석입니다. 논문 근거와 개인 연구 아이디어는 구분해서 표시합니다.</p><p>Researchscape Paper ID: ${esc(paper.id)}</p><p>Researchscape Source ID: ${esc(marker)}</p>${bodies}</div>`;
}
export class ZoteroNotes{
  constructor({client,annotations,media}){this.client=client;this.annotations=annotations;this.media=media;this.plans=new Map();this.busy=false;}
  async preview(paper,{library='users/0'}={}){
    zoteroLibrary(library);const connection=await this.client.probe(),approved=await this.annotations.approved(paper),items=await this.client.get(library+'/items');
    const match=matchZoteroItem({...paper,itemKey:approved.binding.itemKey||paper.itemKey},items,this.media);if(match.status!=='matched')throw new Error('자식 노트를 저장할 Zotero 논문 항목을 확실하게 연결해주세요.');
    const itemKey=match.itemKey,marker='rs-note:'+digest([connection.serverId,library,itemKey].join('|')).slice(0,32),html=readingNoteHTML(paper,approved.annotations,marker),data=this.annotations.read(),slot=connection.serverId+'|'+library+'|'+itemKey,prior=data.applications[slot];
    const children=await this.client.get(`${library}/items/${itemKey}/children`),found=children.filter(i=>i.data.itemType==='note'&&i.data.note?.includes(marker));
    let action='create',blocked=null,note=found[0];if(found.length>1)blocked='관리 노트의 고유 식별자가 중복되어 있습니다. 직접 확인해주세요.';
    if(note){action=note.data.note===html||prior?.signature===approved.signature&&digest(note.data.note)===prior.htmlHash?'unchanged':'update';if(action==='update'&&(!prior?.htmlHash||digest(note.data.note)!==prior.htmlHash))blocked='사용자가 수정했거나 소유 내역을 확인할 수 없는 기존 노트를 덮어쓰지 않습니다.';}
    else if(prior?.noteKey&&prior.status!=='pending')blocked='이전에 연결된 관리 노트가 삭제되거나 식별자가 변경되었습니다. 자동으로 새 노트를 만들지 않습니다.';
    const plan={serverId:connection.serverId,library,itemKey,noteKey:note?.key||prior?.noteKey||zoteroKey(),action,blocked,marker,before:note?.data.note||'',after:html,sourceSignature:approved.signature,annotationIds:approved.annotations.map(a=>a.id),paperId:paper.id},planId=randomUUID();this.plans.set(planId,{plan,expires:Date.now()+10*60000});while(this.plans.size>20)this.plans.delete(this.plans.keys().next().value);return {...plan,planId,writes:0};
  }
  async apply(paper,{planId,approved=false}={}){
    if(approved!==true)throw new Error('노트 변경을 미리 보고 최종 승인해주세요.');if(this.busy)throw new Error('Zotero 노트 저장이 실행 중입니다.');const entry=this.plans.get(planId);if(!entry||entry.expires<Date.now()||entry.plan.paperId!==paper.id)throw new ZoteroError('STALE_PLAN','노트 미리보기를 다시 실행해주세요.');
    const plan=entry.plan;if(plan.blocked)throw new Error(plan.blocked);this.busy=true;let unlock=()=>{},failure;
    try{
      unlock=this.annotations.lockExternal?.('zotero-note',paper)||unlock;
      const connection=await this.client.probe(),current=await this.annotations.approved(paper);if(connection.serverId!==plan.serverId||current.signature!==plan.sourceSignature)throw new ZoteroError('STALE_PLAN','Zotero 서버나 승인된 주석이 변경되었습니다. 다시 미리보기해주세요.');
      const items=await this.client.get(plan.library+'/items'),match=matchZoteroItem({...paper,itemKey:paper.itemKey||current.binding.itemKey},items,this.media);
      if(match.status!=='matched'||match.itemKey!==plan.itemKey)throw new ZoteroError('STALE_PLAN','논문과 Zotero 항목의 연결이 변경되었습니다. 노트 미리보기를 다시 실행해주세요.');
      const data=this.annotations.read(),slot=plan.serverId+'|'+plan.library+'|'+plan.itemKey,prior=data.applications[slot];
      let remote;try{remote=await this.client.get(`${plan.library}/items/${plan.noteKey}`);}catch(e){if(e.httpStatus!==404)throw e;}
      if(remote&&(remote.data.itemType!=='note'||remote.data.parentItem!==plan.itemKey||!remote.data.note?.includes(plan.marker)))throw new ZoteroError('NOTE_CHANGED','관리 노트의 상위 논문이나 출처가 변경되었습니다. 덮어쓰지 않습니다.');
      if(remote&&remote.data.note!==plan.after&&remote.data.note!==plan.before)throw new ZoteroError('NOTE_CHANGED','미리보기 이후 노트가 수정되었습니다. 덮어쓰지 않습니다.');
      data.applications[slot]={...prior,noteKey:plan.noteKey,status:'pending',serverId:plan.serverId,library:plan.library,itemKey:plan.itemKey,annotationIds:plan.annotationIds};this.annotations.save(data);
      if(!remote){const response=await this.client.write(plan.library+'/items','POST',[{key:plan.noteKey,version:0,itemType:'note',parentItem:plan.itemKey,note:plan.after,tags:[]}],{'Zotero-Write-Token':randomBytes(16).toString('hex')});if(!response.successful?.['0']&&!response.success?.['0']&&!response.unchanged?.['0'])throw new ZoteroError('WRITE_FAILED','노트 생성 결과를 확인하지 못했습니다. 다시 미리보기해주세요.');}
      else if(remote.data.note!==plan.after&&plan.action!=='unchanged'){
        for(let attempt=0;attempt<3;attempt++)try{await this.client.write(`${plan.library}/items/${plan.noteKey}`,'PATCH',{note:plan.after},{'If-Unmodified-Since-Version':String(remote.version)});break;}catch(e){if(e.code!=='VERSION_CONFLICT'||attempt===2)throw e;remote=await this.client.get(`${plan.library}/items/${plan.noteKey}`);if(remote.data.note!==plan.before)throw new ZoteroError('NOTE_CHANGED','Zotero 노트가 수정되어 갱신을 중지했습니다.');}
      }
      const written=await this.client.get(`${plan.library}/items/${plan.noteKey}`);if(written.data.itemType!=='note'||written.data.parentItem!==plan.itemKey||!written.data.note?.includes(plan.marker))throw new ZoteroError('NOTE_VERIFY_FAILED','저장된 자식 노트의 소유·출처를 확인하지 못했습니다.');
      const latest=this.annotations.read();latest.applications[slot]={...latest.applications[slot],status:'applied',htmlHash:digest(written.data.note),signature:plan.sourceSignature,appliedAt:new Date().toISOString()};this.annotations.save(latest);this.plans.delete(planId);return {ok:true,action:remote?.data.note===plan.after?'unchanged':plan.action,noteKey:plan.noteKey};
    }catch(e){failure=e;throw e;}finally{unlock(failure);this.busy=false;}
  }
}
