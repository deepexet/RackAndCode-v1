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
  if (route === 'inventory') { hydrateInventory(); }
  if (route === 'admin') { Promise.all([hydrateComputeNodes(),hydratePlatformSettings(),hydrateGitSyncSettings(),hydrateWorkflowConfiguration(),hydrateCustomFieldDefinitions(),hydrateSecretsVault(),hydrateFeatureDocs(),hydrateAIGateway(),hydratePrivacy(),hydrateMFA(),hydrateRetrievalEval(),hydrateAIApprovals(),hydrateTeam(),hydrateTimeTracking(),hydrateConflictQueue(),hydrateServiceMonitors(),hydrateConnectors(),hydrateTemplatesAdmin(),hydrateSessionsAdmin(),hydrateOrgSettings(),hydrateEmailInboxes()]); renderAITeam(); hydrateDigest(); document.dispatchEvent(new CustomEvent('routeChange',{detail:'admin'})); }
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

  const filterBar = document.getElementById('auditLogFilter');
  const limitSel = document.getElementById('auditLogLimit');
  const actionFilter = document.getElementById('auditLogActionFilter');

  // Inject filter controls if container supports them
  const section = el.closest('section') || el.parentElement;
  if (section && !document.getElementById('auditLogFilter')) {
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center';
    controls.innerHTML = `
      <input id="auditLogFilter" placeholder="Поиск по действию / актору…" style="flex:1;min-width:150px;padding:5px 10px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px">
      <select id="auditLogActionFilter" style="padding:5px 8px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px">
        <option value="">Все действия</option>
        <option value="auth">auth</option>
        <option value="inventory">inventory</option>
        <option value="project">project</option>
        <option value="supplier">supplier</option>
        <option value="reservation">reservation</option>
      </select>
      <select id="auditLogLimit" style="padding:5px 8px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px">
        <option value="50">50</option>
        <option value="100">100</option>
        <option value="200">200</option>
      </select>
      <button id="auditLogRefreshBtn" class="button ghost" type="button" style="font-size:12px">↻</button>`;
    el.before(controls);
  }

  async function loadAudit() {
    const q = document.getElementById('auditLogFilter')?.value || '';
    const action = document.getElementById('auditLogActionFilter')?.value || '';
    const limit = document.getElementById('auditLogLimit')?.value || '50';
    let url = `/api/v1/admin/audit-log?limit=${limit}`;
    if (action) url += `&action=${encodeURIComponent(action)}`;
    el.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    try {
      const resp = await apiFetch(url);
      const { entries } = await resp.json();
      let filtered = entries;
      if (q) {
        const lq = q.toLowerCase();
        filtered = entries.filter(e =>
          (e.action||'').toLowerCase().includes(lq) ||
          (e.actor_id||'').toLowerCase().includes(lq) ||
          (e.target_id||'').toLowerCase().includes(lq)
        );
      }
      if (!filtered.length) { el.innerHTML = '<p class="empty-copy">Нет записей.</p>'; return; }
      el.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px">
        ${filtered.map(e => {
          const OUTCOME_BADGE = { success: '#3bb969', failure: '#f46', warning: '#e8a84c' };
          const outcomeColor = OUTCOME_BADGE[e.outcome] || '#778195';
          return `<div class="audit-row" style="gap:6px;cursor:default" title="${escapeHtml(JSON.stringify({actor:e.actor_id,role:e.actor_role,target:e.target_id,ip:e.ip}))}">
            <code style="font-size:10px;color:var(--text-muted);min-width:130px;flex-shrink:0">${(e.created_at||'').slice(0,19).replace('T',' ')}</code>
            <span style="color:${outcomeColor};flex-shrink:0" title="${e.outcome||''}">●</span>
            <strong style="font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.action)}</strong>
            <small style="color:var(--text-muted);flex-shrink:0;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.actor_id||'—')}</small>
            ${e.target_type ? `<small style="color:var(--text-muted);flex-shrink:0;font-size:10px">${escapeHtml(e.target_type)}</small>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    } catch (e) { el.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }
  }

  loadAudit();
  document.getElementById('auditLogRefreshBtn')?.addEventListener('click', loadAudit);
  document.getElementById('auditLogFilter')?.addEventListener('input', () => loadAudit());
  document.getElementById('auditLogActionFilter')?.addEventListener('change', loadAudit);
  document.getElementById('auditLogLimit')?.addEventListener('change', loadAudit);
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

// ── AI Field Note Parsing ─────────────────────────────────────────────────
let _fieldNoteDraftId = null;
let _fieldNoteProjectId = null;

const CHANGE_TYPE_LABEL = {
  work_item_progress: '📋 Work item',
  location_progress:  '📍 Location',
  new_issue:          '⚠ New issue',
};
const SEVERITY_COLOR = { low: '#778195', medium: '#e09800', high: '#e05353', critical: '#b00' };

function _renderChangePreview(changes, unrecognized) {
  if (!changes.length && !unrecognized.length) {
    return '<p class="empty-copy">No changes detected. Try rephrasing the note.</p>';
  }

  const changesHtml = changes.map((c, i) => {
    const typeLabel = CHANGE_TYPE_LABEL[c.type] || c.type;
    const conf = Math.round((c.confidence || 0) * 100);
    const confColor = conf >= 80 ? 'var(--accent)' : conf >= 60 ? '#e09800' : '#e05353';

    let detail = '';
    if (c.type === 'work_item_progress') {
      detail = [
        c.work_item_code ? `<strong>${escapeHtml(c.work_item_code)}</strong>` : '',
        c.work_item_title ? escapeHtml(c.work_item_title) : '',
        c.completion_percent != null ? `→ ${c.completion_percent}%` : '',
        c.new_status ? `<span style="text-transform:uppercase;font-size:10px;font-weight:700;color:var(--accent)">${c.new_status}</span>` : '',
      ].filter(Boolean).join(' ');
    } else if (c.type === 'location_progress') {
      detail = [
        c.location_code ? `<strong>${escapeHtml(c.location_code)}</strong>` : '',
        c.location_name ? escapeHtml(c.location_name) : '',
        c.notes ? `— ${escapeHtml(c.notes.slice(0, 80))}` : '',
      ].filter(Boolean).join(' ');
    } else if (c.type === 'new_issue') {
      detail = `<span style="color:${SEVERITY_COLOR[c.severity]||'#e05353'}">[${c.severity}]</span> ${escapeHtml(c.title)}`;
    }

    return `<label style="display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:8px;border:1px solid var(--border);cursor:pointer;background:var(--surface)">
      <input type="checkbox" class="note-change-chk" data-index="${i}" checked style="margin-top:3px;flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:2px">
          <span style="font-size:11px;font-weight:700;color:var(--text-secondary)">${typeLabel}</span>
          <span style="font-size:10px;font-weight:700;color:${confColor}">${conf}% conf.</span>
        </div>
        <div style="font-size:13px">${detail}</div>
        ${c.notes && c.type !== 'location_progress' ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:3px">${escapeHtml(c.notes.slice(0,100))}</div>` : ''}
      </div>
    </label>`;
  }).join('');

  const unrecoHtml = unrecognized.length
    ? `<div style="margin-top:10px;padding:8px 12px;border-radius:8px;background:rgba(224,152,0,.08);border:1px solid rgba(224,152,0,.25)">
        <p style="font-size:11px;font-weight:700;color:#e09800;margin:0 0 4px">UNRECOGNIZED</p>
        ${unrecognized.map(s => `<p style="font-size:12px;color:var(--text-secondary);margin:2px 0">${escapeHtml(s)}</p>`).join('')}
       </div>`
    : '';

  return `<div style="display:flex;flex-direction:column;gap:6px">${changesHtml}</div>${unrecoHtml}`;
}

function openFieldNoteDialog(projectId) {
  _fieldNoteProjectId = projectId;
  _fieldNoteDraftId = null;
  const dlg = document.getElementById('fieldNoteDialog');
  const textarea = document.getElementById('fieldNoteText');
  const preview = document.getElementById('fieldNotePreview');
  const actions = document.getElementById('fieldNoteActions');
  const status = document.getElementById('parseNoteStatus');
  if (!dlg) return;
  if (textarea) textarea.value = '';
  if (preview) preview.innerHTML = '';
  if (actions) actions.style.display = 'none';
  if (status) status.textContent = '';
  dlg.showModal();
  textarea?.focus();
}

function setupFieldNote() {
  document.getElementById('closeFieldNoteDialog')?.addEventListener('click', () => {
    document.getElementById('fieldNoteDialog')?.close();
  });

  document.getElementById('parseNoteBtn')?.addEventListener('click', async () => {
    const text = document.getElementById('fieldNoteText')?.value?.trim();
    if (!text) return;
    const statusEl = document.getElementById('parseNoteStatus');
    const previewEl = document.getElementById('fieldNotePreview');
    const actionsEl = document.getElementById('fieldNoteActions');
    const btn = document.getElementById('parseNoteBtn');
    btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Parsing…';
    if (previewEl) previewEl.innerHTML = '';
    if (actionsEl) actionsEl.style.display = 'none';
    try {
      const result = await apiFetch('/api/v1/ai/parse-note', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify({ text, project_id: _fieldNoteProjectId }),
      });
      _fieldNoteDraftId = result.draft_id;
      const changes = result.proposed_changes || [];
      // Store on dialog element for apply handler
      const dlg = document.getElementById('fieldNoteDialog');
      if (dlg) dlg._parsedChanges = changes;
      if (previewEl) previewEl.innerHTML = _renderChangePreview(changes, result.unrecognized || []);
      if (actionsEl && changes.length > 0) actionsEl.style.display = 'block';
      if (statusEl) {
        statusEl.textContent = result.provider === 'local'
          ? `Local parser · ${result.proposed_changes?.length || 0} changes`
          : `${result.provider} ${result.model} · ${result.proposed_changes?.length || 0} changes`;
      }
    } catch (e) {
      if (previewEl) previewEl.innerHTML = `<p style="color:#e05353">${e.message}</p>`;
      if (statusEl) statusEl.textContent = '';
    }
    btn.disabled = false;
  });

  document.getElementById('applyNoteBtn')?.addEventListener('click', async () => {
    if (!_fieldNoteDraftId) return;
    // Collect only checked changes
    const checks = document.querySelectorAll('.note-change-chk');
    const previewEl = document.getElementById('fieldNotePreview');
    // We need to reconstruct approved changes from stored parse result
    // Use checkboxes to filter
    const allChanges = Array.from(previewEl?.querySelectorAll('[data-index]') || [])
      .map(el => parseInt(el.dataset.index));
    const checkedIndices = new Set(
      Array.from(checks).filter(c => c.checked).map(c => parseInt(c.dataset.index))
    );
    // Re-read changes from a stored parse context — we need the full list
    // The simplest approach: store changes on the dialog element
    const stored = document.getElementById('fieldNoteDialog')?._parsedChanges || [];
    const approved = stored.filter((_, i) => checkedIndices.has(i));

    const btn = document.getElementById('applyNoteBtn');
    btn.disabled = true;
    try {
      const result = await apiFetch(`/api/v1/ai/notes/${_fieldNoteDraftId}/apply`, {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify({ approved_changes: approved }),
      });
      document.getElementById('fieldNoteDialog')?.close();
      const ap = result.applied || {};
      toast(`Applied: ${ap.daily_updates||0} updates, ${ap.work_items||0} work items, ${ap.issues||0} issues`);
      hydrateProjects();
    } catch (e) { toast(`Error: ${e.message}`); }
    btn.disabled = false;
  });

  document.getElementById('rejectNoteBtn')?.addEventListener('click', async () => {
    if (!_fieldNoteDraftId) return;
    try {
      await apiFetch(`/api/v1/ai/notes/${_fieldNoteDraftId}/reject`, {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: '{}',
      });
    } catch { /* silent */ }
    document.getElementById('fieldNoteDialog')?.close();
  });
}

// ── Webhooks ──────────────────────────────────────────────────────────────
async function hydrateWebhooks() {
  const listEl = document.getElementById('webhooksList');
  if (!listEl) return;
  try {
    const { webhooks = [] } = await apiFetch('/api/v1/webhooks');
    if (!webhooks.length) {
      listEl.innerHTML = '<p class="empty-copy">No webhooks configured.</p>';
      return;
    }
    listEl.innerHTML = webhooks.map(w => {
      const evts = Array.isArray(w.events) ? w.events.join(', ') : w.events;
      const statusColor = w.enabled ? 'var(--accent)' : 'var(--text-secondary)';
      return `<div class="detail-panel" style="padding:12px 14px;display:flex;gap:12px;align-items:center" data-wh-id="${w.id}">
        <div style="flex:1;min-width:0">
          <strong style="font-size:13px">${escapeHtml(w.name)}</strong>
          <div style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(w.url)}</div>
          <div style="font-size:11px;margin-top:2px">Events: <code>${escapeHtml(evts)}</code></div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
          <span style="font-size:10px;font-weight:700;color:${statusColor}">${w.enabled ? '● ON' : '○ OFF'}</span>
          <button class="button ghost wh-toggle-btn" data-id="${w.id}" data-enabled="${w.enabled}" style="font-size:11px;padding:3px 8px">${w.enabled ? 'Pause' : 'Enable'}</button>
          <button class="button ghost wh-log-btn" data-id="${w.id}" style="font-size:11px;padding:3px 8px">Log</button>
          <button class="button ghost wh-del-btn" data-id="${w.id}" style="font-size:11px;padding:3px 8px;color:#e05353">✕</button>
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.wh-toggle-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const enabled = btn.dataset.enabled === '1' || btn.dataset.enabled === 'true';
        await apiFetch(`/api/v1/webhooks/${btn.dataset.id}/toggle`, {
          method: 'POST',
          headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
          body: JSON.stringify({ enabled: !enabled }),
        });
        hydrateWebhooks();
      });
    });
    listEl.querySelectorAll('.wh-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this webhook?')) return;
        await apiFetch(`/api/v1/webhooks/${btn.dataset.id}/delete`, {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}), body: '{}',
        });
        hydrateWebhooks();
      });
    });
    listEl.querySelectorAll('.wh-log-btn').forEach(btn => {
      btn.addEventListener('click', () => loadWebhookDeliveryLog(btn.dataset.id));
    });
  } catch(e) { listEl.innerHTML = `<p style="color:#e05353">${e.message}</p>`; }
}

async function loadWebhookDeliveryLog(webhookId) {
  const section = document.getElementById('webhookDeliveryLog');
  const logEl = document.getElementById('webhookDeliveryList');
  if (!section || !logEl) return;
  section.style.display = 'block';
  try {
    const { deliveries = [] } = await apiFetch(`/api/v1/webhooks/${webhookId}/deliveries?limit=30`);
    if (!deliveries.length) { logEl.innerHTML = '<p class="empty-copy">No deliveries yet.</p>'; return; }
    logEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--text-secondary);text-align:left;border-bottom:1px solid var(--border)">
        <th style="padding:5px 8px">Time</th><th style="padding:5px 8px">Event</th>
        <th style="padding:5px 8px">Status</th><th style="padding:5px 8px">Attempts</th><th style="padding:5px 8px">Error</th>
      </tr></thead>
      <tbody>${deliveries.map(d => {
        const dt = new Date(d.created_at).toLocaleString('en-GB',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
        const ok = d.delivered_at;
        const statusColor = ok ? 'var(--accent)' : (d.next_retry_at ? '#e09800' : '#e05353');
        const statusLabel = ok ? `✓ ${d.last_status}` : (d.next_retry_at ? `↻ retry` : `✕ ${d.last_status||0}`);
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:5px 8px;white-space:nowrap">${dt}</td>
          <td style="padding:5px 8px">${escapeHtml(d.event_type)}</td>
          <td style="padding:5px 8px;color:${statusColor};font-weight:700">${statusLabel}</td>
          <td style="padding:5px 8px">${d.attempts}</td>
          <td style="padding:5px 8px;color:#e05353">${d.last_error ? escapeHtml(d.last_error.slice(0,60)) : ''}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  } catch(e) { logEl.innerHTML = `<p style="color:#e05353">${e.message}</p>`; }
}

function setupWebhooks() {
  hydrateWebhooks();

  document.getElementById('addWebhookBtn')?.addEventListener('click', () => {
    document.getElementById('webhookForm')?.reset();
    document.getElementById('webhookDialog')?.showModal();
  });

  document.getElementById('webhookForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const events = (document.getElementById('whEvents')?.value || '*')
      .split(',').map(s => s.trim()).filter(Boolean);
    try {
      await apiFetch('/api/v1/webhooks', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify({
          name: document.getElementById('whName')?.value,
          url: document.getElementById('whUrl')?.value,
          secret_key: document.getElementById('whSecret')?.value || '',
          events,
        }),
      });
      document.getElementById('webhookDialog')?.close();
      toast('Webhook registered');
      hydrateWebhooks();
    } catch(e) { toast(`Error: ${e.message}`); }
  });
}

// ── AI Agents ─────────────────────────────────────────────────────────────
let _activeAgent = 'technical';

function _agentBubble(role, text, sources, meta) {
  const isUser = role === 'user';
  const avatar = isUser ? '👤' : (_activeAgent === 'technical' ? '⚙' : '📄');
  const bgColor = isUser ? 'var(--surface)' : 'rgba(79,142,247,.08)';
  const border = isUser ? 'var(--border)' : 'rgba(79,142,247,.25)';

  const sourcesHtml = (sources || []).length
    ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">
        ${sources.map(s => {
          const label = s.asset_code
            ? `⚙ ${escapeHtml(s.asset_code)}`
            : `📄 ${escapeHtml((s.object_name||'').slice(0,24))}`;
          return `<span style="font-size:10px;font-weight:600;background:rgba(79,142,247,.12);border:1px solid rgba(79,142,247,.25);border-radius:4px;padding:2px 6px;color:var(--accent)">${label}</span>`;
        }).join('')}
       </div>`
    : '';
  const metaHtml = meta
    ? `<div style="font-size:10px;color:var(--text-secondary);margin-top:5px">${escapeHtml(meta)}</div>`
    : '';

  return `<div style="display:flex;gap:10px;align-items:flex-start">
    <span style="font-size:18px;flex-shrink:0;margin-top:2px">${avatar}</span>
    <div style="flex:1;background:${bgColor};border:1px solid ${border};border-radius:10px;padding:10px 12px">
      <div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${escapeHtml(text)}</div>
      ${sourcesHtml}${metaHtml}
    </div>
  </div>`;
}

function setupAiAgents() {
  const historyEl = document.getElementById('agentChatHistory');
  const inputEl = document.getElementById('agentQueryInput');
  const sendBtn = document.getElementById('sendAgentQueryBtn');
  const labelEl = document.getElementById('activeAgentLabel');

  function setAgent(type) {
    _activeAgent = type;
    if (labelEl) labelEl.textContent = type === 'technical' ? '⚙ Technical Agent' : '📄 Documentation Agent';
    document.getElementById('selectTechAgent')?.classList.toggle('primary', type === 'technical');
    document.getElementById('selectDocAgent')?.classList.toggle('primary', type === 'documentation');
    inputEl?.focus();
  }

  document.getElementById('selectTechAgent')?.addEventListener('click', () => setAgent('technical'));
  document.getElementById('selectDocAgent')?.addEventListener('click', () => setAgent('documentation'));
  setAgent('technical');

  // Populate project filter from cached projects list
  function populateProjectFilter() {
    const sel = document.getElementById('aiAgentProjectFilter');
    if (!sel || !projects?.length) return;
    sel.innerHTML = '<option value="">All projects</option>' +
      projects.map(p => `<option value="${p.id}">${escapeHtml(p.code)} · ${escapeHtml(p.name)}</option>`).join('');
  }
  populateProjectFilter();

  async function sendQuery() {
    const query = inputEl?.value?.trim();
    if (!query) return;
    if (!historyEl) return;

    // Append user bubble
    historyEl.insertAdjacentHTML('beforeend', _agentBubble('user', query, null, null));
    if (inputEl) inputEl.value = '';
    sendBtn && (sendBtn.disabled = true);

    // Typing indicator
    const typingId = `typing-${Date.now()}`;
    historyEl.insertAdjacentHTML('beforeend',
      `<div id="${typingId}" style="color:var(--text-secondary);font-size:12px;padding-left:32px">Agent is thinking…</div>`
    );
    historyEl.scrollTop = historyEl.scrollHeight;

    const projectId = document.getElementById('aiAgentProjectFilter')?.value || undefined;
    const endpoint = _activeAgent === 'technical'
      ? '/api/v1/ai/agents/technical'
      : '/api/v1/ai/agents/documentation';

    try {
      const result = await apiFetch(endpoint, {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify({ query, project_id: projectId || null }),
      });
      document.getElementById(typingId)?.remove();
      const meta = result.model && result.model !== 'local'
        ? `${result.provider} · ${result.model} · ${result.latency_ms || 0}ms`
        : (result.provider === 'local' ? 'Local mode — configure LLM for full answers' : null);
      historyEl.insertAdjacentHTML('beforeend',
        _agentBubble('agent', result.answer || '(no answer)', result.sources, meta)
      );
    } catch (e) {
      document.getElementById(typingId)?.remove();
      historyEl.insertAdjacentHTML('beforeend',
        _agentBubble('agent', `Error: ${e.message}`, null, null)
      );
    }

    sendBtn && (sendBtn.disabled = false);
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  sendBtn?.addEventListener('click', sendQuery);
  inputEl?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuery(); } });
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
const ASSET_TYPE_ICON = {
  device:'🖥', panel:'📟', port:'🔌', cable:'🔗', circuit:'⚡', sensor:'📡', other:'📦',
  door:'🚪', camera:'📷', reader:'🪪', controller:'🎛', network:'🌐', rack:'🗄'
};

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
          <button class="button ghost" style="font-size:11px;padding:4px 8px" data-asset-docs="${a.id}" title="Связанные документы">📎</button>
          <button class="button ghost" style="font-size:11px;padding:4px 8px" data-edit-asset="${a.id}">Ред.</button>
          <button class="button ghost" style="font-size:11px;padding:4px 8px;color:#e05353" data-delete-asset="${a.id}">✕</button>
        </div>
      </div>
      <div id="asset-docs-${a.id}" style="display:none;padding:8px 12px 4px 48px;border-top:1px solid var(--border)">
        <p style="font-size:11px;color:var(--text-muted);margin:0 0 4px">Загрузка документов…</p>
      </div>`;
    }).join('');
    // Wire asset document panels
    listEl.querySelectorAll('[data-asset-docs]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const assetId = btn.dataset.assetDocs;
        const panel = document.getElementById(`asset-docs-${assetId}`);
        if (!panel) return;
        const wasOpen = panel.style.display !== 'none';
        panel.style.display = wasOpen ? 'none' : '';
        if (!wasOpen) {
          try {
            const r = await apiFetch(`/api/v1/objects/by-entity?type=asset&id=${encodeURIComponent(assetId)}`, { headers: apiHeaders({ Accept: 'application/json' }) });
            const { documents = [] } = await r.json();
            if (!documents.length) {
              panel.innerHTML = '<p style="font-size:11px;color:var(--text-muted);margin:0">Нет привязанных документов.</p>';
            } else {
              panel.innerHTML = documents.map(d =>
                `<div style="font-size:12px;display:flex;align-items:center;gap:8px;padding:3px 0">
                  <span>📄</span><span>${escapeHtml(d.name)}</span>
                  <small style="color:var(--text-muted)">${(d.sizeBytes/1024).toFixed(1)} KB</small>
                </div>`
              ).join('');
            }
          } catch(e) { panel.innerHTML = `<p style="color:#e05353;font-size:11px;margin:0">${e.message}</p>`; }
        }
      });
    });
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
async function hydrateConnectors() {
  const list = document.getElementById('connectorsList');
  const addBtn = document.getElementById('addConnectorBtn');
  if (!list) return;
  const CONNECTOR_ICON = { jobber:'🔧', ms365:'🏢', google_workspace:'📊', webhook:'🔗', custom:'⚙' };
  const STATUS_COLOR = { active:'#3bb969', error:'#e05353', unconfigured:'#778195', paused:'#f5a623' };
  try {
    const r = await apiFetch('/api/v1/admin/connectors');
    const { connectors = [] } = await r.json();
    if (!connectors.length) {
      list.innerHTML = '<p class="empty-copy">Нет коннекторов. Добавьте первый с помощью кнопки выше.</p>';
    } else {
      list.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">${connectors.map(c => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:13px 16px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:20px">${CONNECTOR_ICON[c.connector_type]||'⚙'}</span>
            <strong style="font-size:13px">${escapeHtml(c.name)}</strong>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 6px;text-transform:uppercase">${escapeHtml(c.connector_type)}</p>
          <span style="font-size:10px;font-weight:700;color:${STATUS_COLOR[c.status]||'#778'};text-transform:uppercase">${c.status}</span>
          ${c.last_sync_at ? `<small style="display:block;font-size:10px;color:var(--text-muted);margin-top:3px">Синхр: ${c.last_sync_at.slice(0,16).replace('T',' ')}</small>` : ''}
        </div>`).join('')}</div>`;
    }
  } catch(e) { if (list) list.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }

  addBtn?.addEventListener('click', async () => {
    const TYPES = ['jobber','ms365','google_workspace','webhook','custom'];
    const connectorType = prompt(`Тип коннектора:\n${TYPES.join(', ')}`, 'webhook');
    if (!connectorType || !TYPES.includes(connectorType)) return;
    const name = prompt(`Название коннектора (${connectorType}):`);
    if (!name) return;
    try {
      await apiFetch('/api/v1/admin/connectors', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify({ connectorType, name, config: {}, enabled: true }),
      });
      hydrateConnectors();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  }, { once: true });
}

async function hydrateServiceMonitors() {
  const list = document.getElementById('monitorList');
  const addBtn = document.getElementById('addMonitorBtn');
  if (!list) return;
  try {
    const r = await apiFetch('/api/v1/admin/monitors');
    const { monitors = [] } = await r.json();
    const STATUS_COLOR = { up:'#3bb969', down:'#e05353', unknown:'#778195' };
    if (!monitors.length) {
      list.innerHTML = '<p class="empty-copy">Нет мониторов. Нажмите «＋ Монитор» чтобы добавить.</p>';
    } else {
      list.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">${monitors.map(m => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:9px">
          <span style="width:10px;height:10px;border-radius:50%;background:${STATUS_COLOR[m.last_status]||'#778'};flex-shrink:0"></span>
          <div style="flex:1;min-width:0">
            <strong style="font-size:13px">${escapeHtml(m.name)}</strong>
            <small style="display:block;font-size:11px;color:var(--text-muted)">${escapeHtml(m.check_type.toUpperCase())} · ${escapeHtml(m.target)}${m.port ? ':' + m.port : ''}</small>
          </div>
          ${m.last_latency_ms != null ? `<span style="font-size:12px;color:var(--text-secondary)">${Math.round(m.last_latency_ms)}ms</span>` : ''}
          <span style="font-size:11px;font-weight:700;color:${STATUS_COLOR[m.last_status]||'#778'};text-transform:uppercase">${m.last_status||'unknown'}</span>
          <button class="button ghost" style="font-size:11px;padding:3px 8px;color:#e05353" data-delete-monitor="${m.id}">✕</button>
        </div>`).join('')}</div>`;
      list.querySelectorAll('[data-delete-monitor]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Удалить монитор?')) return;
          try {
            await apiFetch(`/api/v1/admin/monitors/${btn.dataset.deleteMonitor}/delete`, {
              method:'POST', headers:apiHeaders({'Content-Type':'application/json'}), body:'{}'
            });
            hydrateServiceMonitors();
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        });
      });
    }
  } catch(e) { if (list) list.innerHTML = `<p class="empty-copy" style="color:#e05353">${e.message}</p>`; }

  addBtn?.addEventListener('click', async () => {
    const name = prompt('Название монитора:');
    if (!name) return;
    const target = prompt('Target (IP или hostname):');
    if (!target) return;
    const checkType = prompt('Тип (ping / tcp / http):', 'ping') || 'ping';
    try {
      await apiFetch('/api/v1/admin/monitors', {
        method:'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
        body: JSON.stringify({ name, target, checkType }),
      });
      hydrateServiceMonitors();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  }, { once: true });
}

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

