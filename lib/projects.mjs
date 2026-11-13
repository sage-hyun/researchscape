export const CATEGORIES=['research','coursework','unclassified'];
export const SOURCE_FILTERS=['all','non-coursework',...CATEGORIES];

export function classifyConversation(conversation,projects={},overrides={}) {
  const projectId=conversation?.projectId||null,project=projects[projectId];
  const manualCategory=overrides[conversation?.id]?.category;
  const hasManual=CATEGORIES.includes(manualCategory);
  const inheritedCategory=CATEGORIES.includes(project?.category)?project.category:'unclassified';
  const category=hasManual?manualCategory:inheritedCategory;
  return {projectId,projectName:projectId?(project?.name||`이름 미등록 프로젝트 · ${projectId.slice(-8)}`):null,projectUrl:projectId?`https://chatgpt.com/g/${encodeURIComponent(projectId)}/project`:null,category,inheritedCategory,classificationSource:hasManual?'manual':project?'project':'unclassified',manualCategory:hasManual?manualCategory:null};
}

export function sourceFilter(params) {
  const category=params.get('category')||'all',project=params.get('project')||'';
  if(!SOURCE_FILTERS.includes(category))throw new Error('올바른 대화 분류를 선택해주세요.');
  if(project&&project!=='__none__'&&!/^g-p-[A-Za-z0-9-]+$/.test(project))throw new Error('올바른 프로젝트 ID를 선택해주세요.');
  return {category,project,active:category!=='all'||!!project};
}

export function matchingConversations(conversations,filter,projects={},overrides={}) {
  return new Set(conversations.filter(c=>{
    const label=classifyConversation(c,projects,overrides);
    const matchesCategory=filter.category==='all'||(filter.category==='non-coursework'?label.category!=='coursework':label.category===filter.category);
    const matchesProject=!filter.project||(filter.project==='__none__'?!label.projectId:label.projectId===filter.project);
    return matchesCategory&&matchesProject;
  }).map(c=>c.id));
}

export function projectCatalog(conversations,projects={}) {
  const counts=new Map(Object.keys(projects).map(id=>[id,0]));
  for(const c of conversations)if(c.projectId)counts.set(c.projectId,(counts.get(c.projectId)||0)+1);
  return [...counts].map(([id,conversationCount])=>{
    const label=classifyConversation({projectId:id},projects);
    return {id,name:label.projectName,category:label.category,conversationCount};
  }).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
}

export function paperCategories(mentions,labels) {
  const counts=new Map();
  for(const m of mentions){
    if(!counts.has(m.paperId))counts.set(m.paperId,{research:0,coursework:0,unclassified:0});
    counts.get(m.paperId)[labels.get(m.conversationId)?.category||'unclassified']++;
  }
  return counts;
}
