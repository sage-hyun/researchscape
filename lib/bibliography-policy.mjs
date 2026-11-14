import {titleTokens} from './paper-links.mjs';

const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
// Curated identities, never search an ambiguous acronym and trust the first result.
// Metadata must still agree with both the identifier and the recorded full title.
export const VERIFIED_ALIASES = Object.freeze([
  {alias:'MAML',title:'Model-Agnostic Meta-Learning for Fast Adaptation of Deep Networks',identifiers:['arxiv:1703.03400'],source:'https://arxiv.org/abs/1703.03400'},
  {alias:'CLIP',title:'Learning Transferable Visual Models From Natural Language Supervision',identifiers:['arxiv:2103.00020'],source:'https://arxiv.org/abs/2103.00020'},
  {alias:'SMPL',title:'SMPL: A Skinned Multi-Person Linear Model',identifiers:['doi:10.1145/2816795.2818013'],source:'https://smpl.is.tue.mpg.de/'},
  {alias:'IMUTube',title:'IMUTube: Automatic Extraction of Virtual on-body Accelerometry from Video for Human Activity Recognition',identifiers:['doi:10.1145/3411841'],source:'https://github.com/hyeokhyen/imutube'}
]);

export function aliasIdentity(value){return VERIFIED_ALIASES.find(a=>norm(a.alias)===norm(value));}
export function candidatePolicy(value){
  const title=String(value||'').trim(),n=norm(title);
  if(/^(?:chi|uist|cvpr|iccv|eccv|iclr|icml|neurips|aaai|acl|emnlp|iros|rss|siggraph|ieee|acm)(?:\d{4})?$/.test(n)||/^(?:proceedings of|international conference on|conference on human factors)/i.test(title))return {kind:'conference',eligible:false};
  if(/^(?:zupt|zerovelocityupdate|zerovelocityupdates|slam|ekf|imu|llm|cnn|transformer|attention|diffusion|lora|rag)$/.test(n))return {kind:'technology',eligible:false};
  if(/^(?:imagenet|cifar10|cifar100|amass|human36m|ucihar|pamap2|motionx|humaneva|mnist)(?:dataset)?$/.test(n))return {kind:'dataset',eligible:false};
  if(/^(?:\d+[.)]\s*)?(?:related work|related papers|background|introduction|conclusions?|future work|table of contents|experimental (?:setup|results)|ablation stud(?:y|ies)|(?:model|method|system|network) (?:architecture|overview)|(?:key idea|methodology|implementation details|research questions|summary|overview)(?:\s|:|$))/i.test(title)||/:\s*(?:key idea(?: and architecture)?|(?:model )?architecture(?: overview)?|method overview|paper summary|summary|overview)$/i.test(title))return {kind:'section-heading',eligible:false};
  if(/^(?:arXiv|DOI|OpenReview|논문 링크) · /i.test(title)||/https?:\/\//i.test(title))return {kind:'identifier-label',eligible:false};
  if(!title.includes(' '))return {kind:'acronym',eligible:false};
  return {kind:'title',eligible:title.length>=24&&title.length<=220&&titleTokens(title).length>=4&&!/[{}=<>\n]/.test(title)};
}
export const specificTitle=t=>candidatePolicy(t).eligible;
export const blockedCandidate=t=>['conference','technology','dataset','section-heading'].includes(candidatePolicy(t).kind);
export const exactTitle=(a,b)=>norm(a)===norm(b);
