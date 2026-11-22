// Review order, not a calibrated probability or authorization to link a paper.
// LLM evidence labels remain claims; provider lookup outcomes can lower their
// priority but never turn a label into independently verified identity evidence.
export const REVIEW_EVIDENCE=[
  {type:'identifier-match',label:'식별자 일치',detail:'대화의 DOI·arXiv 등 식별자와 공식 논문의 식별자가 일치한다는 근거입니다.'},
  {type:'exact-title',label:'정식 제목 일치',detail:'충분히 구체적인 정식 제목이 정확히 일치한다는 근거입니다. 같은 제목의 다른 논문이 있으면 추가 확인이 필요합니다.'},
  {type:'explicit-alias-expansion',label:'약칭의 명시적 확장',detail:'약칭과 정식 제목의 대응이 원문에 직접 적혀 있다는 근거입니다.'},
  {type:'author-year-match',label:'저자·연도 일치',detail:'저자와 발표 연도가 일치한다는 보조 근거입니다. 이것만으로 같은 논문이라고 확정하지 않습니다.'},
  {type:'external-identifier',label:'외부 식별자 제안',detail:'외부에서 찾은 DOI·arXiv를 제안한 경우입니다. 공식 조회로 논문의 존재를 확인해도 약칭과 그 논문의 관계는 별도로 확인해야 합니다.'},
  {type:'same-message',label:'같은 메시지의 맥락',detail:'같은 메시지에 함께 등장했다는 맥락 근거입니다. 함께 언급됐다는 이유만으로 같은 논문이 되지는 않습니다.'},
  {type:'adjacent-message',label:'인접 메시지의 맥락',detail:'앞뒤 메시지에서 이어지는 맥락입니다. 같은 메시지보다 간접적인 근거입니다.'},
  {type:'possible-work-version',label:'같은 연구의 다른 버전 가능성',detail:'arXiv와 출판본 등이 같은 연구의 다른 버전일 수 있다는 제안입니다. 동일 논문 자동 병합 근거로 사용하지 않습니다.'},
  {type:'insufficient-evidence',label:'근거 부족',detail:'판단할 근거가 부족합니다. 논문이 아니라는 뜻은 아니므로 제외 여부를 직접 검토해야 합니다.'},
  {type:'conflicting-identifiers',label:'식별자 충돌',detail:'서로 다른 논문의 식별자일 수 있는 충돌입니다. 강한 근거가 함께 적혀 있어도 먼저 충돌을 해결해야 합니다.'}
].map((item,index)=>({...item,rank:index+1}));
const rank=new Map(REVIEW_EVIDENCE.map(e=>[e.type,e.rank]));
export function evidenceOrder(row){
  const types=[...new Set((row.evidence||[]).map(e=>e.type).filter(t=>rank.has(t)))].sort((a,b)=>rank.get(a)-rank.get(b));
  let priority=types.length?Math.min(...types.map(t=>rank.get(t))):11;
  // Negative or ambiguous verification must not be hidden by an optimistic LLM label.
  if(types.includes('conflicting-identifiers')||['conflict','ambiguous','title-mismatch','candidate-mismatch'].includes(row.verification?.status)||['conflicting-metadata','identifier-title-conflict','citation-title-conflict'].includes(row.reason)||!row.candidates?.length&&row.blockedCandidates?.some(c=>c.issues?.length))priority=10;
  else if(types.includes('insufficient-evidence')||['lookup-failed','not-found'].includes(row.verification?.status))priority=Math.max(priority,9);
  else if(types.includes('possible-work-version'))priority=Math.max(priority,8);
  else if(['weak-link','unconfirmed-identifier'].includes(row.verification?.status))priority=Math.max(priority,5);
  return {evidenceTypes:types,evidencePriority:priority};
}