function renderApiMetrics(unavailable=false){
  const summary=$('#apiSummary'),status=$('#apiStatusBreakdown'),routes=$('#apiRouteList'),list=$('#apiLogList'),badge=$('#apiMetricsStatus'),sloEl=$('#apiSloCards');
  if(!summary||!status||!routes||!list)return;
  if(unavailable){summary.innerHTML='<article><span>Status</span><strong>Offline</strong><small>API telemetry unavailable</small></article>';status.innerHTML='';routes.innerHTML='';list.innerHTML='<article class="project-loading">API telemetry временно недоступна.</article>';if(sloEl)sloEl.innerHTML='';if(badge){badge.textContent='Unavailable';badge.className='git-sync-status error';}return;}
  const metrics=apiMetrics||{requestCount:0,averageMs:0,p95Ms:0,errorCount:0,errorRate:0,availability:100,statusCounts:{},methodCounts:{},topRoutes:[],recent:[],updatedAt:null,slos:[]};
  summary.innerHTML=`<article><span>Total requests</span><strong>${metrics.requestCount}</strong><small>retained runtime events</small></article><article><span>Average response</span><strong>${metrics.averageMs} ms</strong><small>mean latency</small></article><article><span>P95 response</span><strong>${metrics.p95Ms} ms</strong><small>slow path signal</small></article><article><span>Error rate</span><strong>${metrics.errorRate??'0'}%</strong><small>${metrics.errorCount} errors</small></article><article><span>Availability</span><strong>${metrics.availability??'100'}%</strong><small>non-5xx</small></article>`;
  if(sloEl&&metrics.slos&&metrics.slos.length){
    sloEl.innerHTML=metrics.slos.map(s=>`<article style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:${s.ok?'rgba(59,185,105,.07)':'rgba(224,80,83,.07)'};border:1px solid ${s.ok?'rgba(59,185,105,.3)':'rgba(224,80,83,.3)'};border-radius:8px;gap:12px"><div><strong style="font-size:12px">${escapeHtml(s.name)}</strong><small style="font-size:10px;color:var(--text-secondary);display:block">Target: ${escapeHtml(s.target)}</small></div><div style="text-align:right"><b style="font-size:14px;color:${s.ok?'#3bb969':'#e05353'}">${escapeHtml(s.current)}</b><small style="font-size:10px;display:block;color:${s.ok?'#3bb969':'#e05353'}">${s.ok?'✓ OK':'✗ BREACH'}</small></div></article>`).join('');
  }
  status.innerHTML=Object.entries(metrics.statusCounts||{}).map(([code,count])=>`<article class="${Number(code)>=400?'error':'ok'}"><span>${escapeHtml(code)}</span><strong>${count}</strong></article>`).join('')||'<p class="empty-copy">No API responses yet.</p>';
  routes.innerHTML=(metrics.topRoutes||[]).map(route=>`<article><strong>${escapeHtml(route.route)}</strong><span>${route.count} requests</span></article>`).join('')||'<p class="empty-copy">No route data yet.</p>';
  list.innerHTML=(metrics.recent||[]).map(event=>`<article class="${event.status>=400?'error':''}"><div><span>${escapeHtml(event.method)} · ${escapeHtml(event.route)}</span><strong>${event.status} · ${event.durationMs} ms</strong><small>${escapeHtml(event.requestId)} · ${escapeHtml(event.organizationId)}</small></div><time datetime="${escapeHtml(event.createdAt)}">${new Date(event.createdAt).toLocaleTimeString('ru-RU')}</time></article>`).join('')||'<article class="project-loading">No API requests recorded yet.</article>';
  if(badge){badge.textContent=metrics.updatedAt?`Updated ${new Date(metrics.updatedAt).toLocaleTimeString('ru-RU')}`:'Runtime';badge.className='git-sync-status configured';}
}

async function hydrateApiMetrics(){
  try{const response=await fetch('/api/v1/admin/api-metrics',{headers:apiHeaders()});if(!response.ok)throw new Error('api metrics unavailable');const payload=await response.json();apiMetrics=payload.metrics;renderApiMetrics();}catch{renderApiMetrics(true);}
  hydrateRunbooks();
}

async function hydrateRunbooks(){
  const el=$('#runbookList');if(!el)return;
  try{
    const {runbooks=[]}=await apiFetch('/api/v1/admin/runbooks');
    const sev={critical:'#e05353',warning:'#f59e0b',info:'var(--text-secondary)'};
    el.innerHTML=runbooks.map(rb=>`
      <details style="border:1px solid var(--border);border-radius:8px;padding:0;overflow:hidden;margin-bottom:8px">
        <summary style="padding:12px 14px;cursor:pointer;display:flex;gap:10px;align-items:center;list-style:none">
          <span style="width:8px;height:8px;border-radius:50%;background:${sev[rb.severity]||sev.info};flex-shrink:0"></span>
          <strong style="flex:1;font-size:13px">${escapeHtml(rb.title)}</strong>
          <small style="color:var(--text-secondary);font-size:11px">${escapeHtml(rb.trigger)}</small>
        </summary>
        <div style="padding:12px 14px;border-top:1px solid var(--border)">
          <ol style="margin:0 0 10px;padding-left:18px;font-size:12px;line-height:1.7">
            ${rb.steps.map(s=>`<li>${escapeHtml(s)}</li>`).join('')}
          </ol>
          <p style="font-size:11px;color:${sev[rb.severity]||sev.info};margin:0">⚡ Escalation: ${escapeHtml(rb.escalation||'—')}</p>
        </div>
      </details>`).join('')||'<p class="empty-copy">No runbooks configured.</p>';
  }catch{el.innerHTML='<p class="empty-copy">Runbooks unavailable.</p>';}
}

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

function _getProjectFilters() {
  const q = ($('#projectFilterInput')?.value || '').toLowerCase().trim();
  const status = $('#projectStatusFilter')?.value || '';
  const kind = $('#projectKindFilter')?.value || '';
  const sort = $('#projectSortBy')?.value || 'name';
  return { q, status, kind, sort };
}

function _applyProjectFilters(list) {
  const { q, status, kind, sort } = _getProjectFilters();
  let result = list.filter(p => {
    if (status && p.status !== status) return false;
    if (kind && p.kind !== kind) return false;
    if (q && !p.name.toLowerCase().includes(q) && !p.code.toLowerCase().includes(q) && !(p.description||'').toLowerCase().includes(q)) return false;
    return true;
  });
  result = [...result].sort((a, b) => {
    switch (sort) {
      case 'progress': return (b.progress||0) - (a.progress||0);
      case 'updated': return (b.updatedAt||'').localeCompare(a.updatedAt||'');
      case 'deadline': return (a.targetDate||'9999').localeCompare(b.targetDate||'9999');
      case 'code': return (a.code||'').localeCompare(b.code||'');
      default: return (a.name||'').localeCompare(b.name||'');
    }
  });
  return result;
}

