// Zotero 10 Local API only. Keys never leave this private in-memory vault.
export class ZoteroError extends Error{
  constructor(code,message,status=409){super(message);this.code=code;this.httpStatus=status;}
}
export function zoteroLibrary(value='users/0'){
  if(typeof value!=='string'||!/^(?:users\/(?:0|[1-9]\d*)|groups\/[1-9]\d*)$/.test(value))throw new Error('올바른 Zotero library를 선택해주세요.');return value;
}
export class ZoteroClient{
  #serverId;#key=null;#remember=false;#authorizing=false;
  constructor({base='http://127.0.0.1:23119/api/',fetchFn=fetch,serverId=null}={}){
    const u=new URL(base);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/api/'||u.username||u.password||u.search||u.hash)throw new Error('Zotero API는 로컬 /api/ 주소만 사용할 수 있습니다.');
    this.base=u.href;this.fetchFn=fetchFn;this.#serverId=serverId;
  }
  get serverId(){return this.#serverId;}
  credentials(){return {authorized:!!this.#key,remember:this.#remember,storage:'server-memory'};}
  forget(){this.#key=null;this.#remember=false;}
  async #json(response){try{return await response.json();}catch{throw new ZoteroError('INVALID_RESPONSE','Zotero 응답 형식을 확인하지 못했습니다. 응답 본문은 보안상 표시하지 않습니다.',502);}}
  async probe(){
    const previous=this.#serverId,r=await this.#fetch('',{probe:true}),id=r.headers.get('Zotero-Server-ID'),apiVersion=r.headers.get('Zotero-API-Version');
    await r.body?.cancel();
    if(!id||apiVersion!=='3'){this.forget();throw new ZoteroError('UNSUPPORTED','Zotero 10 Local API v3와 Server ID가 필요합니다. Zotero의 로컬 API 설정을 확인해주세요.',503);}
    const changed=!!previous&&previous!==id;if(changed)this.forget();this.#serverId=id;
    return {available:true,serverId:id,serverChanged:changed,apiVersion,schemaVersion:r.headers.get('Zotero-Schema-Version'),...this.credentials()};
  }
  async #fetch(path,{method='GET',data,rawBody,headers={},probe=false,signal}={}){
    if(typeof path!=='string'||path.startsWith('/')||path.includes('..')||/^(?:https?:|\/\/)/.test(path))throw new Error('잘못된 Zotero API 경로입니다.');
    const write=!['GET','HEAD'].includes(method),auth=path==='local/authorize';
    if(write&&!this.#serverId)throw new ZoteroError('SERVER_REQUIRED','먼저 Zotero 연결을 확인해주세요.');
    if(write&&!auth&&!this.#key)throw new ZoteroError('AUTH_REQUIRED','Zotero 쓰기 권한이 필요합니다. 쓰기 권한 요청 후 다시 미리보기·적용해주세요.',401);
    const requestHeaders={'Zotero-API-Version':'3',...headers};
    if(this.#serverId&&!probe)requestHeaders['Zotero-Server-ID']=this.#serverId;
    if(write&&!auth){requestHeaders['Zotero-API-Key']=this.#key;if(!this.#remember)this.forget();}
    if(data!==undefined)requestHeaders['Content-Type']='application/json';
    let r;try{r=await this.fetchFn(new URL(path,this.base),{method,headers:requestHeaders,body:rawBody??(data===undefined?undefined:JSON.stringify(data)),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(auth?180000:20000)]):AbortSignal.timeout(auth?180000:20000)});}
    catch(e){if(signal?.aborted)throw signal.reason;throw new ZoteroError('UNAVAILABLE','Zotero Local API에 연결할 수 없습니다. Zotero 실행 및 고급 설정의 로컬 API 허용을 확인해주세요.',503);}
    const received=r.headers.get('Zotero-Server-ID');
    if(!probe&&received&&this.#serverId&&received!==this.#serverId){this.forget();this.#serverId=received;await r.body?.cancel();throw new ZoteroError('SERVER_CHANGED','Zotero 데이터베이스가 변경되었습니다. 새 연결에서 미리보기를 다시 생성해주세요.');}
    if(!r.ok){await r.body?.cancel();
      if(r.status===401){this.forget();throw new ZoteroError('AUTH_REQUIRED','Zotero 승인이 만료되었거나 일회성 키가 사용되었습니다. 권한을 다시 요청해주세요.',401);}
      if(r.status===403&&probe)throw new ZoteroError('LOCAL_API_DISABLED','Zotero의 로컬 API가 꺼져 있습니다. Zotero 설정 → 고급에서 “Allow other applications on this computer to communicate with Zotero”를 켠 뒤 연결 확인을 다시 누르세요. 읽기 연결과 쓰기 승인은 별도입니다.',403);
      if(r.status===403)throw new ZoteroError('PERMISSION_DENIED',auth?'Zotero에서 쓰기 승인이 거절되었습니다. 다시 요청하려면 Zotero 창에서 Allow 또는 Always Allow를 선택해주세요.':'선택한 Zotero 라이브러리에 접근할 수 없습니다. My Library를 선택하거나 해당 라이브러리의 접근·편집 권한을 확인해주세요.',403);
      if(r.status===412)throw new ZoteroError('VERSION_CONFLICT','Zotero 객체 버전이 변경되었습니다. 최신 상태로 다시 확인해야 합니다.',412);
      if(r.status===429)throw new ZoteroError('RATE_LIMITED','Zotero 권한 요청이 제한되었습니다. 잠시 후 직접 다시 요청해주세요.',429);
      throw new ZoteroError('ZOTERO_HTTP',`Zotero 요청 실패 (HTTP ${r.status}).`,r.status===404?404:409);
    }
    return r;
  }
  async authorize(){
    if(this.#authorizing)throw new ZoteroError('AUTH_PENDING','Zotero 승인 요청이 이미 진행 중입니다.');
    this.#authorizing=true;try{await this.probe();this.forget();const r=await this.#fetch('local/authorize',{method:'POST',data:{appName:'Researchscape'}}),value=await this.#json(r);if(!/^[A-Za-z0-9]{32}$/.test(value.key||''))throw new ZoteroError('INVALID_AUTH','Zotero 승인 응답을 확인하지 못했습니다.');this.#key=value.key;this.#remember=value.remember===true;return {serverId:this.#serverId,...this.credentials()};}finally{this.#authorizing=false;}
  }
  async get(path){if(!this.#serverId)await this.probe();const r=await this.#fetch(path);return r.status===204?null:this.#json(r);}
  async libraries(){const groups=await this.get('users/0/groups');return [{id:'users/0',name:'My Library'},...groups.map(g=>({id:'groups/'+(g.id||g.data?.id),name:g.data?.name||g.name||'Group'}))];}
  async write(path,method,data,headers={},signal){const usedKey=this.#key,r=await this.#fetch(path,{method,data,headers,signal});if(r.status===204)return null;const result=await this.#json(r),failed=result.failed&&Object.values(result.failed)[0];if(failed){let detail=String(failed.message||'객체 저장 실패');if(usedKey)detail=detail.split(usedKey).join('[redacted]');detail=detail.slice(0,300);throw new ZoteroError('WRITE_FAILED',`Zotero 객체 저장 실패 (${Number(failed.code)||400}): ${detail}`,Number(failed.code)>=400&&Number(failed.code)<600?Number(failed.code):409);}return result;}
  async text(path){if(!this.#serverId)await this.probe();return (await this.#fetch(path)).text();}
  async form(path,values,headers={},signal){const r=await this.#fetch(path,{method:'POST',rawBody:new URLSearchParams(values).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},signal});return r.status===204?null:this.#json(r);}
  async uploadFile(url,buffer,contentType,signal){
    const target=new URL(url),base=new URL(this.base);
    if(target.origin!==base.origin||!/^\/api\/local\/uploads\/[A-Za-z0-9_-]+$/.test(target.pathname)||target.search||target.hash||target.username||target.password)throw new ZoteroError('INVALID_UPLOAD','Zotero가 반환한 로컬 업로드 주소를 확인하지 못했습니다.');
    let response;try{response=await this.fetchFn(target,{method:'POST',body:buffer,headers:{'Content-Type':contentType||'application/pdf'},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});}catch(e){if(signal?.aborted)throw signal.reason;throw new ZoteroError('UPLOAD_FAILED','Zotero 파일 전송이 중단되었습니다. 같은 파일로 다시 미리보기 후 재개하세요.',503);}
    await response.body?.cancel();if(response.status!==201)throw new ZoteroError('UPLOAD_FAILED',`Zotero 파일 전송 실패 (HTTP ${response.status}).`,response.status===403?403:409);
  }
  async addCollections(library,itemKey,keys){
    zoteroLibrary(library);if(!/^[A-Z0-9]{8}$/.test(itemKey)||keys.some(k=>!/^[A-Z0-9]{8}$/.test(k)))throw new Error('잘못된 Zotero Key입니다.');
    for(let attempt=0;attempt<3;attempt++){
      const current=await this.get(`${library}/items/${itemKey}`),before=current.data.collections||[],collections=[...new Set([...before,...keys])];
      if(collections.length===before.length)return {unchanged:true};
      try{await this.write(`${library}/items/${itemKey}`,'PATCH',{collections},{'If-Unmodified-Since-Version':String(current.version)});return {added:collections.filter(k=>!before.includes(k))};}
      catch(e){if(e.code!=='VERSION_CONFLICT'||attempt===2)throw e;}
    }
  }
}
