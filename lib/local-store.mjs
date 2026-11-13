import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const locked=e=>['EPERM','EACCES','EBUSY'].includes(e.code);
function versions(directory,name){
  try{return fs.readdirSync(directory).filter(n=>n.startsWith(name+'.v-')&&n.endsWith('.json')).sort().reverse();}catch{return [];}
}
export function storeVersion(directory,name){
  const selected=versions(directory,name)[0]||name;
  try{const file=path.join(directory,selected),s=fs.statSync(file);return `${selected}:${s.mtimeMs}:${s.size}`;}catch{return '';}
}
export function loadJSON(directory,name,fallback){
  for(const selected of [...versions(directory,name),name]){
    try{return JSON.parse(fs.readFileSync(path.join(directory,selected),'utf8'));}catch{}
  }
  return fallback;
}
// A long-lived destination lock uses bounded, versioned snapshots instead of overwriting it.
export function saveJSON(directory,name,value,{rename=fs.renameSync,attempts=16,fallback=true}={}){
  const file=path.join(directory,name),temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx'});
  try{
    let snapshot=fallback&&versions(directory,name).length>0;
    if(!snapshot)for(let attempt=0;;attempt++){
      try{rename(temp,file);return;}catch(e){
        if(!locked(e))throw e;
        if(attempt>=attempts-1){if(!fallback)throw e;snapshot=true;break;}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(300,30*(attempt+1)));
      }
    }
    if(snapshot){
      const previous=versions(directory,name)[0];
      const priorTime=previous?Number(previous.slice((name+'.v-').length).split('-')[0]):0;
      const revision=Math.max(Date.now(),priorTime+1);
      const destination=`${file}.v-${revision}-${process.pid}-${randomUUID()}.json`;
      fs.renameSync(temp,destination);
      // Never remove the main file. Keep three completed snapshots; locked old ones can stay.
      for(const old of versions(directory,name).slice(3)){try{fs.unlinkSync(path.join(directory,old));}catch{}}
    }
  }finally{try{if(fs.existsSync(temp))fs.unlinkSync(temp);}catch{}}
}
