// Fictional candidates for bulk review tests: acronym candidates with a cached official record
// (link candidates exist) and acronym candidates with nothing cached (an LLM has to propose one).
import {crossrefRecord} from '../../lib/bibliography.mjs';

export const linkedName=i=>`Vela${i}Net`,orphanName=i=>`Orph${i}Lab`;
export const candidateId=name=>'name:'+name.toLowerCase();
export const linkedDoi=i=>`10.5555/vela${i}`,orphanDoi=i=>`10.7777/orph${i}`;
export const linkedTitle=i=>`${linkedName(i)}: Robust Inertial Motion Learning Study ${i}`;
export const orphanTitle=i=>`${orphanName(i)}: A Verified Official Title for Motion Study ${i}`;
export const orphanWork=i=>({DOI:orphanDoi(i),title:[orphanTitle(i)],author:[{given:'Fixture',family:'Author'}],published:{'date-parts':[[2024]]}});

// Messages for the app's own conversation shape ({id,title,messages}); repeats vary mention counts.
export function reviewConversations({linked=600,orphans=620,project=null}={}){
  const conversation=(name,i)=>({id:'c-'+name.toLowerCase(),title:'Fixture '+name,...(project?{conversation_template_id:project}:{}),messages:Array.from({length:1+i%4},(_,n)=>({id:`m-${name.toLowerCase()}-${n}`,role:n%2?'assistant':'user',date:1700000000+i*10+n,text:`PRIVATE_CHAT_BODY ${name} 논문을 다시 검토했다.`}))});
  return [...Array.from({length:linked},(_,i)=>conversation(linkedName(i),i)),...Array.from({length:orphans},(_,i)=>conversation(orphanName(i),i))];
}
// The same conversations in ChatGPT export form for server tests.
export function exportConversations(options){
  return reviewConversations(options).map(c=>{
    const mapping={};c.messages.forEach((m,n)=>{mapping[m.id]={parent:n?c.messages[n-1].id:null,message:{id:m.id,author:{role:m.role},create_time:m.date,content:{parts:[m.text]}}};});
    return {id:c.id,title:c.title,conversation_template_id:c.conversation_template_id,create_time:c.messages[0].date,current_node:c.messages.at(-1).id,mapping};
  });
}
export function reviewStore(linked=600){
  const records=Array.from({length:linked},(_,i)=>crossrefRecord({DOI:linkedDoi(i),title:[linkedTitle(i)],author:[{given:'Fixture',family:'Author'}]}));
  return {records:Object.fromEntries(records.map(r=>[r.id,r])),lookups:{}};
}
const evidence=detail=>[{type:'explicit-alias-expansion',detail}];
// One decision per exported item: match the listed candidate, or handle a candidate without one.
export function reviewDecision(item){
  if(item.candidates.length)return {candidateId:item.candidateId,decision:'match',recordId:item.candidates[0].recordId,evidence:evidence('The acronym is the prefix of this official title.'),needsManualReview:false};
  const i=Number(/\d+/.exec(item.title)[0]);
  if(i%4===0)return {candidateId:item.candidateId,decision:'propose',recordId:null,proposal:{doi:orphanDoi(i)},evidence:[{type:'external-identifier',detail:'Known DOI of the paper that introduced this name.'}],needsManualReview:false};
  if(i%4===1)return {candidateId:item.candidateId,decision:'separate',recordId:null,evidence:evidence('This is a lab name, not a paper.'),needsManualReview:false};
  if(i%4===2)return {candidateId:item.candidateId,decision:'defer',recordId:null,evidence:[],needsManualReview:false};
  return {candidateId:item.candidateId,decision:'propose',recordId:null,proposal:{doi:`10.9999/missing${i}`},evidence:[{type:'external-identifier',detail:'A DOI that no provider knows.'}],needsManualReview:false};
}
// Stand-in for Crossref/OpenAlex/Semantic Scholar/arXiv. Only orphan DOIs with i%4===0 exist.
export function providerFetch(calls=[]){
  const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  return async input=>{
    const url=new URL(input);calls.push(url.href);
    if(url.hostname==='api.crossref.org'&&url.pathname.startsWith('/works/')){
      const i=Number(/^10\.7777\/orph(\d+)$/.exec(decodeURIComponent(url.pathname.slice('/works/'.length)))?.[1]??NaN);
      return Number.isInteger(i)&&i%4===0?json({message:orphanWork(i)}):json({},404);
    }
    if(url.hostname==='api.crossref.org')return json({message:{items:[]}});
    if(url.hostname==='api.openalex.org')return json({results:[]});
    if(url.hostname==='api.semanticscholar.org')return json({},404);
    if(url.hostname==='export.arxiv.org')return new Response('<feed></feed>');
    throw new Error('Unexpected provider in fixture: '+url.hostname);
  };
}
