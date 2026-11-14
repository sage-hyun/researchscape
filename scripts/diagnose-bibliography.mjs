import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {storagePaths} from '../lib/config.mjs';
import {loadJSON} from '../lib/local-store.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';
import {bibliographyDiagnostics} from '../lib/bibliography-diagnostics.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),{state}=storagePaths(root);
const raw=loadJSON(state,'index.json',null);
if(!raw)throw new Error('색인이 없습니다. 먼저 node server.mjs --index를 실행하세요.');
const store=loadJSON(state,'bibliography.json',{records:{},lookups:{}}),decisions=loadJSON(state,'bibliography-decisions.json',{});
const report=bibliographyDiagnostics(raw,store,reconcileIndex(raw,store,decisions));
// Read-only, including when legacy caches are used. Never exports conversations or changes review files.
console.log(JSON.stringify(process.argv.includes('--json')?report:{summary:report.summary,lookupSummary:report.lookupSummary,byProvider:report.byProvider,curatedAliases:report.curatedAliases,workVersions:report.workVersions.length,notes:report.notes},null,2));
