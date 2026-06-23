import { STATUSES, AREAS, INITIAL_TASKS } from './data.js';

const STORAGE_KEY = 'fieldos.workspace.v1';
const UNIT_OUTBOX_KEY = 'fieldos.unit-outbox.v1';
const ORGANIZATION_ID = 'local-dev';
const state = loadState();
const $ = selector => document.querySelector(selector);
let syncTimer;
let syncInFlight = false;
let localChangeVersion = 0;
let projects = [];
let computeNodes = [];
let gitSyncSettings = null;
let platformSettings = null;
let logs = [];
let workflowConfiguration = [];
let customFieldDefinitions = [];
let selectedProjectId = null;
let selectedLocationId = null;
let editingAudioLocation = null;
const unitScopeByLocation = new Map();
let unitOutbox = loadUnitOutbox();
let unitOutboxSyncing = false;
const WORK_ITEM_TRANSITIONS = {
  ideas:['backlog','ready'], backlog:['ideas','ready'], ready:['backlog','progress'],
  progress:['blocked','review'], blocked:['backlog','progress'], review:['progress','testing'],
  testing:['progress','done'], done:['progress']
};

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed?.version === 1 && Array.isArray(parsed.tasks)) {
      return { revision: 0, pendingSync: false, audit: [], dirtyTaskIds: [], deletedTaskIds: [], auditDirty: false, fullReplace: false, ...parsed };
    }
  } catch { /* recover from invalid local state */ }
  return { version: 1, revision: 0, pendingSync: false, tasks: structuredClone(INITIAL_TASKS), audit: [{ at: new Date().toISOString(), text: 'Workspace инициализирован' }], dirtyTaskIds: [], deletedTaskIds: [], auditDirty: false, fullReplace: false };
}

function persist(message, mutation = {}) {
  if (message) {
    state.audit.unshift({ at: new Date().toISOString(), text: message });
    state.auditDirty = true;
  }
  if (mutation.taskId && !state.dirtyTaskIds.includes(mutation.taskId)) state.dirtyTaskIds.push(mutation.taskId);
  if (mutation.deletedTaskId) {
    state.dirtyTaskIds = state.dirtyTaskIds.filter(id => id !== mutation.deletedTaskId);
    if (!state.deletedTaskIds.includes(mutation.deletedTaskId)) state.deletedTaskIds.push(mutation.deletedTaskId);
  }
  if (mutation.fullReplace) state.fullReplace = true;
  if (mutation.auditDirty) state.auditDirty = true;
  state.audit = state.audit.slice(0, 30);
  state.pendingSync = true;
  localChangeVersion += 1;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  setSyncState('saving');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncToServer, 300);
}

function setSyncState(mode) {
  const indicator = $('#saveState');
  indicator.classList.toggle('saving', mode === 'saving');
  indicator.classList.toggle('offline', mode === 'offline');
  indicator.lastChild.textContent = mode === 'offline' ? ' Сохранено офлайн' : mode === 'saving' ? ' Синхронизация…' : ' Синхронизировано';
}

async function syncToServer() {
  if (syncInFlight) return;
  syncInFlight = true;
  const capturedVersion = localChangeVersion;
  try {
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await fetch('/api/v1/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Organization-ID': ORGANIZATION_ID },
        body: JSON.stringify({ expectedRevision: state.revision, tasks: state.tasks, audit: state.audit })
      });
    if (response.status !== 409 || attempt === 1) break;
      const remoteResponse = await fetch('/api/v1/workspace', { headers: { Accept: 'application/json', 'X-Organization-ID': ORGANIZATION_ID } });
      if (!remoteResponse.ok) throw new Error('Unable to rebase workspace');
      rebasePendingState(await remoteResponse.json());
    }
    if (!response.ok) throw new Error(`Sync failed: ${response.status}`);
    const result = await response.json();
    state.revision = result.revision;
    state.pendingSync = capturedVersion !== localChangeVersion;
    if (!state.pendingSync) {
      state.dirtyTaskIds = [];
      state.deletedTaskIds = [];
      state.auditDirty = false;
      state.fullReplace = false;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setSyncState(state.pendingSync ? 'saving' : 'synced');
    await hydrateProjects();
    if (state.pendingSync) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncToServer, 100);
    }
  } catch {
    state.pendingSync = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setSyncState('offline');
  } finally {
    syncInFlight = false;
  }
}

async function hydrateProjects() {
  try {
    const response = await fetch('/api/v1/projects', { headers: { Accept: 'application/json', 'X-Organization-ID': ORGANIZATION_ID } });
    if (!response.ok) throw new Error('Projects API unavailable');
    projects = (await response.json()).projects;
    applyUnitOutbox();
    renderProjects();
    if (selectedProjectId) selectedLocationId ? renderLocationDetail() : renderProjectDetail();
  } catch {
    if (!projects.length) renderProjects(true);
  }
}

