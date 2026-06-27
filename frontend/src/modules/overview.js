import { apiJSON } from '../core/api.js'
import { createStore } from '../core/store.js'

const state = createStore({ kpi: null, projects: [], activity: [], loading: true })

export async function mount() {
  const el = document.querySelector('[data-view="overview"]')
  if (!el) return unmount
  renderSkeleton(el)
  try {
    const [kpiData, projectsData, notifData] = await Promise.all([
      apiJSON('/api/v1/overview/kpi').catch(() => null),
      apiJSON('/api/v1/projects').catch(() => ({ projects: [] })),
      apiJSON('/api/v1/notifications').catch(() => ({ notifications: [] })),
    ])
    state.set({
      loading: false,
      kpi: kpiData || { activeProjects: 0, openWorkOrders: 0, stockAlerts: 0, techsOnline: 0 },
      projects: (projectsData.projects || []).filter(p => p.status !== 'completed').slice(0, 4),
      activity: (notifData.notifications || []).slice(0, 5),
    })
    renderFull(el, state.get())
  } catch {
    state.set({ loading: false })
    renderFull(el, state.get())
  }
  return unmount
}

function renderSkeleton(el) {
  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="skeleton" style="width:200px;height:22px;margin-bottom:6px;border-radius:6px"></div>
        <div class="skeleton" style="width:260px;height:13px;border-radius:6px"></div>
      </div>
    </div>
    <div class="kpi-grid">
      ${[0,1,2,3].map(() => `
        <div class="kpi-card">
          <div class="skeleton" style="width:70%;height:11px;margin-bottom:10px;border-radius:4px"></div>
          <div class="skeleton" style="width:50%;height:26px;border-radius:4px"></div>
        </div>`).join('')}
    </div>
    <div class="card">
      ${[0,1,2].map(() => `
        <div class="card-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="skeleton" style="width:55%;height:12px;border-radius:4px"></div>
          <div class="skeleton" style="height:4px;border-radius:2px"></div>
        </div>`).join('')}
    </div>`
}

function renderFull(el, s) {
  const k = s.kpi || {}
  const hour = new Date().getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${greet}</div>
        <div class="page-sub">${fmtToday()} · ${k.activeProjects ?? 0} active projects · ${k.openWorkOrders ?? 0} open WOs</div>
      </div>
      <button class="btn btn--primary" id="ov-new">
        <i class="ti ti-plus" aria-hidden="true"></i> New project
      </button>
    </div>

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Active projects</div>
        <div class="kpi-value">${k.activeProjects ?? 0}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Open work orders</div>
        <div class="kpi-value">${k.openWorkOrders ?? 0}</div>
        ${k.overdueCount > 0 ? `<div class="kpi-delta down">${k.overdueCount} overdue</div>` : ''}
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Stock alerts</div>
        <div class="kpi-value" style="${k.stockAlerts > 0 ? 'color:var(--amber)' : ''}">${k.stockAlerts ?? 0}</div>
        ${k.stockAlerts > 0 ? '<div class="kpi-delta down">Low / out of stock</div>' : ''}
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Techs online</div>
        <div class="kpi-value">${k.techsOnline ?? 0}</div>
      </div>
    </div>

    ${s.projects.length > 0 ? projectsBlock(s.projects) : emptyProjects()}
    ${s.activity.length > 0 ? activityBlock(s.activity) : ''}
  `
  el.querySelector('#ov-new')?.addEventListener('click', () => { location.hash = '#projects' })
}

function projectsBlock(projects) {
  return `
    <div class="card mb-20">
      <div class="card-header">
        <span class="card-title">Active projects</span>
        <a class="card-link" href="#projects">View all</a>
      </div>
      ${projects.map(p => `
        <div class="card-row" style="flex-direction:column;align-items:stretch;cursor:pointer;gap:0"
             onclick="location.hash='#projects/${p.id}'">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
            <div>
              <div style="font-size:13px;font-weight:500;color:var(--text-2)">${esc(p.name)}</div>
              <div style="font-size:11px;color:var(--text-4)">${esc(p.type || '')}${p.location ? ' · ' + esc(p.location) : ''}</div>
            </div>
            ${statusBadge(p.status)}
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <div class="progress" style="flex:1">
              <div class="progress-fill" style="width:${Math.round(p.progress ?? 0)}%;background:${progressColor(p.status)}"></div>
            </div>
            <span style="font-size:11px;color:var(--text-4)">${Math.round(p.progress ?? 0)}%</span>
            ${p.dueDate ? `<span style="font-size:11px;color:${overdue(p.dueDate) ? 'var(--red)' : 'var(--text-4)'}">${fmtDate(p.dueDate)}</span>` : ''}
          </div>
        </div>`).join('')}
    </div>`
}

function activityBlock(items) {
  const col = { info:'var(--blue)', warning:'var(--amber)', success:'var(--green)', error:'var(--red)' }
  return `
    <div class="card">
      <div class="card-header"><span class="card-title">Recent activity</span></div>
      ${items.map(n => `
        <div class="activity-item">
          <div class="activity-dot" style="background:${col[n.type] || 'var(--text-4)'}"></div>
          <div>
            <div class="activity-text">${esc(n.message || n.title || '')}</div>
            <div class="activity-time">${relTime(n.createdAt)}</div>
          </div>
        </div>`).join('')}
    </div>`
}

function emptyProjects() {
  return `<div class="card" style="padding:36px;text-align:center">
    <i class="ti ti-briefcase" style="font-size:32px;color:var(--text-4);display:block;margin-bottom:10px"></i>
    <div style="font-size:14px;color:var(--text-2);margin-bottom:5px">No active projects</div>
    <div style="font-size:12px;color:var(--text-4)">Create your first project to get started.</div>
  </div>`
}

export function unmount() {}

function statusBadge(status) {
  const m = { active:'badge--blue', in_progress:'badge--blue', at_risk:'badge--amber', on_hold:'badge--gray', planning:'badge--purple', completed:'badge--green' }
  const l = { active:'In progress', in_progress:'In progress', at_risk:'At risk', on_hold:'On hold', planning:'Planning', completed:'Completed' }
  const cls = m[status] || 'badge--gray'
  return `<span class="badge ${cls}">${l[status] || esc(status) || '—'}</span>`
}

function progressColor(s) {
  return { at_risk:'var(--amber)', on_hold:'var(--text-4)', completed:'var(--green)' }[s] || 'var(--blue)'
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function fmtToday() {
  return new Intl.DateTimeFormat('en-GB', { weekday:'short', day:'numeric', month:'short' }).format(new Date())
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-GB', { day:'numeric', month:'short' }).format(new Date(iso))
}

function overdue(iso) { return iso && new Date(iso) < new Date() }

function relTime(iso) {
  if (!iso) return ''
  const m = Math.floor((Date.now() - new Date(iso)) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
