import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,stdio:'ignore'});
execFileSync('git',['config','--local','core.hooksPath','.githooks'],{cwd:root});
process.stdout.write('이 저장소의 pre-commit 데이터 검사 훅을 활성화했습니다.\n');
