import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const allowedRoot=new Set(['.gitignore','.gitattributes','.editorconfig','AGENTS.md','README.md','LICENSE','package.json','package-lock.json','server.mjs','researchscape.config.example.json']);
const allowedDirectories=['lib/','public/','scripts/','test/','docs/','examples/','.githooks/','.github/'];
const privatePath=/(?:^|\/)(?:data|\.local|backups|artifacts|node_modules)(?:\/|$)|(?:^|\/)researchscape\.local\.json$|(?:^|\/)\.env(?:\.|$)|\.(?:db|sqlite3?)(?:-|$)|\.(?:log|pid|tmp|zip|7z)$/i;

export function contentProblems(name,content){
  const issues=[];
  if(/\bg-p-[a-f0-9]{32}\b/i.test(content))issues.push('실제 ChatGPT 프로젝트 ID');
  if(/https:\/\/chatgpt\.com\/c\/[a-f0-9-]{20,}/i.test(content))issues.push('개인 ChatGPT 대화 주소');
  if(/\bfile_[a-f0-9]{32}\b/i.test(content))issues.push('개인 업로드 파일 ID');
  if(name.endsWith('.json')&&/"(?:conversation_id|message_id)"\s*:\s*"[a-f0-9]{8}-[a-f0-9-]{27,}"/i.test(content))issues.push('실제 대화/메시지 ID 형태의 JSON');
  return issues;
}

export function checkIndex({staged=true,root=ROOT}={}){
  const git=args=>execFileSync('git',args,{cwd:root,maxBuffer:3_000_000});
  const names=git(staged?['diff','--cached','--name-only','--diff-filter=ACMR','-z']:['ls-files','-z']).toString('utf8').split('\0').filter(Boolean);
  const errors=[];
  for(const name of names){
    const exampleEnv=name==='.env.example';
    if((privatePath.test(name)&&!exampleEnv)||(!allowedRoot.has(name)&&!allowedDirectories.some(dir=>name.startsWith(dir))&&!exampleEnv)){
      errors.push(`${JSON.stringify(name)}: 코드 경로 밖의 파일 또는 개인 데이터 경로`);continue;
    }
    const size=Number(git(['cat-file','-s',':'+name]).toString('utf8'));
    if(size>2_000_000){errors.push(`${JSON.stringify(name)}: 2MB를 넘는 파일은 별도 확인 필요`);continue;}
    const content=git(['show',':'+name]).toString('utf8');
    for(const issue of contentProblems(name,content))errors.push(`${JSON.stringify(name)}: ${issue} 감지`);
  }
  return {files:names.length,errors};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=checkIndex({staged:!process.argv.includes('--all')});
    if(result.errors.length){process.stderr.write('커밋 대상 검사 실패. 파일 내용은 출력하지 않습니다.\n'+result.errors.join('\n')+'\n');process.exitCode=1;}
    else process.stdout.write(`Git 대상 ${result.files}개 검사 통과: 보호 대상 경로/ID 없음\n`);
  }catch(e){process.stderr.write('Git 대상 검사를 완료하지 못했습니다: '+e.message+'\n');process.exitCode=1;}
}