function setupProjectFilters() {
  const update = () => renderProjects();
  $('#projectFilterInput')?.addEventListener('input', update);
  $('#projectStatusFilter')?.addEventListener('change', update);
  $('#projectKindFilter')?.addEventListener('change', update);
  $('#projectSortBy')?.addEventListener('change', update);
}

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
  const filtered = _applyProjectFilters(projects);
  const countEl = $('#projectFilterCount');
  if (countEl) countEl.textContent = filtered.length < projects.length ? `${filtered.length} из ${projects.length}` : '';
  if (!filtered.length) {
    portfolio.innerHTML = '<article class="project-card project-loading">Нет проектов по фильтру.</article>';
    return;
  }
  portfolio.innerHTML = filtered.map(project => {
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
  container.innerHTML = `<header class="detail-header"><div><a href="#projects">← Все проекты</a><p class="eyebrow">${escapeHtml(project.code)} · PROJECT DETAIL</p><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.description || 'Описание проекта не добавлено')}</p></div><div class="detail-actions">${canManage ? `<button class="button ghost" type="button" data-add-location>＋ Этаж / зона</button><button class="button ghost" id="exportCsvBtn" type="button" title="Экспорт work items в CSV">⬇ CSV</button><button class="button ghost" id="exportKpiBtn" type="button" title="Экспорт KPI проекта в CSV">⬇ KPI</button><button class="button ghost" id="exportProjectBtn" type="button" title="Экспорт данных проекта (JSON)">⬇ JSON</button><label class="button ghost" style="cursor:pointer" title="Импорт данных проекта из JSON">⬆ Импорт<input type="file" id="importProjectInput" accept="application/json" style="display:none"></label>` : ''}${canProgress ? `<button class="button ghost" id="smartNoteBtn" type="button" title="AI parse of free-form field note">✦ Smart note</button>` : ''}<button class="button ghost" id="dailyLogReportBtn" type="button" title="Сформировать дневной лог за сегодня">📋 Daily log</button><button class="button primary" type="button" data-daily-update ${canProgress ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'}>＋ Отчет за сегодня</button></div></header>
    <section class="detail-kpis">${(() => {
      const now = Date.now();
      const week = 7 * 86400000;
      const allWi = project.workItems || [];
      const overdue = allWi.filter(w => w.status !== 'done' && w.dueDate && new Date(w.dueDate).getTime() < now);
      const soon = allWi.filter(w => w.status !== 'done' && w.dueDate && new Date(w.dueDate).getTime() >= now && new Date(w.dueDate).getTime() <= now + week);
      const blocked = allWi.filter(w => (w.effectiveStatus || w.status) === 'blocked');
      const overdueHtml = overdue.length ? `<span style="color:#f46;font-size:10px;font-weight:700">⚠ ${overdue.length} просрочено</span>` : '';
      const soonHtml = soon.length ? `<span style="color:#e8a84c;font-size:10px;font-weight:600">⏰ ${soon.length} в 7 дней</span>` : '';
      // Health score: 100 - overduePenalty - blockedPenalty - issuePenalty
      const total = allWi.length || 1;
      let health = 100;
      health -= Math.min(40, Math.round(overdue.length / total * 60));
      health -= Math.min(20, Math.round(blocked.length / total * 30));
      health -= Math.min(20, openIssues.length * 5);
      health = Math.max(0, health);
      const healthColor = health >= 70 ? '#3bb969' : health >= 40 ? '#e8a84c' : '#f46';
      const healthLabel = health >= 70 ? 'Хорошее' : health >= 40 ? 'Среднее' : 'Критическое';
      return `<article><span>Прогресс</span><strong>${project.progress}%</strong></article>
        <article><span>Health</span><strong style="color:${healthColor}">${health} <small style="font-size:9px;font-weight:400">${healthLabel}</small></strong></article>
        <article><span>Проблемы</span><strong>${openIssues.length}</strong></article>
        <article><span>Локации</span><strong>${project.locations.length}</strong></article>
        ${(overdueHtml || soonHtml) ? `<article style="flex-direction:column;gap:2px;align-items:flex-start">
          <span>Дедлайны</span>${overdueHtml}${soonHtml}</article>` : ''}`;
    })()}</section>
    <section class="detail-section"><div class="detail-section-title"><div><p class="eyebrow">WORK PROGRESS</p><h2>Прогресс по видам работ</h2></div><div style="display:flex;gap:8px"><button class="button ghost" id="progressHistoryBtn" type="button" style="font-size:12px">📈 История</button><button class="button ghost" id="criticalPathBtn" type="button" style="font-size:12px">⛓ Critical path</button><button class="button ghost" id="analyticsBtn" type="button" style="font-size:12px">📊 Analytics</button></div></div><div class="scope-cards">${project.workTypeProgress.map(scope => `<article style="--scope:${scope.color}"><div><strong>${escapeHtml(scope.name)}</strong><b>${scope.progress}%</b></div><div class="scope-bar"><i style="width:${scope.progress}%"></i></div><small>${scope.fieldUpdateCount} обновлений · ${scope.taskCount} задач${scope.blocked ? ` · ${scope.blocked} blocked` : ''}</small></article>`).join('')}</div><div id="progressHistoryPanel" style="display:none;margin-top:16px;padding:14px;background:rgba(79,142,247,.05);border:1px solid rgba(79,142,247,.2);border-radius:10px"></div><div id="criticalPathPanel" style="display:none;margin-top:16px;padding:14px;background:rgba(79,142,247,.05);border:1px solid rgba(79,142,247,.2);border-radius:10px"></div><div id="analyticsPanel" style="display:none;margin-top:16px;padding:14px;background:rgba(79,142,247,.05);border:1px solid rgba(79,142,247,.2);border-radius:10px"></div></section>
    <section class="detail-section" id="workItemsSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">FIELD WORKFLOW</p><h2>Все задачи <small style="font-weight:400;font-size:14px;color:var(--text-secondary)">(${workItems.length})</small></h2></div>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="wiFilterStatus" style="padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px">
            <option value="">Все статусы</option>
            <option value="pending">Pending</option>
            <option value="ongoing">Ongoing</option>
            <option value="done">Done</option>
            <option value="blocked">Blocked</option>
          </select>
          <div style="display:flex;border:1px solid var(--border);border-radius:7px;overflow:hidden">
            <button type="button" class="wi-view-btn active" data-wi-view="list" style="padding:4px 9px;font-size:11px;background:var(--surface);border:none;cursor:pointer;color:var(--text)">≡ Список</button>
            <button type="button" class="wi-view-btn" data-wi-view="kanban" style="padding:4px 9px;font-size:11px;background:var(--surface);border:none;cursor:pointer;color:var(--text-muted);border-left:1px solid var(--border)">⊞ Kanban</button>
          </div>
          ${canManage ? `<button class="button ghost" id="wiImportCsvBtn" type="button" style="font-size:11px">⬆ CSV</button>` : ''}
          ${canManage ? `<button class="button ghost" id="wiAiGenerateBtn" type="button" style="font-size:11px">✦ AI задачи</button>` : ''}
          ${canManage ? `<button class="button ghost" id="wiBulkDoneBtn" type="button" style="font-size:11px;display:none">✓ Bulk done</button>` : ''}
        </div>
      </div>
      <div id="workItemsFullList" style="display:flex;flex-direction:column;gap:6px;margin-top:6px"></div>
      <div id="workItemsKanban" style="display:none;margin-top:6px;overflow-x:auto"></div>
      <input type="file" id="wiCsvInput" accept=".csv,.txt" style="display:none">
    </section>
    <section class="detail-grid"><article class="detail-panel">${_renderLocationsPanel(project, canManage)}</article>
    <article class="detail-panel">
      <div class="detail-section-title"><div><p class="eyebrow">ISSUES</p><h2>Проблемы</h2></div>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="issueSevFilter" style="padding:3px 6px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
            <option value="">Все</option>
            <option value="critical">Критические</option>
            <option value="high">Высокие</option>
            <option value="medium">Средние</option>
            <option value="low">Низкие</option>
          </select>
          <b class="issue-count">${openIssues.length}</b>
          ${canManage ? `<button class="button ghost" id="addIssueBtn" type="button" style="font-size:11px">＋ Проблема</button>` : ''}
        </div>
      </div>
      <div class="issue-list" id="issuesList">
        ${openIssues.length ? openIssues.map(issue => {
          const SEV_COLOR = {critical:'#f46',high:'#e87',medium:'#e8a84c',low:'#4f8ef7'};
          const st = issue.status_v2||issue.status||'open';
          return `<div class="issue-item ${issue.severity}" data-issue-id="${issue.id}" data-issue-sev="${issue.severity}">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                  <span style="font-size:9px;font-weight:700;text-transform:uppercase;color:${SEV_COLOR[issue.severity]||'#888'};background:${SEV_COLOR[issue.severity]||'#888'}22;padding:1px 5px;border-radius:4px">${escapeHtml(issue.severity)}</span>
                  <span style="font-size:9px;padding:1px 6px;border-radius:8px;background:rgba(79,142,247,.12);color:var(--accent)">${escapeHtml(st)}</span>
                  ${issue.assigned_to ? `<small style="font-size:9px;color:var(--text-muted)">👤 ${escapeHtml(issue.assigned_to)}</small>` : ''}
                </div>
                <strong style="font-size:12px;display:block;margin-bottom:2px">${escapeHtml(issue.title)}</strong>
                ${issue.description ? `<small style="color:var(--text-muted);font-size:11px">${escapeHtml(issue.description.slice(0,120))}${issue.description.length>120?'…':''}</small>` : ''}
                ${issue.resolution_note ? `<small style="color:#3bb969;font-size:10px;display:block;margin-top:2px">✓ ${escapeHtml(issue.resolution_note)}</small>` : ''}
              </div>
              <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;align-items:flex-end">
                ${canManage ? `<button type="button" class="text-button" style="font-size:10px" data-issue-transition="${issue.id}">→ Статус</button>` : ''}
                ${canManage ? `<button type="button" class="text-button" style="font-size:10px" data-issue-assign="${issue.id}">👤 Назначить</button>` : ''}
              </div>
            </div>
          </div>`;
        }).join('') : '<p class="empty-copy">Открытых проблем нет.</p>'}
      </div>
    </article></section>
    <section class="detail-section" id="reservationsSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">СКЛАД</p><h2>Резервирование материалов</h2></div>
        ${canManage ? `<button class="button ghost" id="addReservationBtn" type="button" style="font-size:12px">＋ Резерв</button>` : ''}
      </div>
      <div id="reservationsList"><p style="font-size:12px;color:var(--text-muted)">Загрузка…</p></div>
    </section>
    <section class="detail-section" id="budgetSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">БЮДЖЕТ</p><h2>Финансы проекта</h2></div>
        <div style="display:flex;gap:6px">
          ${canManage ? `<button class="button ghost" id="addExpenseBtn" type="button" style="font-size:12px">＋ Расход</button>
          <button class="button ghost" id="setBudgetBtn" type="button" style="font-size:12px">✏ Бюджет</button>` : ''}
        </div>
      </div>
      <div id="budgetWidget"><p style="font-size:12px;color:var(--text-muted)">Загрузка…</p></div>
    </section>
    <section class="detail-section" id="ganttSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">TIMELINE</p><h2>Диаграмма Ганта</h2></div>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="ganttGroupBy" style="padding:4px 8px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
            <option value="workType">По типу работ</option>
            <option value="assignee">По исполнителю</option>
            <option value="status">По статусу</option>
          </select>
          <button class="button ghost" id="ganttRefreshBtn" type="button" style="font-size:11px">↻</button>
        </div>
      </div>
      <div id="ganttChart" style="overflow-x:auto;min-height:120px"><p style="font-size:12px;color:var(--text-muted)">Загрузка…</p></div>
    </section>
    <section class="detail-section" id="milestonesSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">ROADMAP</p><h2>Вехи проекта</h2></div>
        <div style="display:flex;gap:6px">
          <button class="button ghost" id="exportMilestonesBtn" type="button" style="font-size:12px" title="Экспорт вех в CSV">⬇ CSV</button>
          ${canManage ? `<button class="button ghost" id="addMilestoneBtn" type="button" style="font-size:12px">＋ Веха</button>` : ''}
        </div>
      </div>
      <div id="milestonesList"><p style="font-size:12px;color:var(--text-muted)">Загрузка…</p></div>
    </section>
    <section class="detail-section" id="risksSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">УПРАВЛЕНИЕ РИСКАМИ</p><h2>Реестр рисков</h2></div>
        <div style="display:flex;gap:6px">
          ${canManage ? `<button class="button ghost" id="addRiskBtn" type="button" style="font-size:12px">＋ Риск</button>` : ''}
        </div>
      </div>
      <div id="risksList"><p style="font-size:12px;color:var(--text-muted)">Загрузка…</p></div>
    </section>
    <section class="detail-section" id="standupSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">ЕЖЕДНЕВНО</p><h2>Стендап — ${new Date().toLocaleDateString('ru-RU')}</h2></div>
        <div style="display:flex;gap:6px">
          <button class="button ghost" id="standupRefreshBtn" type="button" style="font-size:12px">↻</button>
          <button class="button ghost" id="standupAiBtn" type="button" style="font-size:12px">✦ AI сводка</button>
        </div>
      </div>
      <div id="standupWidget"><p style="font-size:12px;color:var(--text-muted)">Загрузка…</p></div>
    </section>
    <section class="detail-section" id="projectCommentsSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">ОБСУЖДЕНИЕ</p><h2>Комментарии к проекту</h2></div>
      </div>
      <div id="projectCommentsList" style="margin-bottom:12px"></div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <textarea id="projectCommentInput" placeholder="Написать комментарий…" rows="2"
          style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;resize:vertical"></textarea>
        <button class="button primary" id="projectCommentSendBtn" type="button" style="font-size:12px;height:36px">Отправить</button>
      </div>
    </section>
    <section class="detail-section" id="workloadWidgetSection">
      <div class="detail-section-title"><div><p class="eyebrow">НАГРУЗКА</p><h2>Распределение задач</h2></div></div>
      <div id="workloadSection"><p style="font-size:12px;color:var(--text-muted)">Загрузка…</p></div>
    </section>
    <section class="detail-section" id="projectTeamSection">
      <div class="detail-section-title"><div><p class="eyebrow">КОМАНДА</p><h2>Назначенные сотрудники</h2></div><div style="display:flex;gap:6px">${canManage ? '<button class="button ghost" id="assignMemberBtn" type="button">＋ Назначить</button>' : ''}<button class="button ghost" id="presenceToggleBtn" type="button" style="font-size:11px">📍 Присутствие</button></div></div>
      <div id="projectTeamList" style="display:flex;flex-wrap:wrap;gap:8px"><p class="empty-copy" style="font-size:13px">Загрузка…</p></div>
      <div id="presencePanel" style="display:none;margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <input type="date" id="presenceDatePicker" style="padding:5px 9px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px">
          <button class="button ghost" id="presenceRefreshBtn" style="font-size:11px">↺</button>
          ${canManage ? '<button class="button ghost" id="addPresenceBtn" type="button" style="font-size:11px">＋ Отметить</button>' : ''}
        </div>
        <div id="presenceList"><p class="empty-copy" style="font-size:12px">Выберите дату.</p></div>
      </div>
      ${canManage ? `<dialog id="assignMemberDialog" style="max-width:400px;width:100%">
        <div class="dialog-head"><div><p class="eyebrow">НАЗНАЧЕНИЕ</p><h2>Выбрать сотрудника</h2></div><button class="icon-button" id="closeAssignDialog" type="button">×</button></div>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
          <select id="assignMemberSelect" style="padding:8px 10px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px"></select>
          <input id="assignRoleInput" type="text" placeholder="Роль на проекте (Lead Tech, Foreman…)" maxlength="100" style="padding:8px 10px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px">
          <div class="dialog-actions"><span></span><button class="button ghost" id="cancelAssignDialog" type="button">Отмена</button><button class="button primary" id="confirmAssignBtn" type="button">Назначить</button></div>
        </div>
      </dialog>` : ''}
    </section>
    <section class="detail-section" id="weeklyPlanSection">
      <div class="detail-section-title">
        <div><p class="eyebrow">WEEKLY PLANNING</p><h2>Недельный план</h2></div>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="week" id="weekPlanPicker" style="padding:6px 10px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px">
          <button class="button ghost" id="weekPlanRefreshBtn" type="button" style="font-size:12px">↺</button>
        </div>
      </div>
      <div id="weekPlanGrid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-top:8px"></div>
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
      <div class="detail-section-title">
        <div><p class="eyebrow">ACTIVITY</p><h2>Активность и комментарии</h2></div>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="activityTypeFilter" style="padding:4px 8px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
            <option value="">Все события</option>
            <option value="comment">Комментарии</option>
            <option value="work_item">Задачи</option>
            <option value="issue">Проблемы</option>
            <option value="daily_update">Дневные отчёты</option>
            <option value="milestone">Вехи</option>
          </select>
          <button class="button ghost" id="activityRefreshBtn" type="button" style="font-size:11px">↻</button>
        </div>
      </div>
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

  container.querySelector('#smartNoteBtn')?.addEventListener('click', () => openFieldNoteDialog(project.id));

  container.querySelector('#dailyLogReportBtn')?.addEventListener('click', async () => {
    const today = new Date().toISOString().slice(0, 10);
    let panel = container.querySelector('#dailyLogReportPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'dailyLogReportPanel';
      panel.style.cssText = 'margin-top:18px;padding:18px;background:var(--surface,#0d121b);border:1px solid var(--border,#242c3a);border-radius:12px';
      container.querySelector('.detail-header')?.after(panel);
    }
    if (panel.dataset.open === '1') { panel.style.display = 'none'; panel.dataset.open = '0'; return; }
    panel.style.display = 'block';
    panel.dataset.open = '1';
    panel.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">Формирование лога…</p>';
    try {
      const report = await apiFetch(`/api/v1/projects/${encodeURIComponent(project.id)}/daily-report?date=${today}`);
      const noteResp = await apiFetch(`/api/v1/projects/${encodeURIComponent(project.id)}/daily-log-note?date=${today}`).catch(() => ({note:''}));
      const sectionHtml = (report.sections || []).map(sec => `
        <div style="margin-bottom:14px">
          <p style="font-size:10px;font-weight:700;color:var(--accent);margin:0 0 8px;letter-spacing:.08em">${escapeHtml(sec.title.toUpperCase())}</p>
          ${sec.type === 'unit_completions' ? sec.items.map(i => `<p style="font-size:12px;margin:4px 0">• <strong>${escapeHtml(i.location)}</strong> / ${escapeHtml(i.workType)} / ${escapeHtml(i.action)}: <b>${i.count} units</b></p>`).join('') : ''}
          ${sec.type === 'progress_updates' ? sec.items.map(i => `<p style="font-size:12px;margin:4px 0">• ${escapeHtml(i.location)} / ${escapeHtml(i.workType)}: <b>${i.percent}%</b>${i.comments ? ` — ${escapeHtml(i.comments)}` : ''}</p>`).join('') : ''}
          ${sec.type === 'issues' ? sec.items.map(i => `<p style="font-size:12px;margin:4px 0;color:#e05353">• [${escapeHtml(i.severity.toUpperCase())}] ${escapeHtml(i.description)}</p>`).join('') : ''}
        </div>`).join('') || '<p style="font-size:12px;color:var(--text-secondary)">Нет записей за сегодня.</p>';
      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div><p style="margin:0;font-size:10px;font-weight:700;letter-spacing:.1em;color:var(--accent)">DAILY LOG · ${today}</p>
          <p style="margin:4px 0 0;font-size:11px;color:var(--text-secondary)">${report.stats?.unitCompletions||0} units · ${report.stats?.progressUpdates||0} обновлений · ${report.stats?.issuesOpened||0} проблем</p></div>
          <button class="button ghost" id="copyDailyLogBtn" type="button" style="font-size:11px">Копировать текст</button>
        </div>
        ${sectionHtml}
        <div style="margin-top:16px;border-top:1px solid var(--border,#242c3a);padding-top:14px">
          <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:6px">Ручные пояснения (сохраняются)</label>
          <textarea id="dailyLogNote" rows="4" style="width:100%;padding:10px 12px;background:#0b1018;border:1px solid #2b3443;border-radius:8px;color:var(--text);font-size:13px;resize:vertical">${escapeHtml(noteResp.note||'')}</textarea>
          <div style="display:flex;justify-content:flex-end;margin-top:8px">
            <button class="button primary" id="saveDailyLogNoteBtn" type="button" style="font-size:12px">Сохранить заметку</button>
          </div>
        </div>`;
      panel.querySelector('#copyDailyLogBtn')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(report.text + (noteResp.note ? '\n\n' + noteResp.note : '')).then(() => toast('Скопировано'));
      });
      panel.querySelector('#saveDailyLogNoteBtn')?.addEventListener('click', async () => {
        const note = panel.querySelector('#dailyLogNote')?.value || '';
        try {
          await apiFetch(`/api/v1/projects/${encodeURIComponent(project.id)}/daily-log-note`, {
            method: 'POST', body: JSON.stringify({ date: today, note })
          });
          toast('Заметка сохранена');
        } catch(e) { toast(e.message || 'Ошибка сохранения'); }
      });
    } catch(e) { panel.innerHTML = `<p style="color:#e05353">${e.message}</p>`; }
  });

  // Weekly planning view
  const weekPicker = container.querySelector('#weekPlanPicker');
  const weekGrid = container.querySelector('#weekPlanGrid');
  if (weekPicker && weekGrid) {
    // Default to current week
    const now = new Date();
    const wYear = now.getFullYear();
    const wNum = (() => {
      const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      return Math.ceil(((d - Date.UTC(d.getUTCFullYear(),0,1)) / 86400000 + 1) / 7);
    })();
    weekPicker.value = `${wYear}-W${String(wNum).padStart(2,'0')}`;

    function renderWeekPlan() {
      const val = weekPicker.value; // "YYYY-Www"
      if (!val) return;
      const [yStr, wStr] = val.split('-W');
      const year = parseInt(yStr), week = parseInt(wStr);
      // Monday of that week
      const jan4 = new Date(year, 0, 4);
      const monday = new Date(jan4.getTime() + (week - 1 - Math.floor((jan4.getDay() + 6) / 7)) * 7 * 86400000);
      monday.setDate(monday.getDate() - monday.getDay() + 1);

      const days = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map((label, i) => {
        const d = new Date(monday.getTime() + i * 86400000);
        return { label, date: d.toISOString().slice(0,10) };
      });

      const workItems = project.workItems || [];
      weekGrid.innerHTML = days.map(day => {
        const dayItems = workItems.filter(wi => wi.dueDate === day.date);
        const isToday = day.date === new Date().toISOString().slice(0,10);
        return `<div style="background:${isToday?'rgba(79,142,247,.08)':'#0a101a'};border:1px solid ${isToday?'rgba(79,142,247,.3)':'#1e2535'};border-radius:9px;padding:10px;min-height:90px">
          <p style="margin:0 0 8px;font-size:10px;font-weight:700;color:${isToday?'var(--accent)':'#778398'};letter-spacing:.06em">${day.label} <span style="font-weight:400;opacity:.7">${day.date.slice(5)}</span></p>
          ${dayItems.length ? dayItems.map(wi => `
            <div style="padding:5px 7px;margin-bottom:5px;background:rgba(255,255,255,.03);border-left:2px solid ${wi.effectiveStatus==='blocked'?'#e05353':wi.status==='done'?'#3bb969':'#6879ff'};border-radius:3px;font-size:11px;color:var(--text-secondary)">
              <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(wi.title)}</span>
              <small style="font-size:9px;color:#556">${wi.effectiveStatus||wi.status}</small>
            </div>`).join('') : '<p style="color:#334;font-size:11px;margin:0">—</p>'}
        </div>`;
      }).join('');
    }

    renderWeekPlan();
    weekPicker.addEventListener('change', renderWeekPlan);
    container.querySelector('#weekPlanRefreshBtn')?.addEventListener('click', renderWeekPlan);
  }

  container.querySelector('#progressHistoryBtn')?.addEventListener('click', async () => {
    const panel = container.querySelector('#progressHistoryPanel');
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    panel.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">Загрузка истории…</p>';
    try {
      const to = new Date().toISOString().slice(0,10);
      const from = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
      const { days = [], projectName = '' } =
        await apiFetch(`/api/v1/projects/${encodeURIComponent(project.id)}/progress-history?from=${from}&to=${to}`);
      if (!days.length) {
        panel.innerHTML = '<p class="empty-copy">Нет данных о прогрессе за последние 30 дней.</p>';
        return;
      }
      // Collect all work types present
      const typeMap = new Map();
      days.forEach(d => d.byType.forEach(t => {
        if (!typeMap.has(t.id)) typeMap.set(t.id, { name: t.name, color: t.color });
      }));
      const types = [...typeMap.entries()];

      const W = 560, H = 160, PAD = { l:32, r:12, t:10, b:30 };
      const dw = (W - PAD.l - PAD.r) / Math.max(days.length - 1, 1);

      const lines = types.map(([tid, tmeta]) => {
        const pts = days.map((d, i) => {
          const t = d.byType.find(x => x.id === tid);
          const y = t ? t.avgPercent : null;
          return { x: PAD.l + i * dw, y, date: d.date };
        }).filter(p => p.y !== null);
        if (pts.length < 2) return '';
        const d = pts.map((p,i) => `${i===0?'M':'L'}${p.x},${PAD.t + (H - PAD.t - PAD.b) * (1 - p.y/100)}`).join(' ');
        return `<path d="${d}" fill="none" stroke="${escapeHtml(tmeta.color)}" stroke-width="2" opacity=".8"/>`;
      }).join('');

      const xLabels = days.filter((_,i) => i === 0 || i === days.length-1 || i % Math.ceil(days.length/5) === 0)
        .map(d => `<text x="${PAD.l + days.indexOf(d)*dw}" y="${H - 4}" fill="#778398" font-size="9" text-anchor="middle">${d.date.slice(5)}</text>`).join('');

      const legend = types.map(([,t]) =>
        `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-secondary)"><i style="display:inline-block;width:12px;height:3px;background:${escapeHtml(t.color)};border-radius:2px"></i>${escapeHtml(t.name)}</span>`
      ).join('');

      panel.innerHTML = `
        <p style="font-size:10px;font-weight:700;color:var(--accent);margin:0 0 10px;letter-spacing:.08em">ПРОГРЕСС ЗА 30 ДНЕЙ · ${from} → ${to}</p>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;overflow:visible">
          <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H-PAD.b}" stroke="#2a3447" stroke-width="1"/>
          <line x1="${PAD.l}" y1="${H-PAD.b}" x2="${W-PAD.r}" y2="${H-PAD.b}" stroke="#2a3447" stroke-width="1"/>
          ${[0,25,50,75,100].map(v => {
            const y = PAD.t + (H - PAD.t - PAD.b) * (1 - v/100);
            return `<line x1="${PAD.l}" y1="${y}" x2="${W-PAD.r}" y2="${y}" stroke="#1e2535" stroke-width="1"/>
                    <text x="${PAD.l-4}" y="${y+3}" fill="#556" font-size="8" text-anchor="end">${v}</text>`;
          }).join('')}
          ${lines}
          ${xLabels}
        </svg>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px">${legend}</div>`;
    } catch(e) { panel.innerHTML = `<p style="color:#e05353">${e.message}</p>`; }
  });

  container.querySelector('#criticalPathBtn')?.addEventListener('click', async () => {
    const panel = container.querySelector('#criticalPathPanel');
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    panel.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">Calculating…</p>';
    try {
      const { critical_path = [], project_duration_minutes = 0, all_items = [] } =
        await apiFetch(`/api/v1/projects/${encodeURIComponent(project.id)}/critical-path`);
      const blocked = all_items.filter(i => i.status === 'blocked');
      if (!critical_path.length) {
        panel.innerHTML = '<p class="empty-copy">No dependencies found — nothing to analyze.</p>';
        return;
      }
      const hrs = m => m >= 60 ? `${Math.round(m/60)}h` : `${m}m`;
      panel.innerHTML = `
        <p style="font-size:11px;font-weight:700;color:var(--accent);margin:0 0 10px">CRITICAL PATH · ${hrs(project_duration_minutes)} total</p>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${critical_path.map((item, i) => `
            <div style="display:flex;gap:8px;align-items:center">
              ${i > 0 ? '<div style="width:16px;text-align:center;color:var(--text-secondary);font-size:10px">↓</div>' : '<div style="width:16px"></div>'}
              <div style="flex:1;padding:7px 10px;background:rgba(224,80,83,.08);border:1px solid rgba(224,80,83,.25);border-radius:7px">
                <strong style="font-size:12px">${escapeHtml(item.code||'')} ${escapeHtml(item.title)}</strong>
                <span style="font-size:10px;color:var(--text-secondary);margin-left:8px">${hrs(item.est_minutes)}</span>
              </div>
            </div>`).join('')}
        </div>
        ${blocked.length ? `<p style="font-size:12px;margin:12px 0 0;color:#e05353">⛔ ${blocked.length} items blocked by dependencies</p>` : ''}`;
    } catch(e) { panel.innerHTML = `<p style="color:#e05353">${e.message}</p>`; }
  });
  container.querySelector('#analyticsBtn')?.addEventListener('click', async () => {
    const panel = container.querySelector('#analyticsPanel');
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    panel.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">Loading analytics…</p>';
    try {
      const a = await apiFetch(`/api/v1/projects/${encodeURIComponent(project.id)}/analytics`);
      const riskColor = { low:'#3bb969', medium:'#f5a623', high:'#e05353', critical:'#c0392b' }[a.riskLevel] || '#778';
      const velMax = Math.max(1, ...a.velocityDays.map(d => d.events));
      panel.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:14px">
          <div style="background:#0a101a;border:1px solid #1e2535;border-radius:8px;padding:10px">
            <p style="font-size:10px;color:#556;margin:0">Выполнено</p>
            <strong style="font-size:24px;color:var(--accent)">${a.pctDone}%</strong>
            <small style="font-size:10px;color:#556;display:block">${a.doneItems} / ${a.totalItems} задач</small>
          </div>
          <div style="background:#0a101a;border:1px solid #1e2535;border-radius:8px;padding:10px">
            <p style="font-size:10px;color:#556;margin:0">Risk score</p>
            <strong style="font-size:24px;color:${riskColor}">${a.riskScore}</strong>
            <small style="font-size:10px;color:${riskColor};display:block;text-transform:uppercase">${a.riskLevel}</small>
          </div>
          <div style="background:#0a101a;border:1px solid #1e2535;border-radius:8px;padding:10px">
            <p style="font-size:10px;color:#556;margin:0">Velocity</p>
            <strong style="font-size:24px;color:var(--text)">${a.avgEventsPerDay.toFixed(1)}</strong>
            <small style="font-size:10px;color:#556;display:block">событий / день</small>
          </div>
          <div style="background:#0a101a;border:1px solid #1e2535;border-radius:8px;padding:10px">
            <p style="font-size:10px;color:#556;margin:0">Осталось дней</p>
            <strong style="font-size:24px;color:var(--text)">${a.estimatedDaysRemaining ?? '—'}</strong>
            <small style="font-size:10px;color:#556;display:block">${a.overdueItems ? `${a.overdueItems} просрочено` : ''}${a.blockedItems ? ` · ${a.blockedItems} blocked` : ''}</small>
          </div>
        </div>
        ${a.velocityDays.length ? `
        <p style="font-size:10px;font-weight:700;color:#556;margin:0 0 6px;letter-spacing:.06em">VELOCITY · 14 DAYS</p>
        <div style="display:flex;align-items:flex-end;gap:2px;height:50px;margin-bottom:10px">
          ${a.velocityDays.map(d => `
            <div title="${d.date}: ${d.events} события" style="flex:1;background:rgba(79,142,247,.55);border-radius:2px 2px 0 0;min-height:3px;height:${Math.round(d.events/velMax*100)}%"></div>
          `).join('')}
        </div>` : ''}
        ${a.criticalIssues > 0 ? `<p style="font-size:12px;color:#e05353;margin:0">⚠ ${a.criticalIssues} критических проблем требует внимания</p>` : ''}`;
    } catch(e) { panel.innerHTML = `<p style="color:#e05353">${e.message}</p>`; }
  });

  container.querySelector('#exportCsvBtn')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = `/api/v1/projects/${encodeURIComponent(project.id)}/report.csv`;
    a.download = '';
    a.click();
  });
  container.querySelector('#exportKpiBtn')?.addEventListener('click', async () => {
    try {
      const p = project;
      const wis = p.workItems || [];
      const total = wis.length;
      const done = wis.filter(w => w.status === 'done').length;
      const blocked = wis.filter(w => w.effectiveStatus === 'blocked' || w.status === 'blocked').length;
      const overdue = wis.filter(w => w.status !== 'done' && w.dueDate && w.dueDate < new Date().toISOString().slice(0,10)).length;
      const estH = (wis.reduce((s,w) => s + (w.estimatedMinutes||0), 0) / 60).toFixed(1);
      const actH = (wis.reduce((s,w) => s + (w.actualMinutes||0), 0) / 60).toFixed(1);
      const rows = [
        ['Метрика','Значение'],
        ['Проект', p.name],
        ['Код', p.code||''],
        ['Статус', p.status||''],
        ['Прогресс %', (p.progress||0).toFixed(1)],
        ['Всего задач', total],
        ['Выполнено задач', done],
        ['Заблокировано', blocked],
        ['Просрочено', overdue],
        ['Плановые часы', estH],
        ['Фактические часы', actH],
        ['Дедлайн', p.targetDate||''],
        ['Обновлён', (p.updatedAt||'').slice(0,10)],
      ];
      const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `kpi-${p.code||p.id}.csv` });
      a.click(); URL.revokeObjectURL(a.href);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
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
  setupPresencePanel(project.id);
  setupWorkItemsBulkList(project);
  hydrateProjectWorkload(project.id);
  hydrateMilestones(project.id);
  container.querySelector('#exportMilestonesBtn')?.addEventListener('click', async () => {
    try {
      const r = await apiFetch(`/api/v1/projects/${project.id}/milestones`);
      const { milestones = [] } = await r.json();
      if (!milestones.length) { toast('Нет вех для экспорта'); return; }
      const rows = [['id','name','status','target_date','description']];
      milestones.forEach(m => rows.push([m.id, m.name, m.status, m.target_date, m.description||'']));
      const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `milestones-${project.code||project.id}.csv` });
      a.click(); URL.revokeObjectURL(a.href);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
  setupIssuesPanel(project.id);
  hydrateRisks(project.id);
  hydrateBudgetWidget(project.id);
  hydrateReservations(project.id);
  hydrateGantt(project);
  hydrateProjectComments(project.id);
  hydrateProjectStandup(project.id);
  document.getElementById('activityTypeFilter')?.addEventListener('change', () => hydrateProjectActivity(project.id));
  document.getElementById('activityRefreshBtn')?.addEventListener('click', () => hydrateProjectActivity(project.id));
}

async function hydrateProjectStandup(projectId) {
  const widget = document.getElementById('standupWidget');
  const refreshBtn = document.getElementById('standupRefreshBtn');
  const aiBtn = document.getElementById('standupAiBtn');
  if (!widget) return;

  async function loadStandup(useAi = false) {
    widget.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    try {
      const r = await apiFetch(`/api/v1/projects/${projectId}/standup`,
        useAi ? { method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: '{}' } : {}
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || r.status);
      const section = (label, items, color) => items?.length
        ? `<div style="margin-bottom:10px">
            <p style="font-size:10px;font-weight:700;text-transform:uppercase;color:${color};letter-spacing:.05em;margin-bottom:5px">${label}</p>
            <ul style="margin:0;padding-left:16px">
              ${items.map(t => `<li style="font-size:12px;margin-bottom:3px">${escapeHtml(t)}</li>`).join('')}
            </ul></div>` : '';
      const narrativeHtml = d.narrative ? `<div style="padding:10px 12px;background:rgba(79,142,247,.06);border:1px solid rgba(79,142,247,.2);border-radius:8px;margin-bottom:12px">
        <p style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;margin-bottom:6px">✦ AI</p>
        <p style="font-size:13px;line-height:1.5">${escapeHtml(d.narrative)}</p></div>` : '';
      const body = section('✓ Завершено', d.completed, '#3bb969')
        + section('→ Перемещено', d.moved, '#4f8ef7')
        + section('✏ Обновлено', d.updated, '#e8a84c');
      widget.innerHTML = narrativeHtml + (body || '<p class="empty-copy">Сегодня нет изменений.</p>');
    } catch(e) { widget.innerHTML = `<p class="empty-copy">Ошибка: ${e.message}</p>`; }
  }

  loadStandup();
  refreshBtn?.addEventListener('click', () => loadStandup(false));
  aiBtn?.addEventListener('click', () => loadStandup(true));
}

async function hydrateProjectComments(projectId) {
  const list = document.getElementById('projectCommentsList');
  const input = document.getElementById('projectCommentInput');
  const sendBtn = document.getElementById('projectCommentSendBtn');
  if (!list) return;

  async function loadComments() {
    list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    try {
      const r = await apiFetch(`/api/v1/projects/${projectId}/comments`);
      const { comments = [] } = await r.json();
      if (!comments.length) {
        list.innerHTML = '<p class="empty-copy" style="font-size:13px">Нет комментариев.</p>'; return;
      }
      list.innerHTML = comments.map(c => `
        <div style="border-left:2px solid var(--border);padding:8px 12px;margin-bottom:8px;${c.deleted?'opacity:.4':''}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <strong style="font-size:12px">${escapeHtml(c.author_name || 'Аноним')}</strong>
            <span style="font-size:10px;color:var(--text-muted)">${(c.created_at||'').slice(0,16).replace('T',' ')}</span>
            ${!c.deleted ? `<button data-comment-del="${c.id}" class="text-button" style="margin-left:auto;font-size:10px;color:var(--text-muted)">✕</button>` : ''}
          </div>
          <p style="font-size:13px;margin:0;line-height:1.5">${c.deleted ? '[удалён]' : escapeHtml(c.body)}</p>
        </div>`).join('');
      list.querySelectorAll('[data-comment-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const r2 = await apiFetch(`/api/v1/projects/${projectId}/comments/${btn.dataset.commentDel}`, {
              method: 'DELETE', headers: apiHeaders({'Content-Type':'application/json'}),
            });
            if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
            loadComments();
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        });
      });
    } catch { list.innerHTML = '<p class="empty-copy">Ошибка загрузки.</p>'; }
  }

  loadComments();
  sendBtn?.addEventListener('click', async () => {
    const body = input?.value.trim();
    if (!body) return;
    try {
      const r = await apiFetch(`/api/v1/projects/${projectId}/comments`, {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ body }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
      if (input) input.value = '';
      loadComments();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendBtn?.click();
  });
}

function hydrateGantt(project) {
  const container = document.getElementById('ganttChart');
  if (!container) return;

  function render() {
    const groupBy = document.getElementById('ganttGroupBy')?.value || 'workType';
    const items = (project.workItems || []).filter(wi => wi.startDate || wi.dueDate);
    const milestones = (project.milestones || []);

    if (!items.length && !milestones.length) {
      container.innerHTML = '<p class="empty-copy" style="font-size:13px">Нет задач с датами. Установите startDate/dueDate в задачах.</p>';
      return;
    }

    // Compute date range
    const allDates = [
      ...items.flatMap(wi => [wi.startDate, wi.dueDate].filter(Boolean)),
      ...milestones.map(m => m.target_date).filter(Boolean),
    ].map(d => new Date(d).getTime()).filter(t => !isNaN(t));
    if (!allDates.length) {
      container.innerHTML = '<p class="empty-copy" style="font-size:13px">Нет действительных дат в задачах.</p>';
      return;
    }
    const minT = Math.min(...allDates);
    const maxT = Math.max(...allDates);
    const span = maxT - minT || 86400000;
    const pad = span * 0.05;
    const startT = minT - pad;
    const endT = maxT + pad;
    const totalSpan = endT - startT;

    // Group items
    const groups = new Map();
    for (const wi of items) {
      let key = 'Без группы';
      if (groupBy === 'workType') key = wi.workTypeName || wi.workTypeId || 'Общие';
      else if (groupBy === 'assignee') key = wi.assigneeName || 'Не назначено';
      else if (groupBy === 'status') key = wi.status || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(wi);
    }

    const ROW_H = 28, LABEL_W = 160, HEADER_H = 40, MILESTONE_ROW = ROW_H;
    const totalRows = [...groups.values()].reduce((s, g) => s + g.length, 0) + groups.size;
    const svgH = HEADER_H + totalRows * ROW_H + MILESTONE_ROW + 20;
    const svgW = Math.max(900, container.clientWidth - 24);
    const chartW = svgW - LABEL_W;

    const STATUS_COLOR = { pending:'#8b95a5', ongoing:'#4f8ef7', done:'#4adc84', blocked:'#f46' };

    function xPct(ts) {
      return LABEL_W + (new Date(ts).getTime() - startT) / totalSpan * chartW;
    }

    // Header: month ticks
    const months = [];
    const d = new Date(startT);
    d.setDate(1);
    while (d.getTime() < endT) {
      months.push({ label: d.toLocaleString('ru', { month: 'short', year: '2-digit' }), x: xPct(d) });
      d.setMonth(d.getMonth() + 1);
    }
    const todayX = xPct(Date.now());

    let svgLines = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" style="font-family:inherit;background:var(--surface);border-radius:10px;border:1px solid var(--border)">`,
      // Header bg
      `<rect x="0" y="0" width="${svgW}" height="${HEADER_H}" fill="var(--surface-2,rgba(0,0,0,.04))" rx="10"/>`,
      // Month labels
      ...months.map(m => `<text x="${m.x.toFixed(1)}" y="24" fill="var(--text-muted)" font-size="11" text-anchor="middle">${m.label}</text>
        <line x1="${m.x.toFixed(1)}" y1="0" x2="${m.x.toFixed(1)}" y2="${svgH}" stroke="var(--border)" stroke-width="1" opacity=".5"/>`),
      // Today line
      todayX >= LABEL_W && todayX <= svgW ? `<line x1="${todayX.toFixed(1)}" y1="0" x2="${todayX.toFixed(1)}" y2="${svgH}" stroke="#4f8ef7" stroke-width="1.5" stroke-dasharray="4"/>
        <text x="${(todayX+4).toFixed(1)}" y="14" fill="#4f8ef7" font-size="9">сегодня</text>` : '',
    ];

    let y = HEADER_H;
    for (const [group, groupItems] of groups) {
      // Group header row
      svgLines.push(`<rect x="0" y="${y}" width="${svgW}" height="${ROW_H}" fill="rgba(79,142,247,.05)"/>
        <text x="8" y="${y + ROW_H/2 + 4}" fill="var(--text-muted)" font-size="10" font-weight="700">${escapeHtml(group.toUpperCase())}</text>`);
      y += ROW_H;
      for (const wi of groupItems) {
        const barColor = STATUS_COLOR[wi.status] || '#8b95a5';
        const s = wi.startDate ? new Date(wi.startDate).getTime() : null;
        const e = wi.dueDate ? new Date(wi.dueDate).getTime() : null;
        const x1 = s ? xPct(s) : (e ? xPct(e) - 20 : LABEL_W);
        const x2 = e ? xPct(e) : (s ? xPct(s) + 20 : LABEL_W + 20);
        const bw = Math.max(6, x2 - x1);
        svgLines.push(
          `<text x="${LABEL_W - 6}" y="${y + ROW_H/2 + 4}" fill="var(--text)" font-size="11" text-anchor="end" clip-path="none"
            style="overflow:hidden">${escapeHtml((wi.title||'').slice(0,22))}</text>
          <rect x="${x1.toFixed(1)}" y="${y+5}" width="${bw.toFixed(1)}" height="${ROW_H-10}" rx="4"
            fill="${barColor}" opacity=".8"/>
          <line x1="0" y1="${y}" x2="${svgW}" y2="${y}" stroke="var(--border)" stroke-width=".5" opacity=".4"/>`
        );
        y += ROW_H;
      }
    }

    // Milestone diamonds at bottom
    if (milestones.length) {
      const MY = y + MILESTONE_ROW / 2;
      svgLines.push(`<text x="8" y="${MY+4}" fill="var(--text-muted)" font-size="10" font-weight="700">ВЕХИ</text>`);
      const MS_COLORS = { pending:'#8b95a5', at_risk:'#e8a84c', achieved:'#4adc84', missed:'#f46' };
      for (const m of milestones) {
        if (!m.target_date) continue;
        const mx = xPct(m.target_date);
        const mc = MS_COLORS[m.status] || '#8b95a5';
        svgLines.push(
          `<polygon points="${mx},${MY-8} ${mx+8},${MY} ${mx},${MY+8} ${mx-8},${MY}" fill="${mc}" opacity=".9"/>
          <text x="${mx}" y="${MY+20}" fill="${mc}" font-size="9" text-anchor="middle">${escapeHtml((m.name||'').slice(0,14))}</text>`
        );
      }
    }

    svgLines.push('</svg>');
    container.innerHTML = svgLines.join('\n');
  }

  render();
  document.getElementById('ganttGroupBy')?.addEventListener('change', render);
  document.getElementById('ganttRefreshBtn')?.addEventListener('click', render);
}

