// Only explicitly registered reverse-proxy URLs may reach the loopback server.
export function publicRoutes(values=[]){
  if(!Array.isArray(values))throw new Error('publicUrls must be an array');
  return values.map(value=>{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('publicUrls must contain HTTPS URLs without credentials, queries or fragments');
    const basePath=url.pathname.replace(/\/$/,'');
    if(!/^(?:\/[A-Za-z0-9_-]+)*$/.test(basePath))throw new Error('Invalid public URL path');
    return {host:url.host,origin:url.origin,basePath};
  });
}

export function requestAccess(req,routes=[]){
  // Do not trust X-Forwarded-Host/Proto from an arbitrary caller.
  const host=req.headers.host||'';
  let local;
  try{const url=new URL('http://'+host);local=url.host===host&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);}catch{}
  const route=routes.find(item=>item.host===host);
  if(!local&&!route)return {status:403,error:'Local host only · 등록되지 않은 접속 주소입니다.'};
  const origin=local?'http://'+host:route.origin;
  if(!['GET','HEAD'].includes(req.method)&&req.headers.origin&&req.headers.origin!==origin)return {status:403,error:'다른 사이트에서의 요청은 허용되지 않습니다.'};
  return {basePath:local?'':route.basePath};
}