async function apiPost(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Organization-ID': ORGANIZATION_ID,
      'Idempotency-Key': createIdempotencyKey()
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Request failed: ${response.status}`);
  return result;
}

async function apiPatch(path, payload, idempotencyKey = createIdempotencyKey()) {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Organization-ID': ORGANIZATION_ID, 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || `Request failed: ${response.status}`);
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

function loadUnitOutbox() {
  try { const value=JSON.parse(localStorage.getItem(UNIT_OUTBOX_KEY)); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

function saveUnitOutbox() { localStorage.setItem(UNIT_OUTBOX_KEY,JSON.stringify(unitOutbox)); }

function queueUnitMutation(mutation) {
  const scope=`${mutation.projectId}|${mutation.locationId}|${mutation.unitId}|${mutation.payload.workTypeId}|${mutation.payload.actionId}`;
  const existing=unitOutbox.find(value=>value.scope===scope);
  if(existing){existing.payload=mutation.payload;existing.idempotencyKey=createIdempotencyKey();existing.queuedAt=new Date().toISOString();}
  else unitOutbox.push({...mutation,id:createIdempotencyKey(),scope,idempotencyKey:createIdempotencyKey(),queuedAt:new Date().toISOString()});
  saveUnitOutbox();
}

function applyUnitOutbox() {
  unitOutbox.forEach(mutation=>{const project=projects.find(value=>value.id===mutation.projectId);const locationValue=project?.locations.find(value=>value.id===mutation.locationId);const unit=locationValue?.units.find(value=>value.id===mutation.unitId);if(!unit)return;const index=unit.progress.findIndex(value=>value.workTypeId===mutation.payload.workTypeId&&value.actionId===mutation.payload.actionId);const overlay={...(index>=0?unit.progress[index]:{id:`pending-${mutation.id}`,workTypeId:mutation.payload.workTypeId,actionId:mutation.payload.actionId,version:mutation.payload.expectedVersion||null}),status:mutation.payload.status,completedOn:mutation.payload.status==='complete'?(mutation.payload.completedOn||mutation.queuedAt.slice(0,10)):null,pending:true,pendingOffline:!navigator.onLine};if(index>=0)unit.progress[index]=overlay;else unit.progress.push(overlay);});
}

async function flushUnitOutbox() {
  if(unitOutboxSyncing||!navigator.onLine||!unitOutbox.length)return;
  unitOutboxSyncing=true;
  let changed=false;
  try {
    while(unitOutbox.length&&navigator.onLine){const mutation=unitOutbox[0];try{await apiPatch(mutation.path,mutation.payload,mutation.idempotencyKey);unitOutbox.shift();saveUnitOutbox();changed=true;}catch(error){if(['version_conflict','invalid_request'].includes(error.code)){unitOutbox.shift();saveUnitOutbox();toast('Изменение unit требует повторной проверки');changed=true;continue;}break;}}
  } finally {unitOutboxSyncing=false;if(changed)await hydrateProjects();}
}

function createIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  return `web-${Date.now()}-${[...values].map(value => value.toString(16)).join('')}`;
}

function hasPendingMutations() {
  return state.fullReplace || state.auditDirty || state.dirtyTaskIds.length > 0 || state.deletedTaskIds.length > 0;
}

function mergeAudit(remoteAudit) {
  const combined = [...state.audit, ...remoteAudit];
  const seen = new Set();
  return combined.filter(event => {
    const key = `${event.at}|${event.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
}

function rebasePendingState(remote) {
  if (!state.fullReplace) {
    const localById = new Map(state.tasks.map(task => [task.id, task]));
    const merged = new Map(remote.tasks.map(task => [task.id, task]));
    state.dirtyTaskIds.forEach(id => { if (localById.has(id)) merged.set(id, localById.get(id)); });
    state.deletedTaskIds.forEach(id => merged.delete(id));
    state.tasks = [...merged.values()];
  }
  state.audit = state.auditDirty ? mergeAudit(remote.audit) : remote.audit;
  state.revision = remote.revision;
}

async function hydrateFromServer() {
  try {
    const response = await fetch('/api/v1/workspace', { headers: { Accept: 'application/json', 'X-Organization-ID': ORGANIZATION_ID } });
    if (!response.ok) throw new Error('Workspace API unavailable');
    const remote = await response.json();
    if (remote.initialized && (!state.pendingSync || !hasPendingMutations())) {
      state.tasks = remote.tasks;
      state.audit = remote.audit;
      state.revision = remote.revision;
      state.pendingSync = false;
      state.dirtyTaskIds = [];
      state.deletedTaskIds = [];
      state.auditDirty = false;
      state.fullReplace = false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSyncState('synced');
      render();
      return;
    }
    if (remote.initialized) rebasePendingState(remote);
    else state.revision = remote.revision;
    state.pendingSync = true;
    await syncToServer();
  } catch {
    setSyncState('offline');
  }
}

function escapeHtml(value = '') {
  return value.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function filteredTasks() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const priority = $('#priorityFilter').value;
  const area = $('#areaFilter').value;
  return state.tasks.filter(task =>
    (!q || `${task.id} ${task.title} ${task.description}`.toLowerCase().includes(q)) &&
    (priority === 'all' || task.priority === priority) &&
    (area === 'all' || task.area === area)
  );
}

function render() {
  renderMetrics();
  renderProjects();
  renderRoadmap();
  renderBoard();
  renderAudit();
}

function renderRoute() {
  const requested = location.hash.replace('#', '');
  const routeParts = requested.split('/');
  selectedProjectId = routeParts[0] === 'project' && routeParts[1] ? decodeURIComponent(routeParts[1]) : null;
  selectedLocationId = routeParts[2] === 'location' && routeParts[3] ? decodeURIComponent(routeParts[3]) : null;
  const route = selectedProjectId ? 'projects' : (['overview', 'projects', 'logs', 'admin'].includes(requested) ? requested : 'overview');
  document.body.dataset.route = route;
  document.querySelectorAll('[data-view]').forEach(view => view.classList.toggle('active', view.dataset.view === route));
  document.querySelectorAll('[data-route-link]').forEach(link => {
    const active = link.dataset.routeLink === route;
    link.classList.toggle('active', active);
    link.setAttribute('aria-current', active ? 'page' : 'false');
  });
  $('#projectsListView')?.classList.toggle('hidden', Boolean(selectedProjectId));
  $('#projectDetailView')?.classList.toggle('hidden', !selectedProjectId);
  if (selectedProjectId) selectedLocationId ? renderLocationDetail() : renderProjectDetail();
  if (route === 'logs') hydrateLogs();
  if (route === 'admin') Promise.all([hydrateComputeNodes(),hydratePlatformSettings(),hydrateGitSyncSettings(),hydrateWorkflowConfiguration(),hydrateCustomFieldDefinitions()]);
}

function formatMemory(bytes){return `${(Number(bytes||0)/1073741824).toFixed(1)} GB`;}

function renderComputeNodes(unavailable=false){
  const container=$('#computeNodes'),summary=$('#computeSummary'); if(!container||!summary)return;
  if(unavailable){container.innerHTML='<article class="compute-card project-loading">Мониторинг временно недоступен.</article>';return;}
  const online=computeNodes.filter(value=>value.online).length,enabled=computeNodes.filter(value=>value.online&&value.computeEnabled).length,totalMemory=computeNodes.filter(value=>value.online&&value.computeEnabled).reduce((sum,value)=>sum+value.totalMemoryBytes,0);
  summary.innerHTML=`<article><span>Online</span><strong>${online}</strong></article><article><span>Compute enabled</span><strong>${enabled}</strong></article><article><span>Доступная память узлов</span><strong>${formatMemory(totalMemory)}</strong></article>`;
  container.innerHTML=computeNodes.length?computeNodes.map(node=>{const latest=node.metrics.at(-1)||{};const memoryPercent=latest.memoryTotalBytes?Math.round(latest.memoryUsedBytes/latest.memoryTotalBytes*100):0;const chart=node.metrics.slice(-24).map(metric=>`<i style="height:${Math.max(3,metric.cpuPercent)}%" title="CPU ${metric.cpuPercent}%"></i>`).join('');return `<article class="compute-card ${node.online?'online':'offline'}"><header><div><span class="node-state"></span><div><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(node.hostname)} · ${escapeHtml(node.architecture)}</small></div></div><label class="compute-toggle"><input type="checkbox" data-compute-node="${node.id}" ${node.computeEnabled?'checked':''} ${!node.agentOptIn?'disabled':''}><span>Вычисления</span></label></header><div class="node-metrics"><div><span>CPU</span><strong>${latest.cpuPercent??0}%</strong></div><div><span>Memory</span><strong>${memoryPercent}%</strong><small>${formatMemory(latest.memoryUsedBytes)} / ${formatMemory(latest.memoryTotalBytes)}</small></div><div><span>Battery</span><strong>${latest.batteryPercent??'—'}${latest.batteryPercent==null?'':'%'}</strong><small>${escapeHtml(latest.powerSource||'unknown')}</small></div><div><span>Thermal</span><strong>${escapeHtml(latest.thermalState||'unknown')}</strong></div></div><div class="compute-chart">${chart}</div><footer><span>${node.online?'Online':'Offline'}</span><small>Agent ${escapeHtml(node.agentVersion)} · ${new Date(node.lastSeenAt).toLocaleTimeString('ru-RU')}</small></footer></article>`;}).join(''):'<article class="compute-card project-loading">Ожидание первого Compute Agent…</article>';
  container.querySelectorAll('[data-compute-node]').forEach(toggle=>toggle.addEventListener('change',async()=>{toggle.disabled=true;try{await apiPatch(`/api/v1/admin/compute-nodes/${encodeURIComponent(toggle.dataset.computeNode)}/enabled`,{enabled:toggle.checked});await hydrateComputeNodes();toast(toggle.checked?'Узел разрешен для вычислений':'Вычисления на узле отключены');}catch(error){toggle.checked=!toggle.checked;toast(error.message);}finally{toggle.disabled=false;}}));
}

async function hydrateComputeNodes(){try{const response=await fetch('/api/v1/admin/compute-nodes',{headers:{'X-Organization-ID':ORGANIZATION_ID}});if(!response.ok)throw new Error('monitor unavailable');const payload=await response.json();computeNodes=payload.nodes||[];renderComputeNodes();}catch{renderComputeNodes(true);}}

function renderGitSyncSettings(unavailable=false){
  const form=$('#gitSyncForm'),status=$('#gitSyncStatus'),message=$('#gitSyncMessage'); if(!form||!status||!message)return;
  if(unavailable){status.textContent='Unavailable';status.className='git-sync-status error';message.textContent='Git sync settings are temporarily unavailable.';return;}
  const settings=gitSyncSettings||{};
  $('#gitRemoteUrl').value=settings.remoteUrl||'';
  $('#gitBranchName').value=settings.branchName||'main';
  $('#gitCommitStrategy').value=settings.commitStrategy||'per_task';
  $('#gitAutoCommit').checked=settings.autoCommit!==false;
  $('#gitAutoPush').checked=Boolean(settings.autoPush);
  $('#gitIncludeDocs').checked=settings.includeDocs!==false;
  status.textContent=(settings.lastSyncStatus||'not_configured').replace('_',' ');
  status.className=`git-sync-status ${settings.lastSyncStatus||'not_configured'}`;
  message.textContent=settings.lastSyncMessage||'Credentials are not stored in RackPilot. Use SSH key or local Git credential manager.';
}

async function hydrateGitSyncSettings(){try{const response=await fetch('/api/v1/admin/git-sync',{headers:{'X-Organization-ID':ORGANIZATION_ID}});if(!response.ok)throw new Error('git sync unavailable');const payload=await response.json();gitSyncSettings=payload.settings;renderGitSyncSettings();}catch{renderGitSyncSettings(true);}}

async function submitGitSyncSettings(event){event.preventDefault();const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;try{const response=await fetch('/api/v1/admin/git-sync',{method:'POST',headers:{'Content-Type':'application/json','X-Organization-ID':ORGANIZATION_ID},body:JSON.stringify({remoteUrl:$('#gitRemoteUrl').value.trim(),branchName:$('#gitBranchName').value.trim()||'main',commitStrategy:$('#gitCommitStrategy').value,autoCommit:$('#gitAutoCommit').checked,autoPush:$('#gitAutoPush').checked,includeDocs:$('#gitIncludeDocs').checked})});const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message||'Git settings failed');gitSyncSettings=payload.settings;renderGitSyncSettings();toast('Git sync settings saved');}catch(error){toast(error.message);}finally{button.disabled=false;}}

function renderPlatformSettings(unavailable=false){const form=$('#platformSettingsForm'),status=$('#platformSettingsStatus');if(!form||!status)return;if(unavailable){status.textContent='Unavailable';status.className='git-sync-status error';return;}const settings=platformSettings||{};$('#platformLanguage').value=settings.defaultLanguage||'en';$('#platformTimezone').value=settings.timezone||'America/Halifax';$('#platformRoleMode').value=settings.roleMode||'planned';$('#platformTelemetryMode').value=settings.telemetryMode||'standard';$('#platformLogRetention').value=settings.logRetentionDays||365;status.textContent=settings.updatedAt?'Configured':'Default';status.className=`git-sync-status ${settings.updatedAt?'configured':'not_configured'}`;}

async function hydratePlatformSettings(){try{const response=await fetch('/api/v1/admin/platform-settings',{headers:{'X-Organization-ID':ORGANIZATION_ID}});if(!response.ok)throw new Error('platform settings unavailable');const payload=await response.json();platformSettings=payload.settings;renderPlatformSettings();}catch{renderPlatformSettings(true);}}

async function submitPlatformSettings(event){event.preventDefault();const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;try{const response=await fetch('/api/v1/admin/platform-settings',{method:'POST',headers:{'Content-Type':'application/json','X-Organization-ID':ORGANIZATION_ID},body:JSON.stringify({defaultLanguage:$('#platformLanguage').value,timezone:$('#platformTimezone').value.trim(),roleMode:$('#platformRoleMode').value,telemetryMode:$('#platformTelemetryMode').value,logRetentionDays:Number($('#platformLogRetention').value)})});const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message||'Platform settings failed');platformSettings=payload.settings;renderPlatformSettings();toast('Platform settings saved');}catch(error){toast(error.message);}finally{button.disabled=false;}}

function populateLogProjectFilter(){const filter=$('#logProjectFilter');if(!filter)return;const selected=filter.value;filter.innerHTML='<option value="">All projects</option>'+projects.map(project=>`<option value="${project.id}">${escapeHtml(project.code)} · ${escapeHtml(project.name)}</option>`).join('');filter.value=[...filter.options].some(option=>option.value===selected)?selected:'';}

function renderLogs(unavailable=false){const container=$('#logsList');if(!container)return;populateLogProjectFilter();if(unavailable){container.innerHTML='<article class="project-loading">Журнал временно недоступен.</article>';return;}container.innerHTML=logs.length?logs.map(event=>`<article class="log-entry"><div><span>${escapeHtml(event.source)} · ${escapeHtml(event.entityType||'event')}</span><strong>${escapeHtml(event.message||event.action)}</strong><small>${escapeHtml(event.projectCode||event.projectName||'Workspace')} · ${escapeHtml(event.action||'audit')}</small></div><time datetime="${escapeHtml(event.createdAt||'')}">${event.createdAt?new Date(event.createdAt).toLocaleString('ru-RU'):'—'}</time></article>`).join(''):'<article class="project-loading">По фильтрам событий нет.</article>';}

