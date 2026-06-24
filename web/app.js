import { STATUSES, AREAS, INITIAL_TASKS } from './data.js';
import { t, getLang, setLang, applyI18n } from './i18n.js';

const STORAGE_KEY = 'rackpilot.workspace.v1';
const LEGACY_STORAGE_KEYS = ['fieldos.workspace.v1'];
const UNIT_OUTBOX_KEY = 'rackpilot.unit-outbox.v1';
const LEGACY_UNIT_OUTBOX_KEYS = ['fieldos.unit-outbox.v1'];
const WRITE_OUTBOX_KEY = 'rackpilot.write-outbox.v1';
const PROJECTS_CACHE_KEY = 'rackpilot.projects-cache.v1';
const SYNC_CURSOR_KEY = 'rackpilot.sync-cursor.v1';
const CONFLICT_QUEUE_KEY = 'rackpilot.conflicts.v1';
const ROLE_KEY = 'rackpilot.role-preview.v1';
const ORGANIZATION_ID = 'local-dev';
const state = loadState();
const $ = selector => document.querySelector(selector);
const ROLE_POLICIES = {
  Technician: { label: 'Technician', routes: ['overview', 'projects'], permissions: ['projectRead', 'fieldProgress'] },
  Supervisor: { label: 'Supervisor', routes: ['overview', 'projects', 'logs'], permissions: ['projectRead', 'fieldProgress', 'projectManage', 'logsRead'] },
  ProjectManager: { label: 'Project Manager', routes: ['overview', 'projects', 'logs'], permissions: ['projectRead', 'fieldProgress', 'projectManage', 'logsRead', 'developmentWorkspace'] },
  Administrator: { label: 'Administrator', routes: ['overview', 'projects', 'logs', 'api', 'admin'], permissions: ['projectRead', 'fieldProgress', 'projectManage', 'logsRead', 'apiMonitor', 'adminPanel', 'developmentWorkspace'] },
};
let syncTimer;
let syncInFlight = false;
let localChangeVersion = 0;
let _taskDataVersion = 0; // bumped on every tasks mutation — invalidates filteredTasks cache
let _fcKey = null, _fcBase = null; // filteredTasks memo
let _workspaceETag = null; // ETag from last workspace GET — enables 304 Not Modified

// ── Write Outbox (generalised offline queue) ──────────────────────────────
// Each entry: {id, method, url, headers, body, type, label, queuedAt, retries}
let _writeOutbox = _loadWriteOutbox();
let _writeOutboxFlushing = false;

function _loadWriteOutbox() {
  try { return JSON.parse(localStorage.getItem(WRITE_OUTBOX_KEY) || '[]'); } catch { return []; }
}
function _saveWriteOutbox() {
  localStorage.setItem(WRITE_OUTBOX_KEY, JSON.stringify(_writeOutbox));
  _updateOfflineBanner();
}
function _enqueueWrite(method, url, headers, body, type, label) {
  _writeOutbox.push({ id: crypto.randomUUID(), method, url, headers, body, type, label,
    queuedAt: new Date().toISOString(), retries: 0 });
  _saveWriteOutbox();
}
async function _flushWriteOutbox() {
  if (_writeOutboxFlushing || !navigator.onLine || !_writeOutbox.length) return;
  _writeOutboxFlushing = true;
  let flushed = 0;
  while (_writeOutbox.length && navigator.onLine) {
    const entry = _writeOutbox[0];
    try {
      const resp = await fetch(entry.url, {
        method: entry.method,
        headers: { ...entry.headers, ...apiHeaders() },
        body: entry.body ?? undefined,
      });
      if (resp.ok) {
        _writeOutbox.shift();
        flushed++;
      } else if (resp.status === 409) {
        let serverPayload = null;
        try { serverPayload = await resp.json(); } catch { /* ignore */ }
        _addConflict(_writeOutbox.shift(), serverPayload);
        flushed++;
      } else {
        entry.retries = (entry.retries || 0) + 1;
        if (entry.retries >= 5) { _writeOutbox.shift(); flushed++; toast(`Не удалось синхронизировать: ${entry.label}`); }
        break;
      }
    } catch { break; }
  }
  _saveWriteOutbox();
  _writeOutboxFlushing = false;
  if (flushed > 0) {
    await Promise.all([hydrateFromServer(), hydrateProjects()]);
  }
}

// Wrap critical API calls for offline queueing.
// Returns true if the request was queued (caller should show offline feedback).
async function apiFetchOrQueue(url, opts, label) {
  if (navigator.onLine) return null; // let caller do normal apiFetch
  const body = opts?.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
  const headers = { 'Content-Type': 'application/json', ...(opts?.headers || {}) };
  _enqueueWrite(opts?.method || 'POST', url, headers, body, 'mutation', label || url);
  return 'queued';
}

function _updateOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  const countEl = document.getElementById('offlinePendingCount');
  if (!banner) return;
  const isOffline = !navigator.onLine;
  const unitLen = typeof unitOutbox !== 'undefined' ? (unitOutbox?.length || 0) : 0;
  const total = _writeOutbox.length + unitLen;
  banner.style.display = isOffline ? 'flex' : 'none';
  const cursor = _loadSyncCursor();
  const elapsed = cursor ? _elapsed(cursor) : null;
  if (countEl) {
    const parts = [];
    if (total > 0) parts.push(`${total} в очереди`);
    if (elapsed) parts.push(`данные ${elapsed}`);
    countEl.textContent = parts.join(' · ');
  }
  document.body.style.paddingTop = isOffline ? '41px' : '';
  // Metrics card
  const card = document.getElementById('syncMetricCard');
  const metric = document.getElementById('metricPending');
  if (card) card.style.display = total > 0 || isOffline ? '' : 'none';
  if (metric) metric.textContent = total;
}

// ── Conflict queue ────────────────────────────────────────────────────────
let _conflictQueue = _loadConflictQueue();

function _loadConflictQueue() {
  try { return JSON.parse(localStorage.getItem(CONFLICT_QUEUE_KEY) || '[]'); } catch { return []; }
}
function _saveConflictQueue() {
  localStorage.setItem(CONFLICT_QUEUE_KEY, JSON.stringify(_conflictQueue));
}
function _addConflict(entry, serverPayload) {
  _conflictQueue.push({
    id: crypto.randomUUID(),
    entry,          // original queued write
    serverPayload,  // server response body
    detectedAt: new Date().toISOString(),
    resolution: null,  // 'retry'|'discard'|'server'
  });
  _saveConflictQueue();
  _updateConflictBadge();
}
function _resolveConflict(conflictId, resolution) {
  const idx = _conflictQueue.findIndex(c => c.id === conflictId);
  if (idx < 0) return;
  const conflict = _conflictQueue[idx];
  if (resolution === 'retry') {
    // Re-enqueue the original write with an updated version
    const entry = { ...conflict.entry, retries: 0, id: crypto.randomUUID() };
    _writeOutbox.push(entry);
    _saveWriteOutbox();
  }
  _conflictQueue.splice(idx, 1);
  _saveConflictQueue();
  _updateConflictBadge();
  if (resolution === 'retry') _flushWriteOutbox();
}
function _updateConflictBadge() {
  const badge = document.getElementById('conflictBadge');
  const count = _conflictQueue.length;
  if (badge) { badge.textContent = count > 0 ? String(count) : ''; badge.style.display = count > 0 ? '' : 'none'; }
}

// ── Sync cursor & projects cache ─────────────────────────────────────────
function _saveSyncCursor() {
  localStorage.setItem(SYNC_CURSOR_KEY, new Date().toISOString());
}
function _loadSyncCursor() {
  return localStorage.getItem(SYNC_CURSOR_KEY);
}
function _saveProjectsCache(data) {
  try { localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify({ ts: new Date().toISOString(), data })); }
  catch { /* quota exceeded — skip */ }
}
function _loadProjectsCache() {
  try { const raw = localStorage.getItem(PROJECTS_CACHE_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function _elapsed(isoTs) {
  if (!isoTs) return null;
  const sec = Math.floor((Date.now() - new Date(isoTs).getTime()) / 1000);
  if (sec < 60) return 'только что';
  if (sec < 3600) return `${Math.floor(sec/60)} мин. назад`;
  if (sec < 86400) return `${Math.floor(sec/3600)} ч. назад`;
  return `${Math.floor(sec/86400)} дн. назад`;
}

function _onNetworkOnline() {
  _updateOfflineBanner();
  setSyncState('saving');
  Promise.all([_flushWriteOutbox(), flushUnitOutbox()]).then(() => {
    syncToServer();
    hydrateProjects().then(() => _saveSyncCursor());
  });
}
function _onNetworkOffline() {
  setSyncState('offline');
  _updateOfflineBanner();
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
let currentRole = loadRole();
let projects = [];
let computeNodes = [];
let gitSyncSettings = null;
let platformSettings = null;
let logs = [];
let apiMetrics = null;
let workflowConfiguration = [];
let customFieldDefinitions = [];
let selectedProjectId = null;
let selectedLocationId = null;
let editingAudioLocation = null;
let taskViewMode = 'kanban';
const unitScopeByLocation = new Map();
let unitOutbox = loadUnitOutbox();
let unitOutboxSyncing = false;
const WORK_ITEM_TRANSITIONS = {
  ideas:['backlog','ready'], backlog:['ideas','ready'], ready:['backlog','progress'],
  progress:['blocked','review'], blocked:['backlog','progress'], review:['progress','testing'],
  testing:['progress','done'], done:['progress']
};

function loadState() {
  for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      if (parsed?.version === 1 && Array.isArray(parsed.tasks)) {
        if (key !== STORAGE_KEY) localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        return { revision: 0, pendingSync: false, audit: [], dirtyTaskIds: [], deletedTaskIds: [], auditDirty: false, fullReplace: false, ...parsed };
      }
    } catch {
      /* recover from invalid local state */
    }
  }
  return { version: 1, revision: 0, pendingSync: false, tasks: structuredClone(INITIAL_TASKS), audit: [{ at: new Date().toISOString(), text: 'Workspace инициализирован' }], dirtyTaskIds: [], deletedTaskIds: [], auditDirty: false, fullReplace: false };
}

function loadRole() {
  const saved = localStorage.getItem(ROLE_KEY);
  return ROLE_POLICIES[saved] ? saved : 'Administrator';
}

function rolePolicy() { return ROLE_POLICIES[currentRole] || ROLE_POLICIES.Administrator; }
function roleCan(permission) { return rolePolicy().permissions.includes(permission); }
function routeAllowed(route) { return rolePolicy().routes.includes(route); }

function applyRolePolicy() {
  document.body.dataset.role = currentRole;
  const session = getSession();
  // Show/hide dev-mode badge
  const devBadge = document.getElementById('devModeBadge');
  if (devBadge) devBadge.style.display = session?.token ? 'none' : 'flex';
  // Sync role switcher
  const switcher = $('#roleSwitcher');
  if (switcher) {
    switcher.value = currentRole;
    switcher.style.opacity = session?.token ? '0.5' : '1';
    switcher.title = session?.token ? 'Роль определяется сессией' : 'Dev-mode: выберите роль';
  }
  document.querySelectorAll('[data-route-link]').forEach(link => {
    const allowed = routeAllowed(link.dataset.routeLink);
    link.classList.toggle('role-hidden', !allowed);
    link.setAttribute('aria-disabled', allowed ? 'false' : 'true');
  });
  document.querySelectorAll('[data-permission]').forEach(element => {
    const perm = element.dataset.permission;
    const allowed = roleCan(perm);
    element.classList.toggle('role-hidden', !allowed);
    if ('disabled' in element) element.disabled = !allowed;
    // For sections: also set aria-hidden so screen readers skip
    if (element.tagName === 'SECTION') element.setAttribute('aria-hidden', allowed ? 'false' : 'true');
  });
  renderRoleMatrix();
}

function renderRoleMatrix() {
  const el = document.getElementById('roleMatrixTable');
  if (!el) return;
  const PERM_LABELS = {
    projectRead: 'Просмотр проектов', fieldProgress: 'Полевой прогресс',
    projectManage: 'Управление проектами', logsRead: 'Журналы',
    apiMonitor: 'API-мониторинг', developmentWorkspace: 'Канбан / Dev',
    adminPanel: 'Панель Администратора', secretsManage: 'Secrets Vault',
    agentContext: 'Agent Context',
  };
  const roles = Object.keys(ROLE_POLICIES);
  const perms = Object.keys(PERM_LABELS);
  const headerCells = roles.map(r =>
    `<th style="font-size:11px;font-weight:600;color:${r===currentRole?'#4a7fd4':'#778195'};padding:6px 12px;white-space:nowrap">${ROLE_POLICIES[r].label}${r===currentRole?' ←':''}</th>`
  ).join('');
  const rows = perms.map(p => {
    const cells = roles.map(r =>
      `<td style="text-align:center;padding:5px 12px;font-size:13px">${ROLE_POLICIES[r].permissions.includes(p) ? '<span style="color:#31d4a2">✓</span>' : '<span style="color:#2a3540">✗</span>'}</td>`
    ).join('');
    return `<tr><td style="padding:5px 12px;font-size:12px;color:#b8c5d6;white-space:nowrap">${PERM_LABELS[p]}</td>${cells}</tr>`;
  }).join('');
  el.innerHTML = `<table style="border-collapse:collapse;width:100%;background:#0a1020;border:1px solid #1a2535;border-radius:10px;overflow:hidden">
    <thead><tr><th style="padding:8px 12px;text-align:left;font-size:10px;color:#445060;text-transform:uppercase">Разрешение</th>${headerCells}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function setCurrentRole(role) {
  if (!ROLE_POLICIES[role]) return;
  currentRole = role;
  localStorage.setItem(ROLE_KEY, currentRole);
  applyRolePolicy();
  renderRoute();
  toast(`Role preview: ${ROLE_POLICIES[currentRole].label}`);
}

const SESSION_STORAGE_KEY = 'rackpilot.session.v1';

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)); } catch { return null; }
}
function setSession(s) {
  if (s) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_STORAGE_KEY);
}

function apiHeaders(extra = {}) {
  const session = getSession();
  const headers = { ...extra, 'X-Organization-ID': ORGANIZATION_ID, 'X-RackPilot-Role': currentRole };
  if (session?.token) headers['Authorization'] = `Bearer ${session.token}`;
  return headers;
}

async function logout() {
  const session = getSession();
  if (session?.token) {
    await fetch('/api/v1/auth/logout', { method: 'POST', headers: apiHeaders() }).catch(() => {});
  }
  setSession(null);
  showLoginModal();
}

function showLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.style.display = 'flex';
}
function hideLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.style.display = 'none';
}

async function apiFetch(url, opts = {}) {
  const resp = await fetch(url, { ...opts, headers: { ...apiHeaders(), ...(opts.headers || {}) } });
  if (resp.status === 401) {
    setSession(null);
    showLoginModal();
    throw new Error('Session expired. Please log in again.');
  }
  return resp;
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
  _taskDataVersion++;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  setSyncState('saving');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncToServer, 300);
}

function setSyncState(mode) {
  const indicator = $('#saveState');
  if (!indicator) return;
  indicator.classList.toggle('saving', mode === 'saving');
  indicator.classList.toggle('offline', mode === 'offline');
  const pendingTotal = _writeOutbox.length + (unitOutbox?.length || 0);
  const cursor = _loadSyncCursor();
  const offlineLabel = pendingTotal > 0 ? ` Офлайн (${pendingTotal})` : ' Офлайн';
  const syncedLabel = cursor ? ` Синхр. ${_elapsed(cursor)}` : ' Синхронизировано';
  indicator.lastChild.textContent = mode === 'offline' ? offlineLabel : mode === 'saving' ? ' Синхронизация…' : syncedLabel;
  _updateOfflineBanner();
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
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expectedRevision: state.revision, tasks: state.tasks, audit: state.audit })
      });
    if (response.status !== 409 || attempt === 1) break;
      const remoteResponse = await fetch('/api/v1/workspace', { headers: apiHeaders({ Accept: 'application/json' }) });
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
    const response = await fetch('/api/v1/projects', { headers: apiHeaders({ Accept: 'application/json' }) });
    if (!response.ok) throw new Error('Projects API unavailable');
    projects = (await response.json()).projects;
    _saveProjectsCache(projects);
    _saveSyncCursor();
    applyUnitOutbox();
    renderProjects();
    if (selectedProjectId) selectedLocationId ? renderLocationDetail() : renderProjectDetail();
  } catch {
    // Serve from cache when offline or server unreachable
    const cached = _loadProjectsCache();
    if (cached?.data?.length && !projects.length) {
      projects = cached.data;
      applyUnitOutbox();
      renderProjects();
      if (selectedProjectId) selectedLocationId ? renderLocationDetail() : renderProjectDetail();
      const age = _elapsed(cached.ts);
      if (age) setSyncState('offline');
    } else if (!projects.length) {
      renderProjects(true);
    }
  }
}

async function apiPost(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': createIdempotencyKey() }),
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Request failed: ${response.status}`);
  return result;
}

async function apiPatch(path, payload, idempotencyKey = createIdempotencyKey()) {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: apiHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }),
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
  for (const key of [UNIT_OUTBOX_KEY, ...LEGACY_UNIT_OUTBOX_KEYS]) {
    try {
      const value=JSON.parse(localStorage.getItem(key));
      if(Array.isArray(value)){ if(key!==UNIT_OUTBOX_KEY)localStorage.setItem(UNIT_OUTBOX_KEY,JSON.stringify(value)); return value; }
    } catch {
      /* ignore invalid outbox */
    }
  }
  return [];
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
    const reqHeaders = apiHeaders({ Accept: 'application/json' });
    if (_workspaceETag) reqHeaders['If-None-Match'] = _workspaceETag;
    const response = await fetch('/api/v1/workspace', { headers: reqHeaders });
    if (response.status === 304) { setSyncState('synced'); return; } // unchanged
    if (!response.ok) throw new Error('Workspace API unavailable');
    _workspaceETag = response.headers.get('ETag') || null;
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
      _taskDataVersion++;
      _saveSyncCursor();
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

function filteredTasks(includeStatus = false) {
  const q = $('#searchInput').value.trim().toLowerCase();
  const priority = $('#priorityFilter').value;
  const area = $('#areaFilter').value;
  const status = $('#statusFilter').value;
  // Recompute base list only when tasks data or filters change
  const baseKey = `${_taskDataVersion}|${q}|${priority}|${area}`;
  if (_fcKey !== baseKey) {
    _fcBase = state.tasks.filter(task =>
      (!q || `${task.id} ${task.title} ${task.description}`.toLowerCase().includes(q)) &&
      (priority === 'all' || task.priority === priority) &&
      (area === 'all' || task.area === area)
    );
    _fcKey = baseKey;
  }
  return (!includeStatus || status === 'all') ? _fcBase : _fcBase.filter(t => t.status === status);
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
  const techSubRoute = routeParts[0] === 'tech' ? (routeParts[1] || 'home') : null;
  let route = selectedProjectId ? 'projects' : (['overview', 'projects', 'logs', 'api', 'admin', 'tech'].includes(routeParts[0]) ? routeParts[0] : 'overview');
  if (routeParts[0] === 'tech') route = 'tech';
  if (!routeAllowed(route)) {
    route = 'overview';
    selectedProjectId = null;
    selectedLocationId = null;
    if (location.hash !== '#overview') history.replaceState(null, '', '#overview');
    toast(`Role ${ROLE_POLICIES[currentRole].label} cannot access that section yet`);
  }
  document.body.dataset.route = route;
  applyRolePolicy();
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
  if (route === 'api') hydrateApiMetrics();
  if (route === 'overview') hydrateGrowthChart();
  if (route === 'admin') { Promise.all([hydrateComputeNodes(),hydratePlatformSettings(),hydrateGitSyncSettings(),hydrateWorkflowConfiguration(),hydrateCustomFieldDefinitions(),hydrateSecretsVault(),hydrateFeatureDocs(),hydrateAIGateway(),hydratePrivacy(),hydrateMFA(),hydrateRetrievalEval(),hydrateAIApprovals(),hydrateTeam(),hydrateTimeTracking(),hydrateConflictQueue()]); renderAITeam(); }
  if (route === 'tech') hydrateTechView(techSubRoute || 'home');
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

const AI_TEAM = [
  { id:'claude',   emoji:'⚡', name:'Claude',   role:'Strategic Partner',    desc:'Продуктовые решения, архитектура, парное программирование с Codex', status:'working',  mood:'Работаю в паре с Codex. Погнали.' },
  { id:'codex',    emoji:'🧠', name:'Codex',    role:'Lead Developer',       desc:'Разрабатывает платформу, архитектура, код, тесты',              status:'working',  mood:'Анализирую приоритеты бэклога...' },
  { id:'scout',    emoji:'🔭', name:'Scout',    role:'System Monitor',       desc:'Следит за API-метриками, uptime и здоровьем сервера',           status:'sleeping', mood:'Всё тихо. Сплю до инцидента.' },
  { id:'guardian', emoji:'🛡️', name:'Guardian', role:'Security & Audit',     desc:'Аудит данных, целостность цепочки событий, изоляция тенантов',  status:'sleeping', mood:'Периметр защищён. Не беспокоить.' },
  { id:'relay',    emoji:'📡', name:'Relay',    role:'Sync & Integrations',  desc:'Git sync, GitHub Actions CI, внешние интеграции',               status:'working',  mood:'Синхронизирую последние коммиты...' },
  { id:'analyst',  emoji:'📊', name:'Analyst',  role:'Reports & Analytics',  desc:'Jobber-отчёты, прогресс по видам работ, дневные сводки',        status:'thinking', mood:'Считаю прогресс по проектам...' },
  { id:'janitor',  emoji:'🧹', name:'Janitor',  role:'Maintenance',          desc:'Архивирование логов, чистка кэша, контроль миграций БД',        status:'sleeping', mood:'Убрался. Не будите без причины.' },
];
const AGENT_STATUS_LABEL = { sleeping:'Спит', working:'Работает', thinking:'Думает', waiting:'Ждёт агента', error:'Ошибка' };

function renderAITeam() {
  const grid = document.getElementById('aiTeamGrid');
  if (!grid) return;
  grid.innerHTML = AI_TEAM.map(a => `
    <article class="agent-card" data-agent="${a.id}" data-status="${a.status}">
      <div class="agent-hero">
        <div class="agent-glow"></div>
        <div class="agent-ring">${a.emoji}</div>
        <div class="agent-status-chip">
          <span class="agent-status-dot"></span>
          <span>${AGENT_STATUS_LABEL[a.status] || a.status}</span>
        </div>
      </div>
      <div class="agent-body">
        <strong class="agent-name">${a.name}</strong>
        <span class="agent-role">${a.role}</span>
        <p class="agent-mood">&ldquo;${a.mood}&rdquo;</p>
      </div>
    </article>
  `).join('');
}

async function hydrateComputeNodes(){try{const response=await fetch('/api/v1/admin/compute-nodes',{headers:apiHeaders()});if(!response.ok)throw new Error('monitor unavailable');const payload=await response.json();computeNodes=payload.nodes||[];renderComputeNodes();}catch{renderComputeNodes(true);}}

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

async function hydrateGitSyncSettings(){try{const response=await fetch('/api/v1/admin/git-sync',{headers:apiHeaders()});if(!response.ok)throw new Error('git sync unavailable');const payload=await response.json();gitSyncSettings=payload.settings;renderGitSyncSettings();}catch{renderGitSyncSettings(true);}}

async function submitGitSyncSettings(event){event.preventDefault();const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;try{const response=await fetch('/api/v1/admin/git-sync',{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({remoteUrl:$('#gitRemoteUrl').value.trim(),branchName:$('#gitBranchName').value.trim()||'main',commitStrategy:$('#gitCommitStrategy').value,autoCommit:$('#gitAutoCommit').checked,autoPush:$('#gitAutoPush').checked,includeDocs:$('#gitIncludeDocs').checked})});const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message||'Git settings failed');gitSyncSettings=payload.settings;renderGitSyncSettings();toast('Git sync settings saved');}catch(error){toast(error.message);}finally{button.disabled=false;}}

