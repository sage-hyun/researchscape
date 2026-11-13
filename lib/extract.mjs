import { createHash } from 'node:crypto';
import {publisherLink,webReferences,titleTokens,titleSimilarity} from './paper-links.mjs';

export const RULE_VERSION = 10;
export const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STOP = new Set(('IMU LLM GPT AI API PDF DOI URL HTML JSON NLP CNN RNN LSTM TCN VAE GAN MLP SSL RL CV ML DL HAR SLAM EKF PDR SOTA GPU CPU RAM RGB RGBD ID OOD MAE MSE RMSE ATE RTE F1 CSE IEEE ACM CVPR ICCV ECCV ICLR ICML NeurIPS IROS RSS SIGGRAPH arXiv OpenReview OpenAlex Crossref Semantic Scholar ChatGPT Zotero Researchscape Python PyTorch TensorFlow MATLAB GitHub Google Research Related Paper Papers Figure Table Section Introduction Abstract Conclusion Methods Results Discussion Transformer Attention Diffusion Dataset Model Baseline Method Framework Network Encoder Decoder Datasets Foundation Inertial Motion Video Human Sensor Learning Deep Self Supervised Contrastive Multimodal Proposed Our The This That For From With Without Using Towards Understanding Requirements Project Related Work').toLowerCase().split(/\s+/));
for(const word of 'Few-Shot FewShot Zero-Shot One-Shot fine-tuning finetuning pre-training pretraining Wearable Loss Recognition EMG GPS VLA TTA UDA MDA DA SSL Language Face Survey Activity Detection Classification Segmentation Regression Prediction Adaptation Augmentation Representation Kinematic Kinematics Optimization Training Evaluation Architecture Experiment Experiments Performance Privacy Preservation Data Vision Text Audio Speech Time-Series time-series Domain Cross-Domain Synthetic Real-World Feature Features Fusion Transfer Test-Time End-to-End State-of-the-Art Generalization Benchmark Benchmarks Review Task Tasks Protocol Pipeline Approach Approaches Analysis Summary Overview Key Key-Idea System Systems Signal Signals Inference Prompt Prompting RAG LoRA PEFT SGD Adam AdamW ReLU BatchNorm LayerNorm Normalization SVM PCA t-SNE UMAP IMUs EEG ECG'.split(' '))STOP.add(word.toLowerCase());
for(const word of 'Body Adaptive Localization Sensors One Daily Force Full Replication Conference AAAI Soft Core Physics Dropout Topic Limitations Selection Detailed Nature Renderer Words Word HCI sEMG MoE Human-Centered Pose Human-Activity Human-Centric Neural-Network Machine-Learning'.split(' '))STOP.add(word.toLowerCase());

export function messageText(message) {
  return (message?.content?.parts || []).map(p => typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '').filter(Boolean).join('\n');
}

export function activeMessages(conversation) {
  const mapping = conversation.mapping || {};
  const result = [], seen = new Set();
  let node = conversation.current_node;
  // Unknown branches are deliberately not guessed; their omission is surfaced in stats.
  if (!node || !mapping[node]) return [];
  while (node && mapping[node] && !seen.has(node)) {
    seen.add(node);
    const entry = mapping[node], m = entry.message;
    if (m && ['user', 'assistant'].includes(m.author?.role) &&
        (!m.channel || m.channel === 'final') && !m.metadata?.is_visually_hidden_from_conversation) {
      const text = messageText(m);
      if (text.trim()) result.push({id:m.id || node, role:m.author.role, date:m.create_time || conversation.create_time || null, text,references:webReferences(m)});
    }
    node = entry.parent;
  }
  return result.reverse();
}