async function hydrateLogs(){try{populateLogProjectFilter();const params=new URLSearchParams({source:$('#logSourceFilter')?.value||'all',entityType:$('#logEntityFilter')?.value||'all',q:$('#logSearchInput')?.value||'',limit:'150'});const projectId=$('#logProjectFilter')?.value;if(projectId)params.set('projectId',projectId);const response=await fetch(`/api/v1/logs?${params}`,{headers:{'X-Organization-ID':ORGANIZATION_ID}});if(!response.ok)throw new Error('logs unavailable');const payload=await response.json();logs=payload.logs||[];renderLogs();}catch{renderLogs(true);}}

function renderAgentStatus(agent){const indicator=$('#agentIndicator');if(!indicator)return;indicator.className=`agent-indicator ${agent.status||'idle'}${agent.needsAction?' needs-action':''}`;const labels={working:'Работает',idle:'Не активен',waiting:'Ожидает',blocked:'Требуется действие',limit:'Достигнут лимит'};$('#agentStatusText').textContent=`${labels[agent.status]||agent.status} · ${agent.message||''}`;$('#requestContinueButton').classList.toggle('requested',Boolean(agent.continuationRequested));$('#requestContinueButton').title=agent.continuationRequested?'Запрос уже зарегистрирован':'Запросить продолжение разработки';}

async function hydrateAgentStatus(){try{const response=await fetch('/api/v1/development-agent/status',{headers:{'X-Organization-ID':ORGANIZATION_ID}});if(!response.ok)throw new Error('status unavailable');const payload=await response.json();renderAgentStatus(payload.agent);}catch{renderAgentStatus({status:'blocked',message:'Статус недоступен',needsAction:true});}}

async function requestDevelopmentContinuation(){const button=$('#requestContinueButton');button.disabled=true;try{const response=await fetch('/api/v1/development-agent/continue',{method:'POST',headers:{'X-Organization-ID':ORGANIZATION_ID}});if(!response.ok)throw new Error('request failed');const payload=await response.json();renderAgentStatus(payload.agent);toast('Запрос на продолжение зарегистрирован');}catch{toast('Не удалось зарегистрировать запрос');}finally{button.disabled=false;}}

function renderWorkflowConfiguration(){const container=$('#workflowAdminList');if(!container)return;container.innerHTML=workflowConfiguration.map(type=>`<article style="--workflow-color:${escapeHtml(type.color)}"><div><i></i><div><strong>${escapeHtml(type.name)}</strong><small>${escapeHtml(type.code)} · ${type.actions.length} этапов</small></div></div><div class="workflow-action-chips">${type.actions.filter(value=>value.active).map(value=>`<span>${escapeHtml(value.name)}</span>`).join('')}</div><button class="text-button" type="button" data-edit-work-type="${type.id}">Редактировать</button></article>`).join('')||'<p class="empty-copy">Виды работ не настроены.</p>';container.querySelectorAll('[data-edit-work-type]').forEach(button=>button.addEventListener('click',()=>openWorkTypeDialog(workflowConfiguration.find(value=>value.id===button.dataset.editWorkType))));}

async function hydrateWorkflowConfiguration(){try{const response=await fetch('/api/v1/admin/work-types',{headers:{'X-Organization-ID':ORGANIZATION_ID}});if(!response.ok)throw new Error('workflow unavailable');const payload=await response.json();workflowConfiguration=payload.workTypes||[];renderWorkflowConfiguration();}catch{const container=$('#workflowAdminList');if(container)container.innerHTML='<p class="empty-copy">Настройки workflow временно недоступны.</p>';}}

function openWorkTypeDialog(type=null){$('#workTypeForm').reset();$('#workTypeConfigId').value=type?.id||'';$('#workTypeConfigVersion').value=type?.version||'';$('#workTypeDialogTitle').textContent=type?'Редактировать вид работ':'Новый вид работ';$('#workTypeConfigCode').value=type?.code||'';$('#workTypeConfigName').value=type?.name||'';$('#workTypeConfigColor').value=type?.color||'#7c8cff';$('#workTypeConfigActions').value=(type?.actions||[]).filter(value=>value.active).map(value=>`${value.code} | ${value.name}`).join('\n');$('#workTypeDialog').showModal();}

async function submitWorkType(event){event.preventDefault();if(!event.currentTarget.reportValidity())return;const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;const id=$('#workTypeConfigId').value;const actions=$('#workTypeConfigActions').value.split('\n').map(value=>value.trim()).filter(Boolean).map(line=>{const [code,...name]=line.split('|');return {code:code.trim(),name:name.join('|').trim()};});const payload={code:$('#workTypeConfigCode').value.trim(),name:$('#workTypeConfigName').value.trim(),color:$('#workTypeConfigColor').value,actions};if(id)payload.expectedVersion=Number($('#workTypeConfigVersion').value);try{if(id)await apiPatch(`/api/v1/admin/work-types/${encodeURIComponent(id)}`,payload);else await apiPost('/api/v1/admin/work-types',payload);$('#workTypeDialog').close();await Promise.all([hydrateWorkflowConfiguration(),hydrateProjects()]);toast(id?'Вид работ обновлен':'Вид работ добавлен');}catch(error){toast(error.code==='version_conflict'?'Настройки уже изменены':error.message);}finally{button.disabled=false;}}

function renderCustomFieldAdmin(){const container=$('#customFieldAdminList');if(!container)return;container.innerHTML=customFieldDefinitions.map(field=>`<article><div><i style="background:${field.scope==='unit'?'#7c8cff':'#42d697'}"></i><div><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(field.scope)} · ${escapeHtml(field.code)} · ${escapeHtml(field.dataType)}</small></div></div><div class="workflow-action-chips"><span>${field.required?'Обязательно':'Необязательно'}</span><span>${field.active?'Активно':'Отключено'}</span></div><button class="text-button" type="button" data-edit-custom-field="${field.id}">Редактировать</button></article>`).join('')||'<p class="empty-copy">Дополнительные поля не настроены.</p>';container.querySelectorAll('[data-edit-custom-field]').forEach(button=>button.addEventListener('click',()=>openCustomFieldDialog(customFieldDefinitions.find(value=>value.id===button.dataset.editCustomField))));}

async function hydrateCustomFieldDefinitions(){try{const response=await fetch('/api/v1/admin/custom-fields',{headers:{'X-Organization-ID':ORGANIZATION_ID}});if(!response.ok)throw new Error('custom fields unavailable');const payload=await response.json();customFieldDefinitions=payload.customFields||[];renderCustomFieldAdmin();}catch{const container=$('#customFieldAdminList');if(container)container.innerHTML='<p class="empty-copy">Настройки полей временно недоступны.</p>';}}

function openCustomFieldDialog(field=null){$('#customFieldForm').reset();$('#customFieldId').value=field?.id||'';$('#customFieldVersion').value=field?.version||'';$('#customFieldDialogTitle').textContent=field?'Редактировать поле':'Новое поле';$('#customFieldScope').value=field?.scope||'unit';$('#customFieldType').value=field?.dataType||'text';$('#customFieldCode').value=field?.code||'';$('#customFieldLabel').value=field?.label||'';$('#customFieldOptions').value=(field?.options||[]).join(', ');$('#customFieldRequired').checked=Boolean(field?.required);$('#customFieldActive').checked=field?.active??true;$('#customFieldDialog').showModal();}

async function submitCustomField(event){event.preventDefault();if(!event.currentTarget.reportValidity())return;const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;const id=$('#customFieldId').value;const payload={scope:$('#customFieldScope').value,code:$('#customFieldCode').value.trim(),label:$('#customFieldLabel').value.trim(),dataType:$('#customFieldType').value,options:$('#customFieldOptions').value.split(',').map(value=>value.trim()).filter(Boolean),required:$('#customFieldRequired').checked,active:$('#customFieldActive').checked};if(id)payload.expectedVersion=Number($('#customFieldVersion').value);try{if(id)await apiPatch(`/api/v1/admin/custom-fields/${encodeURIComponent(id)}`,payload);else await apiPost('/api/v1/admin/custom-fields',payload);$('#customFieldDialog').close();await hydrateCustomFieldDefinitions();toast(id?'Поле обновлено':'Поле добавлено');}catch(error){toast(error.code==='version_conflict'?'Поле уже изменено':error.message);}finally{button.disabled=false;}}

