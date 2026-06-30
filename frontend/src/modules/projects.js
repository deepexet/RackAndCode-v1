import { apiFetch, apiJSON, apiPost } from '../core/api.js'
import { timeAgo as uiTimeAgo, renderMarkdown, emptyState, openModal } from '../components/ui.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUSES = [
  { id: 'ideas',    label: 'Ideas',       color: '#8b95a5' },
  { id: 'backlog',  label: 'Backlog',     color: '#a78bfa' },
  { id: 'ready',    label: 'Ready',       color: '#4f7ef7' },
  { id: 'progress', label: 'In Progress', color: '#f5a623' },
  { id: 'blocked',  label: 'Blocked',     color: '#f25757' },
  { id: 'review',   label: 'Review',      color: '#2bcba0' },
  { id: 'testing',  label: 'Testing',     color: '#a78bfa' },
  { id: 'done',     label: 'Done',        color: '#4adc84' },
]
const STATUS = Object.fromEntries(STATUSES.map(s => [s.id, s]))

const PRIORITY = {
  critical: { color: '#f25757', label: 'Critical' },
  high:     { color: '#f5a623', label: 'High' },
  medium:   { color: '#4f7ef7', label: 'Medium' },
  low:      { color: '#8b95a5', label: 'Low' },
}

const PROJECT_STATUS = {
  active:    { label: 'Активный',      cls: 'badge--green' },
  planned:   { label: 'Запланирован',  cls: 'badge--blue' },
  on_hold:   { label: 'На паузе',      cls: 'badge--amber' },
  completed: { label: 'Завершён',      cls: 'badge--gray' },
  cancelled: { label: 'Отменён',       cls: 'badge--red' },
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export async function mount(params = []) {
  const view = document.querySelector('[data-view="projects"]')
  if (!view) return

  const projectId = params[0]

  if (projectId) {
    return mountDetail(view, projectId)
  } else {
    return mountList(view)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════════════════════════════════════════

async function mountList(view) {
  view.innerHTML = `
    <div class="page-header">
      <div>
        <p class="eyebrow">ПРОЕКТЫ</p>
        <h1>Projects</h1>
      </div>
      <button class="btn btn-primary" id="newProjectBtn">＋ Проект</button>
    </div>

    <div class="filter-bar">
      <button class="filter-chip active" data-filter="">Все</button>
      <button class="filter-chip" data-filter="active">Активные</button>
      <button class="filter-chip" data-filter="planned">Запланированные</button>
      <button class="filter-chip" data-filter="on_hold">На паузе</button>
      <button class="filter-chip" data-filter="completed">Завершённые</button>
    </div>

    <div id="projectsGrid" class="projects-grid">
      ${skeleton(3, 'height:120px')}
    </div>
  `

  let projects = [], filter = ''

  async function load() {
    try {
      const data = await apiJSON('/api/v1/projects')
      projects = data.projects || []
      render()
    } catch (e) {
      document.getElementById('projectsGrid').innerHTML =
        `<p class="empty-copy">Ошибка: ${esc(e.message)}</p>`
    }
  }

  function render() {
    const grid = document.getElementById('projectsGrid')
    const list = filter ? projects.filter(p => p.status === filter) : projects
    if (!list.length) { grid.innerHTML = '<p class="empty-copy">Нет проектов.</p>'; return }
    grid.innerHTML = list.map(projectCard).join('')
    grid.querySelectorAll('.project-card').forEach(el =>
      el.addEventListener('click', () => { location.hash = `#projects/${el.dataset.id}` })
    )
  }

  view.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      view.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      filter = btn.dataset.filter
      render()
    })
  })

  document.getElementById('newProjectBtn')?.addEventListener('click', () => openProjectForm(load))

  await load()
  return () => { view.innerHTML = '' }
}

