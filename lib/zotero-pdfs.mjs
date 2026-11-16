import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {saveJSON} from './local-store.mjs';
import {zoteroLibrary} from './zotero-client.mjs';

export async function pdfDigests(filename){
  const before=await fs.stat(filename);
  if(!before.isFile()||before.size>100*1024*1024)throw new Error('100MB 이하의 PDF가 필요합니다.');
  const bytes=await fs.readFile(filename),after=await fs.stat(filename);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('PDF 형식이 아니거나 검사 중 파일이 변경됐습니다.');
  return {sha256:createHash('sha256').update(bytes).digest('hex'),md5:createHash('md5').update(bytes).digest('hex'),size:bytes.length,mtime:Math.floor(after.mtimeMs),bytes};
}

// The Local API returns a file URL as plain text. Never follow a file redirect
// or accept a path outside the configured Zotero storage, including symlinks.
export async function attachmentFile(client,library,key,zoteroRoot){
  if(!/^[A-Z0-9]{8}$/.test(key))throw new Error('잘못된 첨부파일 Key입니다.');
  zoteroLibrary(library);
  let value;try{value=(await client.text(`${library}/items/${key}/file/view/url`)).trim();}catch(e){if(e.httpStatus===404)return null;throw e;}
  if(!value)return null;
  const url=new URL(value);
  if(url.protocol!=='file:'||url.hostname)throw new Error('Zotero의 로컬 PDF 경로를 확인하지 못했습니다.');
  const storage=await fs.realpath(path.join(zoteroRoot,'storage'));
  let filename;try{filename=await fs.realpath(fileURLToPath(url));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const relative=path.relative(storage,filename);
  if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw new Error('Zotero PDF가 설정된 storage 폴더 밖에 있습니다. Zotero 데이터 폴더를 확인하거나 PDF를 직접 업로드해주세요.');
  return filename;
}

export async function scanLocalAPI(media,client,library='users/0',signal){
  zoteroLibrary(library);const connection=await client.probe();
  if(media.library.apiServerId&&media.library.apiServerId!==connection.serverId)throw new Error('다른 Zotero 데이터베이스입니다. 기존 PDF 매핑을 재사용하지 않습니다. Zotero 데이터 폴더와 서버 연결을 확인해주세요.');
  const items=await client.get(library+'/items'),byKey=new Map(items.map(i=>[i.key,i])),records=[];
  for(const item of items.filter(i=>i.data.itemType==='attachment'&&i.data.contentType==='application/pdf')){
    signal?.throwIfAborted();
    const d=item.data,parent=byKey.get(d.parentItem)?.data||d;
    const filename=['imported_file','imported_url'].includes(d.linkMode)?await attachmentFile(client,library,item.key,media.zoteroRoot):null;
    const stat=filename?await fs.stat(filename):null,id=library==='users/0'?'zotero:'+item.key:'zotero:'+library.replace('/','-')+':'+item.key,prior=media.library.records.find(r=>r.id===id);
    const unchanged=prior?.path===filename&&prior?.size===stat?.size&&(prior?.apiMtime===stat?.mtimeMs||prior?.hashStamp===`${stat?.size}:${stat?.mtimeMs}`);
    records.push({id,source:'zotero',itemKey:d.parentItem||null,attachmentKey:item.key,apiLibrary:library,serverId:connection.serverId,title:parent.title||d.title||'',attachmentTitle:d.title||'',doi:parent.DOI||'',url:parent.url||'',extra:parent.extra||'',archiveId:parent.archiveID||'',path:filename,exists:!!stat,size:stat?.size,apiMtime:stat?.mtimeMs,...(unchanged?{hash:prior.hash,hashStamp:prior.hashStamp}:{}),missingReason:stat?null:'outside-storage-or-missing'});
  }
  signal?.throwIfAborted();
  const next=new Map(media.library.records.map(r=>[r.id,r]));
  for(const r of next.values())if((r.apiLibrary===library||library==='users/0'&&!r.apiLibrary)&&!records.some(n=>n.id===r.id))next.set(r.id,{...r,exists:false,missingReason:'not-in-current-api-library'});
  for(const r of records)next.set(r.id,r);
  media.library={...media.library,records:[...next.values()],apiServerId:connection.serverId,apiLibrary:library,snapshotMode:'local-api-read-only',scannedAt:new Date().toISOString()};
  media.library.total=media.library.records.length;media.library.available=media.library.records.filter(r=>r.exists).length;
  saveJSON(media.directory,'zotero.json',media.library);media.refreshRecords();return {items,records,serverId:connection.serverId};
}
