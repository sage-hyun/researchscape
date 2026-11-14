import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {storagePaths} from '../lib/config.mjs';
import {loadJSON,storeVersion} from '../lib/local-store.mjs';
import {activeMessages,buildIndex} from '../lib/extract.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),{state}=storagePaths(root),old=loadJSON(state,'index.json',null);
if(!old)throw new Error('Existing index required');
const names=['reviews.json','projects.json','conversation-labels.json','bibliography-decisions.json','sources.json','bibliography.json','index.json'],stamps=names.map(n=>storeVersion(state,n));
const conversations=new Map();
for(const file of old.sourceFiles)for(const c of JSON.parse(fs.readFileSync(path.resolve(root,file),'utf8'))){const id=c.id||c.conversation_id;if(!id||(conversations.get(id)?.update_time||0)>(c.update_time||0))continue;conversations.set(id,{id,title:c.title,conversation_template_id:c.conversation_template_id,update_time:c.update_time,messages:activeMessages(c)});}
for(const c of loadJSON(state,'sources.json',[]))conversations.set(c.id,c);
const next=buildIndex([...conversations.values()],{priorIndex:old}),store=loadJSON(state,'bibliography.json',{records:{},lookups:{}}),decisions=loadJSON(state,'bibliography-decisions.json',{}),resolved=reconcileIndex(next,store,decisions);
const key=m=>JSON.stringify([m.conversationId,m.messageId,m.start,m.end]),before=new Set(old.mentions.map(key)),after=new Set(next.mentions.map(key));
const byMessage=new Map();for(const m of next.mentions){const k=JSON.stringify([m.conversationId,m.messageId]);if(!byMessage.has(k))byMessage.set(k,[]);byMessage.get(k).push(m);}
const lost=old.mentions.filter(m=>!after.has(key(m))),covered=m=>(byMessage.get(JSON.stringify([m.conversationId,m.messageId]))||[]).some(n=>n.start<=m.start&&n.end>=m.end);
const unrepresented=lost.filter(m=>!covered(m)),paperMap=new Map(old.papers.map(p=>[p.id,p]));
console.log(JSON.stringify({before:{papers:old.papers.length,mentions:old.mentions.length,uniqueSpans:before.size},after:{papers:next.papers.length,mentions:next.mentions.length,uniqueSpans:after.size,verified:resolved.stats.metadataVerified,queue:resolved.resolutionQueue.length},removedSpans:lost.length,coveredByLongerSpans:lost.filter(covered).length,unrepresented:unrepresented.length,unrepresentedTitles:[...new Set(unrepresented.map(m=>paperMap.get(m.paperId)?.title))],addedSpans:next.mentions.filter(m=>!before.has(key(m))).length,missingReviewed:Object.keys(loadJSON(state,'reviews.json',{})).filter(id=>!next.papers.some(p=>p.id===id||p.memberIds?.includes(id))).length,filesUnchanged:names.every((n,i)=>storeVersion(state,n)===stamps[i])},null,2));