async function hydrateReservations(projectId) {
  const el = document.getElementById('reservationsList');
  if (!el) return;
  try {
    const r = await apiFetch(`/api/v1/inventory/reservations?projectId=${projectId}&status=all`);
    const { reservations = [] } = await r.json();
    if (!reservations.length) {
      el.innerHTML = '<p class="empty-copy" style="font-size:13px">Нет резервирований.</p>';
    } else {
      const STATUS_COLORS = { active:'#4f8ef7', consumed:'#4adc84', released:'#8b95a5', cancelled:'#f46' };
      const STATUS_LABELS = { active:'Активен', consumed:'Использован', released:'Снят', cancelled:'Отменён' };
      el.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">
        ${reservations.map(res => {
          const pct = res.quantity > 0 ? Math.round(res.consumed / res.quantity * 100) : 0;
          const color = STATUS_COLORS[res.status] || '#8b95a5';
          return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:12px;font-weight:600">${escapeHtml(res.sku_name||res.sku_id)}</span>
                <span style="font-size:10px;font-family:monospace;color:var(--text-muted)">${escapeHtml(res.sku_code||'')}</span>
                <span style="font-size:10px;padding:2px 6px;border-radius:8px;background:${color}22;color:${color}">${STATUS_LABELS[res.status]||res.status}</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
                ${escapeHtml(res.warehouse_name||'')} · ${res.consumed}/${res.quantity} ${escapeHtml(res.unit||'pcs')}
                ${res.note ? `· ${escapeHtml(res.note)}` : ''}
              </div>
              ${res.status==='active' ? `<div style="background:var(--border);border-radius:3px;height:4px;margin-top:5px">
                <div style="height:4px;border-radius:3px;background:${color};width:${pct}%"></div>
              </div>` : ''}
            </div>
            ${res.status==='active' ? `<div style="display:flex;gap:4px">
              <button data-res-consume="${res.id}" data-res-qty="${res.quantity - res.consumed}" data-res-unit="${escapeHtml(res.unit||'pcs')}"
                class="button ghost" style="font-size:10px;padding:3px 7px">Использовать</button>
              <button data-res-release="${res.id}" class="button ghost" style="font-size:10px;padding:3px 7px;color:var(--text-muted)">Снять</button>
            </div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
      // Bind buttons
      el.querySelectorAll('[data-res-consume]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const rid = btn.dataset.resConsume;
          const max = parseFloat(btn.dataset.resQty);
          const unit = btn.dataset.resUnit;
          const qty = parseFloat(prompt(`Количество использовано (макс ${max} ${unit}):`, String(max)) || '0');
          if (!qty || isNaN(qty) || qty <= 0) return;
          try {
            const r2 = await apiFetch(`/api/v1/inventory/reservations/${rid}/consume`, {
              method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
              body: JSON.stringify({ quantity: qty }),
            });
            if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
            toast(`Записано ${qty} ${unit}`); hydrateReservations(projectId);
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        });
      });
      el.querySelectorAll('[data-res-release]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Снять резервирование?')) return;
          try {
            const r2 = await apiFetch(`/api/v1/inventory/reservations/${btn.dataset.resRelease}/release`, {
              method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
              body: JSON.stringify({}),
            });
            if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
            toast('Резервирование снято'); hydrateReservations(projectId);
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        });
      });
    }

    // Add reservation button
    document.getElementById('addReservationBtn')?.removeEventListener('click', _addReservationHandler);
    _addReservationHandler = async () => {
      const whR = await apiFetch('/api/v1/inventory/warehouses');
      const { warehouses = [] } = await whR.json();
      if (!warehouses.length) { toast('Нет складов. Создайте склад в разделе Склад.'); return; }
      const whOpts = warehouses.map((w,i) => `${i+1}. ${w.name}`).join('\n');
      const whIdx = parseInt(prompt(`Выберите склад:\n${whOpts}`, '1') || '0') - 1;
      if (whIdx < 0 || whIdx >= warehouses.length) return;
      const wh = warehouses[whIdx];

      const skuR = await apiFetch(`/api/v1/inventory/stock?warehouseId=${wh.id}`);
      const { stock = [] } = await skuR.json();
      if (!stock.length) { toast(`На складе ${wh.name} нет SKU.`); return; }
      const skuOpts = stock.map((s,i) => `${i+1}. ${s.sku_name} (${s.sku_code}) — доступно: ${(s.quantity||0)-(s.reserved||0)} ${s.unit}`).join('\n');
      const skuIdx = parseInt(prompt(`Выберите материал:\n${skuOpts}`, '1') || '0') - 1;
      if (skuIdx < 0 || skuIdx >= stock.length) return;
      const sku = stock[skuIdx];

      const qty = parseFloat(prompt(`Количество для резервирования (${sku.unit}):`) || '0');
      if (!qty || isNaN(qty) || qty <= 0) return;
      const note = prompt('Заметка (необязательно):', '') || '';

      try {
        const r2 = await apiFetch('/api/v1/inventory/reservations', {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ projectId, warehouseId: wh.id, skuId: sku.sku_id, quantity: qty, note }),
        });
        if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
        toast('Материал зарезервирован'); hydrateReservations(projectId);
      } catch(e) { toast(`Ошибка: ${e.message}`); }
    };
    document.getElementById('addReservationBtn')?.addEventListener('click', _addReservationHandler);
  } catch { el.innerHTML = '<p class="empty-copy" style="font-size:13px">Недоступно.</p>'; }
}
let _addReservationHandler = null;

async function hydrateBudgetWidget(projectId) {
  const el = document.getElementById('budgetWidget');
  if (!el) return;
  try {
    const r = await apiFetch(`/api/v1/projects/${projectId}/budget`);
    const b = await r.json();
    const hasBudget = b.budgetAmount != null;
    const pct = b.utilizationPct ?? 0;
    const barColor = pct > 90 ? '#f46' : pct > 70 ? '#e8a84c' : '#4adc84';

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px">
        <article style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px">
          <span style="font-size:11px;color:var(--text-muted)">Бюджет</span>
          <strong style="display:block;font-size:18px;margin-top:2px">${hasBudget ? b.budgetAmount.toLocaleString() + ' ' + (b.budgetCurrency||'') : '—'}</strong>
        </article>
        <article style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px">
          <span style="font-size:11px;color:var(--text-muted)">Израсходовано</span>
          <strong style="display:block;font-size:18px;margin-top:2px;color:${barColor}">${(b.totalSpent||0).toLocaleString()}</strong>
        </article>
        <article style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px">
          <span style="font-size:11px;color:var(--text-muted)">Остаток</span>
          <strong style="display:block;font-size:18px;margin-top:2px">${b.remaining != null ? b.remaining.toLocaleString() : '—'}</strong>
        </article>
      </div>
      ${hasBudget ? `<div style="background:var(--border);border-radius:4px;height:6px;margin-bottom:12px">
        <div style="height:6px;border-radius:4px;background:${barColor};width:${Math.min(100,pct)}%;transition:width .4s"></div>
      </div>` : ''}
      <div id="expensesList">
        ${Object.keys(b.byCategory||{}).length ? (() => {
          const cats = Object.entries(b.byCategory||{}).sort((a,b) => b[1]-a[1]);
          const total = cats.reduce((s,[,v]) => s+v, 0);
          const CAT_COLORS = {materials:'#4f8ef7',labour:'#3bb969',equipment:'#e8a84c',other:'#a78bfa',transport:'#f46',design:'#22d3ee'};
          return `<p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Расходы по категориям</p>
          <div style="display:flex;flex-direction:column;gap:6px">${cats.map(([cat,amt]) => {
            const pctCat = total > 0 ? Math.round(amt/total*100) : 0;
            const color = CAT_COLORS[cat] || '#778195';
            return `<div>
              <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                <span style="font-size:11px;color:var(--text)">${escapeHtml(cat)}</span>
                <span style="font-size:11px;color:var(--text-muted)">${amt.toLocaleString()} <small>${pctCat}%</small></span>
              </div>
              <div style="height:5px;border-radius:3px;background:var(--border)">
                <div style="height:100%;width:${pctCat}%;background:${color};border-radius:3px;transition:width .3s"></div>
              </div></div>`;
          }).join('')}</div>`;
        })() : '<p class="empty-copy" style="font-size:13px">Расходов нет.</p>'}
      </div>`;

    document.getElementById('addExpenseBtn')?.addEventListener('click', async () => {
      const category = prompt('Категория (materials/labour/equipment/other):', 'materials') || 'other';
      const desc = prompt('Описание расхода:') || '';
      const amount = parseFloat(prompt('Сумма:') || '0');
      if (!amount || isNaN(amount)) return;
      const date = prompt('Дата (YYYY-MM-DD):', new Date().toISOString().slice(0,10)) || new Date().toISOString().slice(0,10);
      try {
        const r2 = await apiFetch(`/api/v1/projects/${projectId}/expenses`, {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ category, description: desc, amount, expenseDate: date }),
        });
        if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
        toast('Расход добавлен'); hydrateBudgetWidget(projectId);
      } catch(e) { toast(`Ошибка: ${e.message}`); }
    });

    document.getElementById('setBudgetBtn')?.addEventListener('click', async () => {
      const amount = parseFloat(prompt('Бюджет проекта:', b.budgetAmount ?? '') || '0');
      if (isNaN(amount)) return;
      const currency = prompt('Валюта:', b.budgetCurrency || 'USD') || 'USD';
      try {
        const r2 = await apiFetch(`/api/v1/projects/${projectId}/budget`, {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ amount, currency }),
        });
        if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
        toast('Бюджет обновлён'); hydrateBudgetWidget(projectId);
      } catch(e) { toast(`Ошибка: ${e.message}`); }
    });
  } catch { el.innerHTML = '<p class="empty-copy" style="font-size:13px">Недоступно.</p>'; }
}

const _ISSUE_STATUS_LABELS = {open:'Открыта',in_progress:'В работе',resolved:'Решена',closed:'Закрыта',wont_fix:'Не исправим'};
const _ISSUE_TRANSITIONS = {open:['in_progress','wont_fix'],in_progress:['resolved','open'],resolved:['closed','open'],closed:['open'],wont_fix:['open']};

function setupIssuesPanel(projectId) {
  // Add issue
  document.getElementById('addIssueBtn')?.addEventListener('click', async () => {
    const title = prompt('Название проблемы:');
    if (!title?.trim()) return;
    const sev = prompt('Серьёзность (low/medium/high/critical):', 'medium');
    if (!['low','medium','high','critical'].includes(sev||'')) { toast('Неверная серьёзность'); return; }
    try {
      const r = await apiFetch(`/api/v1/projects/${projectId}/issues`, {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ title: title.trim(), severity: sev, description: '' }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
      toast('Проблема добавлена');
      await reloadProjectData(projectId);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
  // Transition buttons
  document.querySelectorAll('[data-issue-transition]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const issueId = btn.dataset.issueTransition;
      const issues = await (await apiFetch(`/api/v1/issues?projectId=${projectId}`)).json();
      const issue = (issues.issues||[]).find(i => i.id === issueId);
      if (!issue) return;
      const current = issue.status_v2 || issue.status || 'open';
      const options = _ISSUE_TRANSITIONS[current] || [];
      if (!options.length) { toast('Нет доступных переходов'); return; }
      const choices = options.map(s => `${s}: ${_ISSUE_STATUS_LABELS[s]}`).join('\n');
      const newStatus = prompt(`Перевести в статус:\n${choices}`, options[0]);
      if (!newStatus || !options.includes(newStatus)) return;
      let note = '';
      if (newStatus === 'resolved') note = prompt('Примечание к решению (опционально):') || '';
      try {
        const r = await apiFetch(`/api/v1/issues/${issueId}/transition`, {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ status: newStatus, resolutionNote: note }),
        });
        if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
        toast(`Статус → ${_ISSUE_STATUS_LABELS[newStatus]}`);
        await reloadProjectData(projectId);
      } catch(e) { toast(`Ошибка: ${e.message}`); }
    });
  });
  // Assign buttons
  document.querySelectorAll('[data-issue-assign]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const issueId = btn.dataset.issueAssign;
      const assignee = prompt('Имя или ID исполнителя:');
      if (!assignee?.trim()) return;
      try {
        const r = await apiFetch(`/api/v1/issues/${issueId}/assign`, {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ assignedTo: assignee.trim() }),
        });
        if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
        toast('Исполнитель назначен');
        await reloadProjectData(projectId);
      } catch(e) { toast(`Ошибка: ${e.message}`); }
    });
  });
  // Severity filter
  document.getElementById('issueSevFilter')?.addEventListener('change', (e) => {
    const sev = e.target.value;
    document.querySelectorAll('#issuesList .issue-item').forEach(el => {
      el.style.display = !sev || el.dataset.issueSev === sev ? '' : 'none';
    });
  });
}

async function reloadProjectData(projectId) {
  try {
    const r = await apiFetch(`/api/v1/projects/${projectId}`);
    const { project } = await r.json();
    const idx = projects.findIndex(p => p.id === projectId);
    if (idx !== -1) { projects[idx] = project; renderProjectDetail(); }
  } catch { /* silent */ }
}

const _RISK_PROB_COLORS = {low:'#4adc84',medium:'#e8a84c',high:'#f46'};
const _RISK_IMPACT_COLORS = {low:'#4f8ef7',medium:'#e8a84c',high:'#e05353',critical:'#f46'};
const _RISK_STATUS_LABELS = {open:'Открыт',mitigated:'Снижен',accepted:'Принят',closed:'Закрыт'};
const _RISK_SCORE = {low:1,medium:2,high:3,critical:4};

async function hydrateRisks(projectId) {
  const list = document.getElementById('risksList');
  if (!list) return;
  const canManage = roleCan('projectManage');
  try {
    const { risks = [] } = await apiFetch(`/api/v1/projects/${projectId}/risks`).then(r => r.json());
    if (!risks.length) {
      list.innerHTML = '<p class="empty-copy" style="font-size:13px">Рисков нет. Нажмите «＋ Риск» чтобы добавить.</p>';
    } else {
      const open = risks.filter(r => r.status === 'open');
      const rest = risks.filter(r => r.status !== 'open');
      const sorted = [...open.sort((a,b) => (_RISK_SCORE[b.impact]||0)*(_RISK_SCORE[b.probability]||0) - (_RISK_SCORE[a.impact]||0)*(_RISK_SCORE[a.probability]||0)), ...rest];
      list.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">
        ${sorted.map(risk => {
          const pc = _RISK_PROB_COLORS[risk.probability] || '#778';
          const ic = _RISK_IMPACT_COLORS[risk.impact] || '#778';
          const closed = risk.status !== 'open';
          return `<div style="background:var(--surface);border:1px solid ${closed ? 'var(--border)' : ic+'44'};border-radius:10px;padding:12px;opacity:${closed ? .6 : 1}">
            <div style="display:flex;align-items:flex-start;gap:10px">
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <strong style="font-size:13px">${escapeHtml(risk.title)}</strong>
                  <span style="font-size:10px;padding:2px 7px;border-radius:8px;background:${pc}22;color:${pc}">P: ${risk.probability}</span>
                  <span style="font-size:10px;padding:2px 7px;border-radius:8px;background:${ic}22;color:${ic}">I: ${risk.impact}</span>
                  <span style="font-size:10px;color:var(--text-muted)">${_RISK_STATUS_LABELS[risk.status]||risk.status}</span>
                </div>
                ${risk.description ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 4px">${escapeHtml(risk.description)}</p>` : ''}
                ${risk.mitigation ? `<p style="font-size:11px;color:#4adc84;margin:0"><strong>Снижение:</strong> ${escapeHtml(risk.mitigation)}</p>` : ''}
                ${risk.owner ? `<p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Ответственный: ${escapeHtml(risk.owner)}</p>` : ''}
              </div>
              ${canManage ? `<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
                <button class="text-button risk-edit-btn" data-risk-id="${risk.id}" style="font-size:11px">✏</button>
                <button class="text-button risk-del-btn" data-risk-id="${risk.id}" style="font-size:11px;color:#e05353">✕</button>
              </div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }
    document.getElementById('addRiskBtn')?.addEventListener('click', async () => {
      const title = prompt('Название риска:'); if (!title?.trim()) return;
      const desc = prompt('Описание риска (пусто = нет):') ?? '';
      const prob = prompt('Вероятность (low/medium/high):', 'medium');
      if (!['low','medium','high'].includes(prob||'')) { toast('Неверная вероятность'); return; }
      const impact = prompt('Влияние (low/medium/high/critical):', 'medium');
      if (!['low','medium','high','critical'].includes(impact||'')) { toast('Неверное влияние'); return; }
      const mitigation = prompt('Меры снижения (пусто = нет):') ?? '';
      const owner = prompt('Ответственный (имя, пусто = нет):') ?? '';
      try {
        const r = await apiFetch(`/api/v1/projects/${projectId}/risks`, {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ title: title.trim(), description: desc, probability: prob, impact, mitigation, owner }),
        });
        if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
        toast('Риск добавлен'); hydrateRisks(projectId);
      } catch(e) { toast(`Ошибка: ${e.message}`); }
    });
    list.querySelectorAll('.risk-edit-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rid = btn.dataset.riskId;
        const risk = risks.find(r => r.id === rid); if (!risk) return;
        const newStatus = prompt(`Статус (open/mitigated/accepted/closed):\nТекущий: ${risk.status}`, risk.status);
        if (!newStatus || !_RISK_STATUS_LABELS[newStatus]) return;
        const newMit = prompt('Меры снижения:', risk.mitigation||'') ?? risk.mitigation;
        try {
          const r = await apiFetch(`/api/v1/projects/${projectId}/risks/${rid}/update`, {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ status: newStatus, mitigation: newMit }),
          });
          if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
          toast('Риск обновлён'); hydrateRisks(projectId);
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
    list.querySelectorAll('.risk-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить риск?')) return;
        const rid = btn.dataset.riskId;
        try {
          const r = await apiFetch(`/api/v1/projects/${projectId}/risks/${rid}/delete`, {
            method: 'POST', headers: apiHeaders({}),
          });
          if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
          toast('Риск удалён'); hydrateRisks(projectId);
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
  } catch { list.innerHTML = '<p class="empty-copy" style="font-size:13px">Недоступно.</p>'; }
}

const _MILESTONE_STATUS_LABELS = {pending:'Ожидается',at_risk:'Под риском',achieved:'Достигнута',missed:'Пропущена'};
const _MILESTONE_STATUS_COLORS = {pending:'var(--text-muted)',at_risk:'#e8a84c',achieved:'#4adc84',missed:'#f46'};

async function hydrateMilestones(projectId) {
  const list = document.getElementById('milestonesList');
  if (!list) return;
  try {
    const r = await apiFetch(`/api/v1/projects/${projectId}/milestones`);
    const { milestones = [] } = await r.json();
    const canManage = roleCan('projectManage');
    if (!milestones.length) {
      list.innerHTML = '<p class="empty-copy" style="font-size:13px">Вехи не добавлены.</p>';
    } else {
      const today = new Date().toISOString().slice(0,10);
      list.innerHTML = milestones.map(m => {
        const isOverdue = m.status !== 'achieved' && m.target_date < today;
        const dateColor = isOverdue ? '#f46' : 'var(--text-muted)';
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)${isOverdue?';background:rgba(255,68,68,.04)':''}">
          <div style="width:10px;height:10px;border-radius:50%;background:${isOverdue?'#f46':_MILESTONE_STATUS_COLORS[m.status]};flex-shrink:0"></div>
          <div style="flex:1">
            <strong style="font-size:13px">${escapeHtml(m.name)}</strong>
            ${isOverdue ? `<small style="display:block;color:#f46;font-size:10px">⚠ Просрочено</small>` : ''}
            ${m.description ? `<small style="display:block;color:var(--text-muted)">${escapeHtml(m.description)}</small>` : ''}
          </div>
          <span style="font-size:11px;color:${isOverdue?'#f46':_MILESTONE_STATUS_COLORS[m.status]};background:${isOverdue?'rgba(255,68,68,.12)':_MILESTONE_STATUS_COLORS[m.status]+'1a'};padding:2px 7px;border-radius:10px">${_MILESTONE_STATUS_LABELS[m.status]||m.status}</span>
          <span style="font-size:11px;color:${dateColor};font-weight:${isOverdue?700:400}">${m.target_date}</span>
          ${canManage ? `<button type="button" class="text-button" style="font-size:11px" data-ms-id="${m.id}" data-ms-action="edit">•••</button>` : ''}
        </div>`;
      }).join('');
    }
    // Add milestone button wiring
    document.getElementById('addMilestoneBtn')?.addEventListener('click', async () => {
      const name = prompt('Название вехи:');
      if (!name?.trim()) return;
      const targetDate = prompt('Целевая дата (YYYY-MM-DD):');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate||'')) { toast('Неверный формат даты'); return; }
      try {
        const r2 = await apiFetch(`/api/v1/projects/${projectId}/milestones`, {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ name: name.trim(), targetDate }),
        });
        if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
        toast('Веха добавлена'); hydrateMilestones(projectId);
      } catch(e) { toast(`Ошибка: ${e.message}`); }
    });
    // Edit/status buttons
    list.querySelectorAll('[data-ms-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mid = btn.dataset.msId;
        const ms = milestones.find(m => m.id === mid);
        if (!ms) return;
        const choices = Object.keys(_MILESTONE_STATUS_LABELS).map(k => `${k}: ${_MILESTONE_STATUS_LABELS[k]}`).join('\n');
        const newStatus = prompt(`Статус вехи:\n${choices}\n\nТекущий: ${ms.status}`, ms.status);
        if (!newStatus || !_MILESTONE_STATUS_LABELS[newStatus]) return;
        try {
          const r2 = await apiFetch(`/api/v1/projects/${projectId}/milestones/${mid}/update`, {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ status: newStatus }),
          });
          if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
          toast('Статус обновлён'); hydrateMilestones(projectId);
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
  } catch { list.innerHTML = '<p class="empty-copy" style="font-size:13px">Недоступно.</p>'; }
}