function renderPlatformSettings(unavailable=false){const form=$('#platformSettingsForm'),status=$('#platformSettingsStatus');if(!form||!status)return;if(unavailable){status.textContent='Unavailable';status.className='git-sync-status error';return;}const settings=platformSettings||{};$('#platformLanguage').value=settings.defaultLanguage||'en';$('#platformTimezone').value=settings.timezone||'America/Halifax';$('#platformRoleMode').value=settings.roleMode||'planned';$('#platformTelemetryMode').value=settings.telemetryMode||'standard';$('#platformLogRetention').value=settings.logRetentionDays||365;status.textContent=settings.updatedAt?'Configured':'Default';status.className=`git-sync-status ${settings.updatedAt?'configured':'not_configured'}`;}

async function hydratePlatformSettings(){try{const response=await fetch('/api/v1/admin/platform-settings',{headers:apiHeaders()});if(!response.ok)throw new Error('platform settings unavailable');const payload=await response.json();platformSettings=payload.settings;renderPlatformSettings();}catch{renderPlatformSettings(true);}}

// ── Platform Guide (self-documenting) ─────────────────────────────────────

const AREA_LABELS = {
  foundation: 'Foundation', platform: 'Platform', field: 'Field Ops',
  integration: 'Integration', ai: 'AI', analytics: 'Analytics', security: 'Security',
};
const STATUS_CONFIG = {
  done:     { label: 'Реализовано', color: '#3dd68c' },
  progress: { label: 'В работе',   color: '#f5c842' },
  review:   { label: 'Ревью',      color: '#4a7fd4' },
  testing:  { label: 'Тестинг',    color: '#a87aff' },
  ready:    { label: 'Готово к старту', color: '#62a8ff' },
  blocked:  { label: 'Заблокировано',  color: '#e05353' },
  backlog:  { label: 'Запланировано',  color: '#556070' },
  ideas:    { label: 'Идеи',       color: '#445060' },
};

let _featureDocsData = [];

async function hydrateFeatureDocs() {
  const list = document.getElementById('featureDocsList');
  if (!list) return;
  list.innerHTML = '<p class="empty-copy">Загрузка…</p>';
  try {
    const resp = await apiFetch('/api/v1/admin/feature-docs');
    const { features } = await resp.json();
    _featureDocsData = features;
    renderFeatureDocs();
  } catch (e) {
    list.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`;
  }
}

function renderFeatureDocs() {
  const list = document.getElementById('featureDocsList');
  if (!list) return;
  const q = (document.getElementById('featureDocsSearch')?.value || '').toLowerCase().trim();
  const filterStatus = document.getElementById('featureDocsFilter')?.value || 'all';

  const IMPLEMENTED = new Set(['done', 'testing', 'review']);
  const IN_PROGRESS  = new Set(['progress', 'ready', 'blocked']);

  let items = _featureDocsData.filter(f => {
    if (filterStatus === 'done'     && !IMPLEMENTED.has(f.status)) return false;
    if (filterStatus === 'progress' && !IN_PROGRESS.has(f.status))  return false;
    if (filterStatus === 'planned'  && !['backlog','ideas'].includes(f.status)) return false;
    if (q && !`${f.id} ${f.title} ${f.description} ${f.area}`.toLowerCase().includes(q)) return false;
    return true;
  });

  if (!items.length) {
    list.innerHTML = '<p class="empty-copy">Ничего не найдено.</p>';
    return;
  }

  // Group by status bucket
  const groups = [
    { key: 'done',     label: 'Реализовано',      color: '#3dd68c', statuses: IMPLEMENTED },
    { key: 'progress', label: 'В работе',          color: '#f5c842', statuses: IN_PROGRESS },
    { key: 'planned',  label: 'Запланировано',     color: '#556070', statuses: new Set(['backlog','ideas']) },
  ];

  let html = '';
  for (const g of groups) {
    const groupItems = items.filter(f => g.statuses.has(f.status));
    if (!groupItems.length) continue;
    html += `<div class="fd-group">
      <div class="fd-group-header">
        <span class="fd-group-dot" style="background:${g.color}"></span>
        <strong>${g.label}</strong>
        <span class="fd-group-count">${groupItems.length}</span>
      </div>
      <div class="fd-group-items">
        ${groupItems.map(f => renderFeatureCard(f)).join('')}
      </div>
    </div>`;
  }
  list.innerHTML = html;

  // Wire up expand / generate / edit buttons
  list.querySelectorAll('.fd-card').forEach(card => {
    const id = card.dataset.id;
    card.querySelector('.fd-toggle')?.addEventListener('click', () => {
      card.classList.toggle('fd-expanded');
    });
    card.querySelector('.fd-generate-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      generateFeatureGuide(id, card);
    });
    card.querySelector('.fd-edit-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openGuideEditor(id, card);
    });
  });
}

function renderFeatureCard(f) {
  const sc = STATUS_CONFIG[f.status] || STATUS_CONFIG.backlog;
  const areaLabel = AREA_LABELS[f.area] || f.area;
  const hasGuide = !!f.guide;
  const guideAge = f.guideUpdatedAt
    ? new Date(f.guideUpdatedAt).toLocaleDateString('ru', { day:'numeric', month:'short' })
    : null;

  return `<article class="fd-card" data-id="${escapeHtml(f.id)}">
    <div class="fd-card-head fd-toggle">
      <div class="fd-card-left">
        <span class="fd-status-dot" style="background:${sc.color}" title="${sc.label}"></span>
        <div>
          <div class="fd-card-title">${escapeHtml(f.title)}</div>
          <div class="fd-card-meta">
            <code>${escapeHtml(f.id)}</code>
            ${areaLabel ? `<span>${escapeHtml(areaLabel)}</span>` : ''}
            ${f.priority ? `<span class="fd-priority fd-priority-${f.priority}">${f.priority}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="fd-card-actions">
        ${hasGuide
          ? `<span class="fd-guide-badge" title="Обновлено ${guideAge || ''}">📖 Гид</span>`
          : `<span class="fd-no-guide">Нет гида</span>`}
        <button class="fd-generate-btn button ghost" type="button" title="${hasGuide ? 'Перегенерировать' : 'Сгенерировать гид AI'}">⚡</button>
        ${hasGuide ? `<button class="fd-edit-btn button ghost" type="button" title="Редактировать вручную">✎</button>` : ''}
        <span class="fd-chevron">›</span>
      </div>
    </div>
    <div class="fd-card-body">
      ${f.description ? `<p class="fd-desc">${escapeHtml(f.description)}</p>` : ''}
      ${hasGuide
        ? `<div class="fd-guide-content fd-markdown">${renderMarkdown(f.guide)}</div>
           <small class="fd-guide-meta">Сгенерировано: ${f.guideGeneratedBy || 'manual'} · ${guideAge}</small>`
        : `<p class="fd-no-guide-msg">Гид не создан. Нажмите ⚡ чтобы сгенерировать через AI.</p>`}
      <div class="fd-guide-editor" style="display:none">
        <textarea class="fd-guide-textarea" rows="10" placeholder="Markdown…"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="button primary fd-save-guide-btn" type="button">Сохранить</button>
          <button class="button ghost fd-cancel-edit-btn" type="button">Отмена</button>
        </div>
      </div>
    </div>
  </article>`;
}

function renderMarkdown(text) {
  // Minimal markdown: headers, bold, numbered lists, bullets
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^## (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h5>$1</h5>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/^[-·] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, s => `<ol>${s}</ol>`)
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

async function generateFeatureGuide(taskId, card) {
  const btn = card.querySelector('.fd-generate-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const resp = await apiFetch('/api/v1/admin/feature-docs/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Generation failed');
    toast(`Гид для ${taskId} готов`);
    // Update local data and re-render
    const f = _featureDocsData.find(x => x.id === taskId);
    if (f) { f.guide = data.guide; f.guideGeneratedBy = 'claude'; f.guideUpdatedAt = new Date().toISOString(); }
    renderFeatureDocs();
  } catch (e) {
    toast(e.message);
    if (btn) { btn.disabled = false; btn.textContent = '⚡'; }
  }
}

function openGuideEditor(taskId, card) {
  const f = _featureDocsData.find(x => x.id === taskId);
  const editor = card.querySelector('.fd-guide-editor');
  const textarea = card.querySelector('.fd-guide-textarea');
  const guideContent = card.querySelector('.fd-guide-content');
  if (!editor || !textarea) return;
  textarea.value = f?.guide || '';
  editor.style.display = 'block';
  if (guideContent) guideContent.style.display = 'none';
  textarea.focus();

  card.querySelector('.fd-save-guide-btn')?.addEventListener('click', async () => {
    const content = textarea.value.trim();
    if (!content) return;
    try {
      const resp = await apiFetch('/api/v1/admin/feature-docs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, content }),
      });
      if (!resp.ok) throw new Error('Save failed');
      const f2 = _featureDocsData.find(x => x.id === taskId);
      if (f2) { f2.guide = content; f2.guideGeneratedBy = 'manual'; f2.guideUpdatedAt = new Date().toISOString(); }
      toast('Гид сохранён');
      renderFeatureDocs();
    } catch (e) { toast(e.message); }
  }, { once: true });

  card.querySelector('.fd-cancel-edit-btn')?.addEventListener('click', () => {
    editor.style.display = 'none';
    if (guideContent) guideContent.style.display = '';
  }, { once: true });
}

async function generateAllDocs() {
  const btn = document.getElementById('generateAllDocsButton');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Генерирую…'; }
  const withoutGuide = _featureDocsData.filter(f => !f.guide && ['done','progress','review','testing'].includes(f.status));
  let count = 0;
  for (const f of withoutGuide) {
    try {
      const resp = await apiFetch('/api/v1/admin/feature-docs/generate', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ taskId: f.id }),
      });
      const data = await resp.json();
      if (resp.ok) { f.guide = data.guide; f.guideGeneratedBy = 'claude'; f.guideUpdatedAt = new Date().toISOString(); count++; }
    } catch { /* continue */ }
  }
  toast(`Сгенерировано ${count} гидов`);
  renderFeatureDocs();
  if (btn) { btn.disabled = false; btn.textContent = '⚡ Авто-документация'; }
}

function setupFeatureDocs() {
  document.getElementById('featureDocsSearch')?.addEventListener('input', renderFeatureDocs);
  document.getElementById('featureDocsFilter')?.addEventListener('change', renderFeatureDocs);
  document.getElementById('generateAllDocsButton')?.addEventListener('click', generateAllDocs);
}

// ── Secrets Vault ──────────────────────────────────────────────────────────

const CATEGORY_LABELS = { api_key: 'API Key', token: 'Token', credential: 'Credential', other: 'Other' };