function renderDynamicFields(scope,containerId,values={}){const container=$(`#${containerId}`);if(!container)return;const definitions=customFieldDefinitions.filter(value=>value.scope===scope&&value.active);container.innerHTML=definitions.map(field=>{const value=values[field.code];if(field.dataType==='boolean')return `<label class="check-label"><input type="checkbox" data-custom-code="${escapeHtml(field.code)}" data-custom-type="boolean" ${value?'checked':''}> ${escapeHtml(field.label)}${field.required?' *':''}</label>`;if(field.dataType==='select')return `<label>${escapeHtml(field.label)}<select data-custom-code="${escapeHtml(field.code)}" data-custom-type="select" ${field.required?'required':''}><option value="">Выберите…</option>${field.options.map(option=>`<option value="${escapeHtml(option)}" ${value===option?'selected':''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;const inputType=field.dataType==='number'?'number':field.dataType==='date'?'date':'text';return `<label>${escapeHtml(field.label)}<input type="${inputType}" data-custom-code="${escapeHtml(field.code)}" data-custom-type="${escapeHtml(field.dataType)}" value="${escapeHtml(value??'')}" ${field.required?'required':''}></label>`;}).join('');}

function collectDynamicFields(containerId){const values={};$(`#${containerId}`)?.querySelectorAll('[data-custom-code]').forEach(input=>{if(input.dataset.customType==='boolean')values[input.dataset.customCode]=input.checked;else if(input.dataset.customType==='number')values[input.dataset.customCode]=input.value===''?null:Number(input.value);else values[input.dataset.customCode]=input.value;});return values;}

function renderProjects(unavailable = false) {
  const portfolio = $('#projectsPortfolio');
  if (!portfolio) return;
  if (unavailable) {
    portfolio.innerHTML = '<article class="project-card project-loading">Реестр проектов временно недоступен. Kanban продолжает работать офлайн.</article>';
    return;
  }
  if (!projects.length) {
    portfolio.innerHTML = '<article class="project-card project-loading">Проекты пока не созданы.</article>';
    return;
  }
  portfolio.innerHTML = projects.map(project => {
    const summary = project.taskSummary;
    const buildings = project.buildings || [];
    const workItems = project.workItems || [];
    const buildingById = new Map(buildings.map(building => [building.id, building]));
    const workTypeById = new Map((project.workTypeProgress || []).map(workType => [workType.id, workType]));
    const stages = project.stages.map(stage => `<li>
      <div><span>${escapeHtml(stage.name)}</span><b>${stage.progress}%</b></div>
      <div class="stage-progress"><i style="width:${stage.progress}%"></i></div>
      <small>${stage.taskCount} задач</small>
    </li>`).join('');
    return `<article class="project-card">
      <header><div><span class="project-code">${escapeHtml(project.code)}</span><h3>${escapeHtml(project.name)}</h3></div><span class="project-status ${project.status}">${project.status.replace('_', ' ')}</span></header>
      <p>${escapeHtml(project.description)}</p>
      <div class="project-summary">
        <div class="project-progress"><strong>${project.progress}%</strong><span>общий прогресс</span></div>
        <dl><div><dt>${summary.total}</dt><dd>задач</dd></div><div><dt>${summary.active}</dt><dd>в работе</dd></div><div><dt>${summary.blocked}</dt><dd>blocked</dd></div><div><dt>${summary.done}</dt><dd>готово</dd></div></dl>
      </div>
      ${project.kind === 'customer' ? `<section class="work-type-progress"><div class="subsection-title"><span>ПРОГРЕСС ПО ВИДАМ РАБОТ</span><small>выполнение · задачи · блокировки</small></div><div class="work-type-grid">${project.workTypeProgress.map(workType => `<article style="--work-color:${workType.color}"><header><span>${escapeHtml(workType.name)}</span><b>${workType.progress}%</b></header><div class="work-type-bar"><i style="width:${workType.progress}%"></i></div><footer>${workType.taskCount} задач · ${workType.done} готово${workType.blocked ? ` · ${workType.blocked} blocked` : ''}</footer></article>`).join('')}</div></section>` : ''}
      <div class="project-operations">
        <div><span>Объекты</span><strong>${project.buildingCount || 0}</strong><small>${buildings.length ? escapeHtml(buildings.slice(0, 2).map(building => building.name).join(' · ')) : 'здания еще не добавлены'}</small></div>
        <div><span>Полевые задачи</span><strong>${workItems.length}</strong><small>${workItems.length ? `${workItems.filter(item => item.status === 'done').length} завершено` : 'операционный поток пуст'}</small></div>
        <div><span>Плановые часы</span><strong>${Math.round(workItems.reduce((sum, item) => sum + (item.estimatedMinutes || 0), 0) / 60 * 10) / 10}</strong><small>${workItems.reduce((sum, item) => sum + (item.actualMinutes || 0), 0) / 60} фактически</small></div>
      </div>
      <ol class="project-stages">${stages}</ol>
      <button class="button project-open" type="button" data-open-project="${project.id}">Открыть проект →</button>
      ${project.kind === 'customer' ? `<footer class="project-actions"><button class="button ghost" type="button" data-add-building="${project.id}">＋ Здание</button><button class="button ghost" type="button" data-add-work-item="${project.id}">＋ Полевая задача</button></footer>` : '<footer class="project-boundary">Внутренний проект · полевые операции отключены</footer>'}
      ${workItems.length ? `<div class="work-items-preview"><div class="preview-title"><span>FIELD WORKFLOW</span><b>${workItems.length}</b></div>${workItems.slice(-5).reverse().map(item => {
        const blockedBy = item.blockedBy || [];
        const allowed = [item.status, ...(WORK_ITEM_TRANSITIONS[item.status] || [])].filter(status => !blockedBy.length || !['progress','review','testing','done'].includes(status));
        const options = STATUSES.filter(status => allowed.includes(status.id)).map(status => `<option value="${status.id}" ${status.id === item.status ? 'selected' : ''}>${status.label}</option>`).join('');
        const building = buildingById.get(item.buildingId);
        const workType = workTypeById.get(item.workTypeId);
        return `<div class="work-item-row ${blockedBy.length ? 'auto-blocked' : ''}"><div><strong>${escapeHtml(item.title)}</strong><small>${workType ? escapeHtml(workType.name) : 'Без вида работ'} · ${building ? escapeHtml(building.code) : 'Без здания'}${item.dueDate ? ` · до ${escapeHtml(item.dueDate)}` : ''}${blockedBy.length ? ` · заблокировано: ${blockedBy.length}` : ''}</small></div><select data-work-item-status="${item.id}" data-project-id="${project.id}" data-version="${item.version}" aria-label="Статус ${escapeHtml(item.title)}">${options}</select></div>`;
      }).join('')}</div>` : ''}
      ${project.activity?.length ? `<section class="project-activity"><div class="subsection-title"><span>ЖУРНАЛ ПРОЕКТА</span><small>${project.activity.length} последних событий</small></div><ol>${project.activity.slice(0, 6).map(event => `<li><i></i><div><strong>${escapeHtml(projectActivityText(event))}</strong><small>${new Date(event.createdAt).toLocaleString('ru-RU')}</small></div></li>`).join('')}</ol></section>` : ''}
    </article>`;
  }).join('');
  portfolio.querySelectorAll('[data-add-building]').forEach(button => button.addEventListener('click', () => openBuildingDialog(button.dataset.addBuilding)));
  portfolio.querySelectorAll('[data-add-work-item]').forEach(button => button.addEventListener('click', () => openWorkItemDialog(button.dataset.addWorkItem)));
  portfolio.querySelectorAll('[data-work-item-status]').forEach(select => select.addEventListener('change', updateWorkItemStatus));
  portfolio.querySelectorAll('[data-open-project]').forEach(button => button.addEventListener('click', () => { location.hash = `project/${encodeURIComponent(button.dataset.openProject)}`; }));
}

function renderProjectDetail() {
  const container = $('#projectDetailView');
  const project = projects.find(value => value.id === selectedProjectId);
  if (!container || !project) { if (container) container.innerHTML = '<p class="project-loading">Проект загружается…</p>'; return; }
  const today = new Date().toISOString().slice(0,10);
  const dailyLog = projectDailyLogEntries(project);
  const updatesToday = dailyLog.filter(value => value.workDate === today);
  const openIssues = project.issues.filter(value => value.status !== 'resolved');
  container.innerHTML = `<header class="detail-header"><div><a href="#projects">← Все проекты</a><p class="eyebrow">${escapeHtml(project.code)} · PROJECT DETAIL</p><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.description || 'Описание проекта не добавлено')}</p></div><div class="detail-actions"><button class="button ghost" type="button" data-add-location>＋ Этаж / зона</button><button class="button primary" type="button" data-daily-update>＋ Отчет за сегодня</button></div></header>
    <section class="detail-kpis"><article><span>Общий прогресс</span><strong>${project.progress}%</strong></article><article><span>Сегодня обновлено</span><strong>${updatesToday.length}</strong></article><article><span>Открытые проблемы</span><strong>${openIssues.length}</strong></article><article><span>Локации</span><strong>${project.locations.length}</strong></article></section>
    <section class="detail-section"><div class="detail-section-title"><div><p class="eyebrow">WORK PROGRESS</p><h2>Прогресс по видам работ</h2></div></div><div class="scope-cards">${project.workTypeProgress.map(scope => `<article style="--scope:${scope.color}"><div><strong>${escapeHtml(scope.name)}</strong><b>${scope.progress}%</b></div><div class="scope-bar"><i style="width:${scope.progress}%"></i></div><small>${scope.fieldUpdateCount} обновлений · ${scope.taskCount} задач${scope.blocked ? ` · ${scope.blocked} blocked` : ''}</small></article>`).join('')}</div></section>
    <section class="detail-grid"><article class="detail-panel"><div class="detail-section-title"><div><p class="eyebrow">LOCATIONS</p><h2>Структура объекта</h2></div><button class="text-button" data-add-location>Добавить</button></div><div class="location-cards">${project.locations.length ? project.locations.map(location => {const parent=project.locations.find(value=>value.id===location.parentLocationId);return `<button type="button" data-open-location="${location.id}" style="--location-depth:${location.depth||0}"><span>${escapeHtml(location.code)}</span><strong>${escapeHtml(location.name)}</strong><small>${parent?`${escapeHtml(parent.name)} → `:''}${escapeHtml(location.kind)}${location.suiteTotal !== null ? ` · ${location.suiteTotal} suites` : ''}${location.audioDetails ? ` · ${location.audioDetails.speakerCount || 0} speakers` : ''}</small></button>`;}).join('') : '<p class="empty-copy">Добавьте этажи или зоны, чтобы техник мог фиксировать прогресс.</p>'}</div></article>
    <article class="detail-panel"><div class="detail-section-title"><div><p class="eyebrow">ISSUES</p><h2>Проблемы</h2></div><b class="issue-count">${openIssues.length}</b></div><div class="issue-list">${openIssues.length ? openIssues.slice(0,6).map(issue => `<div class="issue-item ${issue.severity}"><span>${escapeHtml(issue.severity)}</span><strong>${escapeHtml(issue.title)}</strong><small>${escapeHtml(issue.description)}</small></div>`).join('') : '<p class="empty-copy">Открытых проблем нет.</p>'}</div></article></section>
    <section class="detail-section"><div class="detail-section-title"><div><p class="eyebrow">DAILY LOG · AUTO</p><h2>Последние изменения</h2></div><button class="button primary" type="button" data-daily-update>＋ Добавить пояснение</button></div><div class="daily-feed">${dailyLog.length ? dailyLog.slice(0,20).map(entry => `<article><div class="daily-date"><strong>${escapeHtml(entry.workDate)}</strong><span class="daily-status ${entry.status}">${escapeHtml(entry.status.replaceAll('_',' '))}</span></div><div class="daily-main"><span>${escapeHtml(entry.context)}</span><h3>${escapeHtml(entry.title)}</h3><p>${escapeHtml(entry.detail)}</p></div><div class="daily-result">${entry.percent !== null ? `<strong>${entry.percent}%</strong>` : '<strong class="auto-mark">AUTO</strong>'}${entry.quantity !== null ? `<small>${entry.quantity} шт.</small>` : ''}${entry.editableId ? `<button class="text-button" data-edit-daily="${entry.editableId}">Редактировать</button>` : '<small>Из журнала изменений</small>'}</div></article>`).join('') : '<p class="empty-copy">Изменения проекта автоматически появятся здесь.</p>'}</div></section>`;
  container.querySelectorAll('[data-add-location]').forEach(button => button.addEventListener('click', () => openLocationDialog(project)));
  container.querySelectorAll('[data-daily-update]').forEach(button => button.addEventListener('click', () => openDailyDialog(project)));
  container.querySelectorAll('[data-edit-daily]').forEach(button => button.addEventListener('click', () => openDailyDialog(project, project.dailyUpdates.find(value => value.id === button.dataset.editDaily))));
  container.querySelectorAll('[data-open-location]').forEach(button => button.addEventListener('click', () => { location.hash=`project/${encodeURIComponent(project.id)}/location/${encodeURIComponent(button.dataset.openLocation)}`; }));
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '').slice(0, 10);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function projectDailyLogEntries(project) {
  const unitById = new Map();
  for (const locationValue of project.locations || []) {
    for (const unit of locationValue.units || []) unitById.set(unit.id, { unit, locationValue });
  }
  const workTypeById = new Map((project.workTypes || []).map(value => [value.id, value]));
  const manual = (project.dailyUpdates || []).map(update => ({
    occurredAt: update.updatedAt || update.createdAt || `${update.workDate}T12:00:00`, workDate: update.workDate,
    status: update.status, context: `${update.locationName || 'Проект'} · ${update.workTypeName || 'Работы'}`,
    title: update.actionName || 'Ручное обновление', detail: update.comments || 'Пояснение без комментария',
    percent: update.percentComplete, quantity: update.quantityCompleted, editableId: update.id,
  }));
  const automatic = (project.activity || []).filter(event => event.entityType !== 'daily_update').map(event => {
    const value = event.newValue || {};
    let context = 'Проект';
    let title = projectActivityText(event);
    let detail = 'Изменение зафиксировано автоматически';
    let status = 'automatic';
    if (event.entityType === 'unit_progress') {
      const match = unitById.get(value.unitId);
      const workType = workTypeById.get(value.workTypeId);
      const action = workType?.actions?.find(item => item.id === value.actionId);
      context = `${match?.locationValue?.name || 'Локация'} · ${workType?.name || 'Работы'}`;
      title = `${match?.unit?.name || match?.unit?.code || 'Unit'} · ${action?.name || 'Этап'}`;
      status = value.status === 'complete' ? 'complete' : 'automatic';
      detail = value.status === 'complete' ? 'Этап отмечен выполненным' : 'Отметка выполнения отменена';
    } else if (event.entityType === 'issue') {
      status = 'blocked'; detail = value.description || 'Зафиксирована проблема на проекте';
    } else if (event.entityType === 'work_item') {
      status = value.status === 'done' ? 'complete' : value.status === 'blocked' ? 'blocked' : 'automatic';
      detail = value.description || `Статус: ${value.status || event.action}`;
    }
    return { occurredAt: event.createdAt, workDate: localDateKey(event.createdAt), status, context, title, detail, percent: null, quantity: null, editableId: null };
  });
  return [...manual, ...automatic].sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)));
}

