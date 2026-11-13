import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const state=path.join(root,'.local','demo');
fs.mkdirSync(state,{recursive:true});
const projects=path.join(state,'projects.json');
if(!fs.existsSync(projects))fs.copyFileSync(path.join(root,'examples','demo','projects.example.json'),projects,fs.constants.COPYFILE_EXCL);
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,env:{...process.env,PORT:process.env.PORT||'4319',RESEARCHSCAPE_DATA_DIR:path.join(root,'examples','demo','exports'),RESEARCHSCAPE_STATE_DIR:state},stdio:'inherit'});
process.stdout.write('가상 데모 대화로 실행합니다. 개인 Export와 검토 기록은 읽지 않습니다.\n');
child.on('error',e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code||0;});
process.on('SIGINT',()=>child.kill());
process.on('SIGTERM',()=>child.kill());