async function hydrateSecretsVault() {
  const el = document.getElementById('secretsList');
  if (!el) return;
  try {
    const resp = await apiFetch('/api/v1/admin/secrets');
    const { secrets } = await resp.json();
    if (!secrets.length) {
      el.innerHTML = '<p class="empty-copy">Нет сохранённых секретов. Нажмите «＋ Добавить секрет».</p>';
      return;
    }
    el.innerHTML = secrets.map(s => `
      <div class="secret-card" data-id="${s.id}">
        <div class="secret-meta">
          <span class="secret-category">${CATEGORY_LABELS[s.category] || s.category}</span>
          <strong>${escapeHtml(s.name)}</strong>
          ${s.description ? `<span class="secret-desc">${escapeHtml(s.description)}</span>` : ''}
        </div>
        <div class="secret-value-row">
          <code class="secret-value-masked" id="sv-${s.id}">••••••••••••</code>
          <button class="button ghost secret-reveal-btn" data-id="${s.id}" type="button" title="Показать значение">👁</button>
          <button class="button ghost secret-copy-btn" data-id="${s.id}" type="button" title="Скопировать">⎘</button>
          <button class="button ghost secret-delete-btn" data-id="${s.id}" type="button" title="Удалить">✕</button>
        </div>
        <small style="color:#556070">${new Date(s.created_at).toLocaleDateString('ru')}</small>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`;
  }
}

async function revealSecret(id) {
  const el = document.getElementById(`sv-${id}`);
  if (!el) return;
  if (el.dataset.revealed === '1') { el.textContent = '••••••••••••'; el.dataset.revealed = ''; return; }
  try {
    const resp = await apiFetch(`/api/v1/admin/secrets/${id}/reveal`);
    const { value } = await resp.json();
    el.textContent = value;
    el.dataset.revealed = '1';
    setTimeout(() => { el.textContent = '••••••••••••'; el.dataset.revealed = ''; }, 15000);
  } catch (e) { toast(e.message); }
}

async function copySecret(id) {
  try {
    const resp = await apiFetch(`/api/v1/admin/secrets/${id}/reveal`);
    const { value } = await resp.json();
    await navigator.clipboard.writeText(value);
    toast('Скопировано в буфер');
  } catch (e) { toast(e.message); }
}

async function deleteSecret(id) {
  if (!confirm('Удалить секрет? Это необратимо.')) return;
  try {
    const resp = await apiFetch(`/api/v1/admin/secrets/${id}/delete`, { method: 'POST', headers: {'Content-Type':'application/json'}, body:'{}' });
    if (!resp.ok) throw new Error('Delete failed');
    toast('Секрет удалён');
    hydrateSecretsVault();
  } catch (e) { toast(e.message); }
}

// ── AI Gateway ─────────────────────────────────────────────────────────────

const PROVIDER_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', ollama: 'Ollama', custom: 'Custom' };

async function hydrateAIGateway() {
  await Promise.all([hydrateAIProviders(), hydrateAIUsage()]);
}

async function hydrateAIProviders() {
  const el = document.getElementById('aiProvidersList');
  if (!el) return;
  try {
    const resp = await apiFetch('/api/v1/admin/ai-gateway/providers');
    const { providers } = await resp.json();
    if (!providers.length) {
      el.innerHTML = '<p class="empty-copy">Нет настроенных провайдеров — используется ключ из переменной окружения.</p>';
      return;
    }
    el.innerHTML = `<div class="ai-providers-list">${providers.map(p => `
      <div class="ai-provider-card" data-id="${p.id}">
        <div>
          <strong>${escapeHtml(p.name)}</strong>
          <small style="color:#778195;margin-left:8px">${PROVIDER_LABELS[p.provider] || p.provider} · ${escapeHtml(p.model)}</small>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="fd-guide-badge" style="${p.enabled ? '' : 'color:#556070;background:rgba(85,96,112,.1)'}">
            ${p.enabled ? '● Активен' : '○ Отключён'}
          </span>
          <small style="color:#556070">Приоритет ${p.priority}</small>
          <button class="button ghost provider-delete-btn" data-id="${p.id}" type="button" style="padding:4px 8px">✕</button>
        </div>
      </div>`).join('')}</div>`;
    el.querySelectorAll('.provider-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить провайдер?')) return;
        await apiFetch(`/api/v1/admin/ai-gateway/providers/${btn.dataset.id}/delete`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
        hydrateAIProviders();
      });
    });
  } catch (e) { el.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

async function hydrateAIUsage() {
  const el = document.getElementById('aiUsageChart');
  if (!el) return;
  try {
    const resp = await apiFetch('/api/v1/admin/ai-gateway/usage?days=30');
    const data = await resp.json();
    renderAIUsage(data, el);
  } catch (e) { el.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

function renderAIUsage(data, el) {
  const { byPurpose, daily, monthlyLimit } = data;
  const totalTokens = byPurpose.reduce((s, r) => s + (r.tokens || 0), 0);
  const totalReqs = byPurpose.reduce((s, r) => s + (r.requests || 0), 0);

  const usageBar = monthlyLimit
    ? `<div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#778195;margin-bottom:5px">
          <span>Использовано за месяц</span>
          <span><strong style="color:#dde4f0">${totalTokens.toLocaleString()}</strong> / ${monthlyLimit.toLocaleString()} токенов</span>
        </div>
        <div style="height:4px;background:#1a2535;border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${Math.min(100, totalTokens/monthlyLimit*100).toFixed(1)}%;background:#4a7fd4;border-radius:4px"></div>
        </div>
      </div>` : '';

  const purposeRows = byPurpose.length
    ? byPurpose.map(r => `<tr>
        <td style="padding:5px 8px;color:#b8c5d6;font-size:12px">${escapeHtml(r.purpose)}</td>
        <td style="padding:5px 8px;color:#dde4f0;font-size:12px;text-align:right">${r.requests}</td>
        <td style="padding:5px 8px;color:#4a7fd4;font-size:12px;text-align:right">${(r.tokens||0).toLocaleString()}</td>
        <td style="padding:5px 8px;color:#778195;font-size:11px">${r.model}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" style="padding:12px 8px;color:#556070;font-size:12px">Нет данных за последние 30 дней</td></tr>';

  // Mini daily bar chart
  const maxD = Math.max(...(daily.map(d => d.tokens || 0)), 1);
  const bars = daily.map(d => {
    const h = Math.max(3, Math.round((d.tokens / maxD) * 40));
    const dt = d.day?.slice(5) || '';
    return `<div title="${dt}: ${(d.tokens||0).toLocaleString()} токенов, ${d.requests} запросов" style="display:flex;flex-direction:column;align-items:center;gap:3px;cursor:default">
      <div style="width:10px;height:${h}px;background:#4a7fd4;border-radius:2px;opacity:0.8"></div>
      <span style="font-size:8px;color:#445060;writing-mode:vertical-rl;transform:rotate(180deg)">${dt}</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    ${usageBar}
    <div style="display:flex;gap:20px;margin-bottom:14px">
      <div><strong style="font-size:18px;color:#dde4f0">${totalTokens.toLocaleString()}</strong><div style="font-size:10px;color:#556070;text-transform:uppercase;letter-spacing:.06em">токенов / 30д</div></div>
      <div><strong style="font-size:18px;color:#dde4f0">${totalReqs}</strong><div style="font-size:10px;color:#556070;text-transform:uppercase;letter-spacing:.06em">запросов</div></div>
    </div>
    ${daily.length ? `<div style="display:flex;align-items:flex-end;gap:3px;height:60px;margin-bottom:16px;padding:0 2px">${bars}</div>` : ''}
    <table style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="padding:4px 8px;text-align:left;font-size:10px;color:#556070;text-transform:uppercase;letter-spacing:.06em">Назначение</th>
        <th style="padding:4px 8px;text-align:right;font-size:10px;color:#556070;text-transform:uppercase;letter-spacing:.06em">Запросы</th>
        <th style="padding:4px 8px;text-align:right;font-size:10px;color:#556070;text-transform:uppercase;letter-spacing:.06em">Токены</th>
        <th style="padding:4px 8px;font-size:10px;color:#556070;text-transform:uppercase;letter-spacing:.06em">Модель</th>
      </tr></thead>
      <tbody>${purposeRows}</tbody>
    </table>`;
}

function setupAIGateway() {
  const addBtn = document.getElementById('addProviderButton');
  const dialog = document.getElementById('providerDialog');
  const form = document.getElementById('providerForm');
  const cancelBtn = document.getElementById('cancelProviderButton');
  if (!addBtn || !dialog) return;

  addBtn.addEventListener('click', async () => {
    form?.reset();
    document.getElementById('providerIdField').value = '';
    // Populate secrets dropdown
    const sel = document.getElementById('providerSecretId');
    if (sel) {
      try {
        const r = await apiFetch('/api/v1/admin/secrets');
        const { secrets } = await r.json();
        sel.innerHTML = '<option value="">— из переменной окружения —</option>' +
          secrets.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
      } catch { /* ok */ }
    }
    dialog.showModal();
  });
  cancelBtn?.addEventListener('click', () => dialog.close());

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const payload = {
        id: document.getElementById('providerIdField').value || undefined,
        name: document.getElementById('providerName').value.trim(),
        provider: document.getElementById('providerType').value,
        model: document.getElementById('providerModel').value.trim(),
        priority: parseInt(document.getElementById('providerPriority').value) || 0,
        base_url: document.getElementById('providerBaseUrl').value.trim() || null,
        secret_id: document.getElementById('providerSecretId').value || null,
        enabled: true,
      };
      const resp = await apiFetch('/api/v1/admin/ai-gateway/providers', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error((await resp.json()).error?.message || 'Failed');
      dialog.close();
      toast('Провайдер сохранён');
      hydrateAIProviders();
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  });
}

// ── MFA Admin Panel ────────────────────────────────────────────────────────

async function hydrateMFA() {
  const statusEl = document.getElementById('mfaStatus');
  const actionsEl = document.getElementById('mfaActions');
  if (!statusEl) return;
  try {
    const resp = await apiFetch('/api/v1/auth/me');
    const { mfa } = await resp.json();
    if (mfa.enabled) {
      statusEl.innerHTML = `<span style="color:#31d4a2;font-size:14px">● MFA активна</span> <small style="color:#778195">· ${mfa.backupCodesRemaining} кодов восстановления осталось</small>`;
      if (actionsEl) actionsEl.innerHTML = '<button class="button ghost" id="mfaDisableBtn" type="button" style="color:#e05353;border-color:#e05353">Отключить MFA</button>';
      document.getElementById('mfaDisableBtn')?.addEventListener('click', async () => {
        if (!confirm('Отключить двухфакторную аутентификацию?')) return;
        await apiFetch('/api/v1/auth/mfa/disable', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
        toast('MFA отключена');
        hydrateMFA();
      });
    } else {
      statusEl.innerHTML = '<span style="color:#778195">○ MFA не активна</span> — рекомендуется для защиты аккаунта администратора.';
      if (actionsEl) actionsEl.innerHTML = '<button class="button primary" id="mfaEnrollBtn" type="button">Настроить MFA</button>';
      document.getElementById('mfaEnrollBtn')?.addEventListener('click', startMFAEnroll);
    }
  } catch (e) { statusEl.textContent = e.message; }
}

async function startMFAEnroll() {
  const panel = document.getElementById('mfaEnrollPanel');
  if (!panel) return;
  try {
    const resp = await apiFetch('/api/v1/auth/mfa/enroll', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
    const { secret, uri } = await resp.json();
    document.getElementById('mfaSecretKey').textContent = secret;
    document.getElementById('mfaUri').textContent = uri;
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    document.getElementById('mfaConfirmCode').value = '';
    document.getElementById('mfaConfirmCode').focus();
  } catch (e) { toast(e.message); }
}

function setupMFA() {
  document.getElementById('mfaConfirmBtn')?.addEventListener('click', async () => {
    const code = document.getElementById('mfaConfirmCode').value.trim();
    if (!code) return;
    const btn = document.getElementById('mfaConfirmBtn');
    btn.disabled = true;
    try {
      const resp = await apiFetch('/api/v1/auth/mfa/confirm', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ code }),
      });
      if (!resp.ok) { const e = await resp.json(); throw new Error(e.error?.message || 'Неверный код'); }
      const { backupCodes } = await resp.json();
      document.getElementById('mfaEnrollPanel').style.display = 'none';
      const backupPanel = document.getElementById('mfaBackupCodesPanel');
      backupPanel.style.display = 'block';
      document.getElementById('mfaBackupCodesList').innerHTML = backupCodes.map(c => `<span>${c}</span>`).join('');
      hydrateMFA();
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; }
  });
  document.getElementById('mfaCancelEnrollBtn')?.addEventListener('click', () => {
    document.getElementById('mfaEnrollPanel').style.display = 'none';
  });
  document.getElementById('mfaBackupDoneBtn')?.addEventListener('click', () => {
    document.getElementById('mfaBackupCodesPanel').style.display = 'none';
  });
}

// ── Privacy Controls & Audit Log ───────────────────────────────────────────

const PURPOSE_LABELS = {
  ai_requests: 'AI-запросы',
  audit_log: 'Журнал аудита',
  field_telemetry: 'Полевая телеметрия',
  object_storage: 'Объектное хранилище',
};

const OUTCOME_STYLE = { ok: 'color:#31d4a2', denied: 'color:#e05353', error: 'color:#f59e0b' };

async function hydratePrivacy() {
  await Promise.all([hydratePrivacySettings(), hydrateAuditLog()]);
}

async function hydratePrivacySettings() {
  const el = document.getElementById('privacySettingsList');
  if (!el) return;
  try {
    const resp = await apiFetch('/api/v1/admin/privacy');
    const { settings } = await resp.json();
    if (!settings.length) { el.innerHTML = '<p class="empty-copy">Нет политик — они создаются при первом запуске.</p>'; return; }
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">
      ${settings.map(s => `<div class="privacy-row">
        <div>
          <strong>${escapeHtml(PURPOSE_LABELS[s.purpose] || s.purpose)}</strong>
          <small style="color:#778195;margin-left:8px">${s.purpose}</small>
        </div>
        <div style="display:flex;gap:14px;align-items:center">
          <span style="${s.enabled ? 'color:#31d4a2' : 'color:#556070'}">${s.enabled ? '● Активно' : '○ Отключено'}</span>
          <small style="color:#778195">${s.retention_days > 0 ? `Хранить ${s.retention_days} дней` : 'Хранить навсегда'}</small>
          <button class="button ghost privacy-edit-btn" data-purpose="${s.purpose}" data-enabled="${s.enabled}" data-days="${s.retention_days}" type="button" style="padding:4px 10px;font-size:12px">Изменить</button>
        </div>
      </div>`).join('')}
    </div>`;
    el.querySelectorAll('.privacy-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const purpose = btn.dataset.purpose;
        const days = prompt(`Срок хранения (дней) для "${PURPOSE_LABELS[purpose] || purpose}" (0 = навсегда):`, btn.dataset.days);
        if (days === null) return;
        const retention = parseInt(days) || 0;
        apiFetch('/api/v1/admin/privacy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose, enabled: btn.dataset.enabled !== '0', retention_days: retention }),
        }).then(() => { toast('Политика обновлена'); hydratePrivacySettings(); });
      });
    });
  } catch (e) { el.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

async function hydrateAuditLog() {
  const el = document.getElementById('auditLogList');
  if (!el) return;
  try {
    const resp = await apiFetch('/api/v1/admin/audit-log?limit=50');
    const { entries } = await resp.json();
    if (!entries.length) { el.innerHTML = '<p class="empty-copy">Нет записей в журнале аудита.</p>'; return; }
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px">
      ${entries.map(e => `<div class="audit-row">
        <code style="font-size:10px;color:#445060;min-width:160px">${(e.created_at||'').slice(0,19).replace('T',' ')}</code>
        <span style="${OUTCOME_STYLE[e.outcome] || ''}">●</span>
        <strong style="font-size:12px;min-width:130px">${escapeHtml(e.action)}</strong>
        <small style="color:#778195">${escapeHtml(e.actor_id || '—')}</small>
        <small style="color:#556070">${escapeHtml(e.actor_role || '')}</small>
        ${e.target_type ? `<small style="color:#445060">${escapeHtml(e.target_type)} ${escapeHtml(e.target_id || '')}</small>` : ''}
        ${e.ip ? `<small style="color:#334050">${escapeHtml(e.ip)}</small>` : ''}
      </div>`).join('')}
    </div>`;
  } catch (e) { el.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

// ── Team Members ─────────────────────────────────────────────────────────
const AVAIL_LABEL = { available: 'Доступен', busy: 'Занят', off: 'Нет на месте' };
const AVAIL_COLOR = { available: '#34d399', busy: '#f59e0b', off: '#778195' };

async function hydrateTeam() {
  const grid = document.getElementById('teamGrid');
  if (!grid) return;
  try {
    const resp = await apiFetch('/api/v1/team');
    const { members } = await resp.json();
    if (!members.length) { grid.innerHTML = '<p class="empty-copy">Нет сотрудников. Добавьте первого.</p>'; return; }
    grid.innerHTML = members.map(m => `
      <div class="member-card" data-id="${m.id}">
        <div class="member-header">
          <div class="member-avatar">${(m.name||'?')[0].toUpperCase()}</div>
          <div>
            <strong>${escapeHtml(m.name)}</strong>
            <small style="display:block;color:var(--text-muted)">${escapeHtml(m.trade||m.role)}</small>
          </div>
          <span class="avail-dot" style="color:${AVAIL_COLOR[m.availability]||'#778195'}" title="${AVAIL_LABEL[m.availability]||m.availability}">●</span>
        </div>
        ${m.skills?.length ? `<div class="member-skills">${m.skills.map(s=>`<span class="skill-tag">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
        ${m.email ? `<div class="member-contact"><small>✉ ${escapeHtml(m.email)}</small></div>` : ''}
        ${m.phone ? `<div class="member-contact"><small>✆ ${escapeHtml(m.phone)}</small></div>` : ''}
        <div class="member-footer">
          <span style="font-size:11px;color:var(--text-muted)">${m.project_count||0} проектов</span>
          <div style="display:flex;gap:6px">
            <button class="text-button member-edit-btn" data-id="${m.id}">Ред.</button>
            <button class="text-button member-del-btn" data-id="${m.id}" style="color:#e05353">Удалить</button>
          </div>
        </div>
      </div>`).join('');
    grid.querySelectorAll('.member-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const m = members.find(x => x.id === btn.dataset.id);
        if (!m) return;
        openMemberDialog(m);
      });
    });
    grid.querySelectorAll('.member-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить сотрудника?')) return;
        await apiFetch(`/api/v1/team/${btn.dataset.id}/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
        hydrateTeam();
      });
    });
  } catch (e) { grid.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

function openMemberDialog(member = null) {
  const dialog = document.getElementById('memberDialog');
  if (!dialog) return;
  const title = document.getElementById('memberDialogTitle');
  if (title) title.textContent = member ? 'Редактировать' : 'Новый сотрудник';
  document.getElementById('memberEditId').value = member?.id || '';
  document.getElementById('memberName').value = member?.name || '';
  document.getElementById('memberEmail').value = member?.email || '';
  document.getElementById('memberRole').value = member?.role || 'Technician';
  document.getElementById('memberTrade').value = member?.trade || '';
  document.getElementById('memberPhone').value = member?.phone || '';
  document.getElementById('memberAvailability').value = member?.availability || 'available';
  document.getElementById('memberSkills').value = (member?.skills || []).join(', ');
  document.getElementById('memberNotes').value = member?.notes || '';
  dialog.showModal();
}

function setupTeam() {
  const addBtn = document.getElementById('addMemberBtn');
  const dialog = document.getElementById('memberDialog');
  const closeBtn = document.getElementById('closeMemberDialog');
  const cancelBtn = document.getElementById('cancelMemberDialog');
  const form = document.getElementById('memberForm');
  if (!dialog) return;

  addBtn?.addEventListener('click', () => openMemberDialog(null));
  closeBtn?.addEventListener('click', () => dialog.close());
  cancelBtn?.addEventListener('click', () => dialog.close());

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const editId = document.getElementById('memberEditId').value;
    const payload = {
      name: document.getElementById('memberName').value.trim(),
      email: document.getElementById('memberEmail').value.trim(),
      role: document.getElementById('memberRole').value,
      trade: document.getElementById('memberTrade').value.trim(),
      phone: document.getElementById('memberPhone').value.trim(),
      availability: document.getElementById('memberAvailability').value,
      skills: document.getElementById('memberSkills').value.split(',').map(s=>s.trim()).filter(Boolean),
      notes: document.getElementById('memberNotes').value.trim(),
    };
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      if (editId) {
        await apiFetch(`/api/v1/team/${editId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      } else {
        await apiFetch('/api/v1/team', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      }
      dialog.close(); hydrateTeam();
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  });
}

// ── AI Approval Queue ────────────────────────────────────────────────────
const ACTION_TYPE_LABELS = {
  'task.update': 'Обновление задачи',
  'task.create': 'Создание задачи',
  'project.update': 'Обновление проекта',
  'daily_update.create': 'Создание отчёта',
  'daily_update.update': 'Изменение отчёта',
  'location.update': 'Обновление локации',
  'object.delete': 'Удаление файла',
};
const STATUS_STYLE = { pending: '#f59e0b', approved: '#34d399', rejected: '#e05353', expired: '#445060' };
const STATUS_LABEL = { pending: 'Ожидает', approved: 'Одобрено', rejected: 'Отклонено', expired: 'Истекло' };

async function hydrateAIApprovals(statusFilter) {
  const el = document.getElementById('aiApprovalsList');
  const badge = document.getElementById('approvalPendingBadge');
  if (!el) return;
  const filter = statusFilter ?? document.getElementById('approvalStatusFilter')?.value ?? 'pending';
  try {
    const qs = filter ? `?status=${encodeURIComponent(filter)}` : '';
    const resp = await apiFetch(`/api/v1/admin/ai-approvals${qs}`);
    const { approvals } = await resp.json();
    // Update pending badge regardless of filter
    if (!filter || filter === 'pending') {
      const pendingCount = approvals.filter(a => a.status === 'pending').length;
      if (badge) { badge.textContent = `${pendingCount} ожидают`; badge.style.display = pendingCount ? '' : 'none'; }
    }
    if (!approvals.length) {
      el.innerHTML = `<p class="empty-copy">Нет записей${filter ? ` со статусом «${STATUS_LABEL[filter] || filter}»` : ''}.</p>`;
      return;
    }
    el.innerHTML = approvals.map(a => {
      const color = STATUS_STYLE[a.status] || '#778195';
      const label = ACTION_TYPE_LABELS[a.action_type] || a.action_type;
      const ev = a.evidence || {};
      const payload = a.action_payload || {};
      return `<div class="approval-card" data-id="${a.id}" data-status="${a.status}">
        <div class="approval-header">
          <span class="approval-type">${escapeHtml(label)}</span>
          <span class="approval-status" style="color:${color}">● ${STATUS_LABEL[a.status] || a.status}</span>
          <span class="approval-time">${(a.created_at||'').slice(0,16).replace('T',' ')}</span>
        </div>
        <div class="approval-body">
          ${ev.summary ? `<p class="approval-evidence">${escapeHtml(ev.summary)}</p>` : ''}
          ${Object.keys(payload).length ? `<details class="approval-payload"><summary>Детали изменения</summary><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></details>` : ''}
          ${ev.sources?.length ? `<div class="approval-sources"><strong>Источники:</strong> ${ev.sources.map(s => escapeHtml(s)).join(', ')}</div>` : ''}
        </div>
        ${a.status === 'pending' ? `<div class="approval-actions">
          <input class="approval-note-input" type="text" placeholder="Комментарий (необязательно)" data-for="${a.id}" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px">
          <button class="button primary approval-approve-btn" data-id="${a.id}" type="button" style="padding:5px 14px;font-size:12px">Одобрить</button>
          <button class="button ghost approval-reject-btn" data-id="${a.id}" type="button" style="padding:5px 14px;font-size:12px;color:#e05353;border-color:#e05353">Отклонить</button>
        </div>` : a.reviewer_note ? `<p class="approval-note">Комментарий: ${escapeHtml(a.reviewer_note)}</p>` : ''}
      </div>`;
    }).join('');

    el.querySelectorAll('.approval-approve-btn,.approval-reject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const action = btn.classList.contains('approval-approve-btn') ? 'approve' : 'reject';
        const noteEl = el.querySelector(`.approval-note-input[data-for="${id}"]`);
        const note = noteEl?.value.trim() || '';
        btn.disabled = true;
        try {
          await apiFetch(`/api/v1/admin/ai-approvals/${encodeURIComponent(id)}/${action}`, {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ note }),
          });
          toast(action === 'approve' ? 'Действие одобрено' : 'Действие отклонено');
          hydrateAIApprovals();
        } catch (e) { toast(e.message); btn.disabled = false; }
      });
    });
  } catch (e) { el.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

function setupAIApprovals() {
  const filter = document.getElementById('approvalStatusFilter');
  if (filter) filter.addEventListener('change', () => hydrateAIApprovals(filter.value));
}

// ── Language toggle ───────────────────────────────────────────────────────
function _updateLangBtn() {
  const btn = document.getElementById('langToggleBtn');
  if (btn) btn.textContent = getLang().toUpperCase();
}

function setupLangToggle() {
  _updateLangBtn();
  applyI18n();
  document.getElementById('langToggleBtn')?.addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'ru' : 'en');
    _updateLangBtn();
  });
}

// ── AI Router / Gateway ───────────────────────────────────────────────────
async function hydrateAiGateway() {
  const badge = document.getElementById('aiRouterStatusBadge');
  try {
    const { config, available, key_set } = await apiFetch('/api/v1/ai/status');
    if (badge) {
      const color = available ? 'var(--accent)' : '#e05353';
      const label = available ? t('AI_STATUS_OK') : (key_set ? t('AI_STATUS_OFF') : t('AI_STATUS_NO_KEY'));
      badge.textContent = label;
      badge.style.color = color;
      badge.removeAttribute('data-i18n');
    }
    // Populate form
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('aiProvider', config.provider || 'anthropic');
    set('aiModel', config.model || '');
    set('aiEnvKeyVar', config.env_key_var || 'ANTHROPIC_API_KEY');
    set('aiMaxTokens', config.max_tokens || 1024);
    const enabledEl = document.getElementById('aiEnabled');
    if (enabledEl) enabledEl.checked = config.enabled !== false && config.enabled !== 0;
  } catch { if (badge) { badge.textContent = '● Ошибка'; badge.style.color = '#e05353'; } }
}

function setupAiGateway() {
  hydrateAiGateway();

  document.getElementById('aiRouterConfigForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const config = {
      provider: document.getElementById('aiProvider')?.value || 'anthropic',
      model: document.getElementById('aiModel')?.value || '',
      env_key_var: document.getElementById('aiEnvKeyVar')?.value || 'ANTHROPIC_API_KEY',
      max_tokens: parseInt(document.getElementById('aiMaxTokens')?.value || '1024', 10),
      temperature: 0.3,
      enabled: document.getElementById('aiEnabled')?.checked ?? true,
    };
    try {
      await apiFetch('/api/v1/ai/config', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify(config),
      });
      toast('Конфигурация AI сохранена');
      hydrateAiGateway();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });

  document.getElementById('aiClassifyBtn')?.addEventListener('click', async () => {
    const text = document.getElementById('aiTestPrompt')?.value?.trim();
    if (!text) return;
    const resultEl = document.getElementById('aiTestResult');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    resultEl.textContent = 'Классификация…';
    try {
      const r = await apiFetch('/api/v1/ai/classify', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify({ text }),
      });
      resultEl.textContent = `Intent: ${r.intent}  Confidence: ${(r.confidence*100).toFixed(0)}%\nTags: ${r.tags.join(', ') || '—'}`;
    } catch(e) { resultEl.textContent = `Ошибка: ${e.message}`; }
  });

  document.getElementById('aiInvokeBtn')?.addEventListener('click', async () => {
    const prompt = document.getElementById('aiTestPrompt')?.value?.trim();
    if (!prompt) return;
    const resultEl = document.getElementById('aiTestResult');
    if (!resultEl) return;
    const btn = document.getElementById('aiInvokeBtn');
    btn.disabled = true;
    resultEl.style.display = 'block';
    resultEl.textContent = 'Отправка запроса…';
    try {
      const r = await apiFetch('/api/v1/ai/invoke', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify({ prompt, intent: 'test' }),
      });
      resultEl.textContent = `[${r.provider} · ${r.model} · ${r.latency_ms}ms · ${r.prompt_tokens}+${r.completion_tokens} tokens]\n\n${r.text}`;
    } catch(e) { resultEl.textContent = `Ошибка: ${e.message}`; }
    finally { btn.disabled = false; }
  });

  document.getElementById('loadAiLogBtn')?.addEventListener('click', async () => {
    const logEl = document.getElementById('aiInvocationLog');
    if (!logEl) return;
    try {
      const { log = [] } = await apiFetch('/api/v1/ai/log?limit=50');
      if (!log.length) { logEl.innerHTML = '<p class="empty-copy">Вызовов нет.</p>'; return; }
      logEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="color:var(--text-secondary);text-align:left;border-bottom:1px solid var(--border)">
          <th style="padding:5px 8px">Время</th><th style="padding:5px 8px">Интент</th>
          <th style="padding:5px 8px">Провайдер</th><th style="padding:5px 8px">Токены</th>
          <th style="padding:5px 8px">ms</th><th style="padding:5px 8px">Ошибка</th>
        </tr></thead>
        <tbody>${log.map(e => {
          const dt = new Date(e.created_at).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
          return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:5px 8px;white-space:nowrap">${dt}</td>
            <td style="padding:5px 8px">${escapeHtml(e.intent)}</td>
            <td style="padding:5px 8px">${escapeHtml(e.provider)} / ${escapeHtml(e.model)}</td>
            <td style="padding:5px 8px">${e.prompt_tokens}+${e.completion_tokens}</td>
            <td style="padding:5px 8px">${e.latency_ms}</td>
            <td style="padding:5px 8px;color:#e05353">${e.error ? escapeHtml(e.error.slice(0,60)) : ''}</td>
          </tr>`;
        }).join('')}</tbody></table>`;
    } catch(e) { logEl.innerHTML = `<p style="color:#e05353">${e.message}</p>`; }
  });
}

// ── Knowledge Search ───────────────────────────────────────────────────────
function setupKnowledgeSearch() {
  const inp = document.getElementById('knowledgeSearchInput');
  const btn = document.getElementById('knowledgeSearchBtn');
  const rebuildBtn = document.getElementById('rebuildKnowledgeBtn');
  if (!inp || !btn) return;

  const doSearch = async () => {
    const q = inp.value.trim();
    const el = document.getElementById('knowledgeSearchResults');
    if (!el) return;
    if (!q) { el.innerHTML = ''; return; }
    el.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">Поиск…</p>';
    try {
      const resp = await apiFetch(`/api/v1/knowledge/search?q=${encodeURIComponent(q)}&limit=10`);
      const { results = [] } = resp;
      if (!results.length) { el.innerHTML = '<p class="empty-copy">Ничего не найдено.</p>'; return; }
      el.innerHTML = results.map(r => {
        const snippet = r.snippet || r.chunk_text?.slice(0, 200) || '';
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
            <span style="font-weight:600;font-size:14px">${escapeHtml(r.object_name||'Документ')}</span>
            <span style="font-size:11px;color:var(--text-secondary)">${escapeHtml(r.mime_type||'')}</span>
          </div>
          <div style="font-size:13px;line-height:1.6;color:var(--text-secondary)">${snippet.replace(/<b>/g,'<strong>').replace(/<\/b>/g,'</strong>')}</div>
        </div>`;
      }).join('');
    } catch(e) { el.innerHTML = `<p style="color:#e05353">${e.message}</p>`; }
  };

  btn.addEventListener('click', doSearch);
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') doSearch(); });

  rebuildBtn?.addEventListener('click', async () => {
    rebuildBtn.disabled = true; rebuildBtn.textContent = 'Пересборка…';
    try {
      const r = await apiFetch('/api/v1/knowledge/rebuild', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}), body: '{}',
      });
      toast(`Индекс пересобран: ${r.rebuilt} документов, ${r.skipped} пропущено`);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
    finally { rebuildBtn.disabled = false; rebuildBtn.textContent = '↺ Пересобрать индекс'; }
  });

  // Retrieval audit log
  const logBtn = document.getElementById('loadRetrievalLogBtn');
  logBtn?.addEventListener('click', async () => {
    const logEl = document.getElementById('retrievalLogList');
    if (!logEl) return;
    logBtn.disabled = true;
    try {
      const { log = [] } = await apiFetch('/api/v1/knowledge/log?limit=50');
      if (!log.length) { logEl.innerHTML = '<p class="empty-copy">Записей нет.</p>'; return; }
      const POLICY_COLOR = { org:'var(--accent)', project:'var(--accent-yellow,#e09800)', restricted:'#e05353' };
      logEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="color:var(--text-secondary);text-align:left;border-bottom:1px solid var(--border)">
          <th style="padding:6px 8px">Время</th><th style="padding:6px 8px">Пользователь</th>
          <th style="padding:6px 8px">Запрос</th><th style="padding:6px 8px">Результаты</th>
          <th style="padding:6px 8px">Отфильтровано</th>
        </tr></thead>
        <tbody>${log.map(e => {
          const dt = new Date(e.created_at).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
          const filtered = e.filtered_count > 0
            ? `<span style="color:#e05353;font-weight:600">${e.filtered_count}</span>`
            : '—';
          return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:7px 8px;white-space:nowrap">${dt}</td>
            <td style="padding:7px 8px">${escapeHtml(e.user_id||'—')} <span style="color:var(--text-secondary)">${escapeHtml(e.user_role||'')}</span></td>
            <td style="padding:7px 8px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.query)}</td>
            <td style="padding:7px 8px">${e.result_count}</td>
            <td style="padding:7px 8px">${filtered}</td>
          </tr>`;
        }).join('')}</tbody></table>`;
    } catch(err) { logEl.innerHTML = `<p style="color:#e05353">${err.message}</p>`; }
    finally { logBtn.disabled = false; }
  });
}

// ── Time Tracking ──────────────────────────────────────────────────────────
const HOURS_COLOR = (h) => h >= 8 ? 'var(--accent-red,#e05353)' : h >= 6 ? 'var(--accent-yellow,#e09800)' : 'var(--accent,#4f8ef7)';

async function hydrateTimeTracking() {
  const days = document.getElementById('utilizationDays')?.value || 30;
  const listEl = document.getElementById('utilizationList');
  const sessEl = document.getElementById('sessionsTable');
  if (!listEl) return;
  try {
    const [utilRes, sessRes] = await Promise.all([
      fetch(`/api/v1/time/utilization?days=${days}`, { headers: apiHeaders({ Accept: 'application/json' }) }),
      fetch('/api/v1/time?limit=20', { headers: apiHeaders({ Accept: 'application/json' }) }),
    ]);
    const { utilization = [] } = utilRes.ok ? await utilRes.json() : {};
    const { sessions = [] } = sessRes.ok ? await sessRes.json() : {};
    // Utilization cards
    if (!utilization.length) {
      listEl.innerHTML = '<p class="empty-copy">Нет данных за выбранный период.</p>';
    } else {
      const maxH = Math.max(...utilization.map(u => u.totalHours), 1);
      listEl.innerHTML = utilization.map(u => {
        const pct = Math.round((u.totalHours / maxH) * 100);
        const color = HOURS_COLOR(u.totalHours);
        const avBadge = u.availability === 'available' ? 'var(--accent-green,#2bb46a)' : u.availability === 'off' ? 'var(--text-secondary)' : 'var(--accent-yellow,#e09800)';
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div>
              <span style="font-weight:600;font-size:14px">${u.name}</span>
              <span style="font-size:12px;color:var(--text-secondary);margin-left:8px">${u.trade||''}</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:12px;font-weight:600;color:${color}">${u.totalHours}ч / ${u.session_count} сессий</span>
              <span style="width:8px;height:8px;border-radius:50%;background:${avBadge};display:inline-block"></span>
            </div>
          </div>
          <div style="background:var(--bg);border-radius:4px;height:6px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width .3s"></div>
          </div>
        </div>`;
      }).join('');
    }
    // Recent sessions table
    if (!sessEl) return;
    if (!sessions.length) {
      sessEl.innerHTML = '<p class="empty-copy">Нет сессий.</p>';
    } else {
      sessEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:var(--text-secondary);text-align:left;border-bottom:1px solid var(--border)">
          <th style="padding:6px 10px">Сотрудник</th><th style="padding:6px 10px">Проект</th>
          <th style="padding:6px 10px">Начало</th><th style="padding:6px 10px">Мин.</th>
          <th style="padding:6px 10px">Заметки</th><th style="padding:6px 10px">Статус</th>
        </tr></thead>
        <tbody>${sessions.map(s => {
          const dt = s.started_at ? new Date(s.started_at).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
          const proj = projects.find(p => p.id === s.project_id);
          const status = !s.ended_at ? '<span style="color:var(--accent)">● Активна</span>' : s.approved ? '<span style="color:var(--accent-green,#2bb46a)">✓ Одобрена</span>' : '<span style="color:var(--text-secondary)">Завершена</span>';
          return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 10px">${s.member_name||'—'}</td>
            <td style="padding:8px 10px">${proj?.name||s.project_id||'—'}</td>
            <td style="padding:8px 10px">${dt}</td>
            <td style="padding:8px 10px">${s.duration_min||'—'}</td>
            <td style="padding:8px 10px">${s.notes||''}</td>
            <td style="padding:8px 10px">${status}</td>
          </tr>`;
        }).join('')}</tbody></table>`;
    }
  } catch(e) { if (listEl) listEl.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

function setupTimeTracking() {
  const daysEl = document.getElementById('utilizationDays');
  if (daysEl) daysEl.addEventListener('change', hydrateTimeTracking);

  const logBtn = document.getElementById('logTimeBtn');
  const dialog = document.getElementById('logTimeDialog');
  const cancelBtn = document.getElementById('cancelLogTimeBtn');
  const submitBtn = document.getElementById('submitLogTimeBtn');
  if (!logBtn || !dialog) return;

  logBtn.addEventListener('click', () => {
    // Populate member select
    const memberSel = document.getElementById('logMemberId');
    const projSel = document.getElementById('logProjectId');
    if (memberSel) {
      fetch('/api/v1/team', { headers: apiHeaders({ Accept: 'application/json' }) })
        .then(r => r.json())
        .then(({ members = [] }) => {
          memberSel.innerHTML = members.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
        }).catch(() => {});
    }
    if (projSel) {
      projSel.innerHTML = projects.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    }
    const dtEl = document.getElementById('logStartedAt');
    if (dtEl) dtEl.value = new Date().toISOString().slice(0,16);
    dialog.showModal();
  });

  cancelBtn?.addEventListener('click', () => dialog.close());

  submitBtn?.addEventListener('click', async () => {
    const memberId = document.getElementById('logMemberId')?.value || '';
    const projectId = document.getElementById('logProjectId')?.value || '';
    const startedAt = document.getElementById('logStartedAt')?.value || new Date().toISOString();
    const durationMin = parseInt(document.getElementById('logDurationMin')?.value || '60', 10);
    const notes = document.getElementById('logNotes')?.value || '';
    try {
      await apiFetchOrQueue('/api/v1/time/log', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key': createIdempotencyKey()}),
        body: JSON.stringify({ memberId, projectId, startedAt: new Date(startedAt).toISOString(), durationMin, notes }),
      }, { label: 'Запись времени', method: 'POST', path: '/api/v1/time/log', body: {memberId, projectId, durationMin, notes} });
      dialog.close();
      toast('Время записано');
      hydrateTimeTracking();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
}

// ── Tech PWA View ─────────────────────────────────────────────────────────

let _techSetupDone = false;
let _mediaRecorder = null;
let _voiceChunks = [];
let _voiceTimerInterval = null;
let _uploadQueue = [];  // [{id, file, projectId, note, status, progress}]

// ── Bottom-nav tab switcher ───────────────────────────────────────────────
function _switchTechTab(tab) {
  document.querySelectorAll('.tech-tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tech-nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.techTab === tab));
  const target = document.getElementById(`tech-tab-${tab}`);
  if (target) target.classList.add('active');
  if (tab === 'capture') _populateCaptureProjectSelect();
  if (tab === 'report') _populateReportProjectSelect();
}

function setupTechBottomNav() {
  document.querySelectorAll('.tech-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => _switchTechTab(btn.dataset.techTab));
  });
}

// ── Home tab ─────────────────────────────────────────────────────────────
function _techGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

function _renderTechHomeCards() {
  const el = document.getElementById('techHomeProjectCards');
  if (!el) return;
  const greetEl = document.getElementById('techGreeting');
  if (greetEl) greetEl.textContent = _techGreeting();
  if (!projects.length) { el.innerHTML = '<p class="empty-copy">Нет доступных проектов.</p>'; return; }
  const active = projects.filter(p => p.status === 'active' || !p.status).slice(0, 6);
  el.innerHTML = active.map(p => {
    const loc = p.locations?.length || 0;
    const pct = p.completionPercent ?? 0;
    return `<div class="tech-project-card" onclick="location.hash='project/${encodeURIComponent(p.id)}'">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <span style="font-weight:700;font-size:15px">${escapeHtml(p.name)}</span>
        <span style="font-size:11px;color:var(--text-secondary)">${loc} локаций</span>
      </div>
      <div style="background:var(--bg);border-radius:4px;height:4px;overflow:hidden;margin-bottom:8px">
        <div style="width:${pct}%;height:100%;background:var(--accent);border-radius:4px"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary)">
        <span>${escapeHtml(p.client || p.address || '')}</span>
        <span>${pct}% выполнено</span>
      </div>
    </div>`;
  }).join('');
}

// ── Tasks tab ─────────────────────────────────────────────────────────────
async function _renderTechTasks() {
  const el = document.getElementById('techTasksList');
  if (!el) return;
  try {
    const resp = await fetch('/api/v1/projects', { headers: apiHeaders({ Accept: 'application/json' }) });
    const { projects: all = [] } = resp.ok ? await resp.json() : {};
    // Collect work items from all projects (that have them)
    const items = [];
    for (const p of all) {
      (p.workItems || []).forEach(wi => { if (wi.status !== 'done') items.push({ ...wi, projectName: p.name, projectId: p.id }); });
    }
    if (!items.length) { el.innerHTML = '<p class="empty-copy">Нет активных задач.</p>'; return; }
    const sorted = [...items].sort((a,b) => {
      const pri = {critical:0,high:1,medium:2,low:3};
      return (pri[a.priority]||2)-(pri[b.priority]||2);
    });
    const PRI_COLOR = { critical:'#e05353', high:'#e09800', medium:'var(--accent)', low:'var(--text-secondary)' };
    el.innerHTML = sorted.slice(0,30).map(wi => {
      const color = PRI_COLOR[wi.priority] || 'var(--text-secondary)';
      const done = wi.status === 'done';
      return `<div class="tech-task-card">
        <div class="tech-task-check ${done?'done':''}" data-wi-id="${wi.id}" data-proj-id="${wi.projectId}">
          ${done?'<span style="color:#fff;font-size:13px">✓</span>':''}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px">${escapeHtml(wi.title)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">
            ${escapeHtml(wi.projectName)}
            <span style="margin-left:8px;font-weight:700;color:${color}">${wi.priority||''}</span>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch(e) { el.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

// ── Capture tab (FS-030) ──────────────────────────────────────────────────
function _populateCaptureProjectSelect() {
  const sel = document.getElementById('techCaptureProject');
  if (!sel || sel.options.length > 1) return;
  projects.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
}

function _populateReportProjectSelect() {
  const sel = document.getElementById('techReportProject');
  if (!sel || sel.options.length > 0) return;
  projects.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
}

function _compressImage(file, maxPx = 1920, quality = 0.82) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxPx || height > maxPx) {
        if (width > height) { height = Math.round(height * maxPx / width); width = maxPx; }
        else { width = Math.round(width * maxPx / height); height = maxPx; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

function _renderUploadQueue() {
  const wrap = document.getElementById('techUploadQueue');
  const list = document.getElementById('techUploadQueueList');
  if (!wrap || !list) return;
  wrap.style.display = _uploadQueue.length ? '' : 'none';
  list.innerHTML = _uploadQueue.map(item => {
    const icon = item.file.type.startsWith('audio') ? '🎤' : '🖼';
    const name = item.file.name?.slice(0, 24) || 'файл';
    const pct = item.progress || 0;
    const statusText = item.status === 'uploading' ? `${pct}%` : item.status === 'done' ? '✓ Загружено' : item.status === 'error' ? '✕ Ошибка' : 'Ожидание…';
    return `<div class="upload-item">
      <span style="font-size:20px">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>
        <div class="upload-progress"><div class="upload-progress-bar" style="width:${pct}%"></div></div>
      </div>
      <span style="font-size:12px;color:var(--text-secondary)">${statusText}</span>
    </div>`;
  }).join('');
}

async function _uploadCapturedFile(file, projectId, note) {
  const compressed = file.type.startsWith('image') ? await _compressImage(file) : file;
  const id = crypto.randomUUID();
  const ext = file.type.startsWith('audio') ? '.webm' : '.jpg';
  const fname = `capture_${new Date().toISOString().replace(/[:.]/g,'_')}${ext}`;
  _uploadQueue.push({ id, file: compressed, projectId, note, status: 'pending', progress: 0 });
  _renderUploadQueue();

  const item = _uploadQueue.find(q => q.id === id);
  item.status = 'uploading';
  _renderUploadQueue();

  try {
    const resp = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/objects`, {
      method: 'POST',
      headers: {
        ...apiHeaders({}),
        'Content-Type': compressed.type || 'application/octet-stream',
        'X-File-Name': fname,
        'Idempotency-Key': createIdempotencyKey(),
      },
      body: compressed,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    item.status = 'done'; item.progress = 100;
    toast('Файл загружен');
  } catch(e) {
    item.status = 'error';
    // Queue for offline retry
    _enqueueWrite({ label: `Загрузка: ${fname}`, method: 'POST', path: `/api/v1/projects/${projectId}/objects`, binary: true });
    toast('Добавлено в очередь (офлайн)');
  }
  _renderUploadQueue();
}

function setupCapture() {
  // Camera input
  ['techCameraInput','techGalleryInput'].forEach(id => {
    const inp = document.getElementById(id);
    if (!inp) return;
    inp.addEventListener('change', async () => {
      const projectId = document.getElementById('techCaptureProject')?.value || '';
      const note = document.getElementById('techCaptureNote')?.value || '';
      for (const file of inp.files) await _uploadCapturedFile(file, projectId, note);
      inp.value = '';
    });
  });

  // Voice note
  const startBtn = document.getElementById('techVoiceStartBtn');
  const stopBtn = document.getElementById('techVoiceStopBtn');
  const timerEl = document.getElementById('techVoiceTimer');

  startBtn?.addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia) { toast('Микрофон недоступен'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _voiceChunks = [];
      _mediaRecorder = new MediaRecorder(stream);
      _mediaRecorder.ondataavailable = ev => { if (ev.data.size > 0) _voiceChunks.push(ev.data); };
      _mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(_voiceTimerInterval);
        if (timerEl) timerEl.style.display = 'none';
        if (!_voiceChunks.length) return;
        const blob = new Blob(_voiceChunks, { type: 'audio/webm' });
        const file = new File([blob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
        const projectId = document.getElementById('techCaptureProject')?.value || '';
        const note = document.getElementById('techCaptureNote')?.value || '';
        if (projectId) await _uploadCapturedFile(file, projectId, note);
        else toast('Выберите проект для привязки голосовой заметки');
      };
      _mediaRecorder.start(200);
      let secs = 0;
      if (timerEl) { timerEl.style.display = ''; timerEl.textContent = '00:00'; }
      _voiceTimerInterval = setInterval(() => {
        secs++;
        if (timerEl) timerEl.textContent = `${String(Math.floor(secs/60)).padStart(2,'0')}:${String(secs%60).padStart(2,'0')}`;
        if (secs >= 300) stopBtn?.click(); // max 5 min
      }, 1000);
      startBtn.style.display = 'none'; stopBtn.style.display = '';
    } catch(e) { toast(`Ошибка микрофона: ${e.message}`); }
  });

  stopBtn?.addEventListener('click', () => {
    _mediaRecorder?.stop();
    startBtn.style.display = ''; stopBtn.style.display = 'none';
  });
}

// ── Report tab ────────────────────────────────────────────────────────────
function setupTechReport() {
  const btn = document.getElementById('techSubmitReportBtn');
  const status = document.getElementById('techReportStatus');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const projectId = document.getElementById('techReportProject')?.value || '';
    const notes = document.getElementById('techReportNotes')?.value?.trim() || '';
    if (!projectId) { toast('Выберите проект'); return; }
    if (!notes) { toast('Введите заметки о работе'); return; }
    btn.disabled = true;
    try {
      await apiFetchOrQueue(`/api/v1/projects/${encodeURIComponent(projectId)}/daily-updates`, {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify({ notes, workDate: new Date().toISOString().slice(0,10) }),
      }, { label: 'Ежедневный отчёт', method: 'POST', path: `/api/v1/projects/${projectId}/daily-updates`, body: { notes } });
      document.getElementById('techReportNotes').value = '';
      if (status) { status.style.display=''; status.textContent='✓ Отчёт отправлен'; }
      toast('Отчёт отправлен');
    } catch(e) {
      if (status) { status.style.display=''; status.textContent=`Ошибка: ${e.message}`; }
    } finally { btn.disabled = false; }
  });
}

// ── Main entry ────────────────────────────────────────────────────────────
async function hydrateTechView(tab = 'home') {
  if (!_techSetupDone) {
    setupTechBottomNav();
    setupCapture();
    setupTechReport();
    _techSetupDone = false; // reset on each project render
  }
  _switchTechTab(tab);
  _renderTechHomeCards();
  if (tab === 'tasks') _renderTechTasks();
}

// ── Digital Twin graph ─────────────────────────────────────────────────────

const REL_COLOR = {
  connects_to: '#4f8ef7', powers: '#e09800', feeds: '#2bb46a',
  backs_up: '#a87aff', contains: '#30d7d7', links_to: '#8b8fa8', depends_on: '#ff657b',
};
const REL_LABEL = {
  connects_to:'connects', powers:'powers', feeds:'feeds',
  backs_up:'backs up', contains:'contains', links_to:'links', depends_on:'depends on',
};

function renderAssetGraph(container, assets, relationships) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 900, H = 500;
  const R = 28; // node radius
  const MIN_DIST = R * 2.4;
  const SPRING_LEN = 180;
  const REPULSION = 14000;

  // Spiral initial layout
  const nodes = assets.map((a, i) => {
    const angle = i * 2.399963;
    const r = 50 * Math.sqrt(i + 1);
    return { id: a.id, a, x: W/2 + Math.cos(angle)*r, y: H/2 + Math.sin(angle)*r, vx:0, vy:0 };
  });
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const edges = relationships.map(r => ({
    from: r.from_asset_id, to: r.to_asset_id,
    type: r.relation_type || 'connects_to', label: r.label || '',
  })).filter(e => nodeMap.has(e.from) && nodeMap.has(e.to));

  // Force layout
  for (let iter = 0; iter < 200; iter++) {
    const alpha = Math.pow(1 - iter / 200, 1.6);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i+1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x-a.x, dy = b.y-a.y;
        const d2 = dx*dx+dy*dy||0.01, dist = Math.sqrt(d2);
        const rep = (REPULSION/d2)*alpha + (dist<MIN_DIST?(MIN_DIST-dist)*3:0);
        const fx=(dx/dist)*rep, fy=(dy/dist)*rep;
        a.vx-=fx; a.vy-=fy; b.vx+=fx; b.vy+=fy;
      }
    }
    edges.forEach(e => {
      const a=nodeMap.get(e.from), b=nodeMap.get(e.to); if(!a||!b) return;
      const dx=b.x-a.x, dy=b.y-a.y, dist=Math.sqrt(dx*dx+dy*dy)||1;
      const f=(dist-SPRING_LEN)*0.04*alpha;
      const fx=(dx/dist)*f, fy=(dy/dist)*f;
      a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy;
    });
    nodes.forEach(n => {
      n.vx+=(W/2-n.x)*0.004*alpha; n.vy+=(H/2-n.y)*0.004*alpha;
      n.vx*=0.78; n.vy*=0.78; n.x+=n.vx; n.y+=n.vy;
    });
  }

  container.innerHTML = '';

  // Legend
  const legend = document.createElement('div');
  legend.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;font-size:11px';
  legend.innerHTML = Object.entries(REL_LABEL).map(([k,v])=>
    `<span style="display:flex;align-items:center;gap:4px">
      <span style="width:20px;height:2px;background:${REL_COLOR[k]||'#555'};display:inline-block"></span>
      <span style="color:var(--text-secondary)">${v}</span>
    </span>`).join('');
  container.appendChild(legend);

  const wrap = document.createElement('div');
  wrap.className = 'graph-canvas graph-canvas--interactive';
  wrap.style.cssText = 'height:480px;border-radius:10px;';
  container.appendChild(wrap);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width','100%'); svg.setAttribute('height','100%');
  svg.style.cssText='display:block;cursor:grab;user-select:none;touch-action:none;';
  wrap.appendChild(svg);

  // Arrowhead defs
  const defs = document.createElementNS(NS, 'defs');
  Object.entries(REL_COLOR).forEach(([type, color]) => {
    const m = document.createElementNS(NS, 'marker');
    m.setAttribute('id',`dtarr-${type}`); m.setAttribute('markerWidth','7'); m.setAttribute('markerHeight','5');
    m.setAttribute('refX','6'); m.setAttribute('refY','2.5'); m.setAttribute('orient','auto');
    const p = document.createElementNS(NS, 'polygon');
    p.setAttribute('points','0 0, 7 2.5, 0 5'); p.setAttribute('fill',color); p.setAttribute('opacity','0.8');
    m.appendChild(p); defs.appendChild(m);
  });
  svg.appendChild(defs);

  const root = document.createElementNS(NS, 'g');
  svg.appendChild(root);
  let tx=0, ty=0, scale=1;
  const applyT = () => root.setAttribute('transform',`translate(${tx},${ty}) scale(${scale})`);
  applyT();

  // Draw edges
  const edgeElems = edges.map(e => {
    const color = REL_COLOR[e.type]||'#536078';
    const g = document.createElementNS(NS,'g');

    const line = document.createElementNS(NS,'line');
    line.setAttribute('stroke',color); line.setAttribute('stroke-width','1.5');
    line.setAttribute('stroke-opacity','0.7');
    line.setAttribute('marker-end',`url(#dtarr-${e.type})`);
    g.appendChild(line);

    if (e.label) {
      const txt = document.createElementNS(NS,'text');
      txt.setAttribute('font-size','9'); txt.setAttribute('fill',color);
      txt.setAttribute('text-anchor','middle'); txt.setAttribute('opacity','0.8');
      txt.textContent = e.label.slice(0,18);
      g.appendChild(txt);
    }
    root.insertBefore(g, root.firstChild);
    return { g, line, label: e.label ? g.querySelector('text') : null, from: e.from, to: e.to };
  });

  const updateEdge = (elem) => {
    const a=nodeMap.get(elem.from), b=nodeMap.get(elem.to); if(!a||!b) return;
    // Shorten line to stop at node radius
    const dx=b.x-a.x, dy=b.y-a.y, dist=Math.sqrt(dx*dx+dy*dy)||1;
    const sx=a.x+(dx/dist)*R, sy=a.y+(dy/dist)*R;
    const ex=b.x-(dx/dist)*(R+6), ey=b.y-(dy/dist)*(R+6);
    elem.line.setAttribute('x1',sx); elem.line.setAttribute('y1',sy);
    elem.line.setAttribute('x2',ex); elem.line.setAttribute('y2',ey);
    if (elem.label) { elem.label.setAttribute('x',(sx+ex)/2); elem.label.setAttribute('y',(sy+ey)/2-3); }
  };
  edgeElems.forEach(updateEdge);

  // Draw nodes
  const ICON = ASSET_TYPE_ICON;
  const nodeElems = nodes.map(n => {
    const asset = n.a;
    const statusColor = { planned:'#536078', installed:'#4f8ef7', active:'#2bb46a', faulty:'#e05353', decommissioned:'#778195' }[asset.status]||'#536078';
    const g = document.createElementNS(NS,'g');
    g.style.cursor='pointer';

    const circle = document.createElementNS(NS,'circle');
    circle.setAttribute('r',R); circle.setAttribute('fill','var(--surface)');
    circle.setAttribute('stroke',statusColor); circle.setAttribute('stroke-width','2.5');
    g.appendChild(circle);

    const icon = document.createElementNS(NS,'text');
    icon.setAttribute('text-anchor','middle'); icon.setAttribute('dominant-baseline','central');
    icon.setAttribute('font-size','15'); icon.setAttribute('y','0');
    icon.textContent = ICON[asset.asset_type]||'📦';
    g.appendChild(icon);

    const label = document.createElementNS(NS,'text');
    label.setAttribute('text-anchor','middle'); label.setAttribute('y',R+13);
    label.setAttribute('font-size','10'); label.setAttribute('fill','var(--text)');
    label.textContent = asset.name.length>14?asset.name.slice(0,13)+'…':asset.name;
    g.appendChild(label);

    g.setAttribute('transform',`translate(${n.x},${n.y})`);
    root.appendChild(g);

    // Drag
    let drag=null;
    g.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      const svgRect = svg.getBoundingClientRect();
      drag = { ox:ev.clientX, oy:ev.clientY, nx:n.x, ny:n.y };
      g.setPointerCapture(ev.pointerId);
      svg.style.cursor='grabbing';
    });
    g.addEventListener('pointermove', ev => {
      if(!drag) return;
      ev.stopPropagation();
      n.x = drag.nx + (ev.clientX-drag.ox)/scale;
      n.y = drag.ny + (ev.clientY-drag.oy)/scale;
      g.setAttribute('transform',`translate(${n.x},${n.y})`);
      edgeElems.filter(e=>e.from===n.id||e.to===n.id).forEach(updateEdge);
    });
    g.addEventListener('pointerup', () => { drag=null; svg.style.cursor='grab'; });

    return g;
  });

  // Pan + zoom
  let pan=null;
  svg.addEventListener('pointerdown', ev=>{ if(ev.target===svg||ev.target===root){ pan={ox:ev.clientX-tx,oy:ev.clientY-ty}; svg.setPointerCapture(ev.pointerId); } });
  svg.addEventListener('pointermove', ev=>{ if(!pan) return; tx=ev.clientX-pan.ox; ty=ev.clientY-pan.oy; applyT(); });
  svg.addEventListener('pointerup', ()=>pan=null);
  svg.addEventListener('wheel', ev=>{ ev.preventDefault(); const s=Math.max(0.3,Math.min(3,scale*(1-ev.deltaY/600))); scale=s; applyT(); }, {passive:false});
}

// ── Digital Twin ───────────────────────────────────────────────────────────
const ASSET_STATUS_COLOR = { planned:'var(--text-secondary)', installed:'var(--accent)', active:'var(--accent-green,#2bb46a)', faulty:'#e05353', decommissioned:'var(--text-secondary)' };
const ASSET_TYPE_ICON = { device:'🖥', panel:'📟', port:'🔌', cable:'🔗', circuit:'⚡', sensor:'📡', other:'📦' };

async function hydrateDigitalTwin(projectId) {
  const section = document.getElementById('projectDigitalTwinSection');
  if (!section) return;
  let listEl = document.getElementById('assetsList');
  let graphEl = document.getElementById('assetGraph');
  if (!listEl) return;
  try {
    const resp = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/twin`, { headers: apiHeaders({ Accept: 'application/json' }) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { assets = [], relationships = [] } = await resp.json();

    // Tab switcher — create once
    if (!document.getElementById('twinTabList')) {
      const tabs = document.createElement('div');
      tabs.id = 'twinTabList';
      tabs.style.cssText = 'display:flex;gap:4px;margin-bottom:12px';
      tabs.innerHTML = `
        <button class="button ghost" id="twinTabListBtn" style="font-size:12px;padding:4px 12px;font-weight:600">Список</button>
        <button class="button ghost" id="twinTabGraphBtn" style="font-size:12px;padding:4px 12px">Граф</button>`;
      listEl.parentElement.insertBefore(tabs, listEl);
      // Create graph container
      const graphDiv = document.createElement('div');
      graphDiv.id = 'assetGraph';
      graphDiv.style.display = 'none';
      listEl.parentElement.appendChild(graphDiv);
      graphEl = graphDiv;
      const setTab = (tab) => {
        const isGraph = tab === 'graph';
        listEl.style.display = isGraph ? 'none' : '';
        graphEl.style.display = isGraph ? '' : 'none';
        document.getElementById('twinTabListBtn').style.fontWeight = isGraph ? '' : '700';
        document.getElementById('twinTabGraphBtn').style.fontWeight = isGraph ? '700' : '';
        if (isGraph) { renderAssetGraph(graphEl, assets, relationships); }
      };
      document.getElementById('twinTabListBtn').addEventListener('click', () => setTab('list'));
      document.getElementById('twinTabGraphBtn').addEventListener('click', () => setTab('graph'));
    }

    if (!assets.length) {
      listEl.innerHTML = '<p class="empty-copy">Оборудование не добавлено. Нажмите «＋ Оборудование».</p>';
      return;
    }
    // Build adjacency for relationship count display
    const relCount = {};
    for (const r of relationships) {
      relCount[r.from_asset_id] = (relCount[r.from_asset_id] || 0) + 1;
      relCount[r.to_asset_id] = (relCount[r.to_asset_id] || 0) + 1;
    }
    listEl.innerHTML = assets.map(a => {
      const icon = ASSET_TYPE_ICON[a.asset_type] || '📦';
      const color = ASSET_STATUS_COLOR[a.status] || 'var(--text-secondary)';
      const rels = relCount[a.id] || 0;
      const attrs = typeof a.attributes === 'object' ? Object.entries(a.attributes).map(([k,v]) => `${k}: ${v}`).join(' · ') : '';
      return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:13px 16px;display:flex;align-items:center;gap:12px">
        <span style="font-size:22px;width:32px;text-align:center">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-weight:600;font-size:14px">${escapeHtml(a.name)}</span>
            <span style="font-size:11px;font-weight:700;color:${color};background:${color}1a;padding:1px 6px;border-radius:4px;text-transform:uppercase">${a.status}</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${escapeHtml([a.make, a.model].filter(Boolean).join(' '))}${attrs ? ' · ' + escapeHtml(attrs) : ''}</div>
          ${rels ? `<div style="font-size:11px;color:var(--accent);margin-top:2px">⇌ ${rels} связей</div>` : ''}
        </div>
        <div style="display:flex;gap:6px">
          <button class="button ghost" style="font-size:11px;padding:4px 8px" data-edit-asset="${a.id}">Ред.</button>
          <button class="button ghost" style="font-size:11px;padding:4px 8px;color:#e05353" data-delete-asset="${a.id}">✕</button>
        </div>
      </div>`;
    }).join('');
    // Wire delete/edit buttons
    listEl.querySelectorAll('[data-delete-asset]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить оборудование?')) return;
        try {
          await apiFetch(`/api/v1/assets/${btn.dataset.deleteAsset}/delete`, { method: 'POST', headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key': createIdempotencyKey()}), body: '{}' });
          hydrateDigitalTwin(projectId);
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
    listEl.querySelectorAll('[data-edit-asset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const asset = assets.find(a => a.id === btn.dataset.editAsset);
        if (asset) openAssetDialog(projectId, asset);
      });
    });
  } catch(e) { listEl.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

function openAssetDialog(projectId, asset = null) {
  const dialog = document.getElementById('assetDialog');
  if (!dialog) return;
  document.getElementById('assetDialogTitle').textContent = asset ? 'Редактировать актив' : 'Новый актив';
  document.getElementById('assetDialogId').value = asset?.id || '';
  document.getElementById('assetName').value = asset?.name || '';
  document.getElementById('assetType').value = asset?.asset_type || 'device';
  document.getElementById('assetStatus').value = asset?.status || 'planned';
  document.getElementById('assetMake').value = asset?.make || '';
  document.getElementById('assetModel').value = asset?.model || '';
  document.getElementById('assetSerial').value = asset?.serial_number || '';
  document.getElementById('assetNotes').value = asset?.notes || '';
  dialog._projectId = projectId;
  const histBtn = document.getElementById('viewServiceHistoryBtn');
  if (histBtn) { histBtn.style.display = asset ? '' : 'none'; histBtn._asset = asset; }
  dialog.showModal();
}

// ── Service History ───────────────────────────────────────────────────────
const SVC_ICON = { inspection:'🔍', repair:'🔧', replacement:'🔄', config_change:'⚙️', calibration:'📐', note:'📝' };

async function openServiceHistory(assetId, assetName) {
  const dialog = document.getElementById('serviceHistoryDialog');
  const listEl = document.getElementById('serviceEventsList');
  if (!dialog || !listEl) return;
  document.getElementById('serviceHistoryTitle').textContent = assetName;
  dialog._assetId = assetId;
  listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">Загрузка…</p>';
  dialog.showModal();
  try {
    const resp = await apiFetch(`/api/v1/assets/${assetId}/service`);
    const { events = [] } = resp;
    if (!events.length) {
      listEl.innerHTML = '<p class="empty-copy">Событий нет.</p>';
      return;
    }
    listEl.innerHTML = events.map(e => {
      const dt = new Date(e.performed_at).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
      return `<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:18px;width:24px;flex-shrink:0">${SVC_ICON[e.event_type]||'📝'}</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;font-weight:600;text-transform:capitalize">${e.event_type.replace('_',' ')}</span>
            <span style="font-size:11px;color:var(--text-secondary)">${dt}</span>
          </div>
          ${e.performed_by?`<div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(e.performed_by)}</div>`:''}
          ${e.description?`<div style="font-size:13px;margin-top:4px">${escapeHtml(e.description)}</div>`:''}
        </div>
      </div>`;
    }).join('');
  } catch(ex) { listEl.innerHTML = `<p style="color:#e05353">${ex.message}</p>`; }
}

function setupServiceHistory() {
  const dialog = document.getElementById('serviceHistoryDialog');
  const closeBtn = document.getElementById('closeServiceHistoryDialog');
  const submitBtn = document.getElementById('submitServiceEventBtn');
  if (!dialog) return;
  closeBtn?.addEventListener('click', () => dialog.close());
  submitBtn?.addEventListener('click', async () => {
    const assetId = dialog._assetId;
    if (!assetId) return;
    const payload = {
      eventType: document.getElementById('svcEventType').value,
      performedBy: document.getElementById('svcPerformedBy').value.trim(),
      description: document.getElementById('svcDescription').value.trim(),
      performedAt: new Date().toISOString(),
    };
    try {
      await apiFetch(`/api/v1/assets/${assetId}/service`, {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify(payload),
      });
      document.getElementById('svcDescription').value = '';
      await openServiceHistory(assetId, document.getElementById('serviceHistoryTitle').textContent);
      toast('Событие добавлено');
    } catch(ex) { toast(`Ошибка: ${ex.message}`); }
  });
}

function setupDigitalTwin(projectId) {
  const addBtn = document.getElementById('addAssetBtn');
  if (addBtn) addBtn.addEventListener('click', () => openAssetDialog(projectId));

  const dialog = document.getElementById('assetDialog');
  const closeBtn = document.getElementById('closeAssetDialog');
  const cancelBtn = document.getElementById('cancelAssetBtn');
  const submitBtn = document.getElementById('submitAssetBtn');
  const histBtn = document.getElementById('viewServiceHistoryBtn');
  if (!dialog) return;

  closeBtn?.addEventListener('click', () => dialog.close());
  cancelBtn?.addEventListener('click', () => dialog.close());
  histBtn?.addEventListener('click', () => {
    const asset = histBtn._asset;
    if (asset) { dialog.close(); openServiceHistory(asset.id, asset.name); }
  });

  submitBtn?.addEventListener('click', async () => {
    const id = document.getElementById('assetDialogId').value;
    const pid = dialog._projectId || projectId;
    const payload = {
      name: document.getElementById('assetName').value.trim(),
      assetType: document.getElementById('assetType').value,
      status: document.getElementById('assetStatus').value,
      make: document.getElementById('assetMake').value.trim(),
      model: document.getElementById('assetModel').value.trim(),
      serialNumber: document.getElementById('assetSerial').value.trim(),
      notes: document.getElementById('assetNotes').value.trim(),
      projectId: pid,
    };
    if (!payload.name) { toast('Укажите название'); return; }
    try {
      if (id) {
        await apiFetch(`/api/v1/assets/${id}`, { method: 'PATCH', headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key': createIdempotencyKey()}), body: JSON.stringify(payload) });
      } else {
        await apiFetch('/api/v1/assets', { method: 'POST', headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key': createIdempotencyKey()}), body: JSON.stringify(payload) });
      }
      dialog.close();
      toast(id ? 'Обновлено' : 'Актив добавлен');
      hydrateDigitalTwin(pid);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
}

// ── Conflict Queue UI ──────────────────────────────────────────────────────
function hydrateConflictQueue() {
  const listEl = document.getElementById('conflictList');
  _updateConflictBadge();
  if (!listEl) return;
  if (!_conflictQueue.length) {
    listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:14px">Конфликтов нет — все данные синхронизированы.</p>';
    return;
  }
  listEl.innerHTML = _conflictQueue.map(c => {
    const dt = new Date(c.detectedAt).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    const label = c.entry?.label || c.entry?.path || 'Запись';
    const method = c.entry?.method || 'WRITE';
    const serverMsg = c.serverPayload?.error?.message || JSON.stringify(c.serverPayload||{}).slice(0,120);
    return `<div style="background:var(--surface);border:1px solid #e05353;border-radius:10px;padding:14px 16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <span style="font-weight:600;font-size:14px">${label}</span>
          <span style="font-size:11px;color:var(--text-secondary);margin-left:8px">${method} · ${dt}</span>
        </div>
        <span style="font-size:11px;font-weight:700;color:#e05353;background:rgba(224,83,83,.12);padding:2px 8px;border-radius:4px">КОНФЛИКТ</span>
      </div>
      <p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px">Сервер вернул 409: ${escapeHtml(serverMsg)}</p>
      <div style="display:flex;gap:8px">
        <button class="button ghost" style="font-size:12px" onclick="_resolveConflict('${c.id}','retry'); hydrateConflictQueue()">Повторить</button>
        <button class="button ghost" style="font-size:12px" onclick="_resolveConflict('${c.id}','server'); hydrateConflictQueue()">Принять сервер</button>
        <button class="button ghost" style="font-size:12px;color:#e05353" onclick="_resolveConflict('${c.id}','discard'); hydrateConflictQueue()">Отклонить</button>
      </div>
    </div>`;
  }).join('');
}

function setupConflictQueue() {
  const refreshBtn = document.getElementById('refreshConflictsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', hydrateConflictQueue);
  hydrateConflictQueue();  // initial paint with localStorage data
}

// ── Retrieval Eval ───────────────────────────────────────────────────────
let _evalCases = [];
let _evalRuns = [];

async function hydrateRetrievalEval() {
  try {
    const resp = await apiFetch('/api/v1/admin/retrieval-eval');
    const { cases, runs } = await resp.json();
    _evalCases = cases || [];
    _evalRuns = runs || [];
    _renderEvalCases();
    _renderEvalRunHistory();
  } catch (e) { /* silent — non-critical panel */ }
}

function _renderEvalCases() {
  const el = document.getElementById('evalCasesList');
  if (!el) return;
  if (!_evalCases.length) { el.innerHTML = '<p class="empty-copy" style="font-size:12px">Нет тест-кейсов. Добавьте первый выше.</p>'; return; }
  el.innerHTML = _evalCases.map(c => `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:var(--surface);border-radius:8px;border:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <strong style="font-size:13px">${escapeHtml(c.query)}</strong>
        ${c.expectedDocNames?.length ? `<div style="font-size:11px;color:#778195;margin-top:3px">→ ${c.expectedDocNames.map(n => escapeHtml(n)).join(', ')}</div>` : ''}
        ${c.notes ? `<div style="font-size:11px;color:#556070;margin-top:2px">${escapeHtml(c.notes)}</div>` : ''}
      </div>
      <button class="button ghost eval-del-btn" data-id="${c.id}" type="button" style="padding:3px 8px;font-size:11px">✕</button>
    </div>`).join('');
  el.querySelectorAll('.eval-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/v1/admin/retrieval-eval/cases/${btn.dataset.id}/delete`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
      hydrateRetrievalEval();
    });
  });
}

function _renderEvalRunHistory() {
  const el = document.getElementById('evalRunHistory');
  if (!el || !_evalRuns.length) return;
  el.innerHTML = `<p class="eyebrow" style="margin:0 0 8px">История запусков</p>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr>
        <th style="text-align:left;padding:4px 8px;color:var(--text-muted)">Дата</th>
        <th style="text-align:right;padding:4px 8px;color:var(--text-muted)">Кейсов</th>
        <th style="text-align:right;padding:4px 8px;color:var(--text-muted)">P@3</th>
        <th style="text-align:right;padding:4px 8px;color:var(--text-muted)">R@5</th>
        <th style="text-align:right;padding:4px 8px;color:var(--text-muted)">Hit rate</th>
      </tr></thead>
      <tbody>${_evalRuns.map(r => `<tr>
        <td style="padding:4px 8px;color:var(--text-muted)">${(r.ran_at||'').slice(0,16).replace('T',' ')}</td>
        <td style="padding:4px 8px;text-align:right">${r.case_count}</td>
        <td style="padding:4px 8px;text-align:right;color:${r.precision_at_3>=0.7?'#34d399':'#f59e0b'}">${(r.precision_at_3*100).toFixed(0)}%</td>
        <td style="padding:4px 8px;text-align:right;color:${r.recall_at_5>=0.7?'#34d399':'#f59e0b'}">${(r.recall_at_5*100).toFixed(0)}%</td>
        <td style="padding:4px 8px;text-align:right;color:${r.hit_rate>=0.8?'#34d399':'#f59e0b'}">${(r.hit_rate*100).toFixed(0)}%</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

function setupRetrievalEval() {
  const addBtn = document.getElementById('addEvalCaseBtn');
  const runBtn = document.getElementById('runEvalBtn');
  const queryInput = document.getElementById('evalQueryInput');
  const expectedInput = document.getElementById('evalExpectedInput');
  if (!addBtn || !runBtn) return;

  addBtn.addEventListener('click', async () => {
    const query = queryInput?.value.trim();
    if (!query) { toast('Введите поисковый запрос'); return; }
    const expectedDocNames = (expectedInput?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    try {
      await apiFetch('/api/v1/admin/retrieval-eval/cases', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ query, expectedDocNames }),
      });
      if (queryInput) queryInput.value = '';
      if (expectedInput) expectedInput.value = '';
      hydrateRetrievalEval();
    } catch (e) { toast(e.message); }
  });

  runBtn.addEventListener('click', async () => {
    if (!_evalCases.length) { toast('Добавьте хотя бы один тест-кейс'); return; }
    runBtn.disabled = true; runBtn.textContent = '⏳ Запуск…';
    try {
      const resp = await apiFetch('/api/v1/admin/retrieval-eval/run', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}',
      });
      const { result } = await resp.json();
      _showEvalResult(result);
      hydrateRetrievalEval();
    } catch (e) { toast(e.message); }
    finally { runBtn.disabled = false; runBtn.textContent = '▶ Запустить оценку'; }
  });
}

function _showEvalResult(r) {
  const panel = document.getElementById('evalRunResults');
  const metrics = document.getElementById('evalMetrics');
  const details = document.getElementById('evalRunDetails');
  const ranAt = document.getElementById('evalRunAt');
  if (!panel) return;
  panel.style.display = '';
  if (ranAt) ranAt.textContent = (r.ranAt||'').slice(0,16).replace('T',' ');
  const pct = v => `${(v*100).toFixed(0)}%`;
  const color = v => v >= 0.7 ? '#34d399' : '#f59e0b';
  if (metrics) metrics.innerHTML = [
    { label: 'P@3', val: r.precisionAt3 }, { label: 'R@5', val: r.recallAt5 },
    { label: 'Hit rate', val: r.hitRate }, { label: 'Кейсов', val: r.validCases, raw: true },
  ].map(m => `<article><span>${m.label}</span><strong style="color:${m.raw?'var(--text)':color(m.val)}">${m.raw?m.val:pct(m.val)}</strong></article>`).join('');
  if (details) details.innerHTML = (r.details||[]).map(d => `
    <div style="padding:8px 10px;background:var(--surface);border-radius:8px;border:1px solid var(--border);border-left:3px solid ${d.hit?'#34d399':'#f59e0b'}">
      <div style="font-weight:600;margin-bottom:4px">${escapeHtml(d.query)}</div>
      ${d.note ? `<small style="color:#778195">${d.note}</small>` : `
      <div style="font-size:11px;color:#778195">Ожидалось: ${(d.expected||[]).join(', ')}</div>
      <div style="font-size:11px;color:#556070">Получено: ${(d.retrieved||[]).slice(0,3).join(', ')}</div>
      <div style="font-size:11px;margin-top:3px">P@3: <b>${pct(d.precisionAtK)}</b> R@5: <b>${pct(d.recallAtK)}</b> ${d.hit?'✓ hit':'✗ miss'}</div>`}
    </div>`).join('');
}

function setupSecretsVault() {
  const addBtn = document.getElementById('addSecretButton');
  const dialog = document.getElementById('secretDialog');
  const form = document.getElementById('secretForm');
  const cancelBtn = document.getElementById('cancelSecretButton');
  if (!addBtn || !dialog) return;

  addBtn.addEventListener('click', () => { form?.reset(); dialog.showModal(); });
  cancelBtn?.addEventListener('click', () => dialog.close());
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const resp = await apiFetch('/api/v1/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('secretName').value.trim(),
          value: document.getElementById('secretValue').value,
          description: document.getElementById('secretDescription').value.trim(),
          category: document.getElementById('secretCategory').value,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error?.message || 'Failed to save');
      dialog.close();
      toast(`Секрет «${data.secret.name}» сохранён`);
      hydrateSecretsVault();
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  });

  document.getElementById('secretsList')?.addEventListener('click', e => {
    const id = e.target.dataset.id;
    if (!id) return;
    if (e.target.classList.contains('secret-reveal-btn')) revealSecret(id);
    if (e.target.classList.contains('secret-copy-btn')) copySecret(id);
    if (e.target.classList.contains('secret-delete-btn')) deleteSecret(id);
  });
}

