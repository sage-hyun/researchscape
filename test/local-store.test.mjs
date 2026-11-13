import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {saveJSON,loadJSON} from '../lib/local-store.mjs';

test('transient Windows rename locks retry; permanent failure preserves the previous file',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'researchscape-store-')),file=path.join(dir,'state.json');
  try{
    saveJSON(dir,'state.json',{value:'old'});let calls=0;
    saveJSON(dir,'state.json',{value:'new'},{rename:(from,to)=>{if(calls++<2)throw Object.assign(new Error('locked'),{code:'EPERM'});fs.renameSync(from,to);}});
    assert.equal(calls,3);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).value,'new');
    assert.throws(()=>saveJSON(dir,'state.json',{value:'lost'},{attempts:1,fallback:false,rename:()=>{throw Object.assign(new Error('locked'),{code:'EPERM'});}}));
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).value,'new');assert.deepEqual(fs.readdirSync(dir),['state.json']);
    saveJSON(dir,'state.json',{value:'snapshot'},{attempts:1,rename:()=>{throw Object.assign(new Error('locked'),{code:'EPERM'});}});
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).value,'new');assert.equal(loadJSON(dir,'state.json',null).value,'snapshot');
    for(let i=0;i<6;i++)saveJSON(dir,'state.json',{value:'latest'+i});
    assert.equal(loadJSON(dir,'state.json',null).value,'latest5');assert.equal(fs.readdirSync(dir).length,4);
  }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
});