async function hydrateProjectWorkload(projectId) {
  const container = document.getElementById('workloadSection');
  if (!container) return;
  try {
    const r = await apiFetch(`/api/v1/workload?projectId=${projectId}`);
    const { workload = [] } = await r.json();
    if (!workload.length) {
      container.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Задачи не назначены.</p>';
      return;
    }
    const STATUS_COLOR = { ready:'#4f8ef7', progress:'#f0a44a', blocked:'#e05353', review:'#a06fd0', testing:'#42d697', ideas:'#778195', backlog:'#778195' };
    container.innerHTML = workload.map(m => {
      const bars = Object.entries(m.byStatus).map(([s, cnt]) =>
        `<span title="${s}: ${cnt}" style="display:inline-block;width:${Math.max(4,cnt*8)}px;height:10px;background:${STATUS_COLOR[s]||'#556'};border-radius:2px;margin-right:2px"></span>`
      ).join('');
      return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)">
        <span style="font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.displayName)}</span>
        <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">${m.total} задач</span>
        <div style="display:flex;align-items:center">${bars}</div>
      </div>`;
    }).join('');
  } catch { container.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Недоступно.</p>'; }
}

const _WI_STATUSES = [
  { id: 'pending', label: 'Pending', color: '#8b95a5' },
  { id: 'ongoing', label: 'Ongoing', color: '#4f8ef7' },
  { id: 'done',    label: 'Done',    color: '#4adc84' },
  { id: 'blocked', label: 'Blocked', color: '#f46' },
];

function renderWiKanban(project) {
  const board = document.getElementById('workItemsKanban');
  if (!board) return;
  const items = project.workItems || [];
  const filterStatus = document.getElementById('wiFilterStatus')?.value || '';
  const filtered = filterStatus ? items.filter(wi => wi.status === filterStatus) : items;
  const cols = (filterStatus ? _WI_STATUSES.filter(s => s.id === filterStatus) : _WI_STATUSES);
  board.innerHTML = `<div style="display:flex;gap:12px;min-width:${cols.length * 240}px;padding-bottom:8px">
    ${cols.map(col => {
      const cards = filtered.filter(wi => wi.status === col.id);
      return `<div style="flex:0 0 220px;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <div style="width:8px;height:8px;border-radius:50%;background:${col.color}"></div>
          <strong style="font-size:12px">${col.label}</strong>
          <span style="font-size:11px;color:var(--text-muted);margin-left:auto">${cards.length}</span>
        </div>
        ${cards.length ? cards.map(wi => `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px;cursor:default">
            ${wi.code ? `<span style="font-size:10px;font-family:monospace;color:var(--text-muted)">${escapeHtml(wi.code)}</span>` : ''}
            <p style="font-size:12px;font-weight:600;margin:3px 0 4px;line-height:1.3">${escapeHtml(wi.title)}</p>
            ${wi.assigneeName ? `<small style="color:var(--text-muted);font-size:11px">👤 ${escapeHtml(wi.assigneeName)}</small>` : ''}
            ${wi.dueDate ? `<small style="color:var(--text-muted);font-size:11px;display:block">📅 ${wi.dueDate}</small>` : ''}
            ${wi.startDate && wi.dueDate ? (() => {
              const now = Date.now();
              const due = new Date(wi.dueDate).getTime();
              const overdue = wi.status !== 'done' && due < now;
              return overdue ? `<small style="color:#f46;font-size:10px">⚠ просрочено</small>` : '';
            })() : ''}
          </div>`).join('') : `<div style="border:1px dashed var(--border);border-radius:8px;padding:16px;text-align:center;color:var(--text-muted);font-size:12px">Нет задач</div>`}
      </div>`;
    }).join('')}
  </div>`;
}

function setupWorkItemsBulkList(project) {
  const listEl = document.getElementById('workItemsFullList');
  const kanbanEl = document.getElementById('workItemsKanban');
  const filterSel = document.getElementById('wiFilterStatus');
  const bulkBtn = document.getElementById('wiBulkDoneBtn');
  if (!listEl) return;

  // CSV import
  document.getElementById('wiAiGenerateBtn')?.addEventListener('click', async () => {
    const text = prompt('Опишите задачи проекта свободным текстом.\nAI создаст 3-7 задач автоматически:');
    if (!text?.trim()) return;
    const btn = document.getElementById('wiAiGenerateBtn');
    if (btn) { btn.disabled = true; btn.textContent = '✦ Генерирую…'; }
    try {
      const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/ai-generate`, {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ text: text.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || r.status);
      toast(`✦ AI создал ${data.created} задач${data.errors?.length ? `. Ошибок: ${data.errors.length}` : ''}`);
      if (data.errors?.length) console.warn('AI generate errors:', data.errors);
      await fetchProjects();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '✦ AI задачи'; } }
  });

  document.getElementById('wiImportCsvBtn')?.addEventListener('click', () => {
    const hint = 'Формат CSV: title,status,priority,description,workType,startDate,dueDate,estimatedMinutes\n' +
      'title (обязательно), остальные — опционально.\n\nВыберите CSV файл для импорта.';
    if (confirm(hint.replace('Выберите CSV файл для импорта.', 'Продолжить?')))
      document.getElementById('wiCsvInput')?.click();
  });
  document.getElementById('wiCsvInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    toast('Импортирую задачи из CSV…');
    try {
      const text = await file.text();
      const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/import-csv`, {
        method: 'POST', headers: apiHeaders({'Content-Type':'text/csv'}),
        body: text,
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error?.message || r.status);
      toast(`Создано ${res.created} задач${res.errors?.length ? `. Ошибок: ${res.errors.length}` : '.'}`);
      if (res.errors?.length) console.warn('Import errors:', res.errors);
      // Reload project to show new items
      if (typeof reloadProjectData === 'function') await reloadProjectData(project.id);
      else render();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
    e.target.value = '';
  });

  // View toggle
  let wiViewMode = 'list';
  document.querySelectorAll('.wi-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      wiViewMode = btn.dataset.wiView;
      document.querySelectorAll('.wi-view-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.wiView === wiViewMode);
        b.style.color = b.dataset.wiView === wiViewMode ? 'var(--text)' : 'var(--text-muted)';
        b.style.background = b.dataset.wiView === wiViewMode ? 'rgba(79,142,247,.12)' : 'var(--surface)';
      });
      listEl.style.display = wiViewMode === 'list' ? '' : 'none';
      if (kanbanEl) kanbanEl.style.display = wiViewMode === 'kanban' ? '' : 'none';
      if (wiViewMode === 'kanban') renderWiKanban(project);
      else render();
    });
  });

  const workTypeById = new Map((project.workTypeProgress||[]).map(wt => [wt.id, wt]));
  const buildingById = new Map((project.buildings||[]).map(b => [b.id, b]));
  let selected = new Set();

  function render() {
    const filterStatus = filterSel?.value || '';
    const items = (project.workItems||[]).filter(wi =>
      !filterStatus || wi.status === filterStatus
    );
    if (!items.length) {
      listEl.innerHTML = '<p class="empty-copy">Нет задач.</p>';
      if (bulkBtn) bulkBtn.style.display = 'none';
      return;
    }
    const STATUS_COLOR = { ready:'#3bb969', progress:'#4f8ef7', blocked:'#e05353', done:'#445060', backlog:'#556' };
    listEl.innerHTML = items.map(wi => {
      const wt = workTypeById.get(wi.workTypeId);
      const bld = buildingById.get(wi.buildingId);
      const isSelected = selected.has(wi.id);
      return `<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:${isSelected ? 'rgba(79,142,247,.08)' : 'var(--surface)'};border:1px solid ${isSelected ? 'rgba(79,142,247,.3)' : 'var(--border)'};border-radius:8px;cursor:pointer">
        <input type="checkbox" data-wi-id="${wi.id}" ${isSelected ? 'checked' : ''} style="width:14px;height:14px;cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px">
            <strong style="font-size:12px">${wi.code ? escapeHtml(wi.code) + ' ' : ''}${escapeHtml(wi.title)}</strong>
            <span style="font-size:9px;font-weight:700;color:${STATUS_COLOR[wi.effectiveStatus||wi.status]||'#556'};text-transform:uppercase">${wi.effectiveStatus||wi.status}</span>
          </div>
          <small style="font-size:10px;color:var(--text-muted)">${wt ? escapeHtml(wt.name) : ''}${bld ? ' · ' + escapeHtml(bld.code) : ''}${wi.startDate ? ' · с ' + wi.startDate : ''}${wi.dueDate ? ' · до ' + wi.dueDate : ''}${wi.estimatedMinutes ? ' · <span style="color:#4f8ef7">~' + (wi.estimatedMinutes/60).toFixed(1) + 'ч план</span>' : ''}${wi.actualMinutes ? ' · <span style="color:#4adc84">' + (wi.actualMinutes/60).toFixed(1) + 'ч факт</span>' : ''}</small>
        </div>
        <select class="wi-status-sel" data-wi-status-id="${wi.id}" data-wi-ver="${wi.version}"
          style="padding:3px 6px;font-size:10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:${STATUS_COLOR[wi.effectiveStatus||wi.status]||'#556'};cursor:pointer;flex-shrink:0"
          aria-label="Статус">
          ${['pending','ongoing','done','blocked'].map(s =>
            `<option value="${s}" ${(wi.status||'')==s?'selected':''}>${s}</option>`
          ).join('')}
        </select>
        <select class="wi-priority-sel" data-wi-pri-id="${wi.id}" data-wi-pri-ver="${wi.version}"
          style="padding:3px 6px;font-size:10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:${{critical:'#e05353',high:'#e09800',medium:'var(--accent)',low:'var(--text-muted)'}[wi.priority]||'var(--text-muted)'};cursor:pointer;flex-shrink:0"
          aria-label="Приоритет">
          ${['low','medium','high','critical'].map(p =>
            `<option value="${p}" ${(wi.priority||'')==p?'selected':''}>${p}</option>`
          ).join('')}
        </select>
        <button class="text-button wi-date-btn" data-wi-date-id="${wi.id}" data-wi-ver="${wi.version}"
          data-wi-start="${wi.startDate||''}" data-wi-due="${wi.dueDate||''}"
          style="font-size:11px;color:var(--text-muted);padding:0 4px;flex-shrink:0" title="Даты">📅</button>
        <button class="text-button wi-dep-btn" data-wi-dep-id="${wi.id}" data-wi-dep-on="${(wi.dependsOn||[]).join(',')}"
          style="font-size:11px;color:${(wi.dependsOn||[]).length?'var(--accent)':'var(--text-muted)'};padding:0 4px;flex-shrink:0"
          title="Зависимости (${(wi.dependsOn||[]).length})">${(wi.dependsOn||[]).length?'🔗':'⛓'}</button>
        <button class="text-button wi-desc-btn" data-wi-desc-id="${wi.id}" data-wi-desc-ver="${wi.version}"
          data-wi-desc-val="${escapeHtml(wi.description||'')}"
          style="font-size:11px;color:${wi.description?'var(--accent)':'var(--text-muted)'};padding:0 4px;flex-shrink:0"
          title="Описание">✎</button>
        <button class="text-button wi-ai-est-btn" data-wi-est-id="${wi.id}"
          style="font-size:11px;color:var(--text-muted);padding:0 4px;flex-shrink:0"
          title="AI: оценить трудоёмкость">✦</button>
      </label>`;
    }).join('');

    listEl.querySelectorAll('.wi-status-sel').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        e.stopPropagation();
        const wiId = sel.dataset.wiStatusId;
        const ver = parseInt(sel.dataset.wiVer);
        const newStatus = sel.value;
        try {
          const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/${wiId}`, {
            method: 'PUT', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ status: newStatus, expectedVersion: ver }),
          });
          if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
          const updated = await r.json();
          const wi = (project.workItems||[]).find(w => w.id === wiId);
          if (wi) { wi.status = newStatus; wi.version = updated.version || ver+1; sel.dataset.wiVer = wi.version; }
          sel.style.color = STATUS_COLOR[newStatus] || '#556';
          toast(`Статус → ${newStatus}`);
        } catch(e) { toast(`Ошибка: ${e.message}`); sel.value = sel.dataset.wiVer ? /* prev */ sel.value : newStatus; }
      });
    });

    const PRI_COLOR_MAP = {critical:'#e05353',high:'#e09800',medium:'var(--accent)',low:'var(--text-muted)'};
    listEl.querySelectorAll('.wi-priority-sel').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        e.stopPropagation();
        const wiId = sel.dataset.wiPriId;
        const ver = parseInt(sel.dataset.wiPriVer);
        const newPri = sel.value;
        try {
          const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/${wiId}`, {
            method: 'PUT', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ priority: newPri, expectedVersion: ver }),
          });
          if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
          const updated = await r.json();
          const wi = (project.workItems||[]).find(w => w.id === wiId);
          if (wi) { wi.priority = newPri; wi.version = updated.version || ver+1; sel.dataset.wiPriVer = wi.version; }
          sel.style.color = PRI_COLOR_MAP[newPri] || 'var(--text-muted)';
          toast(`Приоритет → ${newPri}`);
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });

    listEl.querySelectorAll('.wi-date-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const wiId = btn.dataset.wiDateId;
        const ver = parseInt(btn.dataset.wiVer);
        const startDate = prompt('Дата начала (YYYY-MM-DD, пусто = нет):', btn.dataset.wiStart) ?? '';
        const dueDate = prompt('Дата окончания (YYYY-MM-DD, пусто = нет):', btn.dataset.wiDue) ?? '';
        try {
          const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/${wiId}`, {
            method: 'PUT', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ startDate: startDate||null, dueDate: dueDate||null, expectedVersion: ver }),
          });
          if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
          const updated = await r.json();
          const wi = (project.workItems||[]).find(w => w.id === wiId);
          if (wi) { wi.startDate = startDate||null; wi.dueDate = dueDate||null; wi.version = updated.version || ver+1; }
          toast('Даты обновлены'); render();
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });

    listEl.querySelectorAll('.wi-dep-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const wiId = btn.dataset.wiDepId;
        const currentDeps = (btn.dataset.wiDepOn||'').split(',').filter(Boolean);
        const allItems = project.workItems || [];
        const depNames = currentDeps.map(id => {
          const w = allItems.find(x => x.id === id);
          return w ? `${w.code||w.id}: ${w.title}` : id;
        });
        const action = prompt(
          `Зависимости задачи:\n${depNames.length ? depNames.join('\n') : '(нет)'}\n\n` +
          `1 — добавить блокировщика\n2 — удалить блокировщика`,
          '1'
        );
        if (!action) return;
        if (action === '1') {
          const others = allItems.filter(w => w.id !== wiId && !currentDeps.includes(w.id));
          if (!others.length) { toast('Нет доступных задач для добавления'); return; }
          const choices = others.map((w,i) => `${i+1} — ${w.code||''} ${w.title}`).join('\n');
          const pick = prompt(`Выберите блокировщика (номер):\n${choices}`, '1');
          const idx = parseInt(pick||'0') - 1;
          if (idx < 0 || idx >= others.length) return;
          const predId = others[idx].id;
          try {
            const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/${wiId}/dependencies`, {
              method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
              body: JSON.stringify({ predecessorId: predId }),
            });
            if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
            toast('Зависимость добавлена'); await fetchProjects();
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        } else if (action === '2') {
          if (!currentDeps.length) { toast('Нет зависимостей для удаления'); return; }
          const rmChoices = depNames.map((n,i) => `${i+1} — ${n}`).join('\n');
          const rmPick = prompt(`Удалить зависимость (номер):\n${rmChoices}`, '1');
          const rmIdx = parseInt(rmPick||'0') - 1;
          if (rmIdx < 0 || rmIdx >= currentDeps.length) return;
          const predId = currentDeps[rmIdx];
          try {
            const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/${wiId}/dependencies?predecessorId=${encodeURIComponent(predId)}`, {
              method: 'DELETE', headers: apiHeaders({}),
            });
            if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
            toast('Зависимость удалена'); await fetchProjects();
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        }
      });
    });

    listEl.querySelectorAll('.wi-desc-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const wiId = btn.dataset.wiDescId;
        const ver = parseInt(btn.dataset.wiDescVer);
        const current = btn.dataset.wiDescVal || '';
        const newDesc = prompt('Описание задачи:', current);
        if (newDesc === null) return;
        try {
          const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/${wiId}`, {
            method: 'PUT', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ description: newDesc, expectedVersion: ver }),
          });
          if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
          const updated = await r.json();
          const wi = (project.workItems||[]).find(w => w.id === wiId);
          if (wi) { wi.description = newDesc; wi.version = updated.version || ver+1; }
          btn.dataset.wiDescVal = newDesc;
          btn.dataset.wiDescVer = wi?.version || ver+1;
          btn.style.color = newDesc ? 'var(--accent)' : 'var(--text-muted)';
          toast('Описание обновлено');
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });

    listEl.querySelectorAll('.wi-ai-est-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const wiId = btn.dataset.wiEstId;
        btn.textContent = '…'; btn.disabled = true;
        try {
          const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/${wiId}/ai-estimate`, {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({}),
          });
          if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
          const { estimatedHours, confidence, reasoning } = await r.json();
          const wi = (project.workItems||[]).find(w => w.id === wiId);
          if (wi) wi.estimatedMinutes = Math.round(estimatedHours * 60);
          toast(`AI: ~${estimatedHours}ч (${confidence}) · ${reasoning?.slice(0,60)||''}`);
          render();
        } catch(e) {
          toast(`AI оценка: ${e.message}`);
        } finally { btn.textContent = '✦'; btn.disabled = false; }
      });
    });

    listEl.querySelectorAll('[data-wi-id]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.dataset.wiId);
        else selected.delete(cb.dataset.wiId);
        if (bulkBtn) bulkBtn.style.display = selected.size ? 'inline-flex' : 'none';
      });
    });
  }

  filterSel?.addEventListener('change', () => {
    if (wiViewMode === 'kanban') renderWiKanban(project); else render();
  });
  render();

  bulkBtn?.addEventListener('click', async () => {
    if (!selected.size) return;
    const action = prompt(
      `Массовое действие для ${selected.size} задач:\n` +
      `1 — изменить статус\n2 — назначить исполнителя`,
      '1'
    );
    if (!action) return;
    if (action === '1') {
      const targetStatus = prompt(`Статус (${Object.keys(WORK_ITEM_TRANSITIONS).join('/')}):`, 'done');
      if (!targetStatus) return;
      try {
        const r = await apiFetch(`/api/v1/projects/${encodeURIComponent(project.id)}/work-items/bulk-status`, {
          method: 'POST',
          headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key':createIdempotencyKey()}),
          body: JSON.stringify({ ids: [...selected], status: targetStatus }),
        });
        const { updated, skipped } = await r.json();
        toast(`Обновлено: ${updated}, пропущено: ${skipped}`);
      } catch(e) { toast(`Ошибка: ${e.message}`); return; }
    } else if (action === '2') {
      const members = (project.members || []);
      const choiceText = members.length
        ? members.map((m,i) => `${i+1} — ${m.displayName||m.userId}`).join('\n') + '\n0 — снять'
        : 'Введите ID пользователя (пусто = снять):';
      const pick = prompt(choiceText, members.length ? '1' : '');
      let assigneeId = '';
      if (members.length) {
        const idx = parseInt(pick||'0') - 1;
        assigneeId = idx >= 0 && idx < members.length ? members[idx].userId : '';
      } else {
        assigneeId = (pick||'').trim();
      }
      try {
        const r = await apiFetch(`/api/v1/projects/${encodeURIComponent(project.id)}/work-items/bulk-assign`, {
          method: 'POST',
          headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ ids: [...selected], assigneeId }),
        });
        const { updated } = await r.json();
        toast(`Назначено: ${updated}`);
      } catch(e) { toast(`Ошибка: ${e.message}`); return; }
    }
    selected.clear();
    if (bulkBtn) bulkBtn.style.display = 'none';
    await fetchProjects();
  });
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

    const typeFilter = document.getElementById('activityTypeFilter')?.value || '';
    // Merge and sort by created_at desc
    let items = [
      ...activity.map(a => ({ ...a, _kind: 'activity' })),
      ...comments.filter(c => !c.deleted && !c.parent_id).map(c => ({ ...c, _kind: 'comment' })),
    ].sort((a, b) => (b.created_at > a.created_at ? 1 : -1));

    if (typeFilter) {
      if (typeFilter === 'comment') items = items.filter(i => i._kind === 'comment');
      else items = items.filter(i => i._kind === 'activity' && (i.event_type||'').includes(typeFilter));
    }

    if (!items.length) { feed.innerHTML = '<p class="empty-copy">Нет активности по выбранному фильтру.</p>'; return; }

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

// ── Team Presence ──────────────────────────────────────────────────────────

async function setupPresencePanel(projectId) {
  const toggleBtn = document.getElementById('presenceToggleBtn');
  const panel = document.getElementById('presencePanel');
  const datePicker = document.getElementById('presenceDatePicker');
  const list = document.getElementById('presenceList');
  const refreshBtn = document.getElementById('presenceRefreshBtn');
  const addBtn = document.getElementById('addPresenceBtn');
  if (!toggleBtn || !panel) return;

  datePicker.value = new Date().toISOString().slice(0,10);

  async function loadPresence() {
    const date = datePicker.value || new Date().toISOString().slice(0,10);
    try {
      const r = await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/presence?from=${date}&to=${date}`);
      const { presence = [] } = await r.json();
      if (!presence.length) {
        list.innerHTML = '<p class="empty-copy" style="font-size:12px">Никто не отмечен за этот день.</p>';
      } else {
        list.innerHTML = presence.map(p => `
          <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)">
            <span style="width:28px;height:28px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${(p.memberName||'?')[0].toUpperCase()}</span>
            <div style="flex:1">
              <strong style="font-size:12px">${escapeHtml(p.memberName)}</strong>
              <small style="display:block;font-size:10px;color:var(--text-muted)">${escapeHtml(p.trade||'')}${p.checkIn ? ' · ' + p.checkIn.slice(11,16) : ''}${p.checkOut ? ' – ' + p.checkOut.slice(11,16) : ''}</small>
            </div>
            ${p.notes ? `<small style="color:var(--text-muted);font-size:11px">${escapeHtml(p.notes)}</small>` : ''}
          </div>`).join('');
      }
    } catch(e) { list.innerHTML = `<p style="color:#e05353;font-size:12px">${e.message}</p>`; }
  }

  toggleBtn.addEventListener('click', () => {
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : '';
    if (!isOpen) loadPresence();
  });
  datePicker?.addEventListener('change', loadPresence);
  refreshBtn?.addEventListener('click', loadPresence);

  addBtn?.addEventListener('click', async () => {
    const members = document.querySelectorAll('#projectTeamList .team-chip');
    if (!members.length) { toast('Сначала назначьте сотрудников на проект'); return; }
    const date = datePicker.value || new Date().toISOString().slice(0,10);
    const name = prompt('Имя сотрудника (из назначенных):');
    if (!name) return;
    // find member by name from chips
    let memberId = null;
    document.querySelectorAll('#projectTeamList .team-chip').forEach(chip => {
      if (chip.querySelector('strong')?.textContent.trim().toLowerCase() === name.trim().toLowerCase()) {
        memberId = chip.dataset.mid;
      }
    });
    if (!memberId) { toast(`Сотрудник "${name}" не найден в команде проекта`); return; }
    try {
      await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/presence`, {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/json','Idempotency-Key': createIdempotencyKey()}),
        body: JSON.stringify({ memberId, presenceDate: date }),
      });
      loadPresence();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
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
    const SUPPORTED_SCHEMAS = ['rackpilot-project-export/1','rackpilot-project-export/2'];
    if (!SUPPORTED_SCHEMAS.includes(raw.schema)) {
      toast(`Неверный формат файла (ожидается ${SUPPORTED_SCHEMAS.join(' или ')})`);
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
          ${(raw.assets||[]).length ? `<tr><td style="padding:5px 8px;color:var(--text-secondary)">Оборудование</td><td style="padding:5px 8px">${raw.assets.length}</td></tr>` : ''}
          ${(raw.issues||[]).length ? `<tr><td style="padding:5px 8px;color:var(--text-secondary)">Проблемы</td><td style="padding:5px 8px">${raw.issues.length}</td></tr>` : ''}
          ${(raw.comments||[]).length ? `<tr><td style="padding:5px 8px;color:var(--text-secondary)">Комментарии</td><td style="padding:5px 8px">${raw.comments.length}</td></tr>` : ''}
          <tr><td style="padding:5px 8px;color:var(--text-secondary)">Схема</td><td style="padding:5px 8px;font-size:11px;color:var(--text-muted)">${escapeHtml(raw.schema)}</td></tr>
          <tr><td style="padding:5px 8px;color:var(--text-secondary)">Экспортирован</td><td style="padding:5px 8px">${(raw.exported_at||'').slice(0,16).replace('T',' ')}</td></tr>
        </table>
        <p style="font-size:12px;color:var(--text-secondary);margin:0">Существующие записи с совпадающими ID будут пропущены (INSERT OR IGNORE).</p>`;
    }
    document.getElementById('projectImportDialog')?.showModal();
  } catch { toast('Не удалось прочитать файл'); }
}

function setupUnitRegistry() {
  const filterEl = document.getElementById('unitRegistryProjectFilter');
  const listEl = document.getElementById('unitRegistryList');
  const refreshBtn = document.getElementById('unitRegistryRefreshBtn');
  if (!filterEl || !listEl) return;

  async function hydrateUnitRegistry() {
    const projectId = filterEl.value;
    if (!projectId) { listEl.innerHTML = '<p class="empty-copy">Выберите проект для просмотра units.</p>'; return; }
    listEl.innerHTML = '<p class="empty-copy">Загрузка…</p>';
    try {
      const { units = [] } = await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/units`);
      if (!units.length) { listEl.innerHTML = '<p class="empty-copy">Units не найдены.</p>'; return; }
      listEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border)">
          <th style="padding:8px 10px">Код</th><th style="padding:8px 10px">Название</th>
          <th style="padding:8px 10px">Локация</th><th style="padding:8px 10px">Заметки</th>
          <th style="padding:8px 10px"></th>
        </tr></thead>
        <tbody>${units.map(u => `
          <tr data-unit-id="${escapeHtml(u.id)}" style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 10px"><code>${escapeHtml(u.code)}</code></td>
            <td style="padding:8px 10px">${escapeHtml(u.name)}</td>
            <td style="padding:8px 10px;color:var(--text-secondary);font-size:12px">${escapeHtml(u.locationName)}</td>
            <td style="padding:8px 10px;color:var(--text-secondary);font-size:12px;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(u.notes||'—')}</td>
            <td style="padding:8px 10px"><button class="button ghost unit-edit-btn" type="button" style="font-size:11px;padding:4px 8px"
              data-unit='${JSON.stringify({id:u.id,code:u.code,name:u.name,notes:u.notes||'',locationId:u.locationId,version:u.version,projectId})}'
            >Изменить</button></td>
          </tr>`).join('')}
        </tbody></table>`;
    } catch(e) { listEl.innerHTML = `<p class="empty-copy">${e.message}</p>`; }
  }

  // Populate project filter from loaded projects
  async function populateFilter() {
    try {
      const { projects = [] } = await apiFetch('/api/v1/projects');
      filterEl.innerHTML = '<option value="">— Проект —</option>' +
        projects.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    } catch { /* silently skip */ }
  }

  filterEl.addEventListener('change', hydrateUnitRegistry);
  refreshBtn?.addEventListener('click', hydrateUnitRegistry);

  // Inline edit via event delegation
  listEl.addEventListener('click', async e => {
    const btn = e.target.closest('.unit-edit-btn');
    if (!btn) return;
    let u;
    try { u = JSON.parse(btn.dataset.unit); } catch { return; }

    const newCode = prompt('Код unit (макс. 32 символа):', u.code);
    if (!newCode) return;
    const newName = prompt('Название unit (макс. 120 символов):', u.name);
    if (!newName) return;
    const newNotes = prompt('Заметки (макс. 2000):', u.notes);
    if (newNotes === null) return;

    try {
      await apiFetch(
        `/api/v1/projects/${encodeURIComponent(u.projectId)}/locations/${encodeURIComponent(u.locationId)}/units/${encodeURIComponent(u.id)}`,
        { method: 'PATCH', body: JSON.stringify({ code: newCode, name: newName, notes: newNotes, expectedVersion: u.version }) }
      );
      toast('Unit обновлён');
      hydrateUnitRegistry();
    } catch(err) { toast(err.message || 'Ошибка обновления'); }
  });

  // Auto-populate filter when admin section loads
  if (document.body.dataset.route === 'admin') populateFilter();
  document.addEventListener('routeChange', e => { if (e.detail === 'admin') populateFilter(); });
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
  document.getElementById('fromTemplateButton')?.addEventListener('click', openCreateFromTemplate);
  document.getElementById('refreshSessionsBtn')?.addEventListener('click', hydrateSessionsAdmin);
  document.getElementById('addEmailInboxBtn')?.addEventListener('click', async () => {
    const name = prompt('Название инбокса (например: "Поставщик А"):');
    if (!name?.trim()) return;
    const host = prompt('IMAP хост (например: imap.gmail.com):');
    if (!host?.trim()) return;
    const username = prompt('Email адрес / логин:');
    if (!username?.trim()) return;
    const password = prompt('Пароль (будет сохранён в хранилище секретов):');
    const folder = prompt('Папка IMAP:', 'INBOX') || 'INBOX';
    const filterSubject = prompt('Фильтр по теме (оставьте пустым чтобы получать все):') || '';
    const pollInterval = parseInt(prompt('Интервал опроса (минут):', '15') || '15', 10);
    try {
      const r = await apiFetch('/api/v1/admin/email-inboxes', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({
          name: name.trim(), host: host.trim(), username: username.trim(),
          password: password || '', folder, filterSubject,
          pollInterval: isNaN(pollInterval) ? 15 : pollInterval,
          port: 993, useSsl: true,
        }),
      });
      if (!r.ok) { toast(`Ошибка: ${(await r.json()).error?.message||r.status}`); return; }
      toast('Инбокс добавлен'); hydrateEmailInboxes();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
  document.getElementById('saveOrgSettingsBtn')?.addEventListener('click', async () => {
    const el = id => document.getElementById(id);
    const payload = {
      timezone: el('orgTz')?.value.trim() || 'UTC',
      locale: el('orgLocale')?.value.trim() || 'en',
      dateFormat: el('orgDateFormat')?.value.trim() || 'YYYY-MM-DD',
      currency: el('orgCurrency')?.value.trim() || 'USD',
      workWeekStart: parseInt(el('orgWorkWeekStart')?.value || '1', 10),
    };
    try {
      const r = await apiFetch('/api/v1/admin/org-settings', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
      toast('Настройки сохранены');
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
  document.getElementById('addTemplateBtn')?.addEventListener('click', () => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `
      <form method="dialog" style="min-width:320px">
        <h3 style="margin:0 0 16px">Новый шаблон проекта</h3>
        <label style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;font-size:13px">Название
          <input id="tplAdminName" required maxlength="120" style="padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;font-size:13px">Категория
          <select id="tplAdminCategory" style="padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
            <option value="general">General</option>
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
            <option value="data_centre">Data Centre</option>
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;margin-bottom:14px;font-size:13px">Задачи (по одной на строку)
          <textarea id="tplAdminItems" rows="5" placeholder="Обследование объекта&#10;Монтаж кабельной трассы&#10;Пусконаладка" style="padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);resize:vertical;font-family:inherit;font-size:13px"></textarea>
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" id="tplAdminCancelBtn" style="padding:8px 14px">Отмена</button>
          <button type="submit" class="primary-button" style="padding:8px 14px">Сохранить</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('#tplAdminCancelBtn').addEventListener('click', () => { dialog.close(); dialog.remove(); });
    dialog.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const name = dialog.querySelector('#tplAdminName').value.trim();
      const category = dialog.querySelector('#tplAdminCategory').value;
      const items = dialog.querySelector('#tplAdminItems').value
        .split('\n').map(s => s.trim()).filter(Boolean)
        .map(title => ({ title, status: 'backlog', priority: 'medium' }));
      try {
        const r = await apiFetch('/api/v1/templates', {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ name, category, scaffold: { workItems: items } }),
        });
        if (!r.ok) throw new Error((await r.json()).error?.message || r.statusText);
        dialog.close(); dialog.remove();
        toast(`Шаблон "${name}" создан`);
        hydrateTemplatesAdmin();
      } catch(err) { toast(`Ошибка: ${err.message}`); }
    });
  });
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
  setupUnitRegistry();
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
  setupFieldNote();
  setupWebhooks();
  setupAiAgents();
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
setupGlobalSearch();
setupNotificationCenter();
setupProjectFilters();

// PWA service worker registration
// ── Global Search ──────────────────────────────────────────────────────────

// ── Project Templates ─────────────────────────────────────────────────────

let _templates = [];

async function loadTemplates() {
  try {
    const r = await apiFetch('/api/v1/templates');
    const { templates = [] } = await r.json();
    _templates = templates;
    return templates;
  } catch { return []; }
}

// ── Inventory ─────────────────────────────────────────────────────────────────

let _invSelectedWarehouse = null;

async function hydrateInventory() {
  await Promise.all([_loadWarehouses(), _loadPendingCount(), _loadReorderBadge()]);
  _bindInventoryEvents();
}

async function _loadReorderBadge() {
  try {
    const r = await apiFetch('/api/v1/inventory/reorder-requests?status=open');
    const { requests = [] } = await r.json();
    const btn = document.getElementById('invReorderBtn');
    if (btn) {
      const count = requests.length;
      btn.textContent = count > 0 ? `Заявки на пополнение (${count})` : 'Заявки на пополнение';
      btn.style.color = count > 0 ? '#e8a84c' : '';
    }
  } catch { /* silent */ }
}

async function _loadWarehouses() {
  const list = document.getElementById('warehouseList');
  if (!list) return;
  try {
    const r = await apiFetch('/api/v1/inventory/warehouses');
    const { warehouses = [] } = await r.json();
    if (!warehouses.length) {
      list.innerHTML = '<p class="empty-copy" style="font-size:12px">Нет складов.</p>';
      return;
    }
    list.innerHTML = warehouses.map(w => `
      <button type="button" class="button ghost" style="width:100%;justify-content:flex-start;font-size:12px;${_invSelectedWarehouse===w.id?'background:rgba(79,142,247,.15);':''}" data-wh-id="${w.id}">
        🏭 ${escapeHtml(w.name)}
        <small style="display:block;color:var(--text-muted);font-size:10px">${escapeHtml(w.location||'')}</small>
      </button>`).join('');
    list.querySelectorAll('[data-wh-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        _invSelectedWarehouse = btn.dataset.whId;
        _loadWarehouses();
        _loadStock(_invSelectedWarehouse);
      });
    });
    if (_invSelectedWarehouse) _loadStock(_invSelectedWarehouse);
  } catch { list.innerHTML = '<p class="empty-copy" style="font-size:12px">Ошибка.</p>'; }
}