async function submitPlatformSettings(event){event.preventDefault();const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;try{const response=await fetch('/api/v1/admin/platform-settings',{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({defaultLanguage:$('#platformLanguage').value,timezone:$('#platformTimezone').value.trim(),roleMode:$('#platformRoleMode').value,telemetryMode:$('#platformTelemetryMode').value,logRetentionDays:Number($('#platformLogRetention').value)})});const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message||'Platform settings failed');platformSettings=payload.settings;renderPlatformSettings();toast('Platform settings saved');}catch(error){toast(error.message);}finally{button.disabled=false;}}

function populateLogProjectFilter() {
  const filter = $('#logProjectFilter');
  if (!filter) return;
  const selected = filter.value;
  filter.innerHTML = '<option value="">Все проекты</option>' + projects.map(p =>
    `<option value="${p.id}">${escapeHtml(p.code)} · ${escapeHtml(p.name)}</option>`).join('');
  filter.value = [...filter.options].some(o => o.value === selected) ? selected : '';
}

const LOG_SOURCE_ICON = { project:'📋', workspace:'🔧', security:'🔒', activity:'💬', unknown:'•' };
const LOG_SOURCE_COLOR = { project:'#4a7fd4', workspace:'#a78bfa', security:'#f59e0b', activity:'#34d399' };