function renderLocationDetail() {
  const container=$('#projectDetailView'); const project=projects.find(value=>value.id===selectedProjectId); const locationValue=project?.locations.find(value=>value.id===selectedLocationId);
  if(!container||!project||!locationValue){ if(container) container.innerHTML='<p class="project-loading">Локация загружается…</p>'; return; }
  const workTypes=project.workTypes.filter(value=>value.actions.length); const savedScope=unitScopeByLocation.get(locationValue.id); const firstType=workTypes.find(value=>value.id===savedScope?.workTypeId)||workTypes[0]; const firstAction=firstType?.actions.find(value=>value.id===savedScope?.actionId)||firstType?.actions[0];
  const unitsById=new Map(locationValue.units.map(value=>[value.id,value])); const workTypesById=new Map(project.workTypes.map(value=>[value.id,value]));
  const unitHistory=project.activity.filter(event=>event.entityType==='unit_progress'&&unitsById.has(event.newValue?.unitId)).slice(0,20);
  container.innerHTML=`<header class="detail-header location-header"><div><a href="#project/${encodeURIComponent(project.id)}">← ${escapeHtml(project.name)}</a><p class="eyebrow">${escapeHtml(locationValue.code)} · ${escapeHtml(locationValue.kind)}</p><h1>${escapeHtml(locationValue.name)}</h1><p>${locationValue.suiteTotal !== null ? `${locationValue.suiteTotal} units` : 'Зона проекта'}${locationValue.audioDetails ? ` · ${locationValue.audioDetails.speakerCount||0} speakers · ${locationValue.audioDetails.displayCount||0} displays` : ''}</p></div><div class="detail-actions">${locationValue.kind==='area' ? '<button class="button ghost" data-edit-audio type="button">Audio параметры</button>' : ''}<button class="button primary" data-jobber-report type="button">Сформировать отчет Jobber</button></div></header>
    <section class="unit-toolbar"><div><label>Вид работ<select id="unitWorkType">${workTypes.map(value=>`<option value="${value.id}" ${value.id===firstType?.id?'selected':''}>${escapeHtml(value.name)}</option>`).join('')}</select></label><label>Этап<select id="unitAction">${(firstType?.actions||[]).map(value=>`<option value="${value.id}" ${value.id===firstAction?.id?'selected':''}>${escapeHtml(value.name)}</option>`).join('')}</select></label></div><p>Выберите этап и нажимайте на units, где работа завершена. Повторное нажатие отменяет отметку.</p></section>
    <section class="unit-section"><div class="detail-section-title"><div><p class="eyebrow">UNIT PROGRESS</p><h2>Units на этаже</h2></div><div class="unit-bulk"><b id="unitProgressCount">0 / ${locationValue.units.length}</b><label><input id="toggleAllUnits" type="checkbox"><span>Все</span></label><button class="text-button" type="button" data-add-unit>＋ Unit</button></div></div><div class="unit-grid">${locationValue.units.length ? locationValue.units.map(unit=>`<div class="unit-tile"><button type="button" data-unit-id="${unit.id}"><span>${escapeHtml(unit.code)}</span><strong>${escapeHtml(unit.name)}</strong><small>Не отмечено</small></button><button class="unit-edit" type="button" data-edit-unit="${unit.id}" aria-label="Редактировать ${escapeHtml(unit.name)}">•••</button></div>`).join('') : '<p class="empty-copy">Для этой зоны units не созданы.</p>'}</div></section>
    <section class="detail-section unit-history"><div class="detail-section-title"><div><p class="eyebrow">PROGRESS LOG</p><h2>Последние изменения этажа</h2></div><small>${unitHistory.length} событий</small></div><div class="unit-history-list">${unitHistory.length ? unitHistory.map(event=>{const unit=unitsById.get(event.newValue.unitId);const type=workTypesById.get(event.newValue.workTypeId);const action=type?.actions.find(value=>value.id===event.newValue.actionId);return `<article><time datetime="${escapeHtml(event.createdAt)}">${escapeHtml(new Date(event.createdAt).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}))}</time><div><strong>${escapeHtml(unit?.name||unit?.code||'Unit')}</strong><small>${escapeHtml(type?.name||'Вид работ')} · ${escapeHtml(action?.name||'Этап')}</small></div><span class="history-status ${event.newValue.status==='complete'?'complete':''}">${event.newValue.status==='complete'?'Готово':'Отменено'}</span></article>`;}).join('') : '<p class="empty-copy">Изменения units появятся здесь после первой отметки.</p>'}</div></section>
    ${locationValue.audioDetails ? `<section class="detail-section audio-summary"><p class="eyebrow">AUDIO ZONE PROFILE</p><h2>${escapeHtml(locationValue.audioDetails.zoneType.replace('_',' '))}</h2><div><span>Speakers <b>${locationValue.audioDetails.speakerCount||0}</b></span><span>Displays <b>${locationValue.audioDetails.displayCount||0}</b></span></div><p>${escapeHtml(locationValue.audioDetails.sourceDescription||'')}</p><small>${escapeHtml(locationValue.audioDetails.equipmentNotes||'')}</small></section>`:''}`;
  $('#unitWorkType').addEventListener('change',()=>{const type=workTypes.find(value=>value.id===$('#unitWorkType').value); $('#unitAction').innerHTML=type.actions.map(value=>`<option value="${value.id}">${escapeHtml(value.name)}</option>`).join(''); unitScopeByLocation.set(locationValue.id,{workTypeId:type.id,actionId:type.actions[0]?.id}); refreshUnitGridUI(locationValue);}); $('#unitAction').addEventListener('change',()=>{unitScopeByLocation.set(locationValue.id,{workTypeId:$('#unitWorkType').value,actionId:$('#unitAction').value}); refreshUnitGridUI(locationValue);}); unitScopeByLocation.set(locationValue.id,{workTypeId:firstType?.id,actionId:firstAction?.id}); refreshUnitGridUI(locationValue);
  container.querySelectorAll('[data-unit-id]').forEach(button=>button.addEventListener('click',()=>toggleUnit(project,locationValue,button)));
  container.querySelector('[data-add-unit]').addEventListener('click',()=>openUnitDialog(project,locationValue));
  container.querySelectorAll('[data-edit-unit]').forEach(button=>button.addEventListener('click',()=>openUnitDialog(project,locationValue,locationValue.units.find(value=>value.id===button.dataset.editUnit))));
  $('#toggleAllUnits').addEventListener('change',event=>setAllUnits(project,locationValue,event.currentTarget.checked));
  container.querySelector('[data-jobber-report]').addEventListener('click',()=>openJobberReport(project));
  container.querySelector('[data-edit-audio]')?.addEventListener('click',()=>openAudioZone(project,locationValue));
}

