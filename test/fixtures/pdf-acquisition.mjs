import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {FigureManager} from '../../lib/figure-manager.mjs';import {PdfAcquisition} from '../../lib/pdf-acquisition.mjs';import {ZoteroClient} from '../../lib/zotero-client.mjs';
export const title='A Specific Motion Representation Learning Research Paper';
export const paper={id:'doi:10.1234/fixture',title,aliases:[],identifiers:[{kind:'doi',key:'doi:10.1234/fixture',value:'10.1234/fixture',url:'https://doi.org/10.1234/fixture'}],metadata:{title,year:2025,authors:['Fixture Author'],identifiers:[{kind:'doi',key:'doi:10.1234/fixture',value:'10.1234/fixture'}]},count:5,userCount:3};
export const bytes=Buffer.from('%PDF-1.7\nSynthetic fixture bytes only');
export async function fixture(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rs-acquisition-')),zotero=path.join(dir,'zotero');await fs.mkdir(path.join(zotero,'storage'),{recursive:true});
  const state={items:new Map([['ITEM0001',{key:'ITEM0001',version:1,data:{itemType:'journalArticle',title,DOI:'10.1234/fixture',collections:['MANUAL01']}}]]),serverId:'fixture-server',key:'F'.repeat(32),remember:true,deny:false,consumed:false,writes:0,files:new Map(),uploads:new Map(),filePosts:0,extracts:0};
  const fetchFn=async(url,options={})=>{
    const route=new URL(url).pathname.slice(5),method=options.method||'GET',headers=options.headers||{},response=(value,status=200,type='application/json')=>new Response(status===204?null:type==='text/plain'?value:JSON.stringify(value),{status,headers:{'Zotero-Server-ID':state.serverId,'Zotero-API-Version':'3','Content-Type':type}});
    if(!route)return response({});if(route==='local/authorize'){if(state.deny)return response({denied:true},403);state.consumed=false;return response({key:state.key,remember:state.remember});}
    if(route.startsWith('local/uploads/')){const token=route.split('/').at(-1),upload=state.uploads.get(token);if(!upload)return response({},404);if(headers['Zotero-API-Key'])throw Error('Capability upload must not contain a Local API key');upload.bytes=Buffer.from(options.body);state.filePosts++;return response({},201);}
    if(headers['Zotero-Server-ID']!==state.serverId)return response({},412);
    if(method==='GET'){
      if(route==='users/0/groups')return response([]);if(route==='users/0/items')return response([...state.items.values()]);
      const key=route.split('/')[3],item=state.items.get(key);
      if(route.endsWith('/children'))return response([...state.items.values()].filter(i=>i.data.parentItem===key));
      if(route.endsWith('/file/view/url'))return state.files.has(key)?response(pathToFileURL(state.files.get(key)).href,200,'text/plain'):response({},404);
      return response(item||{},item?200:404);
    }
    if(headers['Zotero-API-Key']!==state.key||state.consumed)return response({},401);if(!state.remember)state.consumed=true;state.writes++;
    if(route==='users/0/items'){
      const value=JSON.parse(options.body)[0];if(value.key&&value.version!==0)return response({failed:{0:{code:428,message:'Key-based creates require version: 0'}}});if(state.items.has(value.key))return response({failed:{0:{code:412}}});state.items.set(value.key,{key:value.key,version:1,data:value});return response({successful:{0:{key:value.key}}});
    }
    if(route.endsWith('/file')){
      const key=route.split('/')[3],form=new URLSearchParams(options.body);if(headers['If-None-Match']!=='*')throw Error('File writes require exclusive preconditions');if(state.files.has(key))return response({},412);
      if(form.has('md5')){const token='upload_'+state.uploads.size;state.uploads.set(token,{key,form});return response({url:'http://127.0.0.1:23119/api/local/uploads/'+token,uploadKey:token,contentType:'application/pdf',prefix:'',suffix:''});}
      const upload=state.uploads.get(form.get('upload'));if(!upload?.bytes)return response({},400);const actual=createHash('md5').update(upload.bytes).digest('hex');if(actual!==upload.form.get('md5'))return response({},400);
      const target=path.join(zotero,'storage',key,'researchscape.pdf');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,upload.bytes,{flag:'wx'});state.files.set(key,target);Object.assign(state.items.get(key).data,{md5:actual,filename:'researchscape.pdf'});return response(null,204);
    }return response({},400);
  };
  const client=new ZoteroClient({fetchFn}),papers=[paper,{...paper,id:'other',title:'Another Specific Motion Prediction Research Paper',count:2,userCount:10,identifiers:[],metadata:null}],getIndex=()=>({papers,conversations:[{id:'conversation-a',projectId:'g-p-fixture-a'},{id:'conversation-b',projectId:'g-p-fixture-b'}],mentions:[{paperId:paper.id,conversationId:'conversation-a'},{paperId:'other',conversationId:'conversation-b'}],projects:[{id:'g-p-fixture-a',name:'Motion'},{id:'g-p-fixture-b',name:'IMU'}]});
  const worker=async(root,script,args)=>{if(script==='zotero-library.py')return {records:media.library.records,available:media.library.available,total:media.library.total,snapshotMode:'fixture'};if(args[0]==='inspect'){const value=await fs.readFile(args[args.indexOf('--pdf')+1],'utf8');return {pages:1,metadata:{Title:value.includes('WRONG')?'Different Weather Prediction Research Paper':title},firstPageText:value.includes('WRONG')?'Different Weather Prediction Research Paper DOI: 10.1234/wrong':title+' DOI: 10.1234/fixture'};}
    state.extracts++;const filename=args[args.indexOf('--pdf')+1],hash=createHash('sha256').update(await fs.readFile(filename)).digest('hex'),output=args[args.indexOf('--output')+1];await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'figure.webp'),'fixture');return {version:2,pdfHash:hash,pages:1,pageSizes:[[612,792]],figures:[{id:'figure-1',file:'figure.webp',number:'1',kind:'figure',page:1}],defaultFigureId:'figure-1'};};
  const media=new FigureManager({root:dir,state:dir,getPapers:()=>papers,worker});media.state.settings.zoteroRoot=zotero;media.save();
  const manager=new PdfAcquisition({state:dir,media,client,getIndex});
  async function addAttachment(key,content=bytes,parent='ITEM0001'){const filename=path.join(zotero,'storage',key,'existing.pdf');await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,content,{flag:'wx'});state.files.set(key,filename);state.items.set(key,{key,version:1,data:{itemType:'attachment',parentItem:parent,title:'Existing user PDF',contentType:'application/pdf',linkMode:'imported_file',md5:createHash('md5').update(content).digest('hex')}});return filename;}
  async function connect(){const staged=await manager.stageUpload(paper,bytes,'fixture.pdf');await manager.confirmUpload(paper,{planId:staged.planId,approved:true,extract:false});return staged;}
  const cleanup=()=>{const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('rs-acquisition-'))throw new Error('Refusing cleanup outside the fixture directory');return fs.rm(target,{recursive:true,force:true});};
  return {dir,zotero,state,client,media,manager,papers,getIndex,fetchFn,worker,addAttachment,connect,cleanup};
}