function renderLogs(unavailable = false) {
  const container = $('#logsList');
  if (!container) return;
  populateLogProjectFilter();
  if (unavailable) { container.innerHTML = '<article class="project-loading">Журнал временно недоступен.</article>'; return; }
  if (!logs.length) { container.innerHTML = '<article class="project-loading">По выбранным фильтрам событий нет.</article>'; return; }

  // Summary bar
  const bar = $('#logsSummaryBar');
  if (bar) {
    const bySource = {};
    for (const e of logs) bySource[e.source] = (bySource[e.source]||0)+1;
    bar.innerHTML = `<span>Показано: <strong>${logs.length}</strong></span>` +
      Object.entries(bySource).map(([s,n]) =>
        `<span style="color:${LOG_SOURCE_COLOR[s]||'var(--text-muted)'}">
          ${LOG_SOURCE_ICON[s]||'•'} ${s}: <strong>${n}</strong></span>`).join('');
  }

  container.innerHTML = logs.map(event => {
    const src = event.source || 'unknown';
    const color = LOG_SOURCE_COLOR[src] || 'var(--text-muted)';
    const icon = LOG_SOURCE_ICON[src] || '•';
    const ts = event.createdAt ? new Date(event.createdAt).toLocaleString('ru-RU') : '—';
    const entity = event.entityType || event.target_type || '';
    const project = event.projectCode || event.projectName || event.organization_id || '';
    const actor = event.actor || event.actorId || event.actor_id || '';
    const outcome = event.outcome;
    const outcomeColor = outcome === 'ok' ? '#34d399' : outcome === 'denied' ? '#f59e0b' : outcome === 'error' ? '#e05353' : '';
    return `<article class="log-entry" style="border-left:3px solid ${color}">
      <div class="log-icon" style="color:${color}">${icon}</div>
      <div class="log-body">
        <strong class="log-action">${escapeHtml(event.message||event.action||event.event_type||'event')}</strong>
        <div class="log-meta">
          ${entity ? `<span class="log-tag">${escapeHtml(entity)}</span>` : ''}
          ${project ? `<span class="log-project">${escapeHtml(project)}</span>` : ''}
          ${actor ? `<span class="log-actor">👤 ${escapeHtml(actor)}</span>` : ''}
          ${outcomeColor ? `<span style="color:${outcomeColor};font-size:10px">● ${escapeHtml(outcome)}</span>` : ''}
        </div>
      </div>
      <time class="log-time" datetime="${escapeHtml(event.createdAt||'')}">${ts}</time>
    </article>`;
  }).join('');
}

async function hydrateLogs() {
  try {
    populateLogProjectFilter();
    const src = $('#logSourceFilter')?.value || 'all';
    const params = new URLSearchParams({
      source: src,
      entityType: $('#logEntityFilter')?.value || 'all',
      q: $('#logSearchInput')?.value || '',
      limit: '200',
    });
    const projectId = $('#logProjectFilter')?.value;
    if (projectId) params.set('projectId', projectId);
    const dateFrom = $('#logDateFrom')?.value;
    const dateTo = $('#logDateTo')?.value;
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo + 'T23:59:59');

    // Security source: pull from audit_log endpoint instead
    if (src === 'security') {
      const resp = await apiFetch(`/api/v1/admin/audit-log?limit=200`);
      const { entries } = await resp.json();
      logs = entries.map(e => ({ ...e, source: 'security', message: e.action,
        entityType: e.target_type, actor: e.actor_id, createdAt: e.created_at }));
    } else if (src === 'activity') {
      // activity from all projects — not available as global endpoint yet, show workspace
      const response = await fetch(`/api/v1/logs?${params}`, { headers: apiHeaders() });
      if (!response.ok) throw new Error('logs unavailable');
      const payload = await response.json();
      logs = (payload.logs || []).map(e => ({ ...e, source: 'activity' }));
    } else {
      const response = await fetch(`/api/v1/logs?${params}`, { headers: apiHeaders() });
      if (!response.ok) throw new Error('logs unavailable');
      const payload = await response.json();
      logs = payload.logs || [];
    }
    renderLogs();
  } catch { renderLogs(true); }
}