function refreshUnitGridUI(locationValue){const container=$('#projectDetailView'),type=$('#unitWorkType')?.value,action=$('#unitAction')?.value;if(!container||!type||!action)return;let done=0;container.querySelectorAll('[data-unit-id]').forEach(button=>{const unit=locationValue.units.find(value=>value.id===button.dataset.unitId);const progress=unit?.progress.find(value=>value.workTypeId===type&&value.actionId===action);const complete=progress?.status==='complete';if(complete)done++;button.classList.toggle('complete',complete);button.classList.toggle('pending',Boolean(progress?.pending));button.classList.toggle('pending-offline',Boolean(progress?.pendingOffline));const base=complete?`Готово · ${progress.completedOn}`:progress?.status||'Не отмечено';button.querySelector('small').textContent=progress?.pendingOffline?`${base} · офлайн`:base;});$('#unitProgressCount').textContent=`${done} / ${locationValue.units.length}`;const toggle=$('#toggleAllUnits');if(toggle){toggle.checked=locationValue.units.length>0&&done===locationValue.units.length;toggle.indeterminate=done>0&&done<locationValue.units.length;toggle.disabled=locationValue.units.length===0;}}

async function toggleUnit(project,locationValue,button){const type=$('#unitWorkType').value,action=$('#unitAction').value;unitScopeByLocation.set(locationValue.id,{workTypeId:type,actionId:action});const unit=locationValue.units.find(value=>value.id===button.dataset.unitId);const index=unit.progress.findIndex(value=>value.workTypeId===type&&value.actionId===action);const previous=index>=0?{...unit.progress[index]}:null;const targetStatus=previous?.status==='complete'?'not_started':'complete';const completedOn=targetStatus==='complete'?new Date().toISOString().slice(0,10):null;const optimistic={...(previous||{id:`pending-${unit.id}-${type}-${action}`,workTypeId:type,actionId:action,version:null}),status:targetStatus,completedOn,pending:true,pendingOffline:!navigator.onLine};if(index>=0)unit.progress[index]=optimistic;else unit.progress.push(optimistic);refreshUnitGridUI(locationValue);const path=`/api/v1/projects/${encodeURIComponent(project.id)}/locations/${encodeURIComponent(locationValue.id)}/units/${encodeURIComponent(unit.id)}/progress`;queueUnitMutation({projectId:project.id,locationId:locationValue.id,unitId:unit.id,path,payload:{workTypeId:type,actionId:action,status:targetStatus,completedOn,expectedVersion:previous?.version}});button.disabled=navigator.onLine;await flushUnitOutbox();button.disabled=false;const stillQueued=unitOutbox.some(value=>value.path===path&&value.payload.workTypeId===type&&value.payload.actionId===action);if(stillQueued){optimistic.pendingOffline=true;refreshUnitGridUI(locationValue);toast('Изменение сохранено в очереди');}}

async function setAllUnits(project,locationValue,complete){const type=$('#unitWorkType').value,action=$('#unitAction').value;const targetStatus=complete?'complete':'not_started';const completedOn=complete?new Date().toISOString().slice(0,10):null;unitScopeByLocation.set(locationValue.id,{workTypeId:type,actionId:action});let changed=0;locationValue.units.forEach(unit=>{const index=unit.progress.findIndex(value=>value.workTypeId===type&&value.actionId===action);const previous=index>=0?{...unit.progress[index]}:null;if(previous?.status===targetStatus)return;const optimistic={...(previous||{id:`pending-${unit.id}-${type}-${action}`,workTypeId:type,actionId:action,version:null}),status:targetStatus,completedOn,pending:true,pendingOffline:!navigator.onLine};if(index>=0)unit.progress[index]=optimistic;else unit.progress.push(optimistic);const path=`/api/v1/projects/${encodeURIComponent(project.id)}/locations/${encodeURIComponent(locationValue.id)}/units/${encodeURIComponent(unit.id)}/progress`;queueUnitMutation({projectId:project.id,locationId:locationValue.id,unitId:unit.id,path,payload:{workTypeId:type,actionId:action,status:targetStatus,completedOn,expectedVersion:previous?.version}});changed++;});refreshUnitGridUI(locationValue);if(!changed)return;const toggle=$('#toggleAllUnits');if(toggle)toggle.disabled=true;await flushUnitOutbox();if(unitOutbox.some(value=>value.projectId===project.id&&value.locationId===locationValue.id&&value.payload.workTypeId===type&&value.payload.actionId===action))toast('Изменения сохранены в очереди');}

function openUnitDialog(project,locationValue,unit=null){$('#unitForm').reset();$('#unitProjectId').value=project.id;$('#unitLocationId').value=locationValue.id;$('#unitId').value=unit?.id||'';$('#unitVersion').value=unit?.version||'';$('#unitDialogTitle').textContent=unit?'Редактировать unit':'Добавить unit';$('#unitCode').value=unit?.code||'';$('#unitName').value=unit?.name||'';$('#unitNotes').value=unit?.notes||'';renderDynamicFields('unit','unitCustomFields',unit?.customFields||{});$('#unitDialog').showModal();requestAnimationFrame(()=>$('#unitCode').focus());}

async function submitUnit(event){event.preventDefault();if(!event.currentTarget.reportValidity())return;const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;const projectId=$('#unitProjectId').value,locationId=$('#unitLocationId').value,unitId=$('#unitId').value;const payload={code:$('#unitCode').value.trim(),name:$('#unitName').value.trim(),notes:$('#unitNotes').value.trim(),customFields:collectDynamicFields('unitCustomFields')};try{if(unitId){payload.expectedVersion=Number($('#unitVersion').value);await apiPatch(`/api/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(locationId)}/units/${encodeURIComponent(unitId)}`,payload);}else await apiPost(`/api/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(locationId)}/units`,payload);$('#unitDialog').close();await hydrateProjects();toast(unitId?'Unit обновлен':'Unit добавлен');}catch(error){toast(error.code==='version_conflict'?'Unit уже изменен другим пользователем':error.message);}finally{button.disabled=false;}}

function openAudioZone(project,locationValue){editingAudioLocation={project,location:locationValue}; const audio=locationValue.audioDetails||{}; $('#audioZoneType').value=audio.zoneType||'common_area'; $('#audioSpeakerCount').value=audio.speakerCount??''; $('#audioDisplayCount').value=audio.displayCount??''; $('#audioSourceDescription').value=audio.sourceDescription||''; $('#audioEquipmentNotes').value=audio.equipmentNotes||''; $('#audioZoneDialog').showModal();}