async function _loadStock(warehouseId) {
  const table = document.getElementById('inventoryStockTable');
  if (!table) return;
  table.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
  try {
    const r = await apiFetch(`/api/v1/inventory/stock?warehouseId=${warehouseId}`);
    const { stock = [] } = await r.json();
    if (!stock.length) {
      table.innerHTML = '<p class="empty-copy" style="font-size:13px">Нет остатков на этом складе.</p>'; return;
    }
    table.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--text-muted);text-align:left">
        <th style="padding:6px 8px">SKU</th><th style="padding:6px 8px">Наименование</th>
        <th style="padding:6px 8px">Кол-во</th><th style="padding:6px 8px">Уровень</th>
        <th style="padding:6px 8px">Ед.</th><th style="padding:6px 8px">Бин</th><th style="padding:6px 8px"></th>
      </tr></thead>
      <tbody>${stock.map(s => {
        const pct = s.min_quantity > 0 ? Math.min(100, Math.round(s.quantity / s.min_quantity * 100)) : null;
        const barColor = pct === null ? '#4f8ef7' : pct <= 50 ? '#f46' : pct <= 100 ? '#e8a84c' : '#3bb969';
        const barW = pct === null ? 60 : Math.min(100, Math.max(4, pct));
        const barHtml = `<div style="height:6px;border-radius:3px;background:var(--border);width:60px;overflow:hidden">
          <div style="height:100%;width:${barW}%;background:${barColor};border-radius:3px"></div></div>
          ${pct !== null ? `<span style="font-size:9px;color:${barColor}">${pct}%</span>` : ''}`;
        return `<tr style="border-top:1px solid var(--border)${s.belowMin?';background:rgba(255,68,68,.05)':''}">
        <td style="padding:7px 8px;font-family:monospace">${escapeHtml(s.sku_code)}</td>
        <td style="padding:7px 8px"><strong>${escapeHtml(s.sku_name)}</strong></td>
        <td style="padding:7px 8px"><strong style="color:${s.belowMin?'#f46':'inherit'}">${s.quantity}</strong>${s.belowMin?'<span style="font-size:10px;color:#f46;margin-left:4px">⚠</span>':''}</td>
        <td style="padding:7px 8px">${barHtml}</td>
        <td style="padding:7px 8px;color:var(--text-muted)">${escapeHtml(s.unit)}</td>
        <td style="padding:7px 8px;color:var(--text-muted)">${escapeHtml(s.location_bin||'—')}</td>
        <td style="padding:7px 8px;display:flex;gap:4px">
          <button type="button" class="text-button" style="font-size:11px" data-quick-mv="${s.sku_id}" data-sku-name="${escapeHtml(s.sku_name)}">＋/−</button>
          <button type="button" class="text-button" style="font-size:11px;color:var(--text-muted)" data-stock-settings="${s.sku_id}" data-min-qty="${s.min_quantity??''}" data-bin="${escapeHtml(s.location_bin||'')}">⚙</button>
        </td>
      </tr>`;}).join('')}</tbody>
    </table>`;
    table.querySelectorAll('[data-quick-mv]').forEach(btn => {
      btn.addEventListener('click', () => _quickMovement(warehouseId, btn.dataset.quickMv, btn.dataset.skuName));
    });
    table.querySelectorAll('[data-stock-settings]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const skuId = btn.dataset.stockSettings;
        const curMin = btn.dataset.minQty;
        const curBin = btn.dataset.bin;
        const minQtyStr = prompt('Минимальный остаток (порог оповещения):', curMin);
        if (minQtyStr === null) return;
        const locationBin = prompt('Расположение на складе (бин/полка):', curBin);
        if (locationBin === null) return;
        const minQty = minQtyStr === '' ? null : parseFloat(minQtyStr);
        try {
          const r2 = await apiFetch('/api/v1/inventory/stock-settings', {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ warehouseId, skuId, minQuantity: minQty, locationBin }),
          });
          if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
          toast('Настройки обновлены'); _loadStock(warehouseId);
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
  } catch { table.innerHTML = '<p class="empty-copy">Ошибка загрузки.</p>'; }
}

async function _quickMovement(warehouseId, skuId, skuName) {
  const typeMap = { '1':'receive','2':'issue','3':'adjustment','4':'return','5':'loss' };
  const choice = prompt(`Движение для "${skuName}":\n1 — Приход\n2 — Расход\n3 — Корректировка\n4 — Возврат\n5 — Списание`);
  const movementType = typeMap[choice?.trim()||''];
  if (!movementType) return;
  const qty = parseFloat(prompt('Количество:') || '0');
  if (!qty || isNaN(qty)) return;
  const ref = prompt('Ссылка / номер документа (опционально):') || '';
  try {
    const r = await apiFetch('/api/v1/inventory/movements', {
      method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
      body: JSON.stringify({ warehouseId, skuId, movementType, quantity: qty, reference: ref }),
    });
    if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
    toast(`${movementType} записан`);
    _loadStock(warehouseId);
  } catch(e) { toast(`Ошибка: ${e.message}`); }
}

async function _loadPendingCount() {
  try {
    const r = await apiFetch('/api/v1/inventory/pending?status=pending');
    const { pending = [] } = await r.json();
    const badge = document.getElementById('pendingBadge');
    if (badge) { badge.textContent = pending.length; badge.style.display = pending.length ? '' : 'none'; }
  } catch { /* silent */ }
}

async function _loadPendingList() {
  const list = document.getElementById('inventoryPendingList');
  if (!list) return;
  list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
  try {
    const r = await apiFetch('/api/v1/inventory/pending?status=pending');
    const { pending = [] } = await r.json();
    if (!pending.length) { list.innerHTML = '<p class="empty-copy">Нет ожидающих подтверждения.</p>'; return; }
    list.innerHTML = pending.map(p => `
      <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div>
            <p class="eyebrow" style="margin:0">${escapeHtml(p.source.toUpperCase())} · ${(p.created_at||'').slice(0,16).replace('T',' ')}</p>
            <p style="font-size:12px;color:var(--text-muted);margin:4px 0 8px;max-width:600px">${escapeHtml((p.raw_input||'').slice(0,200))}</p>
            ${p.ai_confidence != null ? `<span style="font-size:11px;color:var(--text-muted)">Уверенность AI: ${Math.round(p.ai_confidence*100)}%</span>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button type="button" class="button ghost" style="font-size:11px" data-approve="${p.id}">✓ Подтвердить</button>
            <button type="button" class="button ghost" style="font-size:11px;color:#f46" data-reject="${p.id}">✕ Отклонить</button>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
          ${(p.suggested_movements||[]).map((mv,i) => `
            <span style="font-size:11px;padding:3px 8px;border-radius:8px;background:rgba(79,142,247,.1);color:var(--accent)">
              ${mv.movementType||'?'} ${mv.quantity||'?'} ${mv.sku_code_guess||mv.skuId||'?'}
              ${mv.skuId ? '' : '<span style="color:#e8a84c"> ⚠ не найден</span>'}
            </span>`).join('')}
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-approve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const r2 = await apiFetch(`/api/v1/inventory/pending/${btn.dataset.approve}/approve`, {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ reviewer: 'user' }),
          });
          const res = await r2.json();
          toast(`Применено: ${res.applied}, ошибок: ${res.errors?.length||0}`);
          _loadPendingList(); _loadPendingCount();
          if (_invSelectedWarehouse) _loadStock(_invSelectedWarehouse);
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
    list.querySelectorAll('[data-reject]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/v1/inventory/pending/${btn.dataset.reject}/reject`, {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ reviewer: 'user' }),
          });
          toast('Отклонено'); _loadPendingList(); _loadPendingCount();
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
  } catch { list.innerHTML = '<p class="empty-copy">Ошибка загрузки.</p>'; }
}

