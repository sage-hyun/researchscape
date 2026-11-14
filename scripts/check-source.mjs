import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files=['server.mjs',...['lib','public','scripts'].flatMap(directory=>fs.readdirSync(path.join(root,directory)).filter(name=>/\.(?:mjs|js)$/.test(name)).map(name=>directory+'/'+name))];
for(const file of files){const result=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8',windowsHide:true});if(result.status!==0){process.stderr.write(result.stderr);process.exit(result.status||1);}}
const python=process.env.RESEARCHSCAPE_PYTHON||'python';
const result=spawnSync(python,['-c',"import ast,pathlib; [ast.parse(p.read_text(encoding='utf-8'),filename=str(p)) for p in pathlib.Path('scripts').glob('*.py')]"],{cwd:root,encoding:'utf8',windowsHide:true});
if(result.error?.code==='ENOENT')console.log('Python 구문 검사 생략: Python 미설치 (PDF 기능은 figures:setup 필요)');
else if(result.status!==0){process.stderr.write(result.stderr);process.exit(result.status||1);}
console.log(`JavaScript ${files.length}개와 사용 가능한 Python 구문 검사 통과`);
