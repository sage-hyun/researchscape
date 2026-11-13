import fs from 'node:fs';
import path from 'node:path';

export function storagePaths(root,env=process.env){
  const file=path.join(root,'researchscape.local.json');
  let config={};
  if(fs.existsSync(file)){
    config=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('researchscape.local.json must be an object');
    for(const [key,value] of Object.entries(config)){
      if(!['dataDirectory','stateDirectory'].includes(key)||typeof value!=='string'||!value.trim())throw new Error(`Invalid local storage setting: ${key}`);
    }
  }
  const data=path.resolve(root,env.RESEARCHSCAPE_DATA_DIR||config.dataDirectory||'data');
  const state=path.resolve(root,env.RESEARCHSCAPE_STATE_DIR||config.stateDirectory||'.local');
  if(data===state)throw new Error('Export and application state directories must be different');
  return {data,state};
}