function exportLogsCSV() {
  if (!logs.length) { toast('Нет данных для экспорта'); return; }
  const cols = ['createdAt','source','action','message','entityType','projectCode','actor','outcome'];
  const header = cols.join(',');
  const rows = logs.map(e => cols.map(c => `"${String(e[c]||'').replace(/"/g,'""')}"`).join(','));
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `logs_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

function renderApiMetrics(unavailable=false){const summary=$('#apiSummary'),status=$('#apiStatusBreakdown'),routes=$('#apiRouteList'),list=$('#apiLogList'),badge=$('#apiMetricsStatus');if(!summary||!status||!routes||!list)return;if(unavailable){summary.innerHTML='<article><span>Status</span><strong>Offline</strong><small>API telemetry unavailable</small></article>';status.innerHTML='';routes.innerHTML='';list.innerHTML='<article class="project-loading">API telemetry временно недоступна.</article>';if(badge){badge.textContent='Unavailable';badge.className='git-sync-status error';}return;}const metrics=apiMetrics||{requestCount:0,averageMs:0,p95Ms:0,errorCount:0,statusCounts:{},methodCounts:{},topRoutes:[],recent:[],updatedAt:null};summary.innerHTML=`<article><span>Total requests</span><strong>${metrics.requestCount}</strong><small>retained runtime events</small></article><article><span>Average response</span><strong>${metrics.averageMs} ms</strong><small>mean latency</small></article><article><span>P95 response</span><strong>${metrics.p95Ms} ms</strong><small>slow path signal</small></article><article><span>Errors</span><strong>${metrics.errorCount}</strong><small>HTTP 4xx/5xx</small></article>`;status.innerHTML=Object.entries(metrics.statusCounts||{}).map(([code,count])=>`<article class="${Number(code)>=400?'error':'ok'}"><span>${escapeHtml(code)}</span><strong>${count}</strong></article>`).join('')||'<p class="empty-copy">No API responses yet.</p>';routes.innerHTML=(metrics.topRoutes||[]).map(route=>`<article><strong>${escapeHtml(route.route)}</strong><span>${route.count} requests</span></article>`).join('')||'<p class="empty-copy">No route data yet.</p>';list.innerHTML=(metrics.recent||[]).map(event=>`<article class="${event.status>=400?'error':''}"><div><span>${escapeHtml(event.method)} · ${escapeHtml(event.route)}</span><strong>${event.status} · ${event.durationMs} ms</strong><small>${escapeHtml(event.requestId)} · ${escapeHtml(event.organizationId)}</small></div><time datetime="${escapeHtml(event.createdAt)}">${new Date(event.createdAt).toLocaleTimeString('ru-RU')}</time></article>`).join('')||'<article class="project-loading">No API requests recorded yet.</article>';if(badge){badge.textContent=metrics.updatedAt?`Updated ${new Date(metrics.updatedAt).toLocaleTimeString('ru-RU')}`:'Runtime';badge.className='git-sync-status configured';}}

async function hydrateApiMetrics(){try{const response=await fetch('/api/v1/admin/api-metrics',{headers:apiHeaders()});if(!response.ok)throw new Error('api metrics unavailable');const payload=await response.json();apiMetrics=payload.metrics;renderApiMetrics();}catch{renderApiMetrics(true);}}

let _lastAgentData = null;

function renderAgentStatus(agent) {
  const indicator = $('#agentIndicator');
  if (!indicator) return;
  _lastAgentData = agent;
  const labels = { working:'Работает', idle:'Не активен', waiting:'Ожидает', blocked:'Требуется действие', limit:'Достигнут лимит' };
  indicator.className = `agent-indicator ${agent.status||'idle'}${agent.needsAction?' needs-action':''}`;
  $('#agentStatusText').textContent = `${labels[agent.status]||agent.status} · ${agent.message||''}`;
  $('#requestContinueButton').classList.toggle('requested', Boolean(agent.continuationRequested));
  $('#requestContinueButton').title = agent.continuationRequested ? 'Запрос уже зарегистрирован' : 'Запросить продолжение разработки';
  _syncCodexDialog(agent);
}

function _syncCodexDialog(agent) {
  const dialog = $('#codexInfoDialog');
  if (!dialog || !dialog.open) return;
  const labels = { working:'Работает', idle:'Не активен', waiting:'Ожидает', blocked:'Требуется действие', limit:'Достигнут лимит' };
  const statusEl = $('#codexDialogStatus');
  if (statusEl) statusEl.className = `agent-indicator ${agent.status||'idle'}`;
  const textEl = $('#codexDialogStatusText');
  if (textEl) textEl.textContent = labels[agent.status] || agent.status;
  const msgEl = $('#codexDialogMessage');
  if (msgEl) msgEl.textContent = agent.message || '';
  const taskBox = $('#codexDialogTask');
  const taskText = $('#codexDialogTaskText');
  if (taskBox && taskText) {
    if (agent.currentTask) { taskBox.style.display = ''; taskText.textContent = agent.currentTask; }
    else taskBox.style.display = 'none';
  }
  const lastEl = $('#codexDialogLastActive');
  if (lastEl && agent.lastActive) {
    const d = new Date(agent.lastActive);
    lastEl.textContent = `Последняя активность: ${isNaN(d) ? agent.lastActive : d.toLocaleString('ru-RU')}`;
  }
  const continueBtn = $('#codexDialogContinueBtn');
  if (continueBtn) {
    continueBtn.textContent = agent.continuationRequested ? '✓ Запрос зарегистрирован' : '▶ Запросить продолжение';
    continueBtn.disabled = Boolean(agent.continuationRequested);
  }
}

function setupCodexDialog() {
  const indicator = $('#agentIndicator');
  const dialog = $('#codexInfoDialog');
  const closeBtn = $('#closeCodexDialog');
  const closeBtn2 = $('#closeCodexDialog2');
  const continueBtn = $('#codexDialogContinueBtn');
  if (!indicator || !dialog) return;

  const open = () => { if (_lastAgentData) _syncCodexDialog(_lastAgentData); dialog.showModal(); };
  indicator.addEventListener('click', e => { if (e.target.closest('#requestContinueButton')) return; open(); });
  indicator.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  closeBtn?.addEventListener('click', () => dialog.close());
  closeBtn2?.addEventListener('click', () => dialog.close());
  continueBtn?.addEventListener('click', async () => {
    continueBtn.disabled = true;
    await requestDevelopmentContinuation();
    if (_lastAgentData) _syncCodexDialog(_lastAgentData);
  });
}

async function hydrateAgentStatus(){try{const response=await fetch('/api/v1/development-agent/status',{headers:apiHeaders()});if(!response.ok)throw new Error('status unavailable');const payload=await response.json();renderAgentStatus(payload.agent);}catch{renderAgentStatus({status:'blocked',message:'Статус недоступен',needsAction:true});}}

// ── Platform Growth Chart ──────────────────────────────────────────────────

async function hydrateGrowthChart() {
  const wrap = document.getElementById('growthChart');
  const meta = document.getElementById('growthChartMeta');
  if (!wrap) return;
  wrap.innerHTML = '<p class="empty-copy" style="padding:24px 0">Загрузка…</p>';
  try {
    const resp = await apiFetch('/api/v1/admin/platform-growth');
    const data = await resp.json();
    renderGrowthChart(data, wrap, meta);
  } catch (e) {
    wrap.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`;
  }
}

function renderGrowthChart(data, wrap, metaEl) {
  const { days, totalCommits, totalMigrations } = data;
  if (!days.length) { wrap.innerHTML = '<p class="empty-copy" style="padding:24px 0">Нет данных</p>'; return; }

  if (metaEl) {
    metaEl.innerHTML = `<strong style="color:#dde4f0">${totalCommits}</strong> коммитов &nbsp;·&nbsp; <strong style="color:#4a7fd4">${totalMigrations}</strong> фич`;
  }

  const W = 900, H = 160, PL = 0, PR = 0, PT = 18, PB = 32;
  const CW = W - PL - PR, CH = H - PT - PB;
  const n = days.length;
  const maxC = Math.max(...days.map(d => d.commits), 1);
  const maxI = Math.max(...days.map(d => (d.insertions || 0) + (d.deletions || 0)), 1);

  // Bar width with gap
  const gap = n > 14 ? 2 : 4;
  const bw = Math.max(4, Math.floor(CW / n) - gap);
  const step = CW / n;

  // Area path for cumulative (normalized 0..1)
  const maxCum = days[days.length - 1]?.cumulative || 1;
  const cumPts = days.map((d, i) => {
    const x = PL + i * step + step / 2;
    const y = PT + CH - (d.cumulative / maxCum) * CH;
    return `${x},${y}`;
  });
  const areaPath = `M${PL + step/2},${PT + CH} L${cumPts.join(' L')} L${PL + (n-1)*step + step/2},${PT + CH} Z`;
  const linePath = `M${cumPts.join(' L')}`;

  // Bars
  const bars = days.map((d, i) => {
    const x = PL + i * step + (step - bw) / 2;
    const bh = Math.max(2, (d.commits / maxC) * CH);
    const y = PT + CH - bh;
    // Color: more commits = brighter
    const intensity = d.commits / maxC;
    const opacity = 0.35 + intensity * 0.65;
    const hasMigration = d.migrations > 0;
    const barColor = hasMigration ? '#4a7fd4' : `rgba(74,127,212,${opacity})`;

    // Tooltip data
    const label = [
      d.date,
      `${d.commits} коммит${d.commits===1?'':'ов'}`,
      d.migrations ? `${d.migrations} фич` : null,
      d.insertions ? `+${d.insertions} строк` : null,
      ...(d.subjects || []).slice(0, 3).map(s => `· ${s}`),
    ].filter(Boolean).join('\n');

    return `<g class="gc-bar" data-tip="${escapeHtml(label)}">
      <rect x="${x}" y="${PT}" width="${bw}" height="${CH}" fill="transparent"/>
      <rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="${barColor}"/>
      ${hasMigration ? `<circle cx="${x + bw/2}" cy="${PT + 8}" r="3" fill="#f5c842"/>` : ''}
    </g>`;
  }).join('');

  // X axis labels (show every N days to avoid clutter)
  const labelEvery = n <= 7 ? 1 : n <= 14 ? 2 : 7;
  const xLabels = days.map((d, i) => {
    if (i % labelEvery !== 0 && i !== n-1) return '';
    const x = PL + i * step + step / 2;
    const parts = d.date.split('-');
    const label = `${parts[2]}.${parts[1]}`;
    return `<text x="${x}" y="${H - 4}" text-anchor="middle" fill="#556070" font-size="10">${label}</text>`;
  }).join('');

  // Y axis hint
  const yHint = `<text x="${PL + 4}" y="${PT + 4}" fill="#445060" font-size="9" dominant-baseline="hanging">${maxC} коммитов макс.</text>`;

  wrap.innerHTML = `
    <div class="gc-outer" style="position:relative">
      <svg id="gcSvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block;overflow:visible">
        <defs>
          <linearGradient id="gcAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4a7fd4" stop-opacity="0.18"/>
            <stop offset="100%" stop-color="#4a7fd4" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#gcAreaGrad)"/>
        <path d="${linePath}" fill="none" stroke="#4a7fd4" stroke-width="1.5" stroke-opacity="0.5"/>
        ${bars}
        ${xLabels}
        ${yHint}
      </svg>
      <div id="gcTooltip" style="display:none;position:absolute;background:#0b1420;border:1px solid #2b3443;border-radius:8px;padding:8px 11px;font-size:11px;color:#dde4f0;white-space:pre;pointer-events:none;z-index:10;line-height:1.6;max-width:260px"></div>
    </div>
    <div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:#556070">
      <span><span style="display:inline-block;width:10px;height:10px;background:#4a7fd4;border-radius:2px;margin-right:5px;vertical-align:middle"></span>Коммиты</span>
      <span><span style="display:inline-block;width:10px;height:2px;background:#4a7fd4;opacity:.5;margin-right:5px;vertical-align:middle"></span>Кумулятивно</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#f5c842;border-radius:50%;margin-right:5px;vertical-align:middle"></span>День с новой фичей</span>
    </div>`;

  // Tooltip interactivity
  const svg = document.getElementById('gcSvg');
  const tip = document.getElementById('gcTooltip');
  if (!svg || !tip) return;
  svg.querySelectorAll('.gc-bar').forEach(g => {
    g.addEventListener('mouseenter', e => {
      tip.textContent = g.dataset.tip;
      tip.style.display = 'block';
    });
    g.addEventListener('mousemove', e => {
      const rect = wrap.getBoundingClientRect();
      let lx = e.clientX - rect.left + 12;
      let ly = e.clientY - rect.top - 10;
      if (lx + 270 > rect.width) lx = e.clientX - rect.left - 270;
      tip.style.left = lx + 'px';
      tip.style.top = ly + 'px';
    });
    g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

async function requestDevelopmentContinuation(){const button=$('#requestContinueButton');button.disabled=true;try{const response=await fetch('/api/v1/development-agent/continue',{method:'POST',headers:apiHeaders()});if(!response.ok)throw new Error('request failed');const payload=await response.json();renderAgentStatus(payload.agent);toast('Запрос на продолжение зарегистрирован');}catch{toast('Не удалось зарегистрировать запрос');}finally{button.disabled=false;}}

function renderWorkflowConfiguration(){const container=$('#workflowAdminList');if(!container)return;container.innerHTML=workflowConfiguration.map(type=>`<article style="--workflow-color:${escapeHtml(type.color)}"><div><i></i><div><strong>${escapeHtml(type.name)}</strong><small>${escapeHtml(type.code)} · ${type.actions.length} этапов</small></div></div><div class="workflow-action-chips">${type.actions.filter(value=>value.active).map(value=>`<span>${escapeHtml(value.name)}</span>`).join('')}</div><button class="text-button" type="button" data-edit-work-type="${type.id}">Редактировать</button></article>`).join('')||'<p class="empty-copy">Виды работ не настроены.</p>';container.querySelectorAll('[data-edit-work-type]').forEach(button=>button.addEventListener('click',()=>openWorkTypeDialog(workflowConfiguration.find(value=>value.id===button.dataset.editWorkType))));}

async function hydrateWorkflowConfiguration(){try{const response=await fetch('/api/v1/admin/work-types',{headers:apiHeaders()});if(!response.ok)throw new Error('workflow unavailable');const payload=await response.json();workflowConfiguration=payload.workTypes||[];renderWorkflowConfiguration();}catch{const container=$('#workflowAdminList');if(container)container.innerHTML='<p class="empty-copy">Настройки workflow временно недоступны.</p>';}}

function openWorkTypeDialog(type=null){$('#workTypeForm').reset();$('#workTypeConfigId').value=type?.id||'';$('#workTypeConfigVersion').value=type?.version||'';$('#workTypeDialogTitle').textContent=type?'Редактировать вид работ':'Новый вид работ';$('#workTypeConfigCode').value=type?.code||'';$('#workTypeConfigName').value=type?.name||'';$('#workTypeConfigColor').value=type?.color||'#7c8cff';$('#workTypeConfigActions').value=(type?.actions||[]).filter(value=>value.active).map(value=>`${value.code} | ${value.name}`).join('\n');$('#workTypeDialog').showModal();}

async function submitWorkType(event){event.preventDefault();if(!event.currentTarget.reportValidity())return;const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;const id=$('#workTypeConfigId').value;const actions=$('#workTypeConfigActions').value.split('\n').map(value=>value.trim()).filter(Boolean).map(line=>{const [code,...name]=line.split('|');return {code:code.trim(),name:name.join('|').trim()};});const payload={code:$('#workTypeConfigCode').value.trim(),name:$('#workTypeConfigName').value.trim(),color:$('#workTypeConfigColor').value,actions};if(id)payload.expectedVersion=Number($('#workTypeConfigVersion').value);try{if(id)await apiPatch(`/api/v1/admin/work-types/${encodeURIComponent(id)}`,payload);else await apiPost('/api/v1/admin/work-types',payload);$('#workTypeDialog').close();await Promise.all([hydrateWorkflowConfiguration(),hydrateProjects()]);toast(id?'Вид работ обновлен':'Вид работ добавлен');}catch(error){toast(error.code==='version_conflict'?'Настройки уже изменены':error.message);}finally{button.disabled=false;}}

function renderCustomFieldAdmin(){const container=$('#customFieldAdminList');if(!container)return;container.innerHTML=customFieldDefinitions.map(field=>`<article><div><i style="background:${field.scope==='unit'?'#7c8cff':'#42d697'}"></i><div><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(field.scope)} · ${escapeHtml(field.code)} · ${escapeHtml(field.dataType)}</small></div></div><div class="workflow-action-chips"><span>${field.required?'Обязательно':'Необязательно'}</span><span>${field.active?'Активно':'Отключено'}</span></div><button class="text-button" type="button" data-edit-custom-field="${field.id}">Редактировать</button></article>`).join('')||'<p class="empty-copy">Дополнительные поля не настроены.</p>';container.querySelectorAll('[data-edit-custom-field]').forEach(button=>button.addEventListener('click',()=>openCustomFieldDialog(customFieldDefinitions.find(value=>value.id===button.dataset.editCustomField))));}

async function hydrateCustomFieldDefinitions(){try{const response=await fetch('/api/v1/admin/custom-fields',{headers:apiHeaders()});if(!response.ok)throw new Error('custom fields unavailable');const payload=await response.json();customFieldDefinitions=payload.customFields||[];renderCustomFieldAdmin();}catch{const container=$('#customFieldAdminList');if(container)container.innerHTML='<p class="empty-copy">Настройки полей временно недоступны.</p>';}}

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
      ${project.kind === 'customer' ? `<footer class="project-actions"><button class="button ghost" type="button" data-permission="projectManage" data-add-building="${project.id}">＋ Здание</button><button class="button ghost" type="button" data-permission="projectManage" data-add-work-item="${project.id}">＋ Полевая задача</button></footer>` : '<footer class="project-boundary">Внутренний проект · полевые операции отключены</footer>'}
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

function _locationCompletionPct(project, locationIds) {
  const set = new Set(locationIds);
  const relevant = project.dailyUpdates?.filter(u => set.has(u.locationId)) || [];
  if (!relevant.length) return 0;
  const done = relevant.filter(u => u.completionPercent >= 100).length;
  return Math.round((done / relevant.length) * 100);
}

function _renderFlatLocations(project, canManage) {
  const locs = project.locations || [];
  return locs.length
    ? locs.map(location => {
        const parent = locs.find(v => v.id === location.parentLocationId);
        return `<button type="button" data-open-location="${location.id}" style="--location-depth:${location.depth||0}">
          <span>${escapeHtml(location.code)}</span>
          <strong>${escapeHtml(location.name)}</strong>
          <small>${parent ? escapeHtml(parent.name) + ' → ' : ''}${escapeHtml(location.kind)}${location.suiteTotal !== null ? ` · ${location.suiteTotal} suites` : ''}</small>
        </button>`;
      }).join('')
    : '<p class="empty-copy">Добавьте этажи или зоны, чтобы техник мог фиксировать прогресс.</p>';
}

function _renderBuildingCentricLocations(project) {
  const buildings = project.buildings || [];
  const locs = project.locations || [];
  const KIND_ICON = { floor:'⬛', suite:'🏢', room:'🚪', area:'📐' };

  return buildings.map(b => {
    const bLocs = locs.filter(l => l.buildingId === b.id || l.building_id === b.id);
    const rootLocs = bLocs.filter(l => !l.parentLocationId);
    const allIds = bLocs.map(l => l.id);
    const pct = _locationCompletionPct(project, allIds);

    const locTree = (parentId) => {
      const children = bLocs.filter(l => l.parentLocationId === parentId);
      if (!children.length) return '';
      return children.map(l => {
        const icon = KIND_ICON[l.kind] || '📍';
        const nested = locTree(l.id);
        return `<div class="bldg-loc" style="margin-left:${(l.depth||0)*12}px">
          <button type="button" data-open-location="${l.id}" style="--location-depth:0">
            <span>${icon} ${escapeHtml(l.code)}</span>
            <strong>${escapeHtml(l.name)}</strong>
            <small>${escapeHtml(l.kind)}${l.suiteTotal !== null ? ` · ${l.suiteTotal} suites` : ''}</small>
          </button>
          ${nested}
        </div>`;
      }).join('');
    };

    const locsHtml = rootLocs.length
      ? locTree(null) + bLocs.filter(l => !l.parentLocationId && !rootLocs.find(r => r.id === l.id)).map(l => locTree(l.id)).join('')
      : locTree(null);

    return `<div class="building-block" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:12px;overflow:hidden">
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-size:11px;font-weight:700;color:var(--text-secondary);letter-spacing:.05em">${escapeHtml(b.code)}</span>
          <h3 style="margin:2px 0 0;font-size:15px;font-weight:700">${escapeHtml(b.name)}</h3>
          ${b.address ? `<p style="margin:2px 0 0;font-size:12px;color:var(--text-secondary)">${escapeHtml(b.address)}</p>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:800;color:var(--accent)">${pct}%</div>
          <div style="font-size:11px;color:var(--text-secondary)">${bLocs.length} лок.</div>
        </div>
      </div>
      <div style="background:var(--border);height:3px"><div style="width:${pct}%;height:100%;background:var(--accent);transition:width .3s"></div></div>
      <div class="location-cards" style="padding:8px 12px">
        ${locsHtml || '<p class="empty-copy" style="font-size:12px;padding:8px 4px">Нет локаций в этом здании</p>'}
      </div>
    </div>`;
  }).join('');
}

function _renderLocationsPanel(project, canManage) {
  const buildings = project.buildings || [];
  const hasMultiBuilding = buildings.length > 1;
  const viewMode = project._locViewMode || (hasMultiBuilding ? 'buildings' : 'list');

  const toggleBtn = buildings.length > 0
    ? `<button class="button ghost" id="toggleLocViewBtn" type="button" style="font-size:12px">${viewMode === 'buildings' ? '≡ Список' : '🏢 Здания'}</button>`
    : '';

  const header = `<div class="detail-section-title">
    <div><p class="eyebrow">LOCATIONS</p><h2>Структура объекта</h2></div>
    <div style="display:flex;gap:6px;align-items:center">
      ${toggleBtn}
      ${canManage ? '<button class="text-button" data-add-location>Добавить</button>' : ''}
    </div>
  </div>`;

  const body = (viewMode === 'buildings' && buildings.length)
    ? _renderBuildingCentricLocations(project)
    : `<div class="location-cards">${_renderFlatLocations(project, canManage)}</div>`;

  return header + body;
}

function renderProjectDetail() {
  const container = $('#projectDetailView');
  const project = projects.find(value => value.id === selectedProjectId);
  if (!container || !project) { if (container) container.innerHTML = '<p class="project-loading">Проект загружается…</p>'; return; }
  const today = new Date().toISOString().slice(0,10);
  const dailyLog = projectDailyLogEntries(project);
  const updatesToday = dailyLog.filter(value => value.workDate === today);
  const openIssues = project.issues.filter(value => value.status !== 'resolved');
  const canManage = roleCan('projectManage');
  const canProgress = roleCan('fieldProgress');
  container.innerHTML = `<header class="detail-header"><div><a href="#projects">← Все проекты</a><p class="eyebrow">${escapeHtml(project.code)} · PROJECT DETAIL</p><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.description || 'Описание проекта не добавлено')}</p></div><div class="detail-actions">${canManage ? `<button class="button ghost" type="button" data-add-location>＋ Этаж / зона</button><button class="button ghost" id="exportProjectBtn" type="button" title="Экспорт данных проекта (JSON)">⬇ Экспорт</button><label class="button ghost" style="cursor:pointer" title="Импорт данных проекта из JSON">⬆ Импорт<input type="file" id="importProjectInput" accept="application/json" style="display:none"></label>` : ''}<button class="button primary" type="button" data-daily-update ${canProgress ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'}>＋ Отчет за сегодня</button></div></header>
    <section class="detail-kpis"><article><span>Общий прогресс</span><strong>${project.progress}%</strong></article><article><span>Сегодня обновлено</span><strong>${updatesToday.length}</strong></article><article><span>Открытые проблемы</span><strong>${openIssues.length}</strong></article><article><span>Локации</span><strong>${project.locations.length}</strong></article></section>
    <section class="detail-section"><div class="detail-section-title"><div><p class="eyebrow">WORK PROGRESS</p><h2>Прогресс по видам работ</h2></div></div><div class="scope-cards">${project.workTypeProgress.map(scope => `<article style="--scope:${scope.color}"><div><strong>${escapeHtml(scope.name)}</strong><b>${scope.progress}%</b></div><div class="scope-bar"><i style="width:${scope.progress}%"></i></div><small>${scope.fieldUpdateCount} обновлений · ${scope.taskCount} задач${scope.blocked ? ` · ${scope.blocked} blocked` : ''}</small></article>`).join('')}</div></section>
    <section class="detail-grid"><article class="detail-panel">${_renderLocationsPanel(project, canManage)}</article>
    <article class="detail-panel"><div class="detail-section-title"><div><p class="eyebrow">ISSUES</p><h2>Проблемы</h2></div><b class="issue-count">${openIssues.length}</b></div><div class="issue-list">${openIssues.length ? openIssues.slice(0,6).map(issue => `<div class="issue-item ${issue.severity}"><span>${escapeHtml(issue.severity)}</span><strong>${escapeHtml(issue.title)}</strong><small>${escapeHtml(issue.description)}</small></div>`).join('') : '<p class="empty-copy">Открытых проблем нет.</p>'}</div></article></section>
    <section class="detail-section" id="projectTeamSection">
      <div class="detail-section-title"><div><p class="eyebrow">КОМАНДА</p><h2>Назначенные сотрудники</h2></div>${canManage ? '<button class="button ghost" id="assignMemberBtn" type="button">＋ Назначить</button>' : ''}</div>
      <div id="projectTeamList" style="display:flex;flex-wrap:wrap;gap:8px"><p class="empty-copy" style="font-size:13px">Загрузка…</p></div>
      ${canManage ? `<dialog id="assignMemberDialog" style="max-width:400px;width:100%">
        <div class="dialog-head"><div><p class="eyebrow">НАЗНАЧЕНИЕ</p><h2>Выбрать сотрудника</h2></div><button class="icon-button" id="closeAssignDialog" type="button">×</button></div>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
          <select id="assignMemberSelect" style="padding:8px 10px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px"></select>
          <input id="assignRoleInput" type="text" placeholder="Роль на проекте (Lead Tech, Foreman…)" maxlength="100" style="padding:8px 10px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px">
          <div class="dialog-actions"><span></span><button class="button ghost" id="cancelAssignDialog" type="button">Отмена</button><button class="button primary" id="confirmAssignBtn" type="button">Назначить</button></div>
        </div>
      </dialog>` : ''}
    </section>
    <section class="detail-section"><div class="detail-section-title"><div><p class="eyebrow">DAILY LOG · AUTO</p><h2>Последние изменения</h2></div>${canProgress ? '<button class="button primary" type="button" data-daily-update>＋ Добавить пояснение</button>' : ''}</div><div class="daily-feed">${dailyLog.length ? dailyLog.slice(0,20).map(entry => `<article><div class="daily-date"><strong>${escapeHtml(entry.workDate)}</strong><span class="daily-status ${entry.status}">${escapeHtml(entry.status.replaceAll('_',' '))}</span></div><div class="daily-main"><span>${escapeHtml(entry.context)}</span><h3>${escapeHtml(entry.title)}</h3><p>${escapeHtml(entry.detail)}</p></div><div class="daily-result">${entry.percent !== null ? `<strong>${entry.percent}%</strong>` : '<strong class="auto-mark">AUTO</strong>'}${entry.quantity !== null ? `<small>${entry.quantity} шт.</small>` : ''}${entry.editableId ? `<button class="text-button" data-edit-daily="${entry.editableId}">Редактировать</button>` : '<small>Из журнала изменений</small>'}</div></article>`).join('') : '<p class="empty-copy">Изменения проекта автоматически появятся здесь.</p>'}</div></section>
    <section class="detail-section" id="projectObjectsSection"><div class="detail-section-title"><div><p class="eyebrow">ДОКУМЕНТЫ</p><h2>Файлы проекта</h2></div><label class="button ghost" style="cursor:pointer">＋ Загрузить<input type="file" id="objectFileInput" multiple style="display:none"></label></div><div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input id="objectsSearchInput" type="search" placeholder="Поиск по файлам…" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px" autocomplete="off"></div><div id="objectsDropZone" class="objects-drop-zone">Перетащите файлы сюда или нажмите «Загрузить»</div><div id="objectsGrid" class="objects-grid"><p class="empty-copy">Загрузка…</p></div><p id="objectsStorageInfo" style="font-size:11px;color:#445060;margin-top:8px"></p></section>
    <dialog id="objectVersionsDialog" style="max-width:520px;width:100%"><div class="dialog-head"><div><p class="eyebrow">ВЕРСИИ</p><h2 id="objectVersionsName"></h2></div><button class="icon-button" id="closeObjectVersionsDialog" type="button">×</button></div><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 8px;color:var(--text-muted)">Версия</th><th style="text-align:left;padding:6px 8px;color:var(--text-muted)">Размер</th><th style="text-align:left;padding:6px 8px;color:var(--text-muted)">Дата</th><th></th></tr></thead><tbody id="objectVersionsList"></tbody></table></div></dialog>
    <section class="detail-section" id="projectDigitalTwinSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">DIGITAL TWIN</p><h2>Реестр оборудования</h2></div>
        <button class="button ghost" id="addAssetBtn" type="button">＋ Оборудование</button>
      </div>
      <div id="assetsList" style="display:flex;flex-direction:column;gap:10px;margin-top:8px"><p class="empty-copy">Загрузка…</p></div>
    </section>
    <section class="detail-section" id="projectActivitySection">
      <div class="detail-section-title"><div><p class="eyebrow">ACTIVITY</p><h2>Активность и комментарии</h2></div></div>
      <div id="projectActivityFeed" class="activity-feed"><p class="empty-copy">Загрузка…</p></div>
      <div class="comment-compose" id="commentCompose">
        <textarea id="commentBody" rows="2" maxlength="4000" placeholder="Оставьте комментарий… (@упоминание поддерживается)" style="width:100%;resize:vertical;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box"></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:6px"><button class="button primary" id="commentSubmitBtn" type="button">Отправить</button></div>
      </div>
    </section>`;
  container.querySelectorAll('[data-add-location]').forEach(button => button.addEventListener('click', () => openLocationDialog(project)));
  container.querySelectorAll('[data-daily-update]').forEach(button => button.addEventListener('click', () => openDailyDialog(project)));
  container.querySelectorAll('[data-edit-daily]').forEach(button => button.addEventListener('click', () => openDailyDialog(project, project.dailyUpdates.find(value => value.id === button.dataset.editDaily))));
  container.querySelectorAll('[data-open-location]').forEach(button => button.addEventListener('click', () => { location.hash=`project/${encodeURIComponent(project.id)}/location/${encodeURIComponent(button.dataset.openLocation)}`; }));

  container.querySelector('#exportProjectBtn')?.addEventListener('click', () => exportProjectData(project.id, project.name));
  container.querySelector('#importProjectInput')?.addEventListener('change', e => {
    if (e.target.files[0]) openProjectImportPreview(e.target.files[0]);
    e.target.value = '';
  });

  container.querySelector('#toggleLocViewBtn')?.addEventListener('click', () => {
    const cur = project._locViewMode || ((project.buildings||[]).length > 1 ? 'buildings' : 'list');
    project._locViewMode = cur === 'buildings' ? 'list' : 'buildings';
    renderProjectDetail();
  });
  setupProjectObjects(project.id);
  hydrateProjectObjects(project.id);
  setupDigitalTwin(project.id);
  setupServiceHistory();
  hydrateDigitalTwin(project.id);
  setupProjectComments(project.id);
  hydrateProjectActivity(project.id);
  setupProjectTeam(project.id);
  hydrateProjectTeam(project.id);
}

// ── Comments & Activity ──────────────────────────────────────────────────────

const ACTIVITY_ICONS = {
  comment: '💬', daily_update: '📋', daily_update_edit: '✏️',
  location_added: '📍', issue_opened: '⚠️', object_uploaded: '📄',
};

async function hydrateProjectActivity(projectId) {
  const feed = document.getElementById('projectActivityFeed');
  if (!feed) return;
  try {
    const [actResp, cmtResp] = await Promise.all([
      apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/activity`),
      apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/comments`),
    ]);
    const { activity } = await actResp.json();
    const { comments } = await cmtResp.json();

    // Merge and sort by created_at desc
    const items = [
      ...activity.map(a => ({ ...a, _kind: 'activity' })),
      ...comments.filter(c => !c.deleted && !c.parent_id).map(c => ({ ...c, _kind: 'comment' })),
    ].sort((a, b) => (b.created_at > a.created_at ? 1 : -1));

    if (!items.length) { feed.innerHTML = '<p class="empty-copy">Нет активности. Напишите первый комментарий.</p>'; return; }

    feed.innerHTML = items.slice(0, 60).map(item => {
      if (item._kind === 'activity') {
        const icon = ACTIVITY_ICONS[item.event_type] || '•';
        return `<div class="activity-item">
          <span class="activity-icon">${icon}</span>
          <div class="activity-content">
            <span class="activity-summary">${escapeHtml(item.summary)}</span>
            <span class="activity-time">${(item.created_at||'').slice(0,16).replace('T',' ')}</span>
          </div>
        </div>`;
      }
      // comment
      const body = item.body.replace(/@(\w+)/g, '<strong>@$1</strong>');
      const replies = comments.filter(c => c.parent_id === item.id && !c.deleted);
      return `<div class="comment-thread" data-comment-id="${item.id}">
        <div class="comment-card">
          <div class="comment-meta">
            <strong>${escapeHtml(item.author_name || 'Пользователь')}</strong>
            <span class="activity-time">${(item.created_at||'').slice(0,16).replace('T',' ')}</span>
            ${item.edited ? '<span style="font-size:10px;color:var(--text-muted)">(изменён)</span>' : ''}
          </div>
          <p class="comment-body">${body}</p>
          <div class="comment-actions">
            <button class="text-button comment-reply-btn" data-reply-to="${item.id}" data-reply-name="${escapeHtml(item.author_name||'')}">Ответить</button>
            <button class="text-button comment-delete-btn" data-id="${item.id}" style="color:var(--text-muted)">Удалить</button>
          </div>
        </div>
        ${replies.length ? `<div class="comment-replies">${replies.map(r => `
          <div class="comment-card reply">
            <div class="comment-meta"><strong>${escapeHtml(r.author_name||'')}</strong><span class="activity-time">${(r.created_at||'').slice(0,16).replace('T',' ')}</span></div>
            <p class="comment-body">${escapeHtml(r.body)}</p>
            <div class="comment-actions"><button class="text-button comment-delete-btn" data-id="${r.id}" style="color:var(--text-muted)">Удалить</button></div>
          </div>`).join('')}</div>` : ''}
      </div>`;
    }).join('');

    // Reply button: pre-fill textarea with @mention
    feed.querySelectorAll('.comment-reply-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const ta = document.getElementById('commentBody');
        if (ta) { ta.value = `@${btn.dataset.replyName} `; ta.focus(); ta.dataset.parentId = btn.dataset.replyTo; }
      });
    });
    // Delete button
    feed.querySelectorAll('.comment-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить комментарий?')) return;
        await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/comments/${btn.dataset.id}/delete`,
          { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
        hydrateProjectActivity(projectId);
      });
    });
  } catch (e) { feed.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

function setupProjectComments(projectId) {
  const submitBtn = document.getElementById('commentSubmitBtn');
  const ta = document.getElementById('commentBody');
  if (!submitBtn || !ta) return;

  const submit = async () => {
    const body = ta.value.trim();
    if (!body) return;
    const parentId = ta.dataset.parentId || null;
    submitBtn.disabled = true;
    try {
      await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/comments`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ body, parentId }),
      });
      ta.value = ''; delete ta.dataset.parentId;
      hydrateProjectActivity(projectId);
    } catch (e) { toast(e.message); }
    finally { submitBtn.disabled = false; }
  };
  submitBtn.addEventListener('click', submit);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); });
}

async function hydrateProjectTeam(projectId) {
  const list = document.getElementById('projectTeamList');
  if (!list) return;
  try {
    const resp = await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/team`);
    const { members } = await resp.json();
    if (!members.length) { list.innerHTML = '<p class="empty-copy" style="font-size:13px">Никто не назначен.</p>'; return; }
    list.innerHTML = members.map(m => `
      <div class="team-chip" data-mid="${m.member_id}">
        <span class="team-chip-avatar">${(m.name||'?')[0].toUpperCase()}</span>
        <div>
          <strong>${escapeHtml(m.name)}</strong>
          <small style="display:block;color:var(--text-muted)">${escapeHtml(m.role_on_project||m.trade||'')}</small>
        </div>
        <span style="color:${AVAIL_COLOR[m.availability]||'#778195'};font-size:10px" title="${AVAIL_LABEL[m.availability]||''}">●</span>
        <button class="icon-button team-unassign-btn" data-mid="${m.member_id}" type="button" title="Снять назначение" style="font-size:11px;opacity:.5">✕</button>
      </div>`).join('');
    list.querySelectorAll('.team-unassign-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/team/${btn.dataset.mid}/remove`,
          { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
        hydrateProjectTeam(projectId);
      });
    });
  } catch (e) { list.innerHTML = `<p class="empty-copy" style="color:#e05353;font-size:13px">${e.message}</p>`; }
}

