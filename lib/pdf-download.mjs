import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

export function publicAddress(value){
  const v=value.toLowerCase().replace(/^\[|\]$/g,'');
  if(v.startsWith('::ffff:'))return publicAddress(v.slice(7));
  if(isIP(v)===4){const a=v.split('.').map(Number);return !([0,10,127].includes(a[0])||a[0]===169&&a[1]===254||a[0]===172&&a[1]>=16&&a[1]<=31||a[0]===192&&a[1]===168||a[0]===100&&a[1]>=64&&a[1]<=127||a[0]>=224);}
  if(isIP(v)===6)return !(/^::(?:1)?$/.test(v)||/^(?:fc|fd|fe8|fe9|fea|feb|ff)/.test(v));
  return false;
}
export async function publicUrl(value,{lookupFn=lookup}={}){
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port&&!['80','443'].includes(url.port))throw new Error('공개 논문 HTTP(S) 주소만 다운로드할 수 있습니다.');
  if(url.hostname==='localhost'||url.hostname.endsWith('.local'))throw new Error('로컬 주소는 다운로드할 수 없습니다.');
  const addresses=await lookupFn(url.hostname.replace(/^\[|\]$/g,''),{all:true});
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('사설 네트워크 주소는 다운로드할 수 없습니다.');
  return url;
}
export function citationPdfUrl(html,base){
  for(const tag of html.match(/<meta\b[^>]*>/gi)||[]){
    const attrs=Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),m[2]]));
    if(/^(?:citation_pdf_url|wkhealth_pdf_url)$/i.test(attrs.name||attrs.property||''))try{return new URL(attrs.content.replace(/&amp;/g,'&'),base).href;}catch{}
  }
  return null;
}
export async function downloadPdf(candidate,directory,{signal,fetchFn=fetch,lookupFn=lookup,onProgress=()=>{},maxBytes=100*1024*1024}={}){
  await fsp.mkdir(directory,{recursive:true});
  let url=candidate.url,redirects=0,discovered=false,temp=null,handle=null;
  try{
    while(redirects<=5){
      signal?.throwIfAborted();await publicUrl(url,{lookupFn});await onProgress(url);
      const res=await fetchFn(url,{redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000),headers:{'User-Agent':'Researchscape/0.3 (personal local paper library)','Accept':'application/pdf,text/html;q=0.8'}});
      if([301,302,303,307,308].includes(res.status)){
        const location=res.headers.get('location');await res.body?.cancel();if(!location)throw new Error('PDF redirect has no location');url=new URL(location,url).href;redirects++;continue;
      }
      if(!res.ok){await res.body?.cancel();const e=new Error(`HTTP ${res.status} · ${new URL(url).hostname}`);e.httpStatus=res.status;e.hostname=new URL(url).hostname;e.status=res.status===429?'rate-limited':[401,403].includes(res.status)?'needs-browser':'download-failed';const raw=res.headers.get('retry-after'),n=Number(raw);e.retryAt=new Date(Date.now()+Math.max(60000,raw?(Number.isFinite(n)?n*1000:Date.parse(raw)-Date.now()):3600000)).toISOString();throw e;}
      if(Number(res.headers.get('content-length'))>maxBytes){await res.body?.cancel();throw new Error('PDF는 100MB 이하만 지원합니다.');}
      let size=0,first=Buffer.alloc(0);const hash=createHash('sha256');
      temp=path.join(directory,randomUUID()+'.part');handle=await fsp.open(temp,'wx');
      for await(const chunk of res.body){
        signal?.throwIfAborted();size+=chunk.length;if(size>maxBytes)throw new Error('PDF는 100MB 이하만 지원합니다.');
        if(first.length<1024)first=Buffer.concat([first,Buffer.from(chunk)]).subarray(0,1024);
        hash.update(chunk);await handle.writeFile(chunk);
        if(size>2000000&&!first.includes(Buffer.from('%PDF-')))throw new Error('PDF 대신 HTML 페이지가 반환됐습니다. 브라우저에서 받아주세요.');
      }
      await handle.close();handle=null;
      if(first.includes(Buffer.from('%PDF-'))){const digest=hash.digest('hex'),target=path.join(directory,digest+'.pdf');if(fs.existsSync(target))await fsp.unlink(temp);else await fsp.rename(temp,target);temp=null;return {path:target,hash:digest,size,url,originalUrl:candidate.url,source:candidate.source,downloadedAt:new Date().toISOString()};}
      const html=await fsp.readFile(temp,'utf8');await fsp.unlink(temp);temp=null;const next=!discovered&&citationPdfUrl(html,url);
      if(next){url=next;discovered=true;redirects++;continue;}
      const e=new Error('PDF 대신 웹페이지가 반환됐습니다. 로그인·사람 확인 후 브라우저에서 PDF를 받아 연결해주세요.');e.status='needs-browser';throw e;
    }
    throw new Error('PDF redirect limit exceeded');
  }finally{if(handle)await handle.close().catch(()=>{});if(temp)await fsp.unlink(temp).catch(()=>{});}
}