async function _loadSkuCatalog() {
  const list = document.getElementById('inventorySkuList');
  if (!list) return;
  list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
  try {
    const r = await apiFetch('/api/v1/inventory/skus');
    const { skus = [] } = await r.json();
    if (!skus.length) { list.innerHTML = '<p class="empty-copy">Нет SKU в каталоге.</p>'; return; }
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--text-muted);text-align:left">
        <th style="padding:6px 8px">Код</th><th style="padding:6px 8px">Наименование</th>
        <th style="padding:6px 8px">Категория</th><th style="padding:6px 8px">Ед.</th>
        <th style="padding:6px 8px">Цена</th><th style="padding:6px 8px">Штрих-код</th><th style="padding:6px 8px"></th>
      </tr></thead>
      <tbody>${skus.map(s => `<tr style="border-top:1px solid var(--border)">
        <td style="padding:7px 8px;font-family:monospace">${escapeHtml(s.sku_code)}</td>
        <td style="padding:7px 8px"><strong>${escapeHtml(s.name)}</strong></td>
        <td style="padding:7px 8px;color:var(--text-muted)">${escapeHtml(s.category)}</td>
        <td style="padding:7px 8px;color:var(--text-muted)">${escapeHtml(s.unit)}</td>
        <td style="padding:7px 8px;color:var(--text-muted)">${s.unit_cost != null ? `${s.unit_cost} ${s.currency||''}` : '—'}</td>
        <td style="padding:7px 8px;color:var(--text-muted);font-size:10px;font-family:monospace">${escapeHtml(s.barcode||'')}</td>
        <td style="padding:7px 8px;white-space:nowrap;display:flex;gap:4px">
          <button class="text-button" data-sku-edit="${s.id}"
            data-sku-code="${escapeHtml(s.sku_code)}" data-sku-name="${escapeHtml(s.name)}"
            data-sku-cat="${escapeHtml(s.category)}" data-sku-unit="${escapeHtml(s.unit)}"
            data-sku-cost="${s.unit_cost??''}" data-sku-cur="${escapeHtml(s.currency||'USD')}"
            data-sku-barcode="${escapeHtml(s.barcode||'')}"
            style="font-size:11px">✏</button>
          <button class="text-button" data-sku-label="${s.id}" style="font-size:11px" title="Печать этикетки">🏷</button>
          <button class="text-button" data-sku-del="${s.id}" style="font-size:11px;color:var(--text-muted)">✕</button>
        </td>
      </tr>`).join('')}</tbody>
    </table>`;
    list.querySelectorAll('[data-sku-edit]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.skuEdit;
        const name = prompt('Наименование:', btn.dataset.skuName);
        if (name === null) return;
        const skuCode = prompt('Код SKU:', btn.dataset.skuCode);
        if (skuCode === null) return;
        const category = prompt('Категория:', btn.dataset.skuCat) ?? btn.dataset.skuCat;
        const unit = prompt('Единица измерения:', btn.dataset.skuUnit) ?? btn.dataset.skuUnit;
        const costStr = prompt('Цена за единицу (пусто = нет):', btn.dataset.skuCost);
        const currency = prompt('Валюта:', btn.dataset.skuCur) ?? 'USD';
        const barcode = prompt('Штрих-код / EAN (пусто = нет):', btn.dataset.skuBarcode ?? '') ?? '';
        const unitCost = costStr?.trim() ? parseFloat(costStr) : null;
        try {
          const r = await apiFetch(`/api/v1/inventory/skus/${id}/update`, {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ name, skuCode, category, unit, unitCost, currency, barcode }),
          });
          if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
          toast('SKU обновлён'); _loadSkuCatalog();
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
    list.querySelectorAll('[data-sku-label]').forEach(btn => {
      btn.addEventListener('click', () => {
        window.open(`/api/v1/inventory/skus/${btn.dataset.skuLabel}/label`, '_blank', 'width=400,height=300');
      });
    });

    list.querySelectorAll('[data-sku-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить SKU (деактивировать)?')) return;
        try {
          const r = await apiFetch(`/api/v1/inventory/skus/${btn.dataset.skuDel}/delete`, {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
            body: '{}',
          });
          if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
          toast('SKU удалён'); _loadSkuCatalog();
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
  } catch { list.innerHTML = '<p class="empty-copy">Ошибка.</p>'; }
}

function _bindInventoryEvents() {
  // Add warehouse
  document.getElementById('invAddWarehouseBtn')?.addEventListener('click', async () => {
    const name = prompt('Название склада:');
    if (!name?.trim()) return;
    const location = prompt('Адрес / расположение:') || '';
    try {
      const r = await apiFetch('/api/v1/inventory/warehouses', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ name: name.trim(), location }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
      toast('Склад создан'); _loadWarehouses();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
  // Pending panel
  document.getElementById('invPendingBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('inventoryPendingPanel');
    const skuPanel = document.getElementById('inventorySkuPanel');
    if (panel) { panel.style.display = panel.style.display === 'none' ? '' : 'none'; _loadPendingList(); }
    if (skuPanel) skuPanel.style.display = 'none';
  });
  document.getElementById('invPendingCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('inventoryPendingPanel'); if (p) p.style.display = 'none';
  });

  // Movement history panel
  const _MT_LABELS = { receive:'Приход', issue:'Расход', transfer:'Перемещение',
    adjustment:'Корректировка', return:'Возврат', loss:'Списание' };
  const _MT_COLORS = { receive:'#4adc84', issue:'#f46', transfer:'#4f8ef7',
    adjustment:'#e8a84c', return:'#a78bfa', loss:'#e05353' };

  async function _loadMovementSparkline() {
    const el = document.getElementById('invMovementSparkline');
    if (!el) return;
    const whParam = _invSelectedWarehouse ? `?warehouseId=${_invSelectedWarehouse}` : '';
    try {
      const { days = [] } = await apiFetch(`/api/v1/inventory/movements-summary${whParam}&days=14`).then(r => r.json());
      if (!days.length) { el.innerHTML = ''; return; }
      const maxVal = Math.max(...days.flatMap(d => [d.receive||0, d.issue||0]));
      const W = 340, H = 50, PAD = 4;
      const bw = (W - PAD*2) / (days.length * 2 + days.length - 1);
      const bars = days.map((d, i) => {
        const x = PAD + i * (bw * 3);
        const rh = maxVal > 0 ? (d.receive||0) / maxVal * (H - PAD*2) : 0;
        const ih = maxVal > 0 ? (d.issue||0) / maxVal * (H - PAD*2) : 0;
        return `<rect x="${x.toFixed(1)}" y="${(H - PAD - rh).toFixed(1)}" width="${bw.toFixed(1)}" height="${rh.toFixed(1)}" fill="#4adc84" opacity=".7" rx="1"/>
                <rect x="${(x+bw+1).toFixed(1)}" y="${(H - PAD - ih).toFixed(1)}" width="${bw.toFixed(1)}" height="${ih.toFixed(1)}" fill="#f46" opacity=".7" rx="1"/>
                <text x="${(x + bw).toFixed(1)}" y="${H}" fill="#445" font-size="7" text-anchor="middle">${d.date.slice(5)}</text>`;
      }).join('');
      el.innerHTML = `<svg viewBox="0 0 ${W} ${H+8}" style="width:100%;height:58px;overflow:visible">
        ${bars}
        <rect x="0" y="6" width="10" height="8" fill="#4adc84" opacity=".7" rx="1"/>
        <text x="13" y="14" fill="#778" font-size="9">приход</text>
        <rect x="60" y="6" width="10" height="8" fill="#f46" opacity=".7" rx="1"/>
        <text x="73" y="14" fill="#778" font-size="9">расход</text>
      </svg>`;
    } catch { el.innerHTML = ''; }
  }

  async function _loadHistory() {
    const list = document.getElementById('inventoryHistoryList');
    if (!list) return;
    list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    const typeFilter = document.getElementById('invHistoryTypeFilter')?.value || '';
    const whParam = _invSelectedWarehouse ? `&warehouseId=${_invSelectedWarehouse}` : '';
    const typeParam = typeFilter ? `&type=${typeFilter}` : '';
    _loadMovementSparkline();
    try {
      const r = await apiFetch(`/api/v1/inventory/movements?limit=200${whParam}${typeParam}`);
      const { movements = [] } = await r.json();
      if (!movements.length) {
        list.innerHTML = '<p class="empty-copy" style="font-size:13px">Нет движений.</p>'; return;
      }
      list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="color:var(--text-muted);text-align:left">
          <th style="padding:6px 8px">Дата</th>
          <th style="padding:6px 8px">Тип</th>
          <th style="padding:6px 8px">SKU</th>
          <th style="padding:6px 8px">Кол-во</th>
          <th style="padding:6px 8px">Склад</th>
          <th style="padding:6px 8px">Ссылка</th>
          <th style="padding:6px 8px">Источник</th>
        </tr></thead>
        <tbody>${movements.map(m => {
          const color = _MT_COLORS[m.movement_type] || '#8b95a5';
          const qty = m.quantity > 0 ? `+${m.quantity}` : String(m.quantity);
          return `<tr style="border-top:1px solid var(--border)">
            <td style="padding:6px 8px;color:var(--text-muted);white-space:nowrap;font-size:11px">${(m.created_at||'').slice(0,16).replace('T',' ')}</td>
            <td style="padding:6px 8px">
              <span style="font-size:10px;padding:2px 7px;border-radius:8px;background:${color}22;color:${color};font-weight:600">${_MT_LABELS[m.movement_type]||m.movement_type}</span>
            </td>
            <td style="padding:6px 8px">
              <strong style="font-size:11px">${escapeHtml(m.sku_name||m.sku_id)}</strong>
              <span style="font-size:10px;font-family:monospace;color:var(--text-muted);margin-left:4px">${escapeHtml(m.sku_code||'')}</span>
            </td>
            <td style="padding:6px 8px;font-weight:700;color:${color}">${qty} ${escapeHtml(m.unit||'')}</td>
            <td style="padding:6px 8px;color:var(--text-muted);font-size:11px">${escapeHtml(m.warehouse_name||'')}</td>
            <td style="padding:6px 8px;color:var(--text-muted);font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.reference||'—')}</td>
            <td style="padding:6px 8px;font-size:10px;color:var(--text-muted)">${escapeHtml(m.source||'')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    } catch { list.innerHTML = '<p class="empty-copy">Ошибка загрузки.</p>'; }
  }

  function _closeAllInvPanels() {
    ['inventoryPendingPanel','inventoryHistoryPanel','inventoryReorderPanel','inventorySkuPanel','inventorySuppliersPanel','inventoryLowStockPanel','inventoryMinQtyPanel','inventoryReconcilePanel','inventoryAnalyticsPanel']
      .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  }

  async function _loadInventoryAnalytics() {
    const el = document.getElementById('inventoryAnalyticsContent');
    if (!el) return;
    el.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    const whParam = _invSelectedWarehouse ? `?warehouseId=${_invSelectedWarehouse}` : '';
    try {
      const { byCategory = [], topMoving = [] } = await apiFetch(`/api/v1/inventory/analytics${whParam}`).then(r => r.json());
      const totalValue = byCategory.reduce((s, c) => s + (c.total_value || 0), 0);
      const CAT_PALETTE = ['#4f8ef7','#4adc84','#e8a84c','#a78bfa','#f46','#22d3ee','#e05353','#f0f'];
      el.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px">
          <div>
            <p style="font-size:11px;font-weight:700;color:var(--accent);letter-spacing:.08em;margin:0 0 10px">ПО КАТЕГОРИЯМ</p>
            ${byCategory.length ? byCategory.map((c, i) => {
              const pct = totalValue > 0 ? Math.round((c.total_value || 0) / totalValue * 100) : 0;
              const color = CAT_PALETTE[i % CAT_PALETTE.length];
              return `<div style="margin-bottom:8px">
                <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                  <span style="font-size:12px">${escapeHtml(c.category || 'Без категории')}</span>
                  <span style="font-size:11px;color:var(--text-muted)">${(c.total_value||0).toLocaleString()} · ${pct}%</span>
                </div>
                <div style="height:5px;border-radius:3px;background:var(--border)">
                  <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width .3s"></div>
                </div>
                <div style="font-size:10px;color:var(--text-muted);margin-top:1px">${c.sku_count} SKU · ${(c.total_qty||0).toFixed(1)} ед.</div>
              </div>`;
            }).join('') : '<p class="empty-copy" style="font-size:12px">Нет данных</p>'}
          </div>
          <div>
            <p style="font-size:11px;font-weight:700;color:var(--accent);letter-spacing:.08em;margin:0 0 10px">ТОП-5 ДВИЖЕНИЙ (30 дней)</p>
            ${topMoving.length ? topMoving.map((s, i) => `
              <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
                <span style="font-size:11px;color:var(--text-muted);width:16px;text-align:right">${i+1}</span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.name)}</div>
                  <div style="font-size:10px;font-family:monospace;color:var(--text-muted)">${escapeHtml(s.sku_code)}</div>
                </div>
                <span style="font-size:12px;font-weight:700;color:#f46">${(s.total_moved||0).toFixed(1)}</span>
              </div>`).join('') : '<p class="empty-copy" style="font-size:12px">Нет движений за 30 дней</p>'}
          </div>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin:0">Итого стоимость запасов: <strong>${totalValue.toLocaleString()}</strong></p>`;
    } catch(e) { el.innerHTML = `<p class="empty-copy">${e.message}</p>`; }
  }

  document.getElementById('invAnalyticsBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('inventoryAnalyticsPanel');
    const wasHidden = panel?.style.display === 'none' || !panel?.style.display;
    _closeAllInvPanels();
    if (wasHidden && panel) { panel.style.display = ''; _loadInventoryAnalytics(); }
  });
  document.getElementById('invAnalyticsCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('inventoryAnalyticsPanel'); if (p) p.style.display = 'none';
  });
  document.getElementById('invAnalyticsRefreshBtn')?.addEventListener('click', _loadInventoryAnalytics);

  async function _loadReconcileList() {
    const list = document.getElementById('inventoryReconcileList');
    const detail = document.getElementById('inventoryReconcileDetail');
    if (!list) return;
    detail.style.display = 'none'; detail.innerHTML = '';
    list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    const whParam = _invSelectedWarehouse ? `?warehouseId=${_invSelectedWarehouse}` : '';
    try {
      const { reconciliations = [] } = await apiFetch(`/api/v1/inventory/reconciliations${whParam}`).then(r => r.json());
      if (!reconciliations.length) {
        list.innerHTML = '<p class="empty-copy" style="font-size:13px">Инвентаризаций нет. Создайте первую.</p>'; return;
      }
      const ST_COLORS = {draft:'#778',in_progress:'#4f8ef7',completed:'#4adc84',cancelled:'#f46'};
      const ST_LABELS = {draft:'Черновик',in_progress:'В процессе',completed:'Завершена',cancelled:'Отменена'};
      list.innerHTML = reconciliations.map(r => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer"
          data-recon-id="${r.id}">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600">${escapeHtml(r.warehouse_name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${r.started_at.slice(0,10)} · ${escapeHtml(r.counted_by||'—')}</div>
          </div>
          <span style="font-size:11px;padding:2px 8px;border-radius:8px;background:${ST_COLORS[r.status]}22;color:${ST_COLORS[r.status]}">${ST_LABELS[r.status]||r.status}</span>
        </div>`).join('');
      list.querySelectorAll('[data-recon-id]').forEach(el => {
        el.addEventListener('click', () => _openReconcileDetail(el.dataset.reconId));
      });
    } catch(e) { list.innerHTML = `<p class="empty-copy">${e.message}</p>`; }
  }

  async function _openReconcileDetail(reconId) {
    const detail = document.getElementById('inventoryReconcileDetail');
    if (!detail) return;
    detail.style.display = 'block';
    detail.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    try {
      const { reconciliation: r } = await apiFetch(`/api/v1/inventory/reconciliations/${reconId}`).then(resp => resp.json());
      const isOpen = r.status === 'draft' || r.status === 'in_progress';
      detail.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <p style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--accent);margin:0">СВЕРКА · ${r.warehouse_name}</p>
            <p style="font-size:12px;color:var(--text-muted);margin:2px 0 0">${r.started_at.slice(0,16).replace('T',' ')} · ${r.counted_by||'—'}</p>
          </div>
          ${isOpen ? `<button class="button primary" id="completeReconBtn" style="font-size:12px">✓ Завершить и применить</button>` : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="color:var(--text-muted);text-align:left">
            <th style="padding:6px 8px">SKU</th>
            <th style="padding:6px 8px">Наименование</th>
            <th style="padding:6px 8px;text-align:right">Учётный</th>
            <th style="padding:6px 8px;text-align:right">${isOpen ? 'Факт (введите)' : 'Фактический'}</th>
            <th style="padding:6px 8px;text-align:right">Расхождение</th>
          </tr></thead>
          <tbody>${r.lines.map(l => {
            const v = l.variance;
            const vc = v === null ? '#778' : v > 0 ? '#4adc84' : v < 0 ? '#f46' : '#778';
            return `<tr style="border-top:1px solid var(--border)" data-line-sku="${l.sku_id}">
              <td style="padding:6px 8px;font-family:monospace;font-size:11px;color:var(--text-muted)">${escapeHtml(l.sku_code)}</td>
              <td style="padding:6px 8px">${escapeHtml(l.sku_name)}</td>
              <td style="padding:6px 8px;text-align:right">${l.system_quantity} ${escapeHtml(l.unit||'')}</td>
              <td style="padding:6px 8px;text-align:right">
                ${isOpen
                  ? `<input type="number" min="0" step="0.001" class="recon-count-inp" data-sku="${l.sku_id}"
                      value="${l.counted_quantity??''}" placeholder="—" data-recon-id="${reconId}"
                      style="width:80px;padding:3px 6px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px;text-align:right">`
                  : `${l.counted_quantity??'—'} ${escapeHtml(l.unit||'')}`}
              </td>
              <td style="padding:6px 8px;text-align:right;font-weight:700;color:${vc}">${v===null ? '—' : (v>0?'+':'')+v.toFixed(3)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`;

      if (isOpen) {
        let _saveTimer = null;
        detail.querySelectorAll('.recon-count-inp').forEach(inp => {
          inp.addEventListener('change', async () => {
            clearTimeout(_saveTimer);
            _saveTimer = setTimeout(async () => {
              const qty = inp.value === '' ? null : parseFloat(inp.value);
              await apiFetch(`/api/v1/inventory/reconciliations/${reconId}`, {
                method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
                body: JSON.stringify({ skuId: inp.dataset.sku, countedQuantity: qty }),
              }).catch(() => {});
            }, 600);
          });
        });
        detail.querySelector('#completeReconBtn')?.addEventListener('click', async () => {
          if (!confirm('Применить расхождения как корректировки склада?')) return;
          try {
            await apiFetch(`/api/v1/inventory/reconciliations/${reconId}`, {
              method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
              body: JSON.stringify({ action: 'complete' }),
            });
            toast('Инвентаризация завершена, корректировки применены');
            _openReconcileDetail(reconId);
            _loadStock(_invSelectedWarehouse);
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        });
      }
    } catch(e) { detail.innerHTML = `<p class="empty-copy">${e.message}</p>`; }
  }

  document.getElementById('invReconcileBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('inventoryReconcilePanel');
    const wasHidden = panel?.style.display === 'none' || !panel?.style.display;
    _closeAllInvPanels();
    if (wasHidden && panel) { panel.style.display = ''; _loadReconcileList(); }
  });
  document.getElementById('invReconcileCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('inventoryReconcilePanel'); if (p) p.style.display = 'none';
  });
  document.getElementById('invReconcileNewBtn')?.addEventListener('click', async () => {
    const wh = _invSelectedWarehouse;
    if (!wh) { toast('Выберите склад для инвентаризации'); return; }
    const note = prompt('Примечание к инвентаризации (пусто = нет):') ?? '';
    const countedBy = prompt('ФИО / имя ответственного:') ?? '';
    try {
      const r = await apiFetch('/api/v1/inventory/reconciliations', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ warehouseId: wh, note, countedBy }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
      const { reconciliation } = await r.json();
      toast('Инвентаризация создана');
      _loadReconcileList();
      setTimeout(() => _openReconcileDetail(reconciliation.id), 300);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });

  document.getElementById('invHistoryBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('inventoryHistoryPanel');
    const wasHidden = panel?.style.display === 'none' || !panel?.style.display;
    _closeAllInvPanels();
    if (wasHidden && panel) { panel.style.display = ''; _loadHistory(); }
  });
  document.getElementById('invHistoryCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('inventoryHistoryPanel'); if (p) p.style.display = 'none';
  });
  document.getElementById('invHistoryTypeFilter')?.addEventListener('change', _loadHistory);

  // Reorder requests panel
  const _RO_STATUS = { open:'Открыта', ordered:'Заказана', received:'Получена', cancelled:'Отменена' };
  const _RO_COLORS = { open:'#e8a84c', ordered:'#4f8ef7', received:'#4adc84', cancelled:'#8b95a5' };

  async function _loadReorders() {
    const list = document.getElementById('inventoryReorderList');
    if (!list) return;
    list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    const status = document.getElementById('invReorderStatusFilter')?.value || 'open';
    try {
      const r = await apiFetch(`/api/v1/inventory/reorder-requests?status=${status}`);
      const { requests = [] } = await r.json();
      if (!requests.length) {
        list.innerHTML = '<p class="empty-copy" style="font-size:13px">Нет заявок.</p>'; return;
      }
      list.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">
        ${requests.map(req => {
          const color = _RO_COLORS[req.status] || '#8b95a5';
          const actions = req.status === 'open'
            ? `<button data-ro-id="${req.id}" data-ro-action="ordered" class="text-button" style="font-size:10px">Заказано</button>
               <button data-ro-id="${req.id}" data-ro-action="cancelled" class="text-button" style="font-size:10px;color:var(--text-muted)">Отменить</button>`
            : req.status === 'ordered'
            ? `<button data-ro-id="${req.id}" data-ro-action="received" class="text-button" style="font-size:10px;color:#4adc84">Получено ✓</button>`
            : '';
          return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:flex-start;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <strong style="font-size:12px">${escapeHtml(req.sku_name)}</strong>
                <code style="font-size:10px;color:var(--text-muted)">${escapeHtml(req.sku_code)}</code>
                <span style="font-size:10px;padding:2px 7px;border-radius:8px;background:${color}22;color:${color}">${_RO_STATUS[req.status]||req.status}</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
                ${escapeHtml(req.warehouse_name)} · ${req.quantity} ${escapeHtml(req.unit||'')}
                ${req.unit_cost ? ` · ${req.unit_cost} ×${req.quantity} = ${(req.unit_cost*req.quantity).toFixed(2)}` : ''}
                ${req.supplier_ref ? ` · ${escapeHtml(req.supplier_ref)}` : ''}
              </div>
              ${req.note ? `<div style="font-size:11px;color:var(--text-muted)">${escapeHtml(req.note)}</div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end">${actions}</div>
          </div>`;
        }).join('')}
      </div>`;
      list.querySelectorAll('[data-ro-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const r2 = await apiFetch(`/api/v1/inventory/reorder-requests/${btn.dataset.roId}/${btn.dataset.roAction}`, {
              method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: '{}',
            });
            if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
            const label = { ordered:'Статус: заказано', received:'Получено — остатки обновлены', cancelled:'Заявка отменена' };
            toast(label[btn.dataset.roAction] || 'Обновлено');
            _loadReorders();
            if (btn.dataset.roAction === 'received' && _invSelectedWarehouse) _loadStock(_invSelectedWarehouse);
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        });
      });
    } catch { list.innerHTML = '<p class="empty-copy">Ошибка загрузки.</p>'; }
  }

  document.getElementById('invReorderBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('inventoryReorderPanel');
    const wasHidden = panel?.style.display === 'none' || !panel?.style.display;
    _closeAllInvPanels();
    if (wasHidden && panel) { panel.style.display = ''; _loadReorders(); }
  });
  document.getElementById('invReorderCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('inventoryReorderPanel'); if (p) p.style.display = 'none';
  });
  document.getElementById('invReorderStatusFilter')?.addEventListener('change', _loadReorders);

  // ── Suppliers panel ────────────────────────────────────────────────────────
  async function _loadSuppliers() {
    const list = document.getElementById('inventorySuppliersList');
    if (!list) return;
    list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    try {
      const r = await apiFetch('/api/v1/inventory/suppliers');
      const { suppliers = [] } = await r.json();
      if (!suppliers.length) {
        list.innerHTML = '<p class="empty-copy">Нет поставщиков. Нажмите ＋ Добавить.</p>'; return;
      }
      list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:6px 8px;text-align:left">Наименование</th>
          <th style="padding:6px 8px;text-align:left">Контакт</th>
          <th style="padding:6px 8px;text-align:left">Email</th>
          <th style="padding:6px 8px;text-align:left">Телефон</th>
          <th style="padding:6px 8px"></th>
        </tr></thead>
        <tbody>${suppliers.map(s => `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:7px 8px;font-weight:600">${escapeHtml(s.name)}</td>
          <td style="padding:7px 8px;color:var(--text-muted)">${escapeHtml(s.contact_name||'—')}</td>
          <td style="padding:7px 8px;color:var(--text-muted)">${s.email ? `<a href="mailto:${escapeHtml(s.email)}" style="color:var(--accent)">${escapeHtml(s.email)}</a>` : '—'}</td>
          <td style="padding:7px 8px;color:var(--text-muted)">${escapeHtml(s.phone||'—')}</td>
          <td style="padding:7px 8px;white-space:nowrap;display:flex;gap:4px">
            <button class="text-button" data-sup-edit="${s.id}"
              data-sup-name="${escapeHtml(s.name)}" data-sup-contact="${escapeHtml(s.contact_name||'')}"
              data-sup-email="${escapeHtml(s.email||'')}" data-sup-phone="${escapeHtml(s.phone||'')}"
              data-sup-address="${escapeHtml(s.address||'')}" data-sup-note="${escapeHtml(s.note||'')}"
              style="font-size:11px">✏</button>
            <button class="text-button" data-sup-del="${s.id}" style="font-size:11px;color:var(--text-muted)">✕</button>
          </td>
        </tr>`).join('')}</tbody>
      </table>`;
      list.querySelectorAll('[data-sup-edit]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.supEdit;
          const name = prompt('Наименование:', btn.dataset.supName); if (name === null) return;
          const contactName = prompt('Контактное лицо:', btn.dataset.supContact) ?? '';
          const email = prompt('Email:', btn.dataset.supEmail) ?? '';
          const phone = prompt('Телефон:', btn.dataset.supPhone) ?? '';
          const address = prompt('Адрес:', btn.dataset.supAddress) ?? '';
          const note = prompt('Заметки:', btn.dataset.supNote) ?? '';
          try {
            const r = await apiFetch(`/api/v1/inventory/suppliers/${id}/update`, {
              method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
              body: JSON.stringify({ name, contactName, email, phone, address, note }),
            });
            if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
            toast('Поставщик обновлён'); _loadSuppliers();
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        });
      });
      list.querySelectorAll('[data-sup-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Удалить поставщика?')) return;
          try {
            const r = await apiFetch(`/api/v1/inventory/suppliers/${btn.dataset.supDel}/delete`, {
              method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
              body: JSON.stringify({}),
            });
            if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
            toast('Поставщик удалён'); _loadSuppliers();
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        });
      });
    } catch { list.innerHTML = '<p class="empty-copy">Ошибка загрузки.</p>'; }
  }

  async function _quickMovementTyped(movementType) {
    if (!_invSelectedWarehouse) {
      toast('Выберите склад из списка'); return;
    }
    const skuSearch = prompt(`SKU — введите код или название для ${movementType === 'receive' ? 'приёма' : 'расхода'}:`);
    if (!skuSearch?.trim()) return;
    try {
      const r = await apiFetch(`/api/v1/inventory/skus?q=${encodeURIComponent(skuSearch.trim())}`);
      const { skus = [] } = await r.json();
      if (!skus.length) { toast('SKU не найден'); return; }
      let skuId, skuName;
      if (skus.length === 1) {
        skuId = skus[0].id; skuName = skus[0].name;
      } else {
        const choices = skus.slice(0,8).map((s,i) => `${i+1} — [${s.sku_code}] ${s.name}`).join('\n');
        const pick = prompt(`Выберите SKU (номер):\n${choices}`, '1');
        const idx = parseInt(pick||'0') - 1;
        if (idx < 0 || idx >= skus.length) return;
        skuId = skus[idx].id; skuName = skus[idx].name;
      }
      const qty = parseFloat(prompt(`Количество для "${skuName}":`) || '0');
      if (!qty || isNaN(qty) || qty <= 0) return;
      const ref = prompt('Ссылка / документ (опционально):') || '';
      const note = prompt('Примечание (опционально):') || '';
      const r2 = await apiFetch('/api/v1/inventory/movements', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ warehouseId: _invSelectedWarehouse, skuId, movementType, quantity: qty, reference: ref, note }),
      });
      if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
      toast(`✓ ${movementType === 'receive' ? 'Принято' : 'Списано'}: ${qty} × ${skuName}`);
      _loadStock(_invSelectedWarehouse);
      _loadReorderBadge();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  }

  document.getElementById('invQuickReceiveBtn')?.addEventListener('click', () => _quickMovementTyped('receive'));
  document.getElementById('invQuickIssueBtn')?.addEventListener('click', () => _quickMovementTyped('issue'));
  document.getElementById('invWriteOffBtn')?.addEventListener('click', () => _quickMovementTyped('loss'));

  document.getElementById('invSuppliersBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('inventorySuppliersPanel');
    const wasHidden = panel?.style.display === 'none' || !panel?.style.display;
    _closeAllInvPanels();
    if (wasHidden && panel) { panel.style.display = ''; _loadSuppliers(); }
  });
  document.getElementById('invSuppliersCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('inventorySuppliersPanel'); if (p) p.style.display = 'none';
  });
  document.getElementById('invSupplierAddBtn')?.addEventListener('click', async () => {
    const name = prompt('Наименование поставщика:'); if (!name?.trim()) return;
    const contactName = prompt('Контактное лицо (пусто = нет):') ?? '';
    const email = prompt('Email (пусто = нет):') ?? '';
    const phone = prompt('Телефон (пусто = нет):') ?? '';
    const address = prompt('Адрес (пусто = нет):') ?? '';
    try {
      const r = await apiFetch('/api/v1/inventory/suppliers', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ name: name.trim(), contactName, email, phone, address }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
      toast('Поставщик добавлен'); _loadSuppliers();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });

  async function _loadLowStock() {
    const list = document.getElementById('inventoryLowStockList');
    if (!list) return;
    list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Проверка остатков…</p>';
    try {
      const r = await apiFetch('/api/v1/inventory/stock?limit=500');
      const { stock = [] } = await r.json();
      const low = stock.filter(s => s.minQuantity != null && s.quantity <= s.minQuantity);
      if (!low.length) {
        list.innerHTML = '<p style="font-size:13px;color:#3bb969;padding:16px 0">✓ Все позиции в норме. Нет товаров ниже минимального остатка.</p>';
        return;
      }
      list.innerHTML = `
        <p style="font-size:11px;color:var(--text-muted);margin-bottom:10px">${low.length} позиц. ниже мин. остатка</p>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${low.sort((a,b) => (a.quantity/a.minQuantity) - (b.quantity/b.minQuantity)).map(s => {
            const pct = Math.round(s.quantity / s.minQuantity * 100);
            const color = pct <= 0 ? '#e05353' : pct <= 50 ? '#f0a44a' : '#e8d74c';
            return `<div style="background:var(--surface);border:1px solid ${color}44;border-radius:8px;padding:10px 12px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <span style="font-size:13px;font-weight:600">${escapeHtml(s.skuName)}</span>
                <span style="font-size:11px;color:${color};font-weight:700">${s.quantity} / ${s.minQuantity} ${escapeHtml(s.unit||'')}</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:6px">
                <span>${escapeHtml(s.skuCode)}</span>
                <span>${escapeHtml(s.warehouseName||'')}</span>
              </div>
              <div style="height:4px;border-radius:2px;background:var(--border)">
                <div style="height:100%;width:${Math.min(100,pct)}%;background:${color};border-radius:2px;transition:width .3s"></div>
              </div>
            </div>`;
          }).join('')}
        </div>`;
    } catch(e) { list.innerHTML = `<p style="font-size:12px;color:#e05353">${e.message}</p>`; }
  }

  async function _loadMinQtyEditor() {
    const list = document.getElementById('inventoryMinQtyList');
    if (!list) return;
    const warehouseId = _invSelectedWarehouse;
    if (!warehouseId) { list.innerHTML = '<p style="font-size:12px;color:#e8a84c">Выберите склад сначала.</p>'; return; }
    list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка позиций…</p>';
    try {
      const { stock = [] } = await apiFetch(`/api/v1/inventory/stock?warehouseId=${warehouseId}&limit=500`).then(r => r.json());
      if (!stock.length) { list.innerHTML = '<p class="empty-copy">Нет позиций на складе.</p>'; return; }
      list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="color:var(--text-muted);text-align:left">
          <th style="padding:6px 8px">SKU</th>
          <th style="padding:6px 8px">Наименование</th>
          <th style="padding:6px 8px;text-align:right">Текущий</th>
          <th style="padding:6px 8px;text-align:right">Мин. порог</th>
          <th style="padding:6px 8px">Бин</th>
        </tr></thead>
        <tbody>${stock.map(s => `<tr data-sku-row="${s.sku_id}" style="border-top:1px solid var(--border)">
          <td style="padding:6px 8px;font-family:monospace;font-size:11px;color:var(--text-muted)">${escapeHtml(s.sku_code)}</td>
          <td style="padding:6px 8px;font-weight:600">${escapeHtml(s.sku_name)}</td>
          <td style="padding:6px 8px;text-align:right;color:${s.belowMin?'#f46':'inherit'}">${s.quantity} ${escapeHtml(s.unit||'')}</td>
          <td style="padding:6px 8px">
            <input type="number" min="0" step="1" class="min-qty-input" data-sku-id="${s.sku_id}" data-wh-id="${warehouseId}" data-bin="${escapeHtml(s.location_bin||'')}"
              value="${s.min_quantity??''}" placeholder="—"
              style="width:70px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px;text-align:right">
          </td>
          <td style="padding:6px 8px">
            <input type="text" class="bin-input" data-sku-id="${s.sku_id}"
              value="${escapeHtml(s.location_bin||'')}" placeholder="A1-01"
              style="width:80px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px">
          </td>
        </tr>`).join('')}</tbody>
      </table>`;
    } catch(e) { list.innerHTML = `<p class="empty-copy">${e.message}</p>`; }
  }

  document.getElementById('invMinQtyEditorBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('inventoryMinQtyPanel');
    const wasHidden = panel?.style.display === 'none' || !panel?.style.display;
    _closeAllInvPanels();
    if (wasHidden && panel) { panel.style.display = ''; _loadMinQtyEditor(); }
  });
  document.getElementById('invMinQtyCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('inventoryMinQtyPanel'); if (p) p.style.display = 'none';
  });
  document.getElementById('invMinQtySaveBtn')?.addEventListener('click', async () => {
    const inputs = document.querySelectorAll('#inventoryMinQtyList .min-qty-input');
    if (!inputs.length) return;
    let saved = 0, errors = 0;
    const warehouseId = _invSelectedWarehouse;
    for (const inp of inputs) {
      const skuId = inp.dataset.skuId;
      const binInp = document.querySelector(`#inventoryMinQtyList .bin-input[data-sku-id="${skuId}"]`);
      const minQty = inp.value === '' ? null : parseFloat(inp.value);
      const locationBin = binInp?.value ?? '';
      try {
        const r = await apiFetch('/api/v1/inventory/stock-settings', {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ warehouseId, skuId, minQuantity: minQty, locationBin }),
        });
        if (!r.ok) throw new Error(r.status);
        saved++;
      } catch { errors++; }
    }
    toast(`Сохранено: ${saved}${errors ? `, ошибок: ${errors}` : ''}`);
    if (!errors) _loadStock(warehouseId);
  });

  document.getElementById('invLowStockBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('inventoryLowStockPanel');
    const wasHidden = panel?.style.display === 'none' || !panel?.style.display;
    _closeAllInvPanels();
    if (wasHidden && panel) { panel.style.display = ''; _loadLowStock(); }
  });
  document.getElementById('invLowStockCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('inventoryLowStockPanel'); if (p) p.style.display = 'none';
  });
  document.getElementById('invLowStockRefreshBtn')?.addEventListener('click', _loadLowStock);

  document.getElementById('invReorderSuggestBtn')?.addEventListener('click', async () => {
    const list = document.getElementById('inventoryReorderList');
    if (list) list.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Анализ остатков…</p>';
    try {
      const r = await apiFetch('/api/v1/inventory/reorder-suggest');
      const { suggestions = [] } = await r.json();
      if (!suggestions.length) {
        if (list) list.innerHTML = '<p class="empty-copy">Нет позиций ниже минимума или все заявки уже открыты.</p>'; return;
      }
      if (list) list.innerHTML = `<p style="font-size:12px;font-weight:600;margin-bottom:8px">Предлагается заказать (${suggestions.length} позиций):</p>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${suggestions.map(s => `
            <div style="background:var(--surface);border:1px solid #e8a84c44;border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px">
              <div style="flex:1">
                <strong style="font-size:12px">${escapeHtml(s.sku_name)}</strong>
                <code style="font-size:10px;margin-left:6px;color:var(--text-muted)">${escapeHtml(s.sku_code)}</code>
                <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(s.warehouse_name)} · есть: ${s.quantity} / мин: ${s.min_quantity} ${escapeHtml(s.unit||'')}</div>
              </div>
              <button data-suggest-sku="${s.sku_id}" data-suggest-wh="${s.warehouse_id}"
                data-suggest-qty="${s.suggestedQty}" data-suggest-unit="${escapeHtml(s.unit||'')}"
                class="button ghost" style="font-size:11px;white-space:nowrap">
                ＋ Заказать ${s.suggestedQty} ${escapeHtml(s.unit||'')}
              </button>
            </div>`).join('')}
        </div>`;
      list?.querySelectorAll('[data-suggest-sku]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const qty = parseFloat(prompt(`Количество для заказа (${btn.dataset.suggestUnit}):`, btn.dataset.suggestQty) || '0');
          if (!qty || isNaN(qty)) return;
          const ref = prompt('Поставщик / ссылка (опционально):', '') || '';
          try {
            const r2 = await apiFetch('/api/v1/inventory/reorder-requests', {
              method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
              body: JSON.stringify({ skuId: btn.dataset.suggestSku, warehouseId: btn.dataset.suggestWh, quantity: qty, supplierRef: ref }),
            });
            if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
            toast('Заявка создана'); _loadReorders();
          } catch(e) { toast(`Ошибка: ${e.message}`); }
        });
      });
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });

  document.getElementById('invReorderAddBtn')?.addEventListener('click', async () => {
    const whR = await apiFetch('/api/v1/inventory/warehouses');
    const { warehouses = [] } = await whR.json();
    if (!warehouses.length) { toast('Нет складов.'); return; }
    const whOpts = warehouses.map((w,i) => `${i+1}. ${w.name}`).join('\n');
    const whIdx = parseInt(prompt(`Склад:\n${whOpts}`, '1') || '0') - 1;
    if (whIdx < 0 || whIdx >= warehouses.length) return;
    const wh = warehouses[whIdx];
    const skuR = await apiFetch('/api/v1/inventory/skus');
    const { skus = [] } = await skuR.json();
    if (!skus.length) { toast('Нет SKU.'); return; }
    const skuOpts = skus.map((s,i) => `${i+1}. ${s.name} (${s.sku_code})`).join('\n');
    const skuIdx = parseInt(prompt(`Материал:\n${skuOpts}`, '1') || '0') - 1;
    if (skuIdx < 0 || skuIdx >= skus.length) return;
    const sku = skus[skuIdx];
    const qty = parseFloat(prompt(`Количество для заказа (${sku.unit||'pcs'}):`) || '0');
    if (!qty || isNaN(qty)) return;
    const ref = prompt('Поставщик / ссылка:', '') || '';
    const note = prompt('Заметка:', '') || '';
    try {
      const r = await apiFetch('/api/v1/inventory/reorder-requests', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ skuId: sku.id, warehouseId: wh.id, quantity: qty, supplierRef: ref, note }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
      toast('Заявка на пополнение создана'); _loadReorders();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });

  // SKU catalog
  document.getElementById('invManageSkusBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('inventorySkuPanel');
    const pendPanel = document.getElementById('inventoryPendingPanel');
    if (panel) { panel.style.display = panel.style.display === 'none' ? '' : 'none'; _loadSkuCatalog(); }
    if (pendPanel) pendPanel.style.display = 'none';
  });
  document.getElementById('invSkuCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('inventorySkuPanel'); if (p) p.style.display = 'none';
  });
  // Add SKU
  document.getElementById('skuCsvInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    e.target.value = '';
    try {
      const r = await apiFetch('/api/v1/inventory/skus/import-csv', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'text/csv; charset=utf-8'}),
        body: text,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || r.status);
      toast(`Импорт: создано ${data.created}, обновлено ${data.updated}${data.errors?.length ? `, ошибок: ${data.errors.length}` : ''}`);
      if (data.errors?.length) console.warn('SKU import errors:', data.errors);
      _loadSkuCatalog();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });

  document.getElementById('invAddSkuBtn')?.addEventListener('click', async () => {
    const code = prompt('Код SKU (уникальный артикул):');
    if (!code?.trim()) return;
    const name = prompt('Наименование:');
    if (!name?.trim()) return;
    const unit = prompt('Единица измерения (pcs/m/kg/roll/box):', 'pcs') || 'pcs';
    const category = prompt('Категория (cable/equipment/consumable/general):', 'general') || 'general';
    try {
      const r = await apiFetch('/api/v1/inventory/skus', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ skuCode: code.trim(), name: name.trim(), unit, category }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
      toast('SKU добавлен'); _loadSkuCatalog();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
  // AI parse
  document.getElementById('invAiParseBtn')?.addEventListener('click', async () => {
    const text = prompt('Текст заметки или описание поставки:');
    if (!text?.trim()) return;
    try {
      toast('Отправляю в AI…');
      const r = await apiFetch('/api/v1/inventory/ai-parse', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ text: text.trim(), warehouseId: _invSelectedWarehouse }),
      });
      const res = await r.json();
      if (!r.ok) { toast(`Ошибка AI: ${res.error?.message||r.status}`); return; }
      toast(`AI предложил ${res.suggested_movements?.length||0} движений. Проверьте очередь одобрения.`);
      const panel = document.getElementById('inventoryPendingPanel');
      if (panel) { panel.style.display = ''; _loadPendingList(); }
      _loadPendingCount();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
  // XLSX import
  // Photo analysis
  // Voice note — Web Speech API transcription → AI inventory parse
  document.getElementById('invVoiceBtn')?.addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast('Браузер не поддерживает голосовой ввод. Используйте Chrome/Edge.');
      return;
    }
    const btn = document.getElementById('invVoiceBtn');
    const rec = new SpeechRecognition();
    rec.lang = 'ru-RU';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    btn.textContent = '⏹ Остановить';
    btn.style.color = '#f46';
    toast('Говорите… нажмите кнопку ещё раз для остановки');

    let stopped = false;
    const stop = () => { if (!stopped) { stopped = true; rec.stop(); } };
    btn.onclick = stop;

    rec.onresult = async (e) => {
      const text = e.results[0][0].transcript.trim();
      btn.textContent = '🎙 Голос';
      btn.style.color = '';
      btn.onclick = null;
      // Re-bind original click
      document.getElementById('invVoiceBtn')?.addEventListener('click', arguments.callee?.caller);
      if (!text) { toast('Ничего не распознано.'); return; }
      toast(`Распознано: «${text.slice(0, 60)}…» — отправляю в AI…`);
      try {
        const r = await apiFetch('/api/v1/inventory/ai-parse', {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({ text, warehouseId: _invSelectedWarehouse }),
        });
        const res = await r.json();
        if (!r.ok) { toast(`Ошибка AI: ${res.error?.message||r.status}`); return; }
        const count = res.suggested_movements?.length || 0;
        toast(`AI предложил ${count} движений. Проверьте очередь одобрения.`);
        _loadPendingCount();
        const panel = document.getElementById('inventoryPendingPanel');
        if (panel) { panel.style.display = ''; _loadPendingList(); }
      } catch(e) { toast(`Ошибка: ${e.message}`); }
    };
    rec.onerror = (e) => {
      btn.textContent = '🎙 Голос'; btn.style.color = ''; btn.onclick = null;
      toast(`Ошибка распознавания: ${e.error}`);
    };
    rec.onend = () => {
      btn.textContent = '🎙 Голос'; btn.style.color = ''; btn.onclick = null;
    };
    rec.start();
  });

  // CSV export
  document.getElementById('invExportBtn')?.addEventListener('click', async () => {
    const since = prompt('Экспорт движений начиная с (YYYY-MM-DD, пусто = все):', '') || '';
    const whParam = _invSelectedWarehouse ? `&warehouseId=${_invSelectedWarehouse}` : '';
    const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
    const url = `/api/v1/inventory/export?format=csv${whParam}${sinceParam}`;
    try {
      const r = await apiFetch(url);
      if (!r.ok) { toast('Ошибка экспорта'); return; }
      const blob = await r.blob();
      const cd = r.headers.get('Content-Disposition') || '';
      const fname = cd.match(/filename="([^"]+)"/)?.[1] || 'inventory.csv';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Скачан файл ${fname}`);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });

  // Barcode / QR scanner using BarcodeDetector API
  document.getElementById('invScanBtn')?.addEventListener('click', async () => {
    if (!('BarcodeDetector' in window)) {
      // Fallback: use file input with BarcodeDetector-like detection via canvas
      toast('Сканер штрих-кодов не поддерживается в этом браузере. Используйте Chrome 83+ или Edge.');
      return;
    }
    // Create a video overlay for live scanning
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px';
    overlay.innerHTML = `
      <p style="color:#fff;font-size:14px;font-weight:600">Наведите камеру на штрих-код</p>
      <video id="_scanVideo" style="width:min(90vw,400px);border-radius:12px;border:2px solid #4f8ef7" autoplay playsinline muted></video>
      <button style="padding:10px 24px;border-radius:8px;border:none;background:#f46;color:#fff;font-size:14px;cursor:pointer" id="_scanCloseBtn">Закрыть</button>`;
    document.body.appendChild(overlay);
    const video = overlay.querySelector('#_scanVideo');
    let stream, animId;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      await video.play();
      const detector = new BarcodeDetector({ formats: ['ean_13','ean_8','code_128','code_39','qr_code','upc_a','upc_e'] });
      const scan = async () => {
        if (!document.body.contains(overlay)) return;
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length) {
            const code = barcodes[0].rawValue;
            cleanup();
            toast(`Штрих-код: ${code} — ищу SKU…`);
            const r = await apiFetch(`/api/v1/inventory/skus?q=${encodeURIComponent(code)}`);
            const { skus = [] } = await r.json();
            if (skus.length) {
              toast(`Найдено: ${skus[0].name} (${skus[0].sku_code})`);
              // Pre-fill search
              const inp = document.getElementById('invSkuSearch');
              if (inp) { inp.value = code; inp.dispatchEvent(new Event('input')); }
            } else {
              toast(`SKU с кодом «${code}» не найден`);
            }
            return;
          }
        } catch {}
        animId = requestAnimationFrame(scan);
      };
      animId = requestAnimationFrame(scan);
    } catch(e) {
      cleanup();
      toast(`Ошибка камеры: ${e.message}`);
    }
    function cleanup() {
      cancelAnimationFrame(animId);
      if (stream) stream.getTracks().forEach(t => t.stop());
      overlay.remove();
    }
    overlay.querySelector('#_scanCloseBtn').addEventListener('click', cleanup);
  });

  document.getElementById('invAiPhotoBtn')?.addEventListener('click', () => {
    document.getElementById('invPhotoInput')?.click();
  });
  document.getElementById('invPhotoInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 20_000_000) { toast('Файл слишком большой (макс 20 МБ)'); return; }
    toast('Анализирую фото…');
    try {
      const buf = await file.arrayBuffer();
      const url = _invSelectedWarehouse
        ? `/api/v1/inventory/ai-photo?warehouseId=${_invSelectedWarehouse}`
        : '/api/v1/inventory/ai-photo';
      const r = await fetch(url, {
        method: 'POST',
        headers: apiHeaders({'Content-Type': file.type || 'image/jpeg'}),
        body: buf,
      });
      const res = await r.json();
      if (!r.ok) { toast(`Ошибка AI: ${res.error?.message||r.status}`); return; }
      const count = res.suggested_movements?.length || 0;
      toast(`AI обнаружил ${count} позиций. Проверьте очередь одобрения.`);
      if (res.aiDescription) {
        const desc = res.aiDescription.slice(0, 300);
        setTimeout(() => toast(`AI: ${desc}…`), 1500);
      }
      const panel = document.getElementById('inventoryPendingPanel');
      if (panel) { panel.style.display = ''; _loadPendingList(); }
      _loadPendingCount();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
    e.target.value = '';
  });
  document.getElementById('invImportXlsxBtn')?.addEventListener('click', () => {
    document.getElementById('invXlsxInput')?.click();
  });
  document.getElementById('invXlsxInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    toast(`Загружаю ${file.name}…`);
    try {
      const data = await file.arrayBuffer();
      const r = await fetch('/api/v1/inventory/import-xlsx', {
        method: 'POST',
        headers: apiHeaders({'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),
        body: data,
      });
      const res = await r.json();
      if (!r.ok) { toast(`Ошибка: ${res.error?.message||r.status}`); return; }
      toast(`Импортировано ${res.suggested_movements?.length||0} строк. Проверьте очередь.`);
      const panel = document.getElementById('inventoryPendingPanel');
      if (panel) { panel.style.display = ''; _loadPendingList(); }
      _loadPendingCount();
    } catch(e) { toast(`Ошибка: ${e.message}`); }
    e.target.value = '';
  });
  // SKU search
  document.getElementById('invSkuSearch')?.addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    if (!q) { if (_invSelectedWarehouse) _loadStock(_invSelectedWarehouse); return; }
    const table = document.getElementById('inventoryStockTable');
    try {
      const r = await apiFetch(`/api/v1/inventory/skus?q=${encodeURIComponent(q)}`);
      const { skus = [] } = await r.json();
      if (table) table.innerHTML = skus.length
        ? `<div style="display:flex;flex-wrap:wrap;gap:8px">${skus.map(s => `<div style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:12px"><strong>${escapeHtml(s.sku_code)}</strong><br>${escapeHtml(s.name)}<br><span style="color:var(--text-muted)">${s.unit}</span></div>`).join('')}</div>`
        : '<p class="empty-copy" style="font-size:13px">Ничего не найдено.</p>';
    } catch { /* silent */ }
  });
  // Transfer between warehouses
  document.getElementById('invTransferBtn')?.addEventListener('click', async () => {
    const whR = await apiFetch('/api/v1/inventory/warehouses');
    const { warehouses = [] } = await whR.json();
    if (warehouses.length < 2) { toast('Нужно минимум 2 склада для перемещения.'); return; }
    const fromOptions = warehouses.map((w,i) => `${i+1}. ${w.name}`).join('\n');
    const fromIdx = parseInt(prompt(`Склад-источник:\n${fromOptions}`, _invSelectedWarehouse ? String(warehouses.findIndex(w=>w.id===_invSelectedWarehouse)+1) : '1') || '0') - 1;
    if (fromIdx < 0 || fromIdx >= warehouses.length) return;
    const fromWh = warehouses[fromIdx];

    const toOpts = warehouses.filter((_,i)=>i!==fromIdx).map((w,i) => `${i+1}. ${w.name}`).join('\n');
    const toFiltered = warehouses.filter((_,i)=>i!==fromIdx);
    const toIdx = parseInt(prompt(`Склад-назначение:\n${toOpts}`, '1') || '0') - 1;
    if (toIdx < 0 || toIdx >= toFiltered.length) return;
    const toWh = toFiltered[toIdx];

    const skuR = await apiFetch(`/api/v1/inventory/stock?warehouseId=${fromWh.id}`);
    const { stock = [] } = await skuR.json();
    if (!stock.length) { toast(`На складе "${fromWh.name}" нет остатков.`); return; }
    const skuOpts = stock.map((s,i) => `${i+1}. ${s.sku_name} (${s.sku_code}) — ${s.quantity} ${s.unit}`).join('\n');
    const skuIdx = parseInt(prompt(`Материал для перемещения:\n${skuOpts}`, '1') || '0') - 1;
    if (skuIdx < 0 || skuIdx >= stock.length) return;
    const sku = stock[skuIdx];

    const qty = parseFloat(prompt(`Количество (макс ${sku.quantity} ${sku.unit}):`) || '0');
    if (!qty || isNaN(qty) || qty <= 0) return;
    const ref = prompt('Документ/ссылка (опционально):', '') || '';

    try {
      const r = await apiFetch('/api/v1/inventory/transfer', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({
          fromWarehouseId: fromWh.id, toWarehouseId: toWh.id,
          skuId: sku.sku_id, quantity: qty, reference: ref,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
      toast(`Перемещено ${qty} ${sku.unit} из "${fromWh.name}" в "${toWh.name}"`);
      if (_invSelectedWarehouse) _loadStock(_invSelectedWarehouse);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
  // Add movement (full form)
  document.getElementById('invAddMovementBtn')?.addEventListener('click', async () => {
    if (!_invSelectedWarehouse) { toast('Сначала выберите склад'); return; }
    const sku = prompt('Код SKU:');
    if (!sku?.trim()) return;
    try {
      const r = await apiFetch(`/api/v1/inventory/skus?q=${encodeURIComponent(sku.trim())}`);
      const { skus = [] } = await r.json();
      if (!skus.length) { toast(`SKU "${sku}" не найден`); return; }
      const found = skus[0];
      _quickMovement(_invSelectedWarehouse, found.id, found.name);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
}

function hydrateDigest() {
  const el = document.getElementById('digestWidget');
  const refreshBtn = document.getElementById('digestRefreshBtn');
  const aiBtn = document.getElementById('digestAiBtn');

  async function loadDigest(useAi = false) {
    if (!el) return;
    el.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
    try {
      const r = await apiFetch('/api/v1/admin/digest', useAi ? { method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: '{}' } : {});
      const data = await r.json();

      const lowStockHtml = data.lowStock?.length ? `
        <div style="margin-bottom:14px">
          <p style="font-size:11px;font-weight:700;color:#e8a84c;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">⚠ Низкий остаток (${data.lowStock.length})</p>
          ${data.lowStock.map(item => {
            const avail = (item.quantity||0) - (item.reserved||0);
            const pct = item.min_quantity > 0 ? Math.round(item.quantity / item.min_quantity * 100) : 0;
            return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(232,168,76,.07);border-radius:7px;margin-bottom:4px">
              <div style="flex:1">
                <span style="font-size:12px;font-weight:600">${escapeHtml(item.sku_name)}</span>
                <span style="font-size:10px;font-family:monospace;color:var(--text-muted);margin-left:6px">${escapeHtml(item.sku_code)}</span>
                <span style="font-size:11px;color:var(--text-muted);display:block">${escapeHtml(item.warehouse_name)}</span>
              </div>
              <div style="text-align:right">
                <strong style="font-size:13px;color:#e8a84c">${item.quantity}</strong>
                <span style="font-size:11px;color:var(--text-muted)">/ min ${item.min_quantity} ${item.unit}</span>
                <div style="font-size:10px;color:var(--text-muted)">avail: ${avail}</div>
              </div>
              <div style="width:40px;font-size:10px;text-align:center;color:#e8a84c">${pct}%</div>
            </div>`;
          }).join('')}
        </div>` : '';

      const projectsHtml = data.projects?.length ? `
        <div style="margin-bottom:14px">
          <p style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">📋 Проекты (${data.projects.length})</p>
          ${data.projects.map(p => {
            const bar = '█'.repeat(Math.floor(p.pct_done/10)) + '░'.repeat(10-Math.floor(p.pct_done/10));
            const barColor = p.pct_done >= 80 ? '#4adc84' : p.pct_done >= 40 ? '#4f8ef7' : '#8b95a5';
            return `<div style="display:flex;align-items:center;gap:10px;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:7px;margin-bottom:4px">
              <code style="font-size:10px;color:var(--text-muted);min-width:36px">${escapeHtml(p.code)}</code>
              <span style="flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name)}</span>
              <span style="font-size:10px;font-family:monospace;color:${barColor}">${bar}</span>
              <span style="font-size:12px;font-weight:700;color:${barColor};min-width:32px;text-align:right">${p.pct_done}%</span>
              ${p.blocked ? `<span style="font-size:10px;color:#f46">⛔${p.blocked}</span>` : ''}
            </div>`;
          }).join('')}
        </div>` : '';

      const notesHtml = (data.pendingApprovals || data.openIssues) ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${data.pendingApprovals ? `<span style="font-size:11px;padding:3px 9px;border-radius:8px;background:rgba(79,142,247,.1);color:var(--accent)">${data.pendingApprovals} ожидают одобрения</span>` : ''}
          ${data.openIssues ? `<span style="font-size:11px;padding:3px 9px;border-radius:8px;background:rgba(244,68,68,.1);color:#f44">${data.openIssues} открытых проблем</span>` : ''}
        </div>` : '';

      const aiNarrativeHtml = data.narrative ? `
        <div style="margin-bottom:14px;padding:12px 14px;background:rgba(79,142,247,.06);border:1px solid rgba(79,142,247,.2);border-radius:10px">
          <p style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">✦ AI СВОДКА</p>
          <p style="font-size:13px;line-height:1.5;color:var(--text)">${escapeHtml(data.narrative)}</p>
        </div>` : '';

      el.innerHTML = `
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Сгенерировано: ${(data.generatedAt||'').replace('T',' ').slice(0,16)} UTC</div>
        ${aiNarrativeHtml}${lowStockHtml}${projectsHtml}${notesHtml}
        ${(!data.lowStock?.length && !data.projects?.length && !data.pendingApprovals && !data.openIssues)
          ? '<p class="empty-copy">Всё в порядке, критических событий нет.</p>' : ''}`;
    } catch(e) {
      if (el) el.innerHTML = `<p class="empty-copy">Ошибка: ${e.message}</p>`;
    }
  }

  refreshBtn?.addEventListener('click', () => loadDigest(false));
  aiBtn?.addEventListener('click', () => loadDigest(true));

  // Email send
  const sendEmailBtn = document.getElementById('digestSendEmailBtn');
  sendEmailBtn?.addEventListener('click', async () => {
    try {
      sendEmailBtn.disabled = true; sendEmailBtn.textContent = 'Отправляю…';
      const r = await apiFetch('/api/v1/admin/digest/send-email', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: '{}',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || r.status);
      toast(`Дайджест отправлен → ${(data.recipients||[]).join(', ')}`);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
    finally { if (sendEmailBtn) { sendEmailBtn.disabled = false; sendEmailBtn.textContent = '📧 Email'; } }
  });

  // SMTP config
  const smtpBtn = document.getElementById('digestSmtpBtn');
  smtpBtn?.addEventListener('click', async () => {
    try {
      const r = await apiFetch('/api/v1/admin/smtp-config');
      const cfg = await r.json();
      const host = prompt('SMTP хост (напр. smtp.gmail.com):', cfg.host||''); if (host===null) return;
      const port = prompt('Порт (587=STARTTLS, 465=SSL):', cfg.port||587); if (port===null) return;
      const username = prompt('Логин (email):', cfg.username||''); if (username===null) return;
      const password = prompt('Пароль (пусто = без изменений):', '');
      const fromAddr = prompt('Адрес отправителя:', cfg.fromAddress||username||''); if (fromAddr===null) return;
      const toAddrs = prompt('Получатели (через запятую):', cfg.toAddresses||''); if (toAddrs===null) return;
      const useTls = parseInt(port||587) === 465;
      const r2 = await apiFetch('/api/v1/admin/smtp-config', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ host, port: parseInt(port||587), useTls, username, password, fromAddress: fromAddr, toAddresses: toAddrs }),
      });
      if (!r2.ok) throw new Error((await r2.json()).error?.message || r2.status);
      toast('SMTP настроен');
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });
}

async function hydrateEmailInboxes() {
  const list = document.getElementById('emailInboxList');
  if (!list) return;
  try {
    const r = await apiFetch('/api/v1/admin/email-inboxes');
    const { inboxes = [] } = await r.json();
    if (!inboxes.length) {
      list.innerHTML = '<p class="empty-copy" style="font-size:13px">Нет настроенных инбоксов.</p>';
      return;
    }
    list.innerHTML = inboxes.map(inbox => `
      <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div>
            <strong style="font-size:14px">${escapeHtml(inbox.name)}</strong>
            <p style="font-size:12px;color:var(--text-muted);margin:4px 0 0">
              ${escapeHtml(inbox.username)}@${escapeHtml(inbox.host)}:${inbox.port}
              · папка: <code>${escapeHtml(inbox.folder)}</code>
              ${inbox.filter_subject ? `· фильтр: "${escapeHtml(inbox.filter_subject)}"` : ''}
              · каждые ${inbox.poll_interval} мин
            </p>
            ${inbox.last_polled_at ? `<p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Последний опрос: ${inbox.last_polled_at.slice(0,16).replace('T',' ')}</p>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button type="button" class="button ghost" style="font-size:11px" data-inbox-poll="${inbox.id}">▶ Опросить</button>
            <button type="button" class="button ghost" style="font-size:11px" data-inbox-log="${inbox.id}">📋 Лог</button>
            <button type="button" class="text-button danger" style="font-size:11px" data-inbox-delete="${inbox.id}">✕</button>
          </div>
        </div>
        <div class="inbox-log" id="inboxLog_${inbox.id}" style="display:none;margin-top:10px;border-top:1px solid var(--border);padding-top:10px"></div>
      </div>`).join('');

    list.querySelectorAll('[data-inbox-poll]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '…';
        try {
          const r2 = await apiFetch(`/api/v1/admin/email-inboxes/${btn.dataset.inboxPoll}/poll`, {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: '{}',
          });
          const res = await r2.json();
          if (!r2.ok) { toast(`Ошибка: ${res.error?.message||r2.status}`); return; }
          toast(`Опрошено: ${res.fetched} писем, разобрано: ${res.parsed}${res.errors?.length ? `, ошибок: ${res.errors.length}` : ''}`);
          hydrateEmailInboxes();
        } catch(e) { toast(`Ошибка: ${e.message}`); }
        finally { btn.disabled = false; btn.textContent = '▶ Опросить'; }
      });
    });

    list.querySelectorAll('[data-inbox-log]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const logDiv = document.getElementById(`inboxLog_${btn.dataset.inboxLog}`);
        if (!logDiv) return;
        logDiv.style.display = logDiv.style.display === 'none' ? '' : 'none';
        if (logDiv.style.display === 'none') return;
        logDiv.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Загрузка…</p>';
        try {
          const r2 = await apiFetch(`/api/v1/admin/email-inboxes/${btn.dataset.inboxLog}/log`);
          const { log = [] } = await r2.json();
          if (!log.length) { logDiv.innerHTML = '<p class="empty-copy" style="font-size:12px">Нет обработанных писем.</p>'; return; }
          logDiv.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr style="color:var(--text-muted)">
              <th style="padding:4px 6px;text-align:left">Дата</th>
              <th style="padding:4px 6px;text-align:left">От</th>
              <th style="padding:4px 6px;text-align:left">Тема</th>
              <th style="padding:4px 6px;text-align:left">Статус</th>
            </tr></thead>
            <tbody>${log.map(e => `<tr style="border-top:1px solid var(--border)">
              <td style="padding:4px 6px;color:var(--text-muted)">${(e.created_at||'').slice(0,16).replace('T',' ')}</td>
              <td style="padding:4px 6px">${escapeHtml((e.sender||'').slice(0,40))}</td>
              <td style="padding:4px 6px">${escapeHtml((e.subject||'').slice(0,60))}</td>
              <td style="padding:4px 6px">${e.pending_id ? '✓ разобрано' : e.status}</td>
            </tr>`).join('')}</tbody>
          </table>`;
        } catch { logDiv.innerHTML = '<p class="empty-copy" style="font-size:12px">Ошибка.</p>'; }
      });
    });

    list.querySelectorAll('[data-inbox-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить инбокс? Сохранённый пароль тоже будет удалён.')) return;
        try {
          const r2 = await apiFetch(`/api/v1/admin/email-inboxes/${btn.dataset.inboxDelete}/delete`, {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: '{}',
          });
          if (!r2.ok) { toast('Ошибка удаления'); return; }
          toast('Инбокс удалён'); hydrateEmailInboxes();
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
  } catch { list.innerHTML = '<p class="empty-copy" style="font-size:13px">Недоступно.</p>'; }
}