async function openJobberReport(project){const date=new Date().toISOString().slice(0,10); const response=await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/daily-report?date=${date}`,{headers:{'X-Organization-ID':ORGANIZATION_ID}}); const report=await response.json(); $('#jobberReportDate').value=date; $('#jobberReportText').value=report.text; $('#jobberReportDialog').showModal();}

function openLocationDialog(project) {
  $('#locationForm').reset(); $('#locationProjectId').value = project.id;
  $('#locationBuilding').innerHTML = '<option value="">Без здания</option>' + project.buildings.map(value => `<option value="${value.id}">${escapeHtml(value.code)} · ${escapeHtml(value.name)}</option>`).join('');
  $('#locationParent').innerHTML = '<option value="">Корневой объект</option>' + project.locations.map(value => `<option value="${value.id}">${'— '.repeat(value.depth||0)}${escapeHtml(value.code)} · ${escapeHtml(value.name)}</option>`).join('');
  renderDynamicFields('location','locationCustomFields');
  $('#locationDialog').showModal();
}

function populateDailyActions(project) {
  const workType = project.workTypes.find(value => value.id === $('#dailyWorkType').value);
  $('#dailyAction').innerHTML = (workType?.actions || []).map(value => `<option value="${value.id}">${escapeHtml(value.name)}</option>`).join('');
}

function openDailyDialog(project, update = null) {
  $('#dailyUpdateForm').reset(); $('#dailyProjectId').value = project.id; $('#dailyEntryId').value = update?.id || ''; $('#dailyEntryVersion').value = update?.version || '';
  $('#dailyDialogTitle').textContent = update ? 'Редактировать обновление' : 'Что сделано сегодня?';
  $('#dailyDate').value = update?.workDate || new Date().toISOString().slice(0,10);
  $('#dailyLocation').innerHTML = project.locations.map(value => `<option value="${value.id}">${escapeHtml(value.code)} · ${escapeHtml(value.name)}</option>`).join('');
  $('#dailyWorkType').innerHTML = project.workTypes.filter(value => value.actions.length).map(value => `<option value="${value.id}">${escapeHtml(value.name)}</option>`).join('');
  if (update) { $('#dailyLocation').value=update.locationId; $('#dailyWorkType').value=update.workTypeId; }
  populateDailyActions(project);
  if (update) { $('#dailyAction').value=update.actionId; $('#dailyStatus').value=update.status; $('#dailyPercent').value=update.percentComplete; $('#dailyQuantity').value=update.quantityCompleted ?? ''; $('#dailyComments').value=update.comments; }
  $('#dailyHasIssue').checked=false; $('#dailyIssueFields').classList.add('hidden'); $('#dailyUpdateDialog').showModal();
}

function projectActivityText(event) {
  const value = event.newValue || {};
  if (event.action === 'created' && event.entityType === 'project') return `Создан проект ${value.code || ''} · ${value.name || ''}`;
  if (event.action === 'created' && event.entityType === 'building') return `Добавлено здание ${value.code || ''} · ${value.name || ''}`;
  if (event.action === 'created' && event.entityType === 'work_item') return `Создана задача: ${value.title || ''}`;
  if (event.action === 'dependency_added') return 'Добавлена зависимость задачи';
  if (event.action === 'updated' && event.entityType === 'work_item') return `Задача обновлена · ${value.status || ''}`;
  if (event.entityType === 'location' && event.action === 'created') return `Добавлена локация ${value.code || ''} · ${value.name || ''}`;
  if (event.entityType === 'daily_update') return `Дневной отчет · ${value.status || ''} · ${value.percentComplete ?? 0}%`;
  if (event.entityType === 'issue' && event.action === 'created') return `Зафиксирована проблема · ${value.severity || ''}`;
  if (event.entityType === 'unit_progress') return `Обновлен прогресс unit · ${value.status || ''}`;
  if (event.entityType === 'unit') return `${event.action === 'created' ? 'Добавлен' : 'Обновлен'} unit ${value.code || ''} · ${value.name || ''}`;
  return `${event.entityType} · ${event.action}`;
}

async function updateWorkItemStatus(event) {
  const select = event.currentTarget;
  select.disabled = true;
  try {
    await apiPatch(`/api/v1/projects/${encodeURIComponent(select.dataset.projectId)}/work-items/${encodeURIComponent(select.dataset.workItemStatus)}`, {
      expectedVersion: Number(select.dataset.version), status: select.value
    });
    await hydrateProjects();
    toast('Статус обновлен');
  } catch (error) {
    await hydrateProjects();
    toast(error.code === 'version_conflict' ? 'Данные уже изменены другим пользователем' : error.message);
  }
}

function openBuildingDialog(projectId) {
  $('#buildingForm').reset();
  $('#buildingProjectId').value = projectId;
  $('#buildingDialog').showModal();
  requestAnimationFrame(() => $('#buildingCode').focus());
}

function openWorkItemDialog(projectId) {
  const project = projects.find(item => item.id === projectId);
  if (!project) return;
  $('#workItemForm').reset();
  $('#workItemProjectId').value = projectId;
  $('#workItemBuilding').innerHTML = '<option value="">Без привязки</option>' + project.buildings.map(building => `<option value="${building.id}">${escapeHtml(building.code)} · ${escapeHtml(building.name)}</option>`).join('');
  $('#workItemStage').innerHTML = '<option value="">Без этапа</option>' + project.stages.map(stage => `<option value="${stage.id}">${escapeHtml(stage.name)}</option>`).join('');
  $('#workItemType').innerHTML = project.workTypeProgress.map(workType => `<option value="${workType.id}">${escapeHtml(workType.name)}</option>`).join('');
  $('#workItemDependency').innerHTML = '<option value="">Нет зависимости</option>' + project.workItems.map(item => `<option value="${item.id}">${escapeHtml(item.title)}</option>`).join('');
  $('#workItemDialog').showModal();
  requestAnimationFrame(() => $('#workItemTitle').focus());
}

async function submitProject(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    await apiPost('/api/v1/projects', {
      code: $('#projectCode').value.trim(), name: $('#projectName').value.trim(),
      description: $('#projectDescription').value.trim(), priority: $('#projectPriority').value,
      startDate: $('#projectStartDate').value || null, targetDate: $('#projectTargetDate').value || null
    });
    $('#projectDialog').close();
    await hydrateProjects();
    toast('Проект создан');
  } catch (error) { toast(error.message); }
  finally { submitButton.disabled = false; }
}

async function submitBuilding(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  submitButton.disabled = true;
  const projectId = $('#buildingProjectId').value;
  try {
    await apiPost(`/api/v1/projects/${encodeURIComponent(projectId)}/buildings`, {
      code: $('#buildingCode').value.trim(), name: $('#buildingName').value.trim(),
      address: $('#buildingAddress').value.trim(), status: $('#buildingStatus').value
    });
    $('#buildingDialog').close();
    await hydrateProjects();
    toast('Здание добавлено');
  } catch (error) { toast(error.message); }
  finally { submitButton.disabled = false; }
}

async function submitWorkItem(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  submitButton.disabled = true;
  const projectId = $('#workItemProjectId').value;
  const hours = $('#workItemEstimate').value;
  try {
    await apiPost(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items`, {
      title: $('#workItemTitle').value.trim(), description: $('#workItemDescription').value.trim(),
      buildingId: $('#workItemBuilding').value || null, stageId: $('#workItemStage').value || null, workTypeId: $('#workItemType').value,
      status: $('#workItemStatus').value, priority: $('#workItemPriority').value,
      dueDate: $('#workItemDueDate').value || null,
      estimatedMinutes: hours === '' ? null : Math.round(Number(hours) * 60),
      dependsOnIds: $('#workItemDependency').value ? [$('#workItemDependency').value] : []
    });
    $('#workItemDialog').close();
    await hydrateProjects();
    toast('Полевая задача создана');
  } catch (error) { toast(error.message); }
  finally { submitButton.disabled = false; }
}

async function submitLocation(event) {
  event.preventDefault(); if (!event.currentTarget.reportValidity()) return;
  const button=event.currentTarget.querySelector('[type="submit"]'); button.disabled=true;
  try {
    const result=await apiPost(`/api/v1/projects/${encodeURIComponent($('#locationProjectId').value)}/locations`, {
      code:$('#locationCode').value.trim(), name:$('#locationName').value.trim(), kind:$('#locationKind').value,
      buildingId:$('#locationBuilding').value || null, parentLocationId:$('#locationParent').value || null,
      suiteTotal:$('#locationSuiteTotal').value === '' ? null : Number($('#locationSuiteTotal').value), customFields:collectDynamicFields('locationCustomFields')
    });
    const isArea=$('#locationKind').value==='area'; $('#locationDialog').close(); await hydrateProjects(); toast('Локация добавлена');
    if(isArea){const project=projects.find(value=>value.id===$('#locationProjectId').value); const locationValue=project?.locations.find(value=>value.id===result.location.id); if(project&&locationValue) openAudioZone(project,locationValue);}
  } catch(error) { toast(error.message); } finally { button.disabled=false; }
}

async function submitAudioZone(event){event.preventDefault(); if(!editingAudioLocation)return; const button=event.currentTarget.querySelector('[type="submit"]'); button.disabled=true; const {project,location:locationValue}=editingAudioLocation; try{await apiPatch(`/api/v1/projects/${encodeURIComponent(project.id)}/locations/${encodeURIComponent(locationValue.id)}`,{expectedVersion:locationValue.version,code:locationValue.code,name:locationValue.name,kind:locationValue.kind,buildingId:locationValue.buildingId,suiteTotal:locationValue.suiteTotal,audioDetails:{zoneType:$('#audioZoneType').value,speakerCount:$('#audioSpeakerCount').value===''?null:Number($('#audioSpeakerCount').value),displayCount:$('#audioDisplayCount').value===''?null:Number($('#audioDisplayCount').value),sourceDescription:$('#audioSourceDescription').value.trim(),equipmentNotes:$('#audioEquipmentNotes').value.trim()}}); $('#audioZoneDialog').close(); await hydrateProjects(); toast('Аудио зона обновлена');}catch(error){toast(error.message);}finally{button.disabled=false;}}

async function submitDailyUpdate(event) {
  event.preventDefault(); if (!event.currentTarget.reportValidity()) return;
  const button=event.currentTarget.querySelector('[type="submit"]'); button.disabled=true;
  const entryId=$('#dailyEntryId').value;
  const payload={
    locationId:$('#dailyLocation').value, workTypeId:$('#dailyWorkType').value, actionId:$('#dailyAction').value,
    workDate:$('#dailyDate').value, status:$('#dailyStatus').value, percentComplete:Number($('#dailyPercent').value),
    quantityCompleted:$('#dailyQuantity').value === '' ? null : Number($('#dailyQuantity').value), comments:$('#dailyComments').value.trim(),
    issueDescription:$('#dailyHasIssue').checked ? $('#dailyIssueDescription').value.trim() : '', issueSeverity:$('#dailyIssueSeverity').value
  };
  if (entryId) payload.expectedVersion=Number($('#dailyEntryVersion').value);
  try {
    const path=`/api/v1/projects/${encodeURIComponent($('#dailyProjectId').value)}/daily-updates${entryId ? `/${encodeURIComponent(entryId)}` : ''}`;
    if (entryId) await apiPatch(path,payload); else await apiPost(path,payload);
    $('#dailyUpdateDialog').close(); await hydrateProjects(); toast(entryId ? 'Обновление изменено' : 'Отчет сохранен');
  } catch(error) { toast(error.code === 'version_conflict' ? 'Отчет уже изменен другим пользователем' : error.message); } finally { button.disabled=false; }
}

function renderMetrics() {
  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.status === 'done').length;
  const active = state.tasks.filter(t => ['progress','review','testing'].includes(t.status)).length;
  const blocked = state.tasks.filter(t => t.status === 'blocked').length;
  const completion = total ? Math.round(done / total * 100) : 0;
  $('#metricTotal').textContent = total;
  $('#metricActive').textContent = active;
  $('#metricDone').textContent = done;
  $('#metricBlocked').textContent = blocked;
  $('#metricDoneNote').textContent = `${completion}% delivery`;
  $('#metricBlockedNote').textContent = blocked ? 'требуют внимания' : 'поток свободен';
  const health = Math.max(20, Math.min(98, 55 + completion - blocked * 7 + active * 2));
  $('#healthScore').textContent = health;
  $('#healthCaption').textContent = blocked > 2 ? 'Есть критичные блокировки' : completion > 60 ? 'Уверенное движение' : 'Система формируется';
}

function renderRoadmap() {
  $('#roadmap').innerHTML = AREAS.map((area, index) => {
    const tasks = state.tasks.filter(t => t.area === area.id);
    const complete = tasks.filter(t => t.status === 'done').length;
    const progress = tasks.length ? Math.round(complete / tasks.length * 100) : 0;
    const active = tasks.filter(t => ['progress','review','testing'].includes(t.status)).length;
    return `<article class="roadmap-item" style="--area:${area.color}">
      <div class="phase-number">0${index}</div>
      <div class="roadmap-copy"><span>PHASE 0${index}</span><strong>${area.label}</strong><small>${tasks.length} задач · ${active} в работе</small></div>
      <div class="progress"><i style="width:${progress}%"></i></div><b>${progress}%</b>
    </article>`;
  }).join('');
}