function cleanTitle(t) {
  return t.replace(/\*\*|__|`/g, '').replace(/^\s*(?:[-•#]+|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim().replace(/\s*\((?:(?:NAACL|ACL|EMNLP|CVPR|ICCV|ECCV|ICLR|ICML|NeurIPS|AAAI|IROS|RSS|SIGGRAPH)[^)]*\d{4}|arxiv:\s*\d{4}\.\d{4,5})\)\s*$/i,'').replace(/[.,;\s]+$/, '');
}
function validTitle(t) {
  return t.length >= 18 && t.length <= 220 && (t.match(/[A-Za-z][A-Za-z'-]*/g)||[]).length >= 4 &&
    !/[\uAC00-\uD7A3{}=<>]/.test(t) && !/^(?:https?:|the following|this paper|in this|we |you |our |here |note:|requirements|related papers)/i.test(t) && !/:\s*(?:key idea(?: and architecture)?|model architecture|architecture overview|method overview|paper summary|summary|overview)$/i.test(t);
}
function shortName(t) {
  const m = /^([A-Za-z][A-Za-z0-9+._-]{2,30})\s*[:：]/.exec(t);
  return m && !STOP.has(m[1].toLowerCase()) ? m[1] : null;
}

export function identifiers(text) {
  const out = [];
  const patterns = [
    ['arxiv', /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf|html)\/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/gi],
    ['doi', /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/gi],
    ['openreview', /openreview\.net\/(?:forum|pdf)\?[^\s)\]>]*?\bid=([A-Za-z0-9_-]+)/gi]
  ];
  for (const [kind, re] of patterns) for (const m of text.matchAll(re)) {
    let raw = m[1].replace(/[.,;:]+$/, '');
    const legacyDoi=kind==='doi'?raw.toLowerCase().replace(/\)+$/,s=>s.slice(0,Math.max(0,s.length-Math.max(0,(raw.match(/\)/g)||[]).length-(raw.match(/\(/g)||[]).length)))):null;
    // A Markdown closing parenthesis terminates a DOI; balanced parentheses can belong to it.
    if(kind==='doi'){let depth=0;for(let at=0;at<raw.length;at++){if(raw[at]==='(')depth++;if(raw[at]===')'){if(!depth){raw=raw.slice(0,at);break;}depth--;}}}
    const value = kind === 'arxiv' ? raw.replace(/v\d+$/, '').toLowerCase() : kind === 'doi' ? raw.toLowerCase().replace(/\)+$/, s => {
      const opens=(raw.match(/\(/g)||[]).length, closes=(raw.match(/\)/g)||[]).length;
      return s.slice(0, Math.max(0, s.length-Math.max(0, closes-opens)));
    }) : raw;
    const at=m.index+m[0].indexOf(m[1]);
    const url = kind==='arxiv' ? `https://arxiv.org/abs/${value}` : kind==='doi' ? `https://doi.org/${value}` : `https://openreview.net/forum?id=${value}`;
    out.push({key:`${kind}:${value}`, kind, value, url, start:at, end:at+raw.length,...(legacyDoi&&legacyDoi!==value?{legacyKeys:[`doi:${legacyDoi}`]}:{})});
  }
  for(const m of text.matchAll(/https?:\/\/[^\s<>"\]\uE200-\uE2FF]+/g)){
    const raw=m[0].replace(/[),.;]+$/,'');const link=publisherLink(raw);
    if(link)out.push({...link,start:m.index,end:m.index+raw.length});
  }
  return out;
}

// Link labels and export citation titles remain observed, not official metadata.
export function discover(text,references=[]) {
  const out=[], ids=identifiers(text);
  for (const id of ids) {
    let title=null, alias=null;
    const before=text.slice(Math.max(0,id.start-320), id.start);
    const link=/\[([^\]\n]{3,220})\]\((?:https?:\/\/[^\s]*)?$/i.exec(before);
    if(link && validTitle(cleanTitle(link[1]))) title=cleanTitle(link[1]);
    if(title) alias=shortName(title);
    const labelStart=link ? Math.max(0,id.start-320)+link.index+1 : null;
    out.push({...id,title,alias,evidence:'identifier',...(title?{start:labelStart,end:labelStart+link[1].length}:{})});
  }
  // Explicit short-name + paper keyword. Keep acronyms provisional and contextual.
  for(const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9+_.-]{2,30})(?:\*\*|`)?\s*(?:논문|paper\b)/gi)) {
    const name=m[1].replace(/[.,]+$/,'');
    if(!STOP.has(name.toLowerCase()) && ((name.match(/[A-Z]/g)||[]).length>=2 || /\d/.test(name))) out.push({key:`name:${normalize(name)}`,title:name,alias:name,evidence:'alias',start:m.index,end:m.index+name.length});
  }
  // Structured English titles in headings, bold spans and quoted text, only in research context.
  if(/논문|\bpaper[s]?\b|arxiv|doi\.org|openreview|\b(?:CVPR|ICLR|ICML|NeurIPS|ECCV|ICCV)\b/i.test(text)) {
    const re=/\*\*([^*\n]{18,220})\*\*|[“"]([^"”\n]{18,220})[”"]|^#{1,4}\s+(.{18,220})$/gm;
    for(const m of text.matchAll(re)) {
      const title=cleanTitle(m[1]||m[2]||m[3]), alias=shortName(title);
      if(validTitle(title) && (alias || /\b(?:learning|estimation|synthesis|generation|recognition|tracking|reconstruction|transformers|representation|modeling|odometry|motion|sensor)\b/i.test(title))) {
        const start=m.index+m[0].indexOf(m[1]||m[2]||m[3]);
        out.push({key:`title:${normalize(title)}`,title,alias,evidence:'title',start,end:start+(m[1]||m[2]||m[3]).length});
      }
    }
  }
  const textCandidates=[...out].filter(d=>d.title);
  for(const ref of references){
    const links=identifiers(ref.url);if(!links.length)continue;
    const title=cleanTitle(ref.title),truncated=/\.{3}|…/.test(title),plain=title.replace(/\.{3}.*$|….*$/,'').trim();
    const candidate=textCandidates.find(d=>{
      if(normalize(d.title)===normalize(plain)&&titleTokens(plain).length>=4)return true;
      if(titleTokens(plain).length>=4&&titleTokens(d.title).length>=4&&titleSimilarity(d.title,plain)>=.94)return true;
      return truncated&&titleTokens(plain).length>=5&&normalize(d.title).startsWith(normalize(plain));
    });
    let span=candidate?{start:candidate.start,end:candidate.end}:null;
    if(!span&&!truncated&&validTitle(title)){const at=text.toLowerCase().indexOf(title.toLowerCase());if(at>=0)span={start:at,end:at+title.length};}
    if(!span)continue;
    for(const link of links)out.push({...link,...span,title:candidate?.title||title,alias:candidate?.alias||shortName(plain),evidence:'citation-metadata',referenceTitle:ref.title,referenceUrl:link.url});
  }
  return out;
}

export function buildIndex(conversations, {sourceFiles=[], warnings=[]}={}) {
  const docs=[];
  for(const c of conversations) {
    const messages=c.messages || activeMessages(c);
    for(const m of messages) docs.push({...m,cid:c.id || c.conversation_id,conversationTitle:c.title || '제목 없는 대화',source:c.source || 'export',url:c.url || null});
  }
  const papers=new Map(), aliasOwners=new Map();
  function put(d) {
    if(!papers.has(d.key)) papers.set(d.key,{id:d.key,title:d.title || `${d.kind==='arxiv'?'arXiv':d.kind==='doi'?'DOI':d.kind==='publisher'?'논문 링크':'OpenReview'} · ${d.value}`,aliases:[],identifiers:[],evidence:d.evidence,status:'unreviewed'});
    const p=papers.get(d.key);
    p.memberIds??=[d.key];
    if(d.legacyKeys)p.memberIds=[...new Set([...p.memberIds,...d.legacyKeys])];
    if(d.title && p.title.includes(' · ')) p.title=d.title;
    if(d.url && !p.identifiers.some(x=>x.key===d.key)) p.identifiers.push({key:d.key,kind:d.kind,value:d.value,url:d.url});
    if(d.evidence==='citation-metadata'){
      p.linkEvidence??=[];
      if(!p.linkEvidence.some(e=>e.url===d.referenceUrl&&e.title===d.referenceTitle))p.linkEvidence.push({source:'export-citation',title:d.referenceTitle,url:d.referenceUrl});
    }
    for(const alias of [d.title,d.alias].filter(Boolean)) {
      if(!p.aliases.includes(alias)) p.aliases.push(alias);
      const n=normalize(alias);
      if(!aliasOwners.has(n)) aliasOwners.set(n,new Set());
      aliasOwners.get(n).add(d.key);
    }
  }
  // Discovery first, dictionary matching second. Do not join papers just because URLs co-occur.
  const discovered=docs.map(d=>discover(d.text,d.references));
  discovered.flat().forEach(put);
  const redirect=new Map();
  for(const owners of aliasOwners.values()) {
    const identified=[...owners].filter(k=>!k.startsWith('name:')&&!k.startsWith('title:'));
    if(identified.length===1) for(const k of owners) if(k!==identified[0]) redirect.set(k,identified[0]);
  }
  // A unique explicit long title can absorb its shorthand record.
  for(const [key,p] of papers) if(key.startsWith('name:')&&!redirect.has(key)) {
    const candidates=[...papers.values()].filter(q=>q.id.startsWith('title:')&&q.aliases.some(a=>normalize(a)===normalize(p.title))&&!redirect.has(q.id));
    if(candidates.length===1) redirect.set(key,candidates[0].id);
  }
  const resolve=k=>{const seen=new Set();while(redirect.has(k)&&!seen.has(k)){seen.add(k);k=redirect.get(k);}return k;};
  for(const [key] of redirect) {
    const target=papers.get(resolve(key)), source=papers.get(key);
    if(target&&source){target.aliases=[...new Set([...target.aliases,...source.aliases])];target.memberIds=[...new Set([...(target.memberIds||[]),...(source.memberIds||[])])];target.linkEvidence=[...(target.linkEvidence||[]),...(source.linkEvidence||[])];}
  }
  for(const key of redirect.keys()) papers.delete(key);
  const finalOwners=new Map();
  for(const p of papers.values())for(const alias of p.aliases){const k=normalize(alias);if(!finalOwners.has(k))finalOwners.set(k,new Set());finalOwners.get(k).add(p.id);}
  const patterns=[];
  // Long titles match case-insensitively. Acronyms require case and nearby research language.
  for(const p of papers.values()) for(const alias of p.aliases) {
    if(alias.length<3) continue;
    const isShort=!alias.includes(' ');
    if(isShort&&finalOwners.get(normalize(alias)).size>1&&!p.id.startsWith('name:'))continue;
    patterns.push({pid:p.id,alias,isShort,re:new RegExp(`(?<![A-Za-z0-9_+\\-])${escape(alias)}(?![A-Za-z0-9_+\\-])`,isShort?'g':'gi')});
  }
  const mentions=[], convPapers=new Map();
  docs.forEach((doc,i)=>{
    const lowerText=doc.text.toLowerCase();
    const found=new Map();
    function add(pid,start,end,method) {
      pid=resolve(pid);
      const k=`${pid}:${start}:${end}`;
      if(!found.has(k)) found.set(k,{paperId:pid,start,end,method});
    }
    discovered[i].forEach(d=>add(d.key,d.start,d.end,d.evidence));
    for(const {pid,alias,isShort,re} of patterns) {
      if(isShort ? !doc.text.includes(alias) : !lowerText.includes(alias.toLowerCase())) continue;
      for(const m of doc.text.matchAll(re)) {
        const near=doc.text.slice(Math.max(0,m.index-180),m.index+alias.length+180);
        if(isShort && !/논문|연구|모델|제안|방법|비교|학습|데이터|\b(?:paper|research|model|learning|dataset|method|arxiv|baseline|approach)\b/i.test(near)) continue;
        if([...found.values()].some(x=>x.paperId===pid && x.start<=m.index && x.end>=m.index+alias.length)) continue;
        add(pid,m.index,m.index+alias.length,isShort?'alias':'title');
      }
    }
    // Remove overlapping spans for the same record (identifier/label matches may coincide).
    const selected=[];
    for(const f of [...found.values()].sort((a,b)=>(b.end-b.start)-(a.end-a.start))) {
      if(selected.some(s=>s.paperId===f.paperId&&s.start<f.end&&f.start<s.end)) continue;
      selected.push(f);
    }
    for(const f of selected) {
      const from=Math.max(0,f.start-170), to=Math.min(doc.text.length,f.end+230);
      mentions.push({...f,id:hash(`${doc.cid}:${doc.id}:${f.paperId}:${f.start}:${f.end}`),conversationId:doc.cid,messageId:doc.id,conversationTitle:doc.conversationTitle,role:doc.role,date:doc.date,source:doc.source,url:doc.url,quote:doc.text.slice(f.start,f.end),excerpt:doc.text.slice(from,to),excerptStart:f.start-from,excerptEnd:f.end-from,contentHash:hash(doc.text)});
      if(!convPapers.has(doc.cid)) convPapers.set(doc.cid,new Set());
      convPapers.get(doc.cid).add(f.paperId);
    }
  });
  const byPaper=new Map();
  for(const m of mentions) {if(!byPaper.has(m.paperId)) byPaper.set(m.paperId,[]);byPaper.get(m.paperId).push(m);}
  const output=[];
  for(const p of papers.values()) {
    const ms=byPaper.get(p.id)||[];
    if(!ms.length)continue;
    const dates=ms.map(m=>m.date).filter(Number.isFinite);
    output.push({...p,count:ms.length,messageCount:new Set(ms.map(m=>`${m.conversationId}:${m.messageId}`)).size,conversationCount:new Set(ms.map(m=>m.conversationId)).size,userCount:ms.filter(m=>m.role==='user').length,assistantCount:ms.filter(m=>m.role==='assistant').length,firstSeen:dates.length?Math.min(...dates):null,lastSeen:dates.length?Math.max(...dates):null});
  }
  output.sort((a,b)=>b.count-a.count);
  // Links are exact conversation-set intersections, computed only for the displayed graph.
  const activity=docs.map(d=>({conversationId:d.cid,messageId:d.id,date:d.date}));
  const hintMap=new Map();
  for(const doc of docs)for(const ref of doc.references||[]){
    const alias=shortName(cleanTitle(ref.title));
    if(!alias||!new RegExp(`(?<![A-Za-z0-9_+\\-])${escape(alias)}(?![A-Za-z0-9_+\\-])`).test(doc.text))continue;
    for(const id of identifiers(ref.url))hintMap.set(id.key,{identifier:{key:id.key,kind:id.kind,value:id.value,url:id.url},observedTitle:ref.title,alias});
  }
  const conversationMetadata=conversations.map(c=>({id:c.id||c.conversation_id,title:c.title||'제목 없는 대화',projectId:c.conversation_template_id?.startsWith('g-p-')?c.conversation_template_id:null}));
  return {version:RULE_VERSION,generatedAt:new Date().toISOString(),sourceFiles,stats:{conversations:conversations.length,messages:docs.length,papers:output.length,mentions:mentions.length,researchConversations:convPapers.size,recoveredCitationPapers:output.filter(p=>p.linkEvidence?.length).length,warnings},papers:output,mentions,activity,bibliographyHints:[...hintMap.values()],conversations:conversationMetadata};
}

export function graphEdges(papers, mentions) {
  const ids=new Set(papers.map(p=>p.id)), byConversation=new Map(), edges=new Map();
  for(const m of mentions) if(ids.has(m.paperId)) {if(!byConversation.has(m.conversationId))byConversation.set(m.conversationId,new Set());byConversation.get(m.conversationId).add(m.paperId);}
  for(const set of byConversation.values()) {
    const a=[...set].sort();
    for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++) {
      const k=JSON.stringify([a[i],a[j]]);
      if(!edges.has(k))edges.set(k,{source:a[i],target:a[j],weight:0,type:'co-mention'});
      edges.get(k).weight++;
    }
  }
  return [...edges.values()].sort((a,b)=>b.weight-a.weight);
}