async function setupProjectTeam(projectId) {
  const assignBtn = document.getElementById('assignMemberBtn');
  const dialog = document.getElementById('assignMemberDialog');
  const closeBtn = document.getElementById('closeAssignDialog');
  const cancelBtn = document.getElementById('cancelAssignDialog');
  const confirmBtn = document.getElementById('confirmAssignBtn');
  const select = document.getElementById('assignMemberSelect');
  const roleInput = document.getElementById('assignRoleInput');
  if (!assignBtn || !dialog) return;

  assignBtn.addEventListener('click', async () => {
    try {
      const resp = await apiFetch('/api/v1/team');
      const { members } = await resp.json();
      if (select) select.innerHTML = members.map(m =>
        `<option value="${m.id}">${escapeHtml(m.name)} — ${escapeHtml(m.trade||m.role)}</option>`).join('');
    } catch { /* ignore */ }
    if (roleInput) roleInput.value = '';
    dialog.showModal();
  });
  closeBtn?.addEventListener('click', () => dialog.close());
  cancelBtn?.addEventListener('click', () => dialog.close());
  confirmBtn?.addEventListener('click', async () => {
    const memberId = select?.value;
    if (!memberId) return;
    confirmBtn.disabled = true;
    try {
      await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/team`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ memberId, roleOnProject: roleInput?.value.trim()||'' }),
      });
      dialog.close();
      hydrateProjectTeam(projectId);
    } catch (err) { toast(err.message); }
    finally { confirmBtn.disabled = false; }
  });
}

// ── Object Storage ──────────────────────────────────────────────────────────

const MIME_ICONS = {
  'image/': '🖼', 'video/': '🎬', 'audio/': '🔊', 'application/pdf': '📄',
  'application/zip': '📦', 'application/x-zip': '📦',
  'text/': '📝', 'application/json': '{}',
};

function mimeIcon(mime) {
  for (const [prefix, icon] of Object.entries(MIME_ICONS)) {
    if (mime.startsWith(prefix)) return icon;
  }
  return '📎';
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

const _POLICY_BADGE = {
  org:        '<span style="font-size:9px;color:var(--accent);font-weight:700">ORG</span>',
  project:    '<span style="font-size:9px;color:var(--accent-yellow,#e09800);font-weight:700">PROJ</span>',
  restricted: '<span style="font-size:9px;color:#e05353;font-weight:700">🔒</span>',
};

function _renderObjectCard(o, projectId) {
  const quarantine = o.scan_result === 'quarantine';
  const policy = o.access_policy || 'org';
  const scanBadge = quarantine
    ? '<span class="badge-warn">⚠ Карантин</span>'
    : (o.version_number > 1 ? `<span class="badge-muted">v${o.version_number}</span>` : '');
  const policyBadge = _POLICY_BADGE[policy] || '';
  const versionBtn = o.version_number >= 1
    ? `<button class="button ghost obj-versions-btn" data-id="${o.id}" data-name="${escapeHtml(o.name)}" type="button" title="История версий" style="padding:4px 8px;font-size:12px">⊞</button>`
    : '';
  const policyBtn = `<button class="button ghost obj-policy-btn" data-id="${o.id}" data-policy="${policy}"
    type="button" title="Политика доступа: ${policy}" style="padding:4px 6px;font-size:11px">${policyBadge}</button>`;
  return `<div class="object-card${quarantine ? ' quarantine' : ''}${policy === 'restricted' ? ' obj-restricted' : ''}" data-obj-id="${o.id}">
    <div class="object-icon">${mimeIcon(o.mime_type)}</div>
    <div class="object-info">
      <strong title="${escapeHtml(o.name)}">${escapeHtml(o.name)}</strong>
      <small>${fmtBytes(o.size_bytes)} · ${(o.created_at || '').slice(0,10)}</small>
      ${scanBadge}
      ${o.description ? `<span class="obj-desc">${escapeHtml(o.description)}</span>` : ''}
    </div>
    <div class="object-actions">
      ${!quarantine ? `<a class="button ghost" href="/api/v1/objects/${o.id}" download="${escapeHtml(o.name)}" style="padding:4px 8px;font-size:12px">↓</a>` : ''}
      ${versionBtn}
      ${policyBtn}
      <button class="button ghost obj-delete-btn" data-id="${o.id}" type="button" style="padding:4px 8px;font-size:12px">✕</button>
    </div>
  </div>`;
}

async function hydrateProjectObjects(projectId, query = '') {
  const grid = document.getElementById('objectsGrid');
  const info = document.getElementById('objectsStorageInfo');
  if (!grid) return;
  try {
    if (query) {
      const resp = await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/objects?q=${encodeURIComponent(query)}`);
      const { results } = await resp.json();
      if (!results.length) { grid.innerHTML = `<p class="empty-copy">По запросу «${escapeHtml(query)}» ничего не найдено.</p>`; return; }
      grid.innerHTML = results.map(o => _renderObjectCard(o, projectId)).join('');
    } else {
      const resp = await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/objects`);
      const { objects, stats } = await resp.json();
      if (info) info.textContent = `${stats.count} файлов · ${fmtBytes(stats.totalBytes)} из ${fmtBytes(stats.quotaBytes)}`;
      if (!objects.length) { grid.innerHTML = '<p class="empty-copy">Нет файлов. Загрузите первый.</p>'; return; }
      grid.innerHTML = objects.map(o => _renderObjectCard(o, projectId)).join('');
    }
    grid.querySelectorAll('.obj-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить файл?')) return;
        await apiFetch(`/api/v1/objects/${btn.dataset.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        hydrateProjectObjects(projectId);
      });
    });
    grid.querySelectorAll('.obj-versions-btn').forEach(btn => {
      btn.addEventListener('click', () => showObjectVersions(btn.dataset.id, btn.dataset.name, projectId));
    });
    grid.querySelectorAll('.obj-policy-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const current = btn.dataset.policy || 'org';
        const cycle = { org: 'project', project: 'restricted', restricted: 'org' };
        const next = cycle[current] || 'org';
        const labels = { org: 'Org-wide (все в организации)', project: 'Project-only (только назначенные)', restricted: 'Restricted (блок для AI retrieval)' };
        if (!confirm(`Изменить политику доступа:\n${labels[current]} → ${labels[next]}`)) return;
        try {
          await apiFetch(`/api/v1/objects/${btn.dataset.id}/policy`, {
            method: 'POST',
            headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
            body: JSON.stringify({ policy: next }),
          });
          hydrateProjectObjects(projectId);
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
  } catch (e) { grid.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
}

async function showObjectVersions(objId, name, projectId) {
  try {
    const resp = await apiFetch(`/api/v1/objects/${encodeURIComponent(objId)}/versions`);
    const { versions } = await resp.json();
    const dialog = document.getElementById('objectVersionsDialog');
    if (!dialog) return;
    document.getElementById('objectVersionsName').textContent = name;
    const list = document.getElementById('objectVersionsList');
    list.innerHTML = versions.map(v =>
      `<tr><td>v${v.version_number}</td><td>${fmtBytes(v.size_bytes)}</td>
       <td>${(v.created_at || '').slice(0,10)}</td>
       <td><a href="/api/v1/objects/${v.id}" download="${escapeHtml(v.name)}" class="button ghost" style="padding:2px 8px;font-size:11px">↓</a></td></tr>`
    ).join('');
    dialog.showModal();
  } catch (e) { toast(e.message); }
}

async function uploadFiles(projectId, files) {
  const zone = document.getElementById('objectsDropZone');
  for (const file of files) {
    if (zone) zone.textContent = `Загрузка ${file.name}…`;
    try {
      const buf = await file.arrayBuffer();
      const resp = await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/objects`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': file.name, 'Content-Length': buf.byteLength },
        body: buf,
      });
      if (!resp.ok) { const e = await resp.json(); toast(e.error?.message || 'Upload failed'); }
    } catch (err) { toast(err.message); }
  }
  if (zone) zone.textContent = 'Перетащите файлы сюда или нажмите «Загрузить»';
  hydrateProjectObjects(projectId);
}

function setupProjectObjects(projectId) {
  const input = document.getElementById('objectFileInput');
  const zone = document.getElementById('objectsDropZone');
  const searchInput = document.getElementById('objectsSearchInput');
  const closeVersions = document.getElementById('closeObjectVersionsDialog');
  if (input) input.addEventListener('change', () => { if (input.files.length) uploadFiles(projectId, [...input.files]); input.value = ''; });
  if (zone) {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); uploadFiles(projectId, [...e.dataTransfer.files]); });
  }
  if (searchInput) {
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => hydrateProjectObjects(projectId, searchInput.value.trim()), 300);
    });
  }
  if (closeVersions) closeVersions.addEventListener('click', () => document.getElementById('objectVersionsDialog')?.close());
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

async function openJobberReport(project){const date=new Date().toISOString().slice(0,10); const response=await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/daily-report?date=${date}`,{headers:apiHeaders()}); const report=await response.json(); $('#jobberReportDate').value=date; $('#jobberReportText').value=report.text; $('#jobberReportDialog').showModal();}

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

function projectScopeOptions() {
  if (workflowConfiguration.length) return workflowConfiguration.filter(value => value.active !== false);
  return [...new Map(projects.flatMap(project => project.workTypes || []).map(value => [value.id, value])).values()];
}

function populateProjectWorkTypeScope() {
  const container = $('#projectWorkTypeScope');
  if (!container) return;
  const options = projectScopeOptions();
  container.innerHTML = options.map(workType => `<label class="scope-check"><input type="checkbox" value="${escapeHtml(workType.id)}" checked><span style="--scope:${escapeHtml(workType.color || '#7c8cff')}"></span><b>${escapeHtml(workType.name)}</b></label>`).join('');
  $('#selectAllProjectWorkTypes').textContent = 'Clear all';
}

function toggleProjectWorkTypeSelection() {
  const inputs = [...document.querySelectorAll('#projectWorkTypeScope input')];
  const shouldSelect = inputs.some(input => !input.checked);
  inputs.forEach(input => { input.checked = shouldSelect; });
  $('#selectAllProjectWorkTypes').textContent = shouldSelect ? 'Clear all' : 'Select all';
}

async function submitProject(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  submitButton.disabled = true;
  const workTypeIds = [...document.querySelectorAll('#projectWorkTypeScope input:checked')].map(input => input.value);
  if (!workTypeIds.length) { toast('Выберите хотя бы один вид работ'); submitButton.disabled = false; return; }
  try {
    await apiPost('/api/v1/projects', {
      code: $('#projectCode').value.trim(), name: $('#projectName').value.trim(),
      description: $('#projectDescription').value.trim(), priority: $('#projectPriority').value,
      startDate: $('#projectStartDate').value || null, targetDate: $('#projectTargetDate').value || null,
      workTypeIds,
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
  const projectId = $('#dailyProjectId').value;
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/daily-updates${entryId ? `/${encodeURIComponent(entryId)}` : ''}`;
  try {
    if (!navigator.onLine) {
      _enqueueWrite(entryId ? 'PATCH' : 'POST', path,
        {'Content-Type':'application/json'}, JSON.stringify(payload),
        'daily_update', `Daily update ${payload.workDate}`);
      $('#dailyUpdateDialog').close();
      toast('Офлайн — отчет добавлен в очередь синхронизации');
      return;
    }
    if (entryId) await apiPatch(path,payload); else await apiPost(path,payload);
    $('#dailyUpdateDialog').close(); await hydrateProjects(); toast(entryId ? 'Обновление изменено' : 'Отчет сохранен');
  } catch(error) {
    if (!navigator.onLine) {
      _enqueueWrite(entryId ? 'PATCH' : 'POST', path,
        {'Content-Type':'application/json'}, JSON.stringify(payload),
        'daily_update', `Daily update ${payload.workDate}`);
      $('#dailyUpdateDialog').close();
      toast('Потеря соединения — отчет сохранён локально');
    } else {
      toast(error.code === 'version_conflict' ? 'Отчет уже изменен другим пользователем' : error.message);
    }
  } finally { button.disabled=false; }
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
  applyRolePolicy();
}

function renderBoard() {
  const isKanban = taskViewMode === 'kanban';
  const isGraph  = taskViewMode === 'graph';
  $('#board')?.classList.toggle('hidden', !isKanban);
  $('#taskGraph')?.classList.toggle('hidden', !isGraph);
  document.querySelectorAll('[data-task-view]').forEach(b => b.classList.toggle('active', b.dataset.taskView === taskViewMode));

  // Search count badge
  const q = $('#searchInput')?.value.trim();
  const countEl = document.getElementById('searchCount');
  if (countEl) {
    if (q) {
      const n = filteredTasks().length;
      countEl.textContent = n;
      countEl.title = `${n} задач найдено`;
      countEl.classList.toggle('hidden', false);
    } else {
      countEl.textContent = '';
      countEl.classList.toggle('hidden', true);
    }
  }

  if (isKanban) {
    const tasks = filteredTasks();
    const statusFilter = $('#statusFilter').value;
    const visibleStatuses = statusFilter === 'all' ? STATUSES : STATUSES.filter(s => s.id === statusFilter);
    const board = $('#board');
    board.classList.toggle('single-column', visibleStatuses.length === 1);
    // Build into a fragment to minimise reflow
    const frag = document.createDocumentFragment();
    visibleStatuses.forEach(status => {
      const cards = tasks.filter(t => t.status === status.id);
      const section = document.createElement('section');
      section.className = 'column';
      section.dataset.status = status.id;
      section.innerHTML = `<header><span class="status-dot ${status.tone}"></span><strong>${status.label}</strong><b>${cards.length}</b></header>
        <div class="card-list" data-dropzone="${status.id}">${cards.map(taskCard).join('') || '<div class="empty-state">Перетащите задачу сюда</div>'}</div>
        <button class="add-inline" type="button" data-add-status="${status.id}">＋ Добавить</button>`;
      frag.appendChild(section);
    });
    board.innerHTML = '';
    board.appendChild(frag);
    bindBoardEvents();
  } else if (isGraph) {
    renderTaskGraph();
  }
}

function renderTaskGraph() {
  const container = $('#taskGraph');
  if (!container) return;
  const tasks = filteredTasks(true);
  const byId = new Map(tasks.map(t => [t.id, t]));
  // Clean up any prior global listeners attached to this graph instance
  if (container._graphCleanup) container._graphCleanup();
  if (!tasks.length) {
    container.innerHTML = '<div class="graph-empty">Нет задач для текущих фильтров.</div>';
    return;
  }

  // Build edges
  const edges = [];
  const seenEdges = new Set();
  const addEdge = (from, to, kind) => {
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    const key = `${from}->${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, kind });
  };
  tasks.forEach(task => {
    (task.dependsOn || []).forEach(src => addEdge(src, task.id, 'depends'));
    if (task.parentId) addEdge(task.parentId, task.id, 'parent');
    (task.unblocks || []).forEach(tgt => addEdge(task.id, tgt, 'unblocks'));
  });

  // Per-node adjacency index for fast edge updates
  const nodeEdges = new Map();
  tasks.forEach(t => nodeEdges.set(t.id, []));
  edges.forEach((e, i) => {
    nodeEdges.get(e.from)?.push(i);
    nodeEdges.get(e.to)?.push(i);
  });

  // Initial layout — spiral so nodes start spread out, not clumped
  const CX = 900, CY = 680;
  const MIN_DIST = 90;          // hard collision radius
  const SPRING_LEN = 200;       // rest length of edge springs
  const REPULSION = 22000;      // node-node repulsion constant
  const nodes = tasks.map((task, i) => {
    // Golden-angle spiral gives even distribution without crowding
    const angle = i * 2.399963; // golden angle ≈ 137.5°
    const r = 55 * Math.sqrt(i + 1);
    return { id: task.id, task, x: CX + Math.cos(angle) * r, y: CY + Math.sin(angle) * r, vx: 0, vy: 0 };
  });
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Force simulation
  for (let iter = 0; iter < 220; iter++) {
    const alpha = Math.pow(1 - iter / 220, 1.6); // slower cool-down
    // Repulsion + collision
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const dist = Math.sqrt(d2);
        // Normal repulsion
        const rep = (REPULSION / d2) * alpha;
        // Extra hard push when nodes overlap
        const col = dist < MIN_DIST ? (MIN_DIST - dist) * 3.5 : 0;
        const f = rep + col;
        const fx = (dx / dist) * f, fy = (dy / dist) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    // Spring attraction along edges — weaker than repulsion
    edges.forEach(e => {
      const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (dist - SPRING_LEN) * 0.03 * alpha;
      const fx = (dx / dist) * f, fy = (dy / dist) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    });
    // Weak center gravity
    nodes.forEach(n => {
      n.vx += (CX - n.x) * 0.003 * alpha;
      n.vy += (CY - n.y) * 0.003 * alpha;
      n.vx *= 0.76; n.vy *= 0.76;
      n.x += n.vx; n.y += n.vy;
    });
  }

  const STATUS_COLOR = {
    ideas: '#a87aff', backlog: '#778195', ready: '#30d7d7',
    in_progress: '#6785ff', blocked: '#ff657b', review: '#ffb84c',
    testing: '#ef78ca', done: '#42d697',
  };

  // DOM structure
  container.innerHTML = '';
  const legend = STATUSES.map(s => `<span><i class="${s.tone}"></i>${s.label}</span>`).join('');
  const meta = document.createElement('div');
  meta.className = 'graph-meta';
  meta.innerHTML = `<div><strong>${tasks.length}</strong><span>задач</span></div><div><strong>${edges.length}</strong><span>связей</span></div><p>Колесо — зум · Фон — пан · Вершина — переместить · Клик — открыть</p>`;
  container.appendChild(meta);
  const legendEl = document.createElement('div');
  legendEl.className = 'graph-legend';
  legendEl.innerHTML = legend;
  container.appendChild(legendEl);

  const canvas = document.createElement('div');
  canvas.className = 'graph-canvas graph-canvas--interactive';
  container.appendChild(canvas);

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.cssText = 'display:block;cursor:grab;user-select:none;touch-action:none;';
  canvas.appendChild(svg);

  // Arrowhead markers
  const defs = document.createElementNS(NS, 'defs');
  [['arrow-depends','#536078'],['arrow-parent','#8b8fa8'],['arrow-unblocks','#6fdcbf']].forEach(([id, color]) => {
    const m = document.createElementNS(NS, 'marker');
    m.setAttribute('id', id); m.setAttribute('markerWidth', '8'); m.setAttribute('markerHeight', '6');
    m.setAttribute('refX', '7'); m.setAttribute('refY', '3'); m.setAttribute('orient', 'auto');
    const p = document.createElementNS(NS, 'polygon');
    p.setAttribute('points', '0 0, 8 3, 0 6'); p.setAttribute('fill', color); p.setAttribute('opacity', '0.65');
    m.appendChild(p); defs.appendChild(m);
  });
  svg.appendChild(defs);

  // Zoom/pan root group
  const root = document.createElementNS(NS, 'g');
  svg.appendChild(root);
  let tx = 0, ty = 0, scale = 1;
  const applyT = () => root.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
  applyT();

  // Draw edges first (below nodes)
  const edgeElems = edges.map(e => {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('class', `graph-edge ${e.kind}`);
    line.setAttribute('marker-end', `url(#arrow-${e.kind})`);
    const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    root.appendChild(line);
    return line;
  });

  const updateEdgesForNode = id => {
    nodeEdges.get(id)?.forEach(i => {
      const e = edges[i], line = edgeElems[i];
      if (!line) return;
      const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    });
  };

  // Draw nodes
  const LABEL_MAX = 20;
  nodes.forEach(node => {
    const linkCount = nodeEdges.get(node.id)?.length || 0;
    const r = linkCount > 5 ? 30 : linkCount > 2 ? 26 : 22;
    const color = STATUS_COLOR[node.task.status] || '#778195';
    const label = node.task.title.length > LABEL_MAX ? node.task.title.slice(0, LABEL_MAX) + '…' : node.task.title;

    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'graph-node');
    g.setAttribute('tabindex', '0');
    g.setAttribute('transform', `translate(${node.x},${node.y})`);

    // Glow
    const glow = document.createElementNS(NS, 'circle');
    glow.setAttribute('r', r + 8); glow.setAttribute('fill', color); glow.setAttribute('opacity', '0.1');
    g.appendChild(glow);

    // Circle
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('r', r); circle.setAttribute('fill', color);
    circle.setAttribute('stroke', '#cdd5e0'); circle.setAttribute('stroke-width', '1.2'); circle.setAttribute('stroke-opacity', '0.4');
    g.appendChild(circle);

    // ID inside circle — bold, dark, readable
    const idTxt = document.createElementNS(NS, 'text');
    idTxt.setAttribute('text-anchor', 'middle');
    idTxt.setAttribute('dominant-baseline', 'middle');
    idTxt.setAttribute('y', '0');
    idTxt.setAttribute('font-size', r > 26 ? '9.5' : '8.5');
    idTxt.setAttribute('font-family', "'DM Mono',monospace");
    idTxt.setAttribute('font-weight', '800');
    idTxt.setAttribute('fill', '#060c14');
    idTxt.setAttribute('pointer-events', 'none');
    idTxt.textContent = node.id;
    g.appendChild(idTxt);

    // Title label below — on a pill background
    const LW = Math.max(label.length * 6.2 + 16, 72);
    const LH = 18, LY = r + 6;
    const pill = document.createElementNS(NS, 'rect');
    pill.setAttribute('x', String(-LW / 2)); pill.setAttribute('y', String(LY));
    pill.setAttribute('width', String(LW)); pill.setAttribute('height', String(LH));
    pill.setAttribute('rx', '5'); pill.setAttribute('fill', '#101929');
    pill.setAttribute('fill-opacity', '0.88'); pill.setAttribute('pointer-events', 'none');
    g.appendChild(pill);

    const titleTxt = document.createElementNS(NS, 'text');
    titleTxt.setAttribute('text-anchor', 'middle');
    titleTxt.setAttribute('dominant-baseline', 'middle');
    titleTxt.setAttribute('y', String(LY + LH / 2));
    titleTxt.setAttribute('font-size', '10');
    titleTxt.setAttribute('font-family', 'Inter,system-ui,sans-serif');
    titleTxt.setAttribute('font-weight', '500');
    titleTxt.setAttribute('fill', '#dde4f0');
    titleTxt.setAttribute('pointer-events', 'none');
    titleTxt.textContent = label;
    g.appendChild(titleTxt);

    // Native tooltip
    const svgTitle = document.createElementNS(NS, 'title');
    svgTitle.textContent = `${node.id} · ${node.task.title}\n${node.task.status} · ${linkCount} связей`;
    g.appendChild(svgTitle);

    root.appendChild(g);
    node.el = g;
    node.circle = circle;
    node.glow = glow;

    g.addEventListener('mouseenter', () => {
      circle.setAttribute('stroke-opacity', '1'); circle.setAttribute('stroke-width', '2');
      glow.setAttribute('opacity', '0.2');
    });
    g.addEventListener('mouseleave', () => {
      circle.setAttribute('stroke-opacity', '0.4'); circle.setAttribute('stroke-width', '1.2');
      glow.setAttribute('opacity', '0.1');
    });
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') openDialog(node.id); });
  });

  // ── Unified drag state ──────────────────────────────────────────────
  // Single object tracks whether we're panning or dragging a node.
  // All movement goes through ONE window mousemove — no per-node listeners.
  let drag = null; // null | { kind:'pan', ox, oy } | { kind:'node', node, ox, oy, moved }

  nodes.forEach(node => {
    node.el.addEventListener('mousedown', e => {
      e.stopPropagation(); // prevent pan
      drag = { kind: 'node', node, ox: (e.clientX - tx) / scale - node.x, oy: (e.clientY - ty) / scale - node.y, moved: false };
      svg.style.cursor = 'grabbing';
    });
  });

  svg.addEventListener('mousedown', e => {
    drag = { kind: 'pan', ox: e.clientX - tx, oy: e.clientY - ty };
    svg.style.cursor = 'grabbing';
  });

  const onMouseMove = e => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      tx = e.clientX - drag.ox; ty = e.clientY - drag.oy; applyT();
    } else {
      drag.moved = true;
      drag.node.x = (e.clientX - tx) / scale - drag.ox;
      drag.node.y = (e.clientY - ty) / scale - drag.oy;
      drag.node.el.setAttribute('transform', `translate(${drag.node.x},${drag.node.y})`);
      updateEdgesForNode(drag.node.id);
    }
  };
  const onMouseUp = e => {
    if (drag?.kind === 'node' && !drag.moved) openDialog(drag.node.id);
    drag = null;
    svg.style.cursor = 'grab';
  };
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  // Zoom
  const onWheel = e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    tx = mx - (mx - tx) * factor;
    ty = my - (my - ty) * factor;
    scale = Math.min(5, Math.max(0.1, scale * factor));
    applyT();
  };
  svg.addEventListener('wheel', onWheel, { passive: false });

  // Pinch zoom
  let pinchDist = null;
  const onTouchStart = e => { if (e.touches.length === 2) { const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY; pinchDist = Math.sqrt(dx*dx+dy*dy); } };
  const onTouchMove = e => { if (e.touches.length === 2 && pinchDist) { const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY; const d = Math.sqrt(dx*dx+dy*dy); scale = Math.min(5, Math.max(0.1, scale * d / pinchDist)); pinchDist = d; applyT(); } };
  const onTouchEnd = () => { pinchDist = null; };
  svg.addEventListener('touchstart', onTouchStart, { passive: true });
  svg.addEventListener('touchmove', onTouchMove, { passive: true });
  svg.addEventListener('touchend', onTouchEnd);

  // Cleanup when graph is re-rendered (filter change etc.)
  container._graphCleanup = () => {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    svg.removeEventListener('wheel', onWheel);
  };

  // Fit to view
  const rect = canvas.getBoundingClientRect();
  const W = rect.width || 900, H = rect.height || 600;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs) - 60, maxX = Math.max(...xs) + 80;
  const minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 80;
  scale = Math.min(W / (maxX - minX), H / (maxY - minY), 1.4) * 0.85;
  tx = (W - (maxX + minX) * scale) / 2;
  ty = (H - (maxY + minY) * scale) / 2;
  applyT();
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