function projectCard(p) {
  const wis  = p.workItems || []
  const done = wis.filter(w => w.status === 'done').length
  const total = wis.length
  const pct  = total ? Math.round(done / total * 100) : (p.progress ?? 0)
  const overdue = wis.filter(w =>
    w.status !== 'done' && w.dueDate && w.dueDate < today()
  ).length
  const sc = PROJECT_STATUS[p.status] || { label: p.status, cls: 'badge--gray' }

  return `
    <div class="project-card" data-id="${esc(p.id)}">
      <div class="project-card-head">
        <div style="min-width:0">
          ${p.code ? `<p class="eyebrow">${esc(p.code)}</p>` : ''}
          <h3 class="project-card-name">${esc(p.name)}</h3>
        </div>
        <span class="badge ${sc.cls}">${sc.label}</span>
      </div>
      ${p.description ? `<p class="project-card-desc">${esc(p.description)}</p>` : ''}
      <div class="project-card-meta">
        ${p.targetDate ? `<span>📅 ${p.targetDate}</span>` : ''}
        ${overdue ? `<span style="color:var(--red)">⚠ ${overdue} просрочено</span>` : ''}
        ${total ? `<span>${done}/${total} задач</span>` : ''}
      </div>
      ${total || p.progress ? `
        <div class="progress" style="margin-top:10px">
          <div class="progress-fill" style="width:${pct}%;background:${pct>=80?'var(--green)':pct>=40?'var(--blue)':'var(--amber)'}"></div>
        </div>
        <p style="font-size:11px;color:var(--text-4);margin-top:4px">${pct}%</p>
      ` : ''}
    </div>
  `
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETAIL + KANBAN
// ═══════════════════════════════════════════════════════════════════════════════

async function mountDetail(view, pid) {
  view.innerHTML = `
    <div style="padding:16px 16px 0">
      <a href="#projects" class="back-link">← Проекты</a>
    </div>
    <div id="detailShell" style="padding:16px">
      ${skeleton(1, 'height:60px;margin-bottom:16px')}
      ${skeleton(1, 'height:40px;margin-bottom:16px')}
      ${skeleton(4, 'height:200px')}
    </div>
  `

  // ── Load data ─────────────────────────────────────────────────────────────
  let project, wis = []
  try {
    const data = await apiJSON('/api/v1/projects')
    project = (data.projects || []).find(p => p.id === pid)
    if (!project) throw new Error('Проект не найден')
    wis = project.workItems || []
  } catch (e) {
    document.getElementById('detailShell').innerHTML =
      `<p class="empty-copy">Ошибка: ${esc(e.message)}</p>`
    return
  }

  // ── Breadcrumb ────────────────────────────────────────────────────────────
  const bc = document.getElementById('topbarBreadcrumb')
  if (bc) bc.innerHTML =
    `<a href="#projects">Projects</a> <span style="opacity:.3">/</span> <span>${esc(project.name)}</span>`

  const sc = PROJECT_STATUS[project.status] || { label: project.status, cls: 'badge--gray' }
  const pct = (() => {
    const total = wis.length
    const done  = wis.filter(w => w.status === 'done').length
    return total ? Math.round(done / total * 100) : (project.progress ?? 0)
  })()

  // ── Shell ─────────────────────────────────────────────────────────────────
  view.querySelector('#detailShell').innerHTML = `
    <div class="project-detail-header">
      <div>
        ${project.code ? `<p class="eyebrow">${esc(project.code)}</p>` : ''}
        <h1 style="font-size:20px;font-weight:700;margin:4px 0">${esc(project.name)}</h1>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
          <span class="badge ${sc.cls}">${sc.label}</span>
          ${project.targetDate ? `<span class="badge badge--gray">📅 ${project.targetDate}</span>` : ''}
          <span class="badge badge--gray">${pct}% выполнено</span>
          <span class="badge badge--gray">${wis.length} задач</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn btn-ghost" id="addWiBtn">＋ Задача</button>
        <button class="btn btn-ghost" id="aiWiBtn">✦ AI</button>
      </div>
    </div>

    <div class="tab-bar" id="tabs">
      <button class="tab-btn active" data-tab="kanban">Kanban</button>
      <button class="tab-btn" data-tab="list">Список</button>
      <button class="tab-btn" data-tab="milestones">Вехи</button>
      <button class="tab-btn" data-tab="risks">Риски</button>
      <button class="tab-btn" data-tab="activity">Активность</button>
      <button class="tab-btn" data-tab="wiki">Wiki</button>
    </div>

    <div id="tabContent"></div>
  `

  let activeTab = 'kanban'

  async function reload() {
    try {
      const data = await apiJSON('/api/v1/projects')
      project = (data.projects || []).find(p => p.id === pid) || project
      wis = project.workItems || []
      renderTab(activeTab)
    } catch {}
  }

  function renderTab(tab) {
    activeTab = tab
    const el = document.getElementById('tabContent')
    if (!el) return
    if (tab === 'kanban')     renderKanban(el)
    else if (tab === 'list')  renderList(el)
    else if (tab === 'milestones') renderMilestones(el, pid)
    else if (tab === 'risks') renderRisks(el, pid)
    else if (tab === 'activity') renderActivity(el, pid)
    else if (tab === 'wiki')    renderProjectWiki(el, pid)
  }

  // Tabs
  view.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      view.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      renderTab(btn.dataset.tab)
    })
  })

  // Add WI button
  document.getElementById('addWiBtn')?.addEventListener('click', () =>
    openWiForm(project, 'backlog', reload)
  )

  // AI generate
  document.getElementById('aiWiBtn')?.addEventListener('click', async () => {
    const text = prompt('Опишите задачи проекта. AI создаст 3-7 задач автоматически:')
    if (!text?.trim()) return
    const btn = document.getElementById('aiWiBtn')
    btn.disabled = true; btn.textContent = '✦ Генерирую…'
    try {
      const r = await apiFetch(`/api/v1/projects/${pid}/work-items/ai-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error?.message || r.status)
      window.toast?.(`✦ AI создал ${d.created} задач`, 'success')
      await reload()
    } catch (e) { window.toast?.('Ошибка: ' + e.message, 'error') }
    finally { btn.disabled = false; btn.textContent = '✦ AI' }
  })

  renderTab('kanban')

  return () => {
    view.innerHTML = ''
    const bc = document.getElementById('topbarBreadcrumb')
    if (bc) bc.innerHTML = '<span>Projects</span>'
  }

  // ── KANBAN ─────────────────────────────────────────────────────────────────

  function renderKanban(el) {
    const isMobile = window.innerWidth < 768
    isMobile ? renderKanbanMobile(el) : renderKanbanDesktop(el)
  }

  function renderKanbanDesktop(el) {
    el.innerHTML = `<div class="kanban-board" id="kanbanBoard">
      ${STATUSES.map(col => {
        const cards = wis.filter(w => (w.effectiveStatus || w.status) === col.id)
        return `
          <div class="kanban-col" data-col="${col.id}">
            <div class="kanban-col-head">
              <div style="display:flex;align-items:center;gap:6px">
                <span style="width:8px;height:8px;border-radius:50%;background:${col.color};flex-shrink:0"></span>
                <span class="kanban-col-label">${col.label}</span>
              </div>
              <span class="kanban-count">${cards.length}</span>
            </div>
            <div class="kanban-cards" data-status="${col.id}">
              ${cards.map(wiCard).join('')}
            </div>
            <button class="kanban-add-btn" data-status="${col.id}">＋ Добавить</button>
          </div>
        `
      }).join('')}
    </div>`

    setupDragDrop(el)

    // Keep the first workflow column visible when opening a project.
    requestAnimationFrame(() => {
      const board = el.querySelector('.kanban-board')
      if (board) board.scrollLeft = 0
    })

    el.querySelectorAll('.kanban-card').forEach(card =>
      card.addEventListener('click', () => {
        const wi = wis.find(w => w.id === card.dataset.id)
        if (wi) openWiDetail(wi, project, reload)
      })
    )
    el.querySelectorAll('.kanban-add-btn').forEach(btn =>
      btn.addEventListener('click', () => openWiForm(project, btn.dataset.status, reload))
    )
  }

  function renderKanbanMobile(el) {
    el.innerHTML = `
      <div class="kanban-status-pills" id="statusPills">
        ${STATUSES.map(s => `
          <button class="status-pill" data-status="${s.id}" style="--pill-color:${s.color}">
            ${s.label}
            <span class="pill-count">${wis.filter(w => (w.effectiveStatus||w.status) === s.id).length}</span>
          </button>
        `).join('')}
      </div>
      <div id="kanbanMobileCards"></div>
    `

    let activePill = null

    function showColumn(statusId) {
      activePill = statusId
      el.querySelectorAll('.status-pill').forEach(p => p.classList.toggle('active', p.dataset.status === statusId))
      const col = STATUSES.find(s => s.id === statusId)
      const cards = wis.filter(w => (w.effectiveStatus || w.status) === statusId)
      const container = document.getElementById('kanbanMobileCards')
      container.innerHTML = `
        <div class="kanban-mobile-header" style="border-left:3px solid ${col.color}">
          <strong>${col.label}</strong>
          <span class="kanban-count">${cards.length}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
          ${cards.map(wiCardMobile).join('')}
          <button class="kanban-add-mobile" data-status="${statusId}">＋ Добавить задачу</button>
        </div>
      `
      container.querySelectorAll('[data-wi-id]').forEach(card =>
        card.addEventListener('click', () => {
          const wi = wis.find(w => w.id === card.dataset.wiId)
          if (wi) openWiDetail(wi, project, reload)
        })
      )
      container.querySelector('.kanban-add-mobile')?.addEventListener('click', () =>
        openWiForm(project, statusId, reload)
      )
    }

    // Default: show first non-empty column or 'backlog'
    const firstNonEmpty = STATUSES.find(s => wis.some(w => (w.effectiveStatus||w.status) === s.id))
    showColumn(firstNonEmpty?.id || 'backlog')

    el.querySelectorAll('.status-pill').forEach(p =>
      p.addEventListener('click', () => showColumn(p.dataset.status))
    )
  }

  function setupDragDrop(el) {
    let dragging = null
    el.querySelectorAll('.kanban-card').forEach(card => {
      card.draggable = true
      card.addEventListener('dragstart', e => {
        dragging = card
        card.classList.add('dragging')
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', card.dataset.id)
      })
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging')
        el.querySelectorAll('.kanban-cards').forEach(c => c.classList.remove('drag-over'))
        dragging = null
      })
    })
    el.querySelectorAll('.kanban-cards').forEach(zone => {
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over') })
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
      zone.addEventListener('drop', async e => {
        e.preventDefault()
        zone.classList.remove('drag-over')
        const id = e.dataTransfer.getData('text/plain')
        const newStatus = zone.dataset.status
        const wi = wis.find(w => w.id === id)
        if (!wi || wi.status === newStatus) return
        await patchWiStatus(pid, wi, newStatus, reload)
      })
    })
  }

  // ── LIST ──────────────────────────────────────────────────────────────────

  function renderList(el) {
    if (!wis.length) {
      el.innerHTML = `<div class="empty-state">
        <p class="empty-copy">Нет задач</p>
        <button class="btn btn-primary" id="addFirstWi">＋ Добавить задачу</button>
      </div>`
      document.getElementById('addFirstWi')?.addEventListener('click', () =>
        openWiForm(project, 'backlog', reload))
      return
    }

    el.innerHTML = `
      <div class="wi-list-toolbar">
        <input class="field-input" id="wiSearch" placeholder="Поиск…" style="max-width:260px">
        <select class="field-input" id="wiStatusFilter" style="max-width:160px">
          <option value="">Все статусы</option>
          ${STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="wi-table-wrap">
        <div class="wi-list-head">
          <span>Задача</span>
          <span>Статус</span>
          <span>Приоритет</span>
          <span>Срок</span>
        </div>
        <div id="wiRows"></div>
      </div>
    `

    function renderRows() {
      const q = document.getElementById('wiSearch')?.value.toLowerCase() || ''
      const st = document.getElementById('wiStatusFilter')?.value || ''
      const filtered = wis.filter(w =>
        (!q || w.title.toLowerCase().includes(q)) &&
        (!st || (w.effectiveStatus || w.status) === st)
      )
      const rows = document.getElementById('wiRows')
      if (!rows) return
      if (!filtered.length) { rows.innerHTML = '<p class="empty-copy" style="padding:16px">Ничего не найдено</p>'; return }
      rows.innerHTML = filtered.map(wi => {
        const s = STATUS[wi.effectiveStatus || wi.status] || STATUS.backlog
        const overdue = wi.status !== 'done' && wi.dueDate && wi.dueDate < today()
        const p = PRIORITY[wi.priority] || PRIORITY.medium
        return `
          <div class="wi-row" data-id="${esc(wi.id)}" tabindex="0">
            <div class="wi-row-title">
              ${wi.code ? `<span class="wi-code">${esc(wi.code)}</span>` : ''}
              <span>${esc(wi.title)}</span>
              ${wi.blockedBy?.length ? `<span class="wi-blocked-badge">⛔ заблокирована</span>` : ''}
            </div>
            <span>
              <select class="wi-status-sel" data-id="${esc(wi.id)}">
                ${STATUSES.map(s2 => `<option value="${s2.id}" ${(wi.effectiveStatus||wi.status)===s2.id?'selected':''}>${s2.label}</option>`).join('')}
              </select>
            </span>
            <span class="wi-priority" style="color:${p.color}">${p.label}</span>
            <span style="${overdue?'color:var(--red)':'color:var(--text-3)'}">${wi.dueDate||'—'}${overdue?' ⚠':''}</span>
          </div>
        `
      }).join('')

      rows.querySelectorAll('.wi-row').forEach(row =>
        row.addEventListener('click', e => {
          if (e.target.tagName === 'SELECT') return
          const wi = wis.find(w => w.id === row.dataset.id)
          if (wi) openWiDetail(wi, project, reload)
        })
      )
      rows.querySelectorAll('.wi-status-sel').forEach(sel =>
        sel.addEventListener('change', async () => {
          const wi = wis.find(w => w.id === sel.dataset.id)
          if (wi) await patchWiStatus(pid, wi, sel.value, reload)
        })
      )
    }

    renderRows()
    document.getElementById('wiSearch')?.addEventListener('input', renderRows)
    document.getElementById('wiStatusFilter')?.addEventListener('change', renderRows)
  }

  // ── MILESTONES ────────────────────────────────────────────────────────────

  async function renderMilestones(el, pid) {
    el.innerHTML = skeleton(3, 'height:60px')
    try {
      const d = await apiJSON(`/api/v1/projects/${pid}/milestones`).catch(() => ({ milestones: [] }))
      const items = d.milestones || []
      if (!items.length) { el.innerHTML = '<p class="empty-copy">Нет вех.</p>'; return }
      el.innerHTML = `<div class="milestones-list">${items.map(m => {
        const overdue = m.status !== 'complete' && m.dueDate && m.dueDate < today()
        return `<div class="milestone-item ${m.status==='complete'?'milestone--done':''}">
          <div class="milestone-dot ${m.status==='complete'?'dot--done':overdue?'dot--overdue':''}"></div>
          <div style="flex:1">
            <strong>${esc(m.name)}</strong>
            ${m.dueDate ? `<span style="font-size:12px;color:${overdue?'var(--red)':'var(--text-3)'};margin-left:8px">${m.dueDate}</span>` : ''}
            ${m.description ? `<p style="font-size:12px;color:var(--text-3);margin-top:4px">${esc(m.description)}</p>` : ''}
          </div>
          <span class="badge ${m.status==='complete'?'badge--green':overdue?'badge--red':'badge--blue'}">
            ${m.status==='complete'?'Готово':overdue?'Просрочено':'В работе'}
          </span>
        </div>`
      }).join('')}</div>`
    } catch (e) { el.innerHTML = `<p class="empty-copy">Ошибка: ${esc(e.message)}</p>` }
  }

  // ── RISKS ─────────────────────────────────────────────────────────────────

  async function renderRisks(el, pid) {
    el.innerHTML = skeleton(2, 'height:80px')
    try {
      const d = await apiJSON(`/api/v1/projects/${pid}/risks`).catch(() => ({ risks: [] }))
      const items = d.risks || []
      if (!items.length) { el.innerHTML = '<p class="empty-copy">Нет рисков.</p>'; return }
      el.innerHTML = `<div class="risks-grid">${items.map(r => {
        const c = { critical:'#f25757', high:'#f5a623', medium:'#4f7ef7', low:'#2bcba0' }[r.impact]||'#8b95a5'
        return `<div class="risk-card">
          <div class="risk-head">
            <strong>${esc(r.title)}</strong>
            <span class="badge" style="background:${c}22;color:${c}">${r.impact||'medium'}</span>
          </div>
          ${r.description?`<p class="risk-desc">${esc(r.description)}</p>`:''}
          ${r.mitigation?`<div class="risk-mitigation"><span class="eyebrow">Митигация</span>${esc(r.mitigation)}</div>`:''}
        </div>`
      }).join('')}</div>`
    } catch (e) { el.innerHTML = `<p class="empty-copy">Ошибка: ${esc(e.message)}</p>` }
  }

  // ── ACTIVITY ──────────────────────────────────────────────────────────────

  async function renderActivity(el, pid) {
    el.innerHTML = skeleton(5, 'height:40px')
    try {
      const d = await apiJSON(`/api/v1/projects/${pid}/activity`).catch(() => ({ entries: [] }))
      const items = d.entries || d.activity || []
      if (!items.length) { el.innerHTML = '<p class="empty-copy">Нет активности.</p>'; return }
      el.innerHTML = `<div class="activity-feed">${items.map(e => `
        <div class="activity-item">
          <div class="activity-dot"></div>
          <div class="activity-body">
            <p class="activity-text">${esc(e.description||e.text||e.action||'')}</p>
            <time class="activity-time">${relTime(e.createdAt||e.created_at)}</time>
          </div>
        </div>
      `).join('')}</div>`
    } catch (e) { el.innerHTML = `<p class="empty-copy">Ошибка: ${esc(e.message)}</p>` }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORK ITEM CARDS
// ═══════════════════════════════════════════════════════════════════════════════

function wiCard(wi) {
  const st = STATUS[wi.effectiveStatus || wi.status] || STATUS.backlog
  const p  = PRIORITY[wi.priority] || PRIORITY.medium
  const overdue = wi.status !== 'done' && wi.dueDate && wi.dueDate < today()
  const blocked = wi.blockedBy?.length > 0

  return `
    <div class="kanban-card ${blocked?'kanban-card--blocked':''}" data-id="${esc(wi.id)}" draggable="true">
      ${wi.code ? `<span class="wi-code">${esc(wi.code)}</span>` : ''}
      <p class="kanban-card-title">${esc(wi.title)}</p>
      <div class="kanban-card-footer">
        ${wi.priority !== 'medium' ? `<span class="wi-prio-dot" style="background:${p.color}" title="${p.label}"></span>` : ''}
        ${wi.labels?.length ? `<span class="wi-label-dot" style="background:#a78bfa" title="${wi.labels.join(', ')}"></span>` : ''}
        <span style="flex:1"></span>
        ${blocked ? `<span style="font-size:10px;color:var(--red)" title="Заблокирована">⛔</span>` : ''}
        ${overdue ? `<span style="font-size:10px;color:var(--red)" title="Просрочено">⚠</span>` : ''}
        ${wi.dueDate ? `<span class="kanban-card-due ${overdue?'due--overdue':''}">${wi.dueDate.slice(5)}</span>` : ''}
        ${wi.assigneeName ? `<span class="wi-avatar" title="${esc(wi.assigneeName)}">${wi.assigneeName[0]}</span>` : ''}
      </div>
    </div>
  `
}

function wiCardMobile(wi) {
  const st = STATUS[wi.effectiveStatus || wi.status] || STATUS.backlog
  const overdue = wi.status !== 'done' && wi.dueDate && wi.dueDate < today()
  return `
    <div class="wo-item" data-wi-id="${esc(wi.id)}" style="cursor:pointer">
      <div class="wo-header">
        <div style="min-width:0">
          ${wi.code ? `<span class="eyebrow">${esc(wi.code)}</span>` : ''}
          <strong style="display:block;font-size:13px">${esc(wi.title)}</strong>
        </div>
        ${wi.priority && wi.priority !== 'medium' ? `<span style="color:${PRIORITY[wi.priority].color};font-size:10px;font-weight:700;flex-shrink:0">${wi.priority.toUpperCase()}</span>` : ''}
      </div>
      <div class="wo-meta">
        ${wi.dueDate ? `<span style="${overdue?'color:var(--red)':''}">📅 ${wi.dueDate}</span>` : ''}
        ${wi.assigneeName ? `<span>👤 ${esc(wi.assigneeName)}</span>` : ''}
        ${wi.blockedBy?.length ? `<span style="color:var(--red)">⛔ заблокирована</span>` : ''}
      </div>
    </div>
  `
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORK ITEM DETAIL MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function openWiDetail(wi, project, onSave) {
  modal('wiDetail', `
    <div class="modal-head">
      <div style="min-width:0">
        ${wi.code ? `<p class="eyebrow">${esc(wi.code)}</p>` : ''}
        <h2 style="font-size:16px;margin-top:4px">${esc(wi.title)}</h2>
      </div>
      <button class="icon-btn" data-close>×</button>
    </div>

    <div class="wi-detail-meta">
      <div class="wi-detail-field">
        <label class="field-label">Статус</label>
        <select class="field-input" id="wdStatus">
          ${STATUSES.map(s => `<option value="${s.id}" ${(wi.effectiveStatus||wi.status)===s.id?'selected':''}>${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="wi-detail-field">
        <label class="field-label">Приоритет</label>
        <select class="field-input" id="wdPriority">
          ${Object.entries(PRIORITY).map(([k,v]) => `<option value="${k}" ${wi.priority===k?'selected':''}>${v.label}</option>`).join('')}
        </select>
      </div>
      <div class="wi-detail-field">
        <label class="field-label">Срок</label>
        <input class="field-input" type="date" id="wdDue" value="${wi.dueDate||''}">
      </div>
      <div class="wi-detail-field">
        <label class="field-label">Оценка (ч)</label>
        <input class="field-input" type="number" id="wdEst" min="0" step="0.5" value="${wi.estimatedMinutes ? wi.estimatedMinutes/60 : ''}">
      </div>
    </div>

    ${wi.description ? `
      <div style="margin:16px 0">
        <label class="field-label">Описание</label>
        <p style="font-size:13px;color:var(--text-2);line-height:1.6;white-space:pre-wrap">${esc(wi.description)}</p>
      </div>` : ''}

    ${wi.blockedBy?.length ? `
      <div class="wi-blocked-banner">
        ⛔ Заблокирована задачами: ${wi.blockedBy.map(b => esc(b)).join(', ')}
      </div>` : ''}

    <div class="modal-actions" style="margin-top:20px">
      <button class="btn btn-ghost" data-close>Закрыть</button>
      <button class="btn btn-primary" id="wdSave">Сохранить</button>
    </div>
  `)

  document.getElementById('wdSave')?.addEventListener('click', async () => {
    const btn = document.getElementById('wdSave')
    btn.disabled = true; btn.textContent = 'Сохраняю…'
    const est = parseFloat(document.getElementById('wdEst')?.value)
    try {
      const r = await apiFetch(`/api/v1/projects/${project.id}/work-items/${wi.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status:           document.getElementById('wdStatus').value,
          priority:         document.getElementById('wdPriority').value,
          dueDate:          document.getElementById('wdDue').value || null,
          estimatedMinutes: est ? Math.round(est * 60) : null,
          expectedVersion: wi.version,
        }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.error?.message || r.status) }
      window.toast?.('Задача обновлена', 'success')
      closeModal('wiDetail')
      await onSave()
    } catch (e) {
      window.toast?.('Ошибка: ' + e.message, 'error')
      btn.disabled = false; btn.textContent = 'Сохранить'
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORK ITEM CREATE FORM
// ═══════════════════════════════════════════════════════════════════════════════

function openWiForm(project, defaultStatus = 'backlog', onSave) {
  modal('wiForm', `
    <div class="modal-head">
      <div><p class="eyebrow">НОВАЯ ЗАДАЧА</p><h2>Work Item</h2></div>
      <button class="icon-btn" data-close>×</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <label class="field-label">Название *
        <input class="field-input" id="wfTitle" required maxlength="200" placeholder="Что нужно сделать…">
      </label>
      <label class="field-label">Описание
        <textarea class="field-textarea" id="wfDesc" rows="3" maxlength="2000"></textarea>
      </label>
      <div class="form-row">
        <label class="field-label">Статус
          <select class="field-input" id="wfStatus">
            ${STATUSES.map(s => `<option value="${s.id}" ${s.id===defaultStatus?'selected':''}>${s.label}</option>`).join('')}
          </select>
        </label>
        <label class="field-label">Приоритет
          <select class="field-input" id="wfPriority">
            ${Object.entries(PRIORITY).map(([k,v]) => `<option value="${k}" ${k==='medium'?'selected':''}>${v.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="form-row">
        <label class="field-label">Начало <input class="field-input" type="date" id="wfStart"></label>
        <label class="field-label">Срок <input class="field-input" type="date" id="wfDue"></label>
        <label class="field-label">Оценка (ч) <input class="field-input" type="number" id="wfEst" min="0" step="0.5" placeholder="0"></label>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close>Отмена</button>
      <button class="btn btn-primary" id="wfSubmit">Создать</button>
    </div>
  `)

  document.getElementById('wfTitle')?.focus()

  document.getElementById('wfSubmit')?.addEventListener('click', async () => {
    const title = document.getElementById('wfTitle')?.value.trim()
    if (!title) { document.getElementById('wfTitle').focus(); return }
    const btn = document.getElementById('wfSubmit')
    btn.disabled = true; btn.textContent = 'Создаю…'
    const est = parseFloat(document.getElementById('wfEst')?.value)
    try {
      const r = await apiFetch(`/api/v1/projects/${project.id}/work-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: document.getElementById('wfDesc')?.value.trim() || '',
          status:      document.getElementById('wfStatus')?.value || defaultStatus,
          priority:    document.getElementById('wfPriority')?.value || 'medium',
          startDate:   document.getElementById('wfStart')?.value || null,
          dueDate:     document.getElementById('wfDue')?.value || null,
          estimatedMinutes: est ? Math.round(est * 60) : null,
          sourceType: 'user',
        }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.error?.message || r.status) }
      window.toast?.('Задача создана', 'success')
      closeModal('wiForm')
      await onSave()
    } catch (e) {
      window.toast?.('Ошибка: ' + e.message, 'error')
      btn.disabled = false; btn.textContent = 'Создать'
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT CREATE FORM
// ═══════════════════════════════════════════════════════════════════════════════

function openProjectForm(onSave) {
  modal('projectForm', `
    <div class="modal-head">
      <div><p class="eyebrow">НОВЫЙ ПРОЕКТ</p><h2>Проект</h2></div>
      <button class="icon-btn" data-close>×</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <label class="field-label">Название *
        <input class="field-input" id="pfName" required maxlength="120" placeholder="Название проекта">
      </label>
      <div class="form-row">
        <label class="field-label">Код <input class="field-input" id="pfCode" maxlength="20" placeholder="PRJ-01"></label>
        <label class="field-label">Статус
          <select class="field-input" id="pfStatus">
            <option value="planned">Запланирован</option>
            <option value="active">Активный</option>
            <option value="on_hold">На паузе</option>
          </select>
        </label>
      </div>
      <label class="field-label">Описание
        <textarea class="field-textarea" id="pfDesc" rows="3" maxlength="1000"></textarea>
      </label>
      <div class="form-row">
        <label class="field-label">Начало <input class="field-input" type="date" id="pfStart"></label>
        <label class="field-label">Окончание <input class="field-input" type="date" id="pfEnd"></label>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close>Отмена</button>
      <button class="btn btn-primary" id="pfSubmit">Создать</button>
    </div>
  `)

  document.getElementById('pfName')?.focus()

  document.getElementById('pfSubmit')?.addEventListener('click', async () => {
    const name = document.getElementById('pfName')?.value.trim()
    if (!name) { document.getElementById('pfName').focus(); return }
    const btn = document.getElementById('pfSubmit')
    btn.disabled = true; btn.textContent = 'Создаю…'
    try {
      const r = await apiFetch('/api/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          code:        document.getElementById('pfCode')?.value.trim() || undefined,
          description: document.getElementById('pfDesc')?.value.trim() || '',
          status:      document.getElementById('pfStatus')?.value || 'planned',
          startDate:   document.getElementById('pfStart')?.value || null,
          targetDate:  document.getElementById('pfEnd')?.value || null,
        }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.error?.message || r.status) }
      window.toast?.('Проект создан', 'success')
      closeModal('projectForm')
      await onSave()
    } catch (e) {
      window.toast?.('Ошибка: ' + e.message, 'error')
      btn.disabled = false; btn.textContent = 'Создать'
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function patchWiStatus(pid, wi, newStatus, reload) {
  const oldStatus = wi.status
  wi.status = newStatus
  wi.effectiveStatus = newStatus
  try {
    const r = await apiFetch(`/api/v1/projects/${pid}/work-items/${wi.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, version: wi.version }),
    })
    if (!r.ok) throw new Error((await r.json()).error?.message || r.status)
    wi.version = (wi.version || 1) + 1
    window.toast?.(`→ ${STATUS[newStatus]?.label || newStatus}`, 'info')
    await reload()
  } catch (e) {
    wi.status = oldStatus
    wi.effectiveStatus = oldStatus
    window.toast?.('Ошибка: ' + e.message, 'error')
    await reload()
  }
}

function modal(id, html) {
  closeModal(id)
  const el = document.createElement('div')
  el.id = `modal-${id}`
  el.className = 'modal-overlay'
  el.innerHTML = `<div class="modal-box">${html}</div>`
  document.body.appendChild(el)
  el.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(id)))
  el.addEventListener('click', e => { if (e.target === el) closeModal(id) })
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { closeModal(id); document.removeEventListener('keydown', esc) }
  })
}

function closeModal(id) {
  document.getElementById(`modal-${id}`)?.remove()
}

function skeleton(n, style = 'height:60px') {
  return Array.from({length: n}, () =>
    `<div class="skeleton" style="${style};border-radius:10px;margin-bottom:8px"></div>`
  ).join('')
}

function today() { return new Date().toISOString().slice(0, 10) }

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function relTime(iso) {
  if (!iso) return ''
  const d = Date.now() - new Date(iso).getTime()
  if (d < 60000)    return 'только что'
  if (d < 3600000)  return `${Math.floor(d/60000)}м назад`
  if (d < 86400000) return `${Math.floor(d/3600000)}ч назад`
  return `${Math.floor(d/86400000)}д назад`
}

// ── Per-project Wiki ──────────────────────────────────────────────────────

const WIKI_CAT_ICONS = { 'Схемы':'ti-circuit-switchboard', 'Доступы':'ti-key', 'Конфигурации':'ti-settings', 'Процедуры':'ti-checklist', 'Контакты':'ti-phone', 'Общее':'ti-file-text' }
const WIKI_PRESET_CATS = ['Схемы', 'Доступы', 'Конфигурации', 'Процедуры', 'Контакты', 'Общее']

async function renderProjectWiki(el, pid) {
  el.innerHTML = '<div class="pwiki-loading"><i class="ti ti-loader-2" style="animation:ui-spin 0.8s linear infinite"></i> Загрузка…</div>'
  let pages = [], selectedId = null

  async function load() {
    const d = await apiJSON(`/api/v1/wiki/projects/${pid}`)
    pages = d.pages || []
  }

  function render() {
    const selected = selectedId ? pages.find(p => p.id === selectedId) : null
    el.innerHTML = `
      <div class="pwiki-layout">
        <aside class="pwiki-sidebar">
          <div class="pwiki-sidebar-top">
            <span class="pwiki-sidebar-label"><i class="ti ti-notebook"></i> Документация проекта</span>
            <button class="pwiki-add-btn" id="pwiki-new"><i class="ti ti-plus"></i></button>
          </div>
          <nav class="pwiki-nav">
            ${!pages.length
              ? `<div class="pwiki-empty-nav">Нет страниц</div>`
              : pages.map(p => `
                <button class="pwiki-nav-item ${p.id === selectedId ? 'active' : ''}" data-id="${esc(p.id)}">
                  <i class="ti ${WIKI_CAT_ICONS[p.category] || 'ti-file-text'} pwiki-nav-icon"></i>
                  <div class="pwiki-nav-info">
                    <span class="pwiki-nav-title">${esc(p.title)}</span>
                    <span class="pwiki-nav-cat">${esc(p.category || 'Общее')}</span>
                  </div>
                </button>`).join('')}
          </nav>
        </aside>
        <div class="pwiki-content">
          ${selected ? renderWikiPage(selected, pages) : renderWikiWelcome(pages, pid)}
        </div>
      </div>`
    bindEvents()
  }

  function renderWikiWelcome(pages) {
    if (!pages.length) return `
      <div class="pwiki-welcome">
        <i class="ti ti-notebook pwiki-welcome-icon"></i>
        <h3>Документация проекта</h3>
        <p>Добавьте схемы, доступы и конфигурации специфичные для этого проекта.</p>
        <button class="wiki-create-first" id="pwiki-new-2"><i class="ti ti-plus"></i> Добавить страницу</button>
      </div>`
    return `
      <div class="pwiki-welcome">
        <i class="ti ti-notebook pwiki-welcome-icon"></i>
        <h3>Документация проекта</h3>
        <p>${pages.length} стр. — выберите слева или <button class="wiki-link-btn" id="pwiki-new-3">добавьте новую</button></p>
        <div class="pwiki-page-list">
          ${pages.map(p => `
            <button class="pwiki-page-card" data-id="${esc(p.id)}">
              <i class="ti ${WIKI_CAT_ICONS[p.category] || 'ti-file-text'}"></i>
              <div><div class="pwiki-card-title">${esc(p.title)}</div>
              <div class="pwiki-card-meta">${esc(p.category || 'Общее')} · ${uiTimeAgo(p.updated_at)}</div></div>
            </button>`).join('')}
        </div>
      </div>`
  }

  function renderWikiPage(p, all) {
    const idx = all.indexOf(p)
    let tags = []
    try { tags = typeof p.tags === 'string' ? JSON.parse(p.tags) : (p.tags || []) } catch {}
    return `
      <div class="pwiki-page">
        <div class="pwiki-page-head">
          <div class="pwiki-page-breadcrumb">${esc(p.category || 'Общее')} ${tags.map(t => `<span class="wiki-tag">${esc(t)}</span>`).join('')}</div>
          <div style="display:flex;gap:4px">
            <button class="wiki-action-btn" data-action="edit" data-id="${esc(p.id)}"><i class="ti ti-edit"></i></button>
            <button class="wiki-action-btn wiki-action-btn--danger" data-action="delete" data-id="${esc(p.id)}"><i class="ti ti-trash"></i></button>
          </div>
        </div>
        <h2 class="pwiki-page-title">${esc(p.title)}</h2>
        <div class="wiki-page-dates">${uiTimeAgo(p.updated_at)}${p.updated_by ? ` · ${esc(p.updated_by)}` : ''}</div>
        <div class="wiki-page-body">${p.content ? renderMarkdown(p.content) : emptyState({ icon: 'ti-file-off', title: 'Пустая страница' })}</div>
        <div class="wiki-page-nav">
          ${all[idx-1] ? `<button class="wiki-nav-btn" data-id="${esc(all[idx-1].id)}"><i class="ti ti-arrow-left"></i> ${esc(all[idx-1].title)}</button>` : '<span></span>'}
          ${all[idx+1] ? `<button class="wiki-nav-btn" data-id="${esc(all[idx+1].id)}">${esc(all[idx+1].title)} <i class="ti ti-arrow-right"></i></button>` : '<span></span>'}
        </div>
      </div>`
  }

  function openWikiModal(page = null) {
    const { close } = openModal({
      title: page ? 'Редактировать' : 'Новая страница',
      maxWidth: '640px',
      body: `<form class="ui-form" id="pwiki-form">
        <div class="ui-form-row"><label>Название</label>
          <input class="ui-input" name="title" value="${esc(page?.title || '')}" placeholder="Название…" required></div>
        <div class="ui-form-row"><label>Раздел</label>
          <select class="ui-input" name="category">
            ${WIKI_PRESET_CATS.map(c => `<option value="${esc(c)}" ${page?.category===c?'selected':''}>${esc(c)}</option>`).join('')}
          </select></div>
        <div class="ui-form-row"><label>Теги (через запятую)</label>
          <input class="ui-input" name="tags" value="${esc((() => { try { return (typeof page?.tags==='string'?JSON.parse(page?.tags||'[]'):page?.tags||[]).join(', ') } catch{return''} })())}"></div>
        <div class="ui-form-row"><label>Контент (Markdown)</label>
          <textarea class="ui-input wiki-textarea" name="content" rows="10">${esc(page?.content || '')}</textarea></div>
      </form>`,
      footer: `<button class="ui-btn ui-btn--primary" id="pwiki-save">Сохранить</button>
               <button class="ui-btn" id="pwiki-cancel">Отмена</button>`,
    })
    document.getElementById('pwiki-cancel')?.addEventListener('click', close)
    document.getElementById('pwiki-save')?.addEventListener('click', async () => {
      const fd = Object.fromEntries(new FormData(document.getElementById('pwiki-form')))
      if (!fd.title?.trim()) { window.toast?.('Введите название', 'error'); return }
      const tags = fd.tags ? fd.tags.split(',').map(t => t.trim()).filter(Boolean) : []
      try {
        if (page) {
          await apiPost(`/api/v1/wiki/${page.id}`, { title: fd.title, category: fd.category, content: fd.content || '', tags })
        } else {
          await apiPost(`/api/v1/wiki/projects/${pid}`, { title: fd.title, category: fd.category, content: fd.content || '', tags })
        }
        close()
        window.toast?.('Сохранено', 'success')
        await load()
        if (page) selectedId = page.id
        render()
      } catch (err) { window.toast?.(`Ошибка: ${err.message}`, 'error') }
    })
  }

  function bindEvents() {
    el.querySelectorAll('[data-id]').forEach(btn =>
      btn.addEventListener('click', () => { selectedId = btn.dataset.id; el.querySelector('.pwiki-content')?.scrollTo(0, 0); render() })
    )
    const openNew = () => openWikiModal()
    document.getElementById('pwiki-new')?.addEventListener('click', openNew)
    document.getElementById('pwiki-new-2')?.addEventListener('click', openNew)
    document.getElementById('pwiki-new-3')?.addEventListener('click', openNew)
    el.querySelectorAll('[data-action="edit"]').forEach(btn =>
      btn.addEventListener('click', () => { const p = pages.find(x => x.id === btn.dataset.id); if (p) openWikiModal(p) })
    )
    el.querySelectorAll('[data-action="delete"]').forEach(btn =>
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить?')) return
        await apiPost(`/api/v1/wiki/${btn.dataset.id}/delete`, {})
        if (selectedId === btn.dataset.id) selectedId = null
        window.toast?.('Удалено', 'info')
        await load(); render()
      })
    )
  }

  try {
    await load()
    render()
  } catch (err) {
    el.innerHTML = emptyState({ icon: 'ti-alert-circle', title: 'Ошибка', message: err.message })
  }
}
