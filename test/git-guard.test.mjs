import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {checkIndex} from '../scripts/check-tracked-files.mjs';

test('Git guard checks staged content, blocks forced personal data and permits fictional examples',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'researchscape-git-'));
  const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  const write=(name,text)=>{fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),text);};
  const privateProject='g-p-'+'f'.repeat(32);
  try{
    git(['init','-q']);write('.gitignore','.local/\n');write('server.mjs','export const demo = true;\n');
    write('examples/demo.json',JSON.stringify({conversation_id:'demo-discussion',projectId:'g-p-demo-research'}));
    git(['add','.gitignore','server.mjs','examples/demo.json']);
    assert.equal(checkIndex({root}).errors.length,0);
    write('server.mjs','const leaked = '+JSON.stringify(privateProject)+';');
    assert.equal(checkIndex({root}).errors.length,0,'unstaged changes must not be mistaken for committed content');
    git(['add','server.mjs']);write('server.mjs','export const demo = true;\n');
    assert.ok(checkIndex({root}).errors.some(e=>e.includes('프로젝트 ID')),'unsafe index cannot be hidden by a safe working file');
    git(['add','server.mjs']);
    write('.local/reviews.json','{}');git(['add','-f','.local/reviews.json']);
    assert.ok(checkIndex({root}).errors.some(e=>e.includes('.local/reviews.json')));
    git(['rm','--cached','-f','.local/reviews.json']);
    const fakeUuid=['f'.repeat(8),'f'.repeat(4),'f'.repeat(4),'f'.repeat(4),'f'.repeat(12)].join('-');
    write('examples/accidental-export.json',JSON.stringify({conversation_id:fakeUuid,mapping:{}}));git(['add','examples/accidental-export.json']);
    assert.ok(checkIndex({root}).errors.some(e=>e.includes('대화/메시지')));
    git(['rm','--cached','-f','examples/accidental-export.json']);
    assert.equal(checkIndex({root,staged:false}).errors.length,0);
  }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