async function exportProjectData(projectId, projectName) {
  try {
    const data = await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    const slug = (projectName || projectId).replace(/[^a-zа-яё0-9]+/gi, '-').toLowerCase();
    link.download = `rp-project-${slug}-${new Date().toISOString().slice(0,10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast('Данные проекта экспортированы');
  } catch (e) { toast(`Ошибка экспорта: ${e.message}`); }
}

let _pendingProjectImport = null;

async function openProjectImportPreview(file) {
  try {
    const raw = JSON.parse(await file.text());
    if (raw.schema !== 'rackpilot-project-export/1') {
      toast('Неверный формат файла (ожидается rackpilot-project-export/1)');
      return;
    }
    _pendingProjectImport = raw;
    const proj = raw.project || {};
    const preview = document.getElementById('projectImportPreview');
    if (preview) {
      preview.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px">
          <tr><td style="padding:5px 8px;color:var(--text-secondary)">Проект</td><td style="padding:5px 8px;font-weight:600">${escapeHtml(proj.name||'—')} <span style="color:var(--text-secondary)">${escapeHtml(proj.code||'')}</span></td></tr>
          <tr><td style="padding:5px 8px;color:var(--text-secondary)">Статус</td><td style="padding:5px 8px">${escapeHtml(proj.status||'—')}</td></tr>
          <tr><td style="padding:5px 8px;color:var(--text-secondary)">Здания</td><td style="padding:5px 8px">${(raw.buildings||[]).length}</td></tr>
          <tr><td style="padding:5px 8px;color:var(--text-secondary)">Локации</td><td style="padding:5px 8px">${(raw.locations||[]).length}</td></tr>
          <tr><td style="padding:5px 8px;color:var(--text-secondary)">Work items</td><td style="padding:5px 8px">${(raw.work_items||[]).length}</td></tr>
          <tr><td style="padding:5px 8px;color:var(--text-secondary)">Daily updates</td><td style="padding:5px 8px">${(raw.daily_updates||[]).length}</td></tr>
          <tr><td style="padding:5px 8px;color:var(--text-secondary)">Экспортирован</td><td style="padding:5px 8px">${(raw.exported_at||'').slice(0,16).replace('T',' ')}</td></tr>
        </table>
        <p style="font-size:12px;color:var(--text-secondary);margin:0">Существующие записи с совпадающими ID будут пропущены (INSERT OR IGNORE).</p>`;
    }
    document.getElementById('projectImportDialog')?.showModal();
  } catch { toast('Не удалось прочитать файл'); }
}

function setupProjectImport() {
  document.getElementById('confirmProjectImportBtn')?.addEventListener('click', async () => {
    if (!_pendingProjectImport) return;
    const btn = document.getElementById('confirmProjectImportBtn');
    btn.disabled = true;
    try {
      const result = await apiFetch('/api/v1/projects/import', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify(_pendingProjectImport),
      });
      document.getElementById('projectImportDialog')?.close();
      _pendingProjectImport = null;
      toast(`Импорт: ${result.imported?.work_items||0} задач, ${result.imported?.locations||0} локаций`);
      hydrateProjects();
    } catch (e) { toast(`Ошибка импорта: ${e.message}`); }
    finally { btn.disabled = false; }
  });

  document.querySelector('[data-close-dialog="projectImportDialog"]')?.addEventListener('click', () => {
    document.getElementById('projectImportDialog')?.close();
    _pendingProjectImport = null;
  });
}

function exportState() {
  const blob = new Blob([JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `rackpilot-workspace-${new Date().toISOString().slice(0,10)}.json`;
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
  $('#roleSwitcher').addEventListener('change', event => setCurrentRole(event.target.value));
  $('#addTaskButton').addEventListener('click', () => openDialog());
  $('#requestContinueButton').addEventListener('click',requestDevelopmentContinuation);
  $('#taskForm').addEventListener('submit', saveTask);
  $('#deleteTaskButton').addEventListener('click', deleteTask);
  $('#exportButton').addEventListener('click', exportState);
  $('#importInput').addEventListener('change', e => e.target.files[0] && importState(e.target.files[0]));
  $('#clearAuditButton').addEventListener('click', () => { state.audit = []; persist('', { auditDirty: true }); renderAudit(); });
  $('#newProjectButton').addEventListener('click', () => { $('#projectForm').reset(); populateProjectWorkTypeScope(); $('#projectDialog').showModal(); requestAnimationFrame(() => $('#projectCode').focus()); });
  $('#selectAllProjectWorkTypes').addEventListener('click', toggleProjectWorkTypeSelection);
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
  // Selects respond instantly; text search debounced to avoid render on every keystroke
  const renderBoardDebounced = debounce(renderBoard, 130);
  $('#searchInput').addEventListener('input', renderBoardDebounced);
  ['priorityFilter','areaFilter','statusFilter'].forEach(id => $(`#${id}`).addEventListener('change', renderBoard));
  document.querySelectorAll('[data-task-view]').forEach(button => button.addEventListener('click', () => { taskViewMode = button.dataset.taskView; renderBoard(); }));
  // Log search: text debounced (triggers network), selects instant
  const hydrateLogsDebounced = debounce(hydrateLogs, 280);
  $('#logSearchInput').addEventListener('input', hydrateLogsDebounced);
  ['logSourceFilter','logProjectFilter','logEntityFilter','logDateFrom','logDateTo'].forEach(id => $(`#${id}`)?.addEventListener('change', hydrateLogs));
  $('#refreshLogsButton')?.addEventListener('click', hydrateLogs);
  $('#exportLogsBtn')?.addEventListener('click', exportLogsCSV);
  $('#refreshApiMetricsButton').addEventListener('click', hydrateApiMetrics);
  setupProjectImport();
  window.addEventListener('online', _onNetworkOnline);
  window.addEventListener('offline', _onNetworkOffline);
  _updateOfflineBanner();
  window.addEventListener('hashchange', renderRoute);

  // Login form
  let _mfaChallengeToken = null;

  function _showMfaStep() {
    document.getElementById('loginForm').style.display = 'none';
    const mfaStep = document.getElementById('mfaStep');
    mfaStep.style.display = 'flex';
    document.getElementById('mfaCode').value = '';
    document.getElementById('mfaError').style.display = 'none';
    setTimeout(() => document.getElementById('mfaCode').focus(), 50);
  }
  function _hideMfaStep() {
    document.getElementById('loginForm').style.display = 'flex';
    document.getElementById('mfaStep').style.display = 'none';
    _mfaChallengeToken = null;
  }

  async function _finishLogin(data) {
    setSession(data);
    if (data.role) setCurrentRole(data.role);
    hideLoginModal();
    await Promise.all([hydrateFromServer(), hydrateProjects()]);
  }

  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      const errEl = document.getElementById('loginError');
      errEl.style.display = 'none';
      const btn = loginForm.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Вход...';
      try {
        const resp = await fetch('/api/v1/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error?.message || 'Неверный email или пароль');
        if (data.mfaRequired) {
          _mfaChallengeToken = data.challengeToken;
          _showMfaStep();
        } else {
          await _finishLogin(data);
        }
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      } finally {
        btn.disabled = false; btn.textContent = 'Войти';
      }
    });
  }

  document.getElementById('mfaSubmitBtn')?.addEventListener('click', async () => {
    const code = document.getElementById('mfaCode').value.trim();
    const errEl = document.getElementById('mfaError');
    errEl.style.display = 'none';
    if (!code || !_mfaChallengeToken) return;
    const btn = document.getElementById('mfaSubmitBtn');
    btn.disabled = true; btn.textContent = 'Проверка…';
    try {
      const resp = await fetch('/api/v1/auth/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: _mfaChallengeToken, code }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error?.message || 'Неверный код');
      await _finishLogin(data);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Подтвердить';
    }
  });
  document.getElementById('mfaCode')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('mfaSubmitBtn')?.click(); });
  document.getElementById('mfaBackBtn')?.addEventListener('click', _hideMfaStep);

  // Logout button
  const logoutBtn = document.getElementById('logoutButton');
  if (logoutBtn) logoutBtn.addEventListener('click', () => logout());

  // Restore role from session, or show login
  const session = getSession();
  if (session?.token) {
    if (session.role) setCurrentRole(session.role);
  } else {
    showLoginModal();
  }

  setupMFA();
  setupAIGateway();
  setupFeatureDocs();
  setupSecretsVault();
  setupRetrievalEval();
  setupAIApprovals();
  setupCodexDialog();
  setupTeam();
  setupLangToggle();
  setupAiGateway();
  setupTimeTracking();
  setupConflictQueue();
  setupKnowledgeSearch();
  applyRolePolicy();
  renderRoute();
  render();
  await Promise.all([hydrateFromServer(), hydrateProjects(),hydrateCustomFieldDefinitions(),hydratePlatformSettings(),hydrateGitSyncSettings(),hydrateAgentStatus()]);
  await flushUnitOutbox();
  setInterval(()=>{ if(document.body.dataset.route==='admin' && !document.hidden) hydrateComputeNodes(); }, 8000);
  setInterval(()=>{ if(document.body.dataset.route==='api' && !document.hidden) hydrateApiMetrics(); }, 8000);
  // Agent status: 15s interval, skip when tab is hidden
  setInterval(()=>{ if(!document.hidden) hydrateAgentStatus(); }, 15000);
  // Flush write outbox every 30s if online
  setInterval(()=>{ if(navigator.onLine && _writeOutbox.length) _flushWriteOutbox(); }, 30000);
  // Refresh elapsed time in banner/indicator every 60s
  setInterval(()=>{ _updateOfflineBanner(); setSyncState(navigator.onLine ? 'synced' : 'offline'); }, 60000);
  // Initial banner state
  _updateOfflineBanner();
  // Restore projects from cache immediately before first network fetch
  const _initCache = _loadProjectsCache();
  if (_initCache?.data?.length && !projects.length) { projects = _initCache.data; renderProjects(); }
}

setup();

// PWA service worker registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Listen for messages from SW (e.g. flush outbox request)
    navigator.serviceWorker.addEventListener('message', ev => {
      if (ev.data?.type === 'FLUSH_OUTBOX' && navigator.onLine) _flushWriteOutbox();
    });
  }).catch(() => {});  // ignore — SW is enhancement only
}