function renderBoard() {
  const tasks = filteredTasks();
  const statusFilter = $('#statusFilter').value;
  const visibleStatuses = statusFilter === 'all' ? STATUSES : STATUSES.filter(status => status.id === statusFilter);
  $('#board').classList.toggle('single-column', visibleStatuses.length === 1);
  $('#board').innerHTML = visibleStatuses.map(status => {
    const cards = tasks.filter(t => t.status === status.id);
    return `<section class="column" data-status="${status.id}">
      <header><span class="status-dot ${status.tone}"></span><strong>${status.label}</strong><b>${cards.length}</b></header>
      <div class="card-list" data-dropzone="${status.id}">
        ${cards.map(taskCard).join('') || '<div class="empty-state">Перетащите задачу сюда</div>'}
      </div>
      <button class="add-inline" type="button" data-add-status="${status.id}">＋ Добавить</button>
    </section>`;
  }).join('');
  bindBoardEvents();
}

function taskCard(task) {
  const area = AREAS.find(a => a.id === task.area);
  return `<article class="task-card" draggable="true" data-id="${task.id}" tabindex="0" aria-label="${escapeHtml(task.title)}">
    <div class="card-top"><span class="type">${task.type}</span><span class="priority ${task.priority}">${task.priority}</span></div>
    <h3>${escapeHtml(task.title)}</h3>
    <p>${escapeHtml(task.description || 'Описание пока не добавлено')}</p>
    ${task.risk ? `<div class="risk">⚠ ${escapeHtml(task.risk)}</div>` : ''}
    ${task.dependsOn?.length ? `<div class="dependency-note">↳ ${task.dependsOn.length} зависимост${task.dependsOn.length === 1 ? 'ь' : 'и'}</div>` : ''}
    <footer><span class="area-tag" style="--tag:${area?.color || '#888'}">${area?.short || '—'}</span><code>${task.id}</code></footer>
  </article>`;
}

function bindBoardEvents() {
  document.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', () => openDialog(card.dataset.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') openDialog(card.dataset.id); });
    card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', card.dataset.id); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  document.querySelectorAll('.card-list').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/plain');
      const task = state.tasks.find(t => t.id === id);
      if (task && task.status !== zone.dataset.dropzone) {
        const from = STATUSES.find(s => s.id === task.status)?.label;
        task.status = zone.dataset.dropzone;
        persist(`${id}: ${from} → ${STATUSES.find(s => s.id === task.status)?.label}`, { taskId: id });
        render();
      }
    });
  });
  document.querySelectorAll('[data-add-status]').forEach(button => button.addEventListener('click', () => openDialog(null, button.dataset.addStatus)));
}

function renderAudit() {
  $('#auditList').innerHTML = state.audit.slice(0, 7).map(event => {
    const date = new Date(event.at);
    return `<li><i></i><div><strong>${escapeHtml(event.text)}</strong><span>${date.toLocaleDateString('ru-RU')} · ${date.toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}</span></div></li>`;
  }).join('') || '<li class="no-events">Событий пока нет</li>';
}

function openDialog(id, preferredStatus = 'backlog') {
  const task = id ? state.tasks.find(item => item.id === id) : null;
  $('#dialogTitle').textContent = task ? task.id : 'Новая задача';
  $('#taskId').value = task?.id || '';
  $('#taskTitle').value = task?.title || '';
  $('#taskDescription').value = task?.description || '';
  $('#taskType').value = task?.type || 'Task';
  $('#taskStatus').value = task?.status || preferredStatus;
  $('#taskPriority').value = task?.priority || 'medium';
  $('#taskArea').value = task?.area || 'foundation';
  $('#taskRisk').value = task?.risk || '';
  const planningMeta = $('#taskPlanningMeta');
  const hasPlanningMeta = task && (task.priorityReason || task.dependsOn?.length || task.unblocks?.length);
  planningMeta.classList.toggle('hidden', !hasPlanningMeta);
  planningMeta.innerHTML = hasPlanningMeta ? `
    <p class="eyebrow">AI PLANNING CONTEXT</p>
    ${task.priorityReason ? `<div><span>Причина приоритета</span><strong>${escapeHtml(task.priorityReason)}</strong></div>` : ''}
    ${task.dependsOn?.length ? `<div><span>Зависит от</span><strong>${escapeHtml(task.dependsOn.join(', '))}</strong></div>` : ''}
    ${task.unblocks?.length ? `<div><span>Разблокирует</span><strong>${escapeHtml(task.unblocks.join(', '))}</strong></div>` : ''}
  ` : '';
  $('#deleteTaskButton').classList.toggle('hidden', !task);
  $('#taskDialog').showModal();
  requestAnimationFrame(() => $('#taskTitle').focus());
}

function saveTask(event) {
  event.preventDefault();
  if (!$('#taskForm').reportValidity()) return;
  const id = $('#taskId').value;
  const values = {
    title: $('#taskTitle').value.trim(), description: $('#taskDescription').value.trim(),
    type: $('#taskType').value, status: $('#taskStatus').value, priority: $('#taskPriority').value,
    area: $('#taskArea').value, risk: $('#taskRisk').value.trim()
  };
  let savedId = id;
  if (id) Object.assign(state.tasks.find(t => t.id === id), values);
  else {
    const sequence = Math.max(0, ...state.tasks.map(t => Number(t.id.replace(/\D/g,'')) || 0)) + 1;
    savedId = `FS-${String(sequence).padStart(3,'0')}`;
    state.tasks.push({ id: savedId, ...values });
  }
  persist(id ? `${id}: задача обновлена` : `${values.title}: задача создана`, { taskId: savedId });
  $('#taskDialog').close();
  render();
  toast(id ? 'Задача обновлена' : 'Задача создана');
}

function deleteTask() {
  const id = $('#taskId').value;
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  persist(`${id}: задача удалена`, { deletedTaskId: id });
  $('#taskDialog').close();
  render();
  toast('Задача удалена');
}

function exportState() {
  const blob = new Blob([JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `fieldos-workspace-${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  persist('Workspace экспортирован');
  renderAudit();
}

async function importState(file) {
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.tasks)) throw new Error('invalid');
    state.tasks = imported.tasks;
    state.audit = Array.isArray(imported.audit) ? imported.audit : [];
    persist('Workspace импортирован', { fullReplace: true });
    render();
    toast('Импорт завершен');
  } catch { toast('Не удалось прочитать файл'); }
  $('#importInput').value = '';
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  setTimeout(() => $('#toast').classList.remove('visible'), 1800);
}

async function setup() {
  $('#taskStatus').innerHTML = STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
  $('#statusFilter').innerHTML += STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
  $('#taskArea').innerHTML = AREAS.map(a => `<option value="${a.id}">${a.label}</option>`).join('');
  $('#areaFilter').innerHTML += AREAS.map(a => `<option value="${a.id}">${a.label}</option>`).join('');
  $('#workItemStatus').innerHTML = STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
  $('#addTaskButton').addEventListener('click', () => openDialog());
  $('#requestContinueButton').addEventListener('click',requestDevelopmentContinuation);
  $('#taskForm').addEventListener('submit', saveTask);
  $('#deleteTaskButton').addEventListener('click', deleteTask);
  $('#exportButton').addEventListener('click', exportState);
  $('#importInput').addEventListener('change', e => e.target.files[0] && importState(e.target.files[0]));
  $('#clearAuditButton').addEventListener('click', () => { state.audit = []; persist('', { auditDirty: true }); renderAudit(); });
  $('#newProjectButton').addEventListener('click', () => { $('#projectForm').reset(); $('#projectDialog').showModal(); requestAnimationFrame(() => $('#projectCode').focus()); });
  $('#projectForm').addEventListener('submit', submitProject);
  $('#buildingForm').addEventListener('submit', submitBuilding);
  $('#workItemForm').addEventListener('submit', submitWorkItem);
  $('#locationForm').addEventListener('submit', submitLocation);
  $('#unitForm').addEventListener('submit', submitUnit);
  $('#workTypeForm').addEventListener('submit', submitWorkType);
  $('#gitSyncForm').addEventListener('submit', submitGitSyncSettings);
  $('#platformSettingsForm').addEventListener('submit', submitPlatformSettings);
  $('#addWorkTypeButton').addEventListener('click',()=>openWorkTypeDialog());
  $('#customFieldForm').addEventListener('submit',submitCustomField);
  $('#addCustomFieldButton').addEventListener('click',()=>openCustomFieldDialog());
  $('#dailyUpdateForm').addEventListener('submit', submitDailyUpdate);
  $('#audioZoneForm').addEventListener('submit', submitAudioZone);
  $('#dailyWorkType').addEventListener('change', () => { const project=projects.find(value=>value.id===$('#dailyProjectId').value); if(project) populateDailyActions(project); });
  $('#dailyStatus').addEventListener('change', () => { if($('#dailyStatus').value==='complete') $('#dailyPercent').value=100; if($('#dailyStatus').value==='not_started') $('#dailyPercent').value=0; });
  $('#dailyHasIssue').addEventListener('change', () => $('#dailyIssueFields').classList.toggle('hidden', !$('#dailyHasIssue').checked));
  $('#copyJobberReport').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#jobberReportText').value); toast('Отчет скопирован'); } catch { $('#jobberReportText').select(); document.execCommand('copy'); toast('Отчет скопирован'); } });
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
  ['searchInput','priorityFilter','areaFilter','statusFilter'].forEach(id => $(`#${id}`).addEventListener('input', renderBoard));
  ['logSourceFilter','logProjectFilter','logEntityFilter','logSearchInput'].forEach(id => $(`#${id}`).addEventListener('input', hydrateLogs));
  $('#refreshLogsButton').addEventListener('click', hydrateLogs);
  window.addEventListener('online', () => { syncToServer(); flushUnitOutbox(); });
  window.addEventListener('offline', () => setSyncState('offline'));
  window.addEventListener('hashchange', renderRoute);
  renderRoute();
  render();
  await Promise.all([hydrateFromServer(), hydrateProjects(),hydrateCustomFieldDefinitions(),hydratePlatformSettings(),hydrateGitSyncSettings(),hydrateAgentStatus()]);
  await flushUnitOutbox();
  setInterval(()=>{if(document.body.dataset.route==='admin')hydrateComputeNodes();},5000);
  setInterval(hydrateAgentStatus,5000);
}

setup();