async function hydrateOrgSettings() {
  try {
    const r = await apiFetch('/api/v1/admin/org-settings');
    const { settings = {} } = await r.json();
    const set = v => v != null ? v : '';
    const el = id => document.getElementById(id);
    if (el('orgTz')) el('orgTz').value = set(settings.timezone);
    if (el('orgLocale')) el('orgLocale').value = set(settings.locale);
    if (el('orgDateFormat')) el('orgDateFormat').value = set(settings.date_format);
    if (el('orgCurrency')) el('orgCurrency').value = set(settings.currency);
    if (el('orgWorkWeekStart')) el('orgWorkWeekStart').value = String(settings.work_week_start ?? 1);
  } catch { /* panel stays with placeholders */ }
}

async function hydrateSessionsAdmin() {
  const list = document.getElementById('sessionsList');
  if (!list) return;
  try {
    const r = await apiFetch('/api/v1/admin/sessions');
    const { sessions = [] } = await r.json();
    if (!sessions.length) {
      list.innerHTML = '<p class="empty-copy" style="font-size:13px">Нет активных сессий.</p>';
      return;
    }
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--text-muted);text-align:left">
        <th style="padding:6px 8px">Пользователь</th>
        <th style="padding:6px 8px">Роль</th>
        <th style="padding:6px 8px">IP</th>
        <th style="padding:6px 8px">Последняя активность</th>
        <th style="padding:6px 8px">Истекает</th>
        <th style="padding:6px 8px"></th>
      </tr></thead>
      <tbody>${sessions.map(s => `<tr style="border-top:1px solid var(--border)">
        <td style="padding:7px 8px">
          <strong>${escapeHtml(s.displayName || s.email || s.userId)}</strong>
          <small style="display:block;color:var(--text-muted)">${escapeHtml(s.email || '')}</small>
        </td>
        <td style="padding:7px 8px">${escapeHtml(s.role)}</td>
        <td style="padding:7px 8px;color:var(--text-muted)">${escapeHtml(s.ipAddress || '—')}</td>
        <td style="padding:7px 8px;color:var(--text-muted)">${(s.lastSeenAt||'').slice(0,16).replace('T',' ')}</td>
        <td style="padding:7px 8px;color:var(--text-muted)">${(s.expiresAt||'').slice(0,16).replace('T',' ')}</td>
        <td style="padding:7px 8px">
          <button type="button" class="text-button danger" style="font-size:11px" data-revoke-prefix="${s.tokenHash.replace('…','')}">Отозвать</button>
        </td>
      </tr>`).join('')}</tbody>
    </table>`;
    list.querySelectorAll('[data-revoke-prefix]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Отозвать эту сессию?')) return;
        try {
          const r2 = await apiFetch('/api/v1/admin/sessions/revoke', {
            method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
            body: JSON.stringify({ tokenHashPrefix: btn.dataset.revokePrefix }),
          });
          const { revoked } = await r2.json();
          toast(revoked ? 'Сессия отозвана' : 'Сессия не найдена');
          hydrateSessionsAdmin();
        } catch(e) { toast(`Ошибка: ${e.message}`); }
      });
    });
  } catch { list.innerHTML = '<p class="empty-copy" style="font-size:13px">Недоступно.</p>'; }
}

async function hydrateTemplatesAdmin() {
  const container = $('#templatesAdminSection');
  if (!container) return;
  const templates = await loadTemplates();
  const CATEGORY_LABEL = { general:'General', residential:'Residential', commercial:'Commercial', data_centre:'Data Centre' };
  if (!templates.length) {
    container.innerHTML = '<p class="empty-copy" style="color:var(--text-muted);font-size:13px">Шаблонов нет. Создайте первый шаблон.</p>';
  } else {
    container.innerHTML = templates.map(t => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
        <div>
          <strong style="font-size:13px">${escapeHtml(t.name)}</strong>
          <small style="margin-left:8px;color:var(--text-muted)">${CATEGORY_LABEL[t.category]||t.category}</small>
          ${t.scaffold.workItems?.length ? `<small style="margin-left:8px;color:var(--text-muted)">${t.scaffold.workItems.length} задач</small>` : ''}
        </div>
        <button type="button" class="text-button danger" data-delete-tpl="${t.id}">Удалить</button>
      </div>`).join('');
    container.querySelectorAll('[data-delete-tpl]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Удалить шаблон?')) return;
      await apiFetch(`/api/v1/templates/${btn.dataset.deleteTpl}/delete`, { method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: '{}' });
      hydrateTemplatesAdmin();
    }));
  }
}

async function openCreateFromTemplate() {
  const templates = await loadTemplates();
  if (!templates.length) { toast('Шаблонов нет. Сначала создайте шаблон в Admin.'); return; }
  const sel = templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <form method="dialog" style="min-width:300px">
      <h3 style="margin:0 0 16px">Создать проект из шаблона</h3>
      <label style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;font-size:13px">
        Шаблон <select id="tplSelect" style="padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)">${sel}</select>
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;font-size:13px">
        Код <input id="tplCode" required maxlength="32" style="padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;font-size:13px">
        Название <input id="tplName" required maxlength="120" style="padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" id="tplCancelBtn" style="padding:8px 14px">Отмена</button>
        <button type="submit" class="primary-button" style="padding:8px 14px">Создать</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  dialog.showModal();
  dialog.querySelector('#tplCancelBtn').addEventListener('click', () => { dialog.close(); dialog.remove(); });
  dialog.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const tplId = dialog.querySelector('#tplSelect').value;
    const code = dialog.querySelector('#tplCode').value.trim();
    const name = dialog.querySelector('#tplName').value.trim();
    try {
      const r = await apiFetch(`/api/v1/templates/${tplId}/use`, {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
        body: JSON.stringify({ code, name }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message || r.statusText);
      const { project } = await r.json();
      dialog.close(); dialog.remove();
      toast(`Проект "${name}" создан из шаблона`);
      location.hash = `project/${project.id}`;
    } catch(err) { toast(`Ошибка: ${err.message}`); }
  });
}

// ── Notification Center ───────────────────────────────────────────────────

let _notifPollTimer = null;

async function fetchNotifications(unreadOnly = false) {
  try {
    const r = await apiFetch(`/api/v1/notifications${unreadOnly ? '?unread=true' : ''}`);
    const { notifications = [], unreadCount = 0 } = await r.json();
    const badge = document.getElementById('notifBadge');
    if (badge) {
      badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      badge.style.display = unreadCount ? 'flex' : 'none';
    }
    return { notifications, unreadCount };
  } catch { return { notifications: [], unreadCount: 0 }; }
}

function renderNotifications(notifications) {
  const list = document.getElementById('notificationList');
  if (!list) return;
  const TYPE_ICON = { work_item_unblocked:'🔓', issue_opened:'⚠', comment:'💬', ai_approval:'🤖', system:'ℹ' };
  if (!notifications.length) {
    list.innerHTML = '<p style="padding:12px 14px;font-size:12px;color:var(--text-muted)">Нет уведомлений.</p>';
    return;
  }
  list.innerHTML = notifications.map(n => `
    <div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.05);background:${n.read ? 'none' : 'rgba(79,142,247,.05)'}" data-notif-id="${n.id}">
      <div style="display:flex;gap:8px;align-items:flex-start">
        <span style="font-size:14px;margin-top:1px">${TYPE_ICON[n.type]||'•'}</span>
        <div style="flex:1;min-width:0">
          <strong style="font-size:12px;display:block">${escapeHtml(n.title)}</strong>
          ${n.body ? `<p style="margin:2px 0 0;font-size:11px;color:var(--text-muted)">${escapeHtml(n.body)}</p>` : ''}
          <small style="font-size:10px;color:#445;margin-top:2px;display:block">${new Date(n.created_at).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</small>
        </div>
        ${!n.read ? '<span style="width:6px;height:6px;border-radius:50%;background:#4f8ef7;flex-shrink:0;margin-top:5px"></span>' : ''}
      </div>
    </div>`).join('');
}

function setupNotificationCenter() {
  const bell = document.getElementById('notificationBellBtn');
  const panel = document.getElementById('notificationPanel');
  const markAllBtn = document.getElementById('markAllReadBtn');
  if (!bell || !panel) return;

  bell.addEventListener('click', async () => {
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : '';
    if (!isOpen) {
      // Generate system alerts on open (once per day, server deduplicates)
      apiFetch('/api/v1/notifications/generate-alerts', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: '{}',
      }).catch(() => {});
      const { notifications } = await fetchNotifications();
      renderNotifications(notifications);
    }
  });

  markAllBtn?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/v1/notifications/read', {
        method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: '{}',
      });
      const badge = document.getElementById('notifBadge');
      if (badge) badge.style.display = 'none';
      const { notifications } = await fetchNotifications();
      renderNotifications(notifications);
    } catch(e) { toast(`Ошибка: ${e.message}`); }
  });

  document.addEventListener('click', e => {
    if (!bell.contains(e.target) && !panel.contains(e.target)) {
      panel.style.display = 'none';
    }
  });

  // Poll for new notifications every 60s
  fetchNotifications(true);
  _notifPollTimer = setInterval(() => fetchNotifications(true), 60000);
}

function setupGlobalSearch() {
  const input = document.getElementById('globalSearchInput');
  const results = document.getElementById('globalSearchResults');
  if (!input || !results) return;

  const TYPE_ICON = { project:'📁', work_item:'✅', location:'📍', asset:'🖥', issue:'⚠', document:'📄' };
  const TYPE_LABEL = { project:'Проект', work_item:'Задача', location:'Локация', asset:'Актив', issue:'Проблема', document:'Документ' };

  let _timer = null;
  let _lastQ = '';

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(_timer);
    if (!q || q.length < 2) { results.style.display = 'none'; return; }
    if (q === _lastQ) return;
    _timer = setTimeout(async () => {
      _lastQ = q;
      try {
        const r = await apiFetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=15`);
        const { results: items = [] } = await r.json();
        if (!items.length) {
          results.innerHTML = '<p style="padding:12px 14px;font-size:12px;color:var(--text-muted)">Ничего не найдено.</p>';
        } else {
          results.innerHTML = items.map(item => `
            <button type="button" data-search-type="${item.type}" data-search-id="${escapeHtml(item.id||'')}" data-search-project="${escapeHtml(item.projectId||item.id||'')}"
              style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 12px;background:none;border:none;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;text-align:left;color:var(--text)">
              <span style="font-size:16px;width:20px;text-align:center">${TYPE_ICON[item.type]||'•'}</span>
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.title)}</div>
                <div style="font-size:10px;color:var(--text-muted)">${TYPE_LABEL[item.type]||item.type}${item.subtitle ? ' · ' + escapeHtml(item.subtitle) : ''}</div>
              </div>
              ${item.status ? `<span style="font-size:9px;font-weight:700;color:#778;text-transform:uppercase">${escapeHtml(item.status)}</span>` : ''}
            </button>`).join('');
        }
        results.style.display = '';
      } catch { results.style.display = 'none'; }
    }, 250);
  });

  results.addEventListener('click', e => {
    const btn = e.target.closest('[data-search-type]');
    if (!btn) return;
    const type = btn.dataset.searchType;
    const projectId = btn.dataset.searchProject;
    results.style.display = 'none';
    input.value = '';
    _lastQ = '';
    if (type === 'project') {
      location.hash = `project/${encodeURIComponent(projectId)}`;
    } else if (type === 'work_item' || type === 'location' || type === 'asset' || type === 'issue') {
      location.hash = `project/${encodeURIComponent(projectId)}`;
    } else if (type === 'document') {
      location.hash = 'projects';
    }
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !results.contains(e.target)) {
      results.style.display = 'none';
    }
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { results.style.display = 'none'; input.blur(); }
  });

  // Cmd+K / Ctrl+K focus global search
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Listen for messages from SW (e.g. flush outbox request)
    navigator.serviceWorker.addEventListener('message', ev => {
      if (ev.data?.type === 'FLUSH_OUTBOX' && navigator.onLine) _flushWriteOutbox();
    });
  }).catch(() => {});  // ignore — SW is enhancement only
}
