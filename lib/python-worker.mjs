import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
export function figurePython(root){
  if(process.env.RESEARCHSCAPE_FIGURE_PYTHON)return process.env.RESEARCHSCAPE_FIGURE_PYTHON;
  const local=path.join(root,'.local','figure-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  return fs.existsSync(local)?local:process.env.RESEARCHSCAPE_PYTHON||'python';
}
export async function pythonWorker(root,script,args=[],{signal,timeout=180000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(figurePython(root),[path.join(root,'scripts',script),...args],{windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let stdout='',stderr='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const kill=()=>{if(!child.pid)return;if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}};
    const abort=()=>{kill();finish(signal.reason||new Error('Figure job interrupted'));};
    const timer=setTimeout(()=>{kill();finish(new Error('PDF 처리 시간이 초과됐습니다. 다른 PDF로 시도해주세요.'));},timeout);
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>16000000){kill();finish(new Error('PDF worker output exceeded limit'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-6000);});
    child.once('error',e=>finish(new Error(`Python 실행 실패: ${e.message} · npm.cmd run figures:setup`)));
    child.once('exit',code=>{
      if(settled)return;
      try{const line=stdout.trim().split(/\r?\n/).at(-1),value=JSON.parse(line);if(code!==0||value.error)throw new Error(value.error||stderr||`Python exited ${code}`);finish(null,value);}
      catch(e){finish(new Error(`${e.message}${stderr?' · '+stderr:''}`));}
    });
  });
}
