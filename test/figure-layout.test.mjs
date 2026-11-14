import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python=process.env.RESEARCHSCAPE_PYTHON||'python',available=spawnSync(python,['--version'],{windowsHide:true}).status===0;

test('layout extraction handles list-item captions, nested panels, vector regions and out-of-page images',{skip:!available},()=>{
  const code=`import importlib.util,json,pathlib
spec=importlib.util.spec_from_file_location('figures',pathlib.Path('scripts/extract-figures.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
layout={'kids':[
 {'type':'list','page number':1,'bounding box':[10,100,500,150],'list items':[{'type':'list item','id':5,'page number':1,'bounding box':[10,100,500,120],'content':'Figure 1: Overall pipeline with panels'}]},
 {'type':'image','id':1,'page number':1,'bounding box':[10,130,250,300]},
 {'type':'image','id':2,'page number':1,'bounding box':[260,130,500,300]},
 {'type':'paragraph','id':6,'page number':2,'bounding box':[20,100,300,120],'content':'Figure 2: A vector-only architecture'},
 {'type':'paragraph','id':7,'page number':2,'bounding box':[20,400,300,460],'content':'Body paragraph above the vector diagram. '*8},
 {'type':'paragraph','id':8,'page number':2,'bounding box':[20,600,300,650],'content':'Figure 3 shows why this work is useful, but this is body text rather than a caption.'},
 {'type':'image','id':9,'page number':2,'bounding box':[-20,-10,700,900]}
]}
figures=module.detect_figures(layout,[[600,800],[600,800]])
print(json.dumps(figures))`;
  const result=spawnSync(python,['-c',code],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);const figures=JSON.parse(result.stdout);
  const one=figures.find(f=>f.number==='1');assert.ok(one);assert.equal(one.page,1);assert.ok(one.bbox[0]<=10&&one.bbox[2]>=500,'both panels are kept');
  const two=figures.find(f=>f.number==='2');assert.equal(two.method,'caption-region-heuristic');assert.ok(two.bbox[3]<400,'body text bounds the region');assert.ok(!figures.some(f=>f.number==='3'));
  for(const f of figures)assert.ok(f.bbox[0]>=0&&f.bbox[1]>=0&&f.bbox[2]<=600&&f.bbox[3]<=800);
});
