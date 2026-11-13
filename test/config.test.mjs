import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {storagePaths} from '../lib/config.mjs';

test('storage stays compatible by default and supports private paths outside the checkout',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'researchscape-paths-'));
  try{
    assert.deepEqual(storagePaths(root,{}),{data:path.join(root,'data'),state:path.join(root,'.local')});
    fs.writeFileSync(path.join(root,'researchscape.local.json'),JSON.stringify({dataDirectory:'../private-exports',stateDirectory:'../private-state'}));
    assert.equal(storagePaths(root,{}).data,path.resolve(root,'../private-exports'));
    assert.equal(storagePaths(root,{RESEARCHSCAPE_STATE_DIR:'./test-state'}).state,path.join(root,'test-state'));
    fs.writeFileSync(path.join(root,'researchscape.local.json'),JSON.stringify({dataDirectory:'same',stateDirectory:'same'}));
    assert.throws(()=>storagePaths(root,{}),/different/);
    fs.writeFileSync(path.join(root,'researchscape.local.json'),JSON.stringify({stateDirectory:12}));
    assert.throws(()=>storagePaths(root,{}),/Invalid/);
  }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
