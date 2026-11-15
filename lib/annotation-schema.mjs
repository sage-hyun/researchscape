import {createHash} from 'node:crypto';
export const ANNOTATION_COLORS={research_question:'#ffd400',method:'#2ea8e5',result:'#a3e86f',limitation:'#f19837'};
export const annotationPrompt='Analyze only the selected PDF sections and explicitly selected research contexts in the attached Researchscape JSON. Return only JSON matching outputSchema and the exact paperId, Zotero keys, pdfHash, and requestId. Propose at most annotationLimit important annotations. quote must be verbatim PDF text, never a paraphrase. Keep your interpretation in comment/reason. Use research_question, method, result, limitation and the category colors. origin must be llm and status must be proposed. Personal ideas must have scope research-context and cite only provided contextRefs (mentionId). Do not infer a methodological relationship just because two papers share a project. If a personal idea has no clear PDF anchor, return type note with quote empty. Do not invent quotes, context references, coordinates, or approvals.';
const keySchema={anyOf:[{type:'null'},{type:'string',pattern:'^[A-Z0-9]{8}$'}]};
export const annotationOutputSchema={
  $schema:'https://json-schema.org/draft/2020-12/schema',type:'object',additionalProperties:false,required:['schemaVersion','paperId','zoteroItemKey','zoteroAttachmentKey','pdfHash','annotations'],
  properties:{schemaVersion:{const:1},requestId:{type:'string'},paperId:{type:'string'},zoteroItemKey:keySchema,zoteroAttachmentKey:keySchema,pdfHash:{type:'string',pattern:'^[a-f0-9]{64}$'},annotations:{type:'array',maxItems:50,items:{type:'object',additionalProperties:false,required:['id','type','quote','pageHint','category','color','comment','reason','origin','status'],properties:{id:{type:'string',minLength:1,maxLength:120},type:{enum:['highlight','note']},quote:{type:'string',maxLength:3000},pageHint:{anyOf:[{type:'integer',minimum:1,maximum:500},{type:'null'}]},category:{enum:Object.keys(ANNOTATION_COLORS)},color:{type:'string',pattern:'^#[a-fA-F0-9]{6}$'},comment:{type:'string',maxLength:5000},reason:{type:'string',maxLength:2000},origin:{const:'llm'},status:{const:'proposed'},scope:{enum:['paper','research-context']},contextRefs:{type:'array',maxItems:10,items:{type:'string'}}}}}}
};
const ownObject=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));
const text=(v,max)=>typeof v==='string'&&v.length<=max;
export function validateAnnotationJSON(value){
  const errors=[],valid=[];
  const top=annotationOutputSchema.properties;
  if(!ownObject(value,Object.keys(top))||value.schemaVersion!==1||!text(value.paperId,300)||!value.paperId||!/^[a-f0-9]{64}$/.test(value.pdfHash||'')||!Array.isArray(value.annotations)||value.annotations.length>50||[value.zoteroItemKey,value.zoteroAttachmentKey].some(v=>v!==null&&(typeof v!=='string'||!/^[A-Z0-9]{8}$/.test(v)))||value.requestId!==undefined&&!text(value.requestId,120))return {valid:[],errors:[{index:null,path:'header',message:'schemaVersion 1, paperId, PDF 해시, Zotero Key/null 및 최대 50개의 annotations가 필요합니다.'}]};
  const allowed=Object.keys(top.annotations.items.properties),seen=new Set();
  for(const [index,a] of value.annotations.entries()){
    const problem=message=>errors.push({index,id:a?.id||null,path:'annotations['+index+']',message});
    if(!ownObject(a,allowed)||!text(a.id,120)||!a.id||!['highlight','note'].includes(a.type)||!text(a.quote,3000)||!text(a.comment,5000)||!text(a.reason,2000)||!Object.hasOwn(ANNOTATION_COLORS,a.category)||!text(a.color,7)||!/^#[a-fA-F0-9]{6}$/.test(a.color)||a.origin!=='llm'||a.status!=='proposed'||a.pageHint!==null&&(!Number.isInteger(a.pageHint)||a.pageHint<1||a.pageHint>500)||a.scope!==undefined&&!['paper','research-context'].includes(a.scope)||a.contextRefs!==undefined&&(!Array.isArray(a.contextRefs)||a.contextRefs.length>10||a.contextRefs.some(x=>!text(x,300)||!x))){problem('항목 스키마가 올바르지 않습니다. 모든 결과는 origin llm, status proposed여야 합니다.');continue;}
    if(seen.has(a.id)){problem('입력 id가 중복되었습니다.');continue;}seen.add(a.id);
    const scope=a.scope||'paper',refs=[...new Set(a.contextRefs||[])];
    if(a.type==='highlight'&&a.quote.trim().length<4||scope==='paper'&&a.quote.trim().length<4){problem('논문 주석과 하이라이트에는 실제 PDF 인용 구절이 필요합니다.');continue;}
    if(scope==='research-context'&&!refs.length||scope==='paper'&&refs.length){problem('연구 맥락 주석에는 선택한 contextRefs가 필요하며 논문 전용 주석에는 넣지 않습니다.');continue;}
    valid.push({...a,scope,contextRefs:refs});
  }
  return {valid,errors};
}
export const annotationFingerprint=(pdfHash,a)=>createHash('sha256').update(JSON.stringify([pdfHash,a.type,a.scope||'paper',a.quote.normalize('NFKC').replace(/\s+/g,' ').trim(),[...(a.contextRefs||[])].sort()])).digest('hex');
