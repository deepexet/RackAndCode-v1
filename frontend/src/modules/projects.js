import { apiGet, apiPost } from '../core/api.js'

// ── Constants ──────────────────────────────────────────────────────────────

const STATUSES = [
  { id: 'ideas',    label: 'Ideas',      color: '#8b95a5' },
  { id: 'backlog',  label: 'Backlog',    color: '#a78bfa' },
  { id: 'ready',    label: 'Ready',      color: '#4f7ef7' },
  { id: 'progress', label: 'In Progress',color: '#f5a623' },
  { id: 'blocked',  label: 'Blocked',    color: '#f25757' },
  { id: 'review',   label: 'Review',     color: '#2bcba0' },
  { id: 'testing',  label: 'Testing',    color: '#a78bfa' },
  { id: 'done',     label: 'Done',       color: '#4adc84' },
]

const STATUS_MAP = Object.fromEntries(STATUSES.map(s => [s.id, s]))

const PRIORITY_COLOR = {
  critical: '#f25757', high: '#f5a623', medium: '#4f7ef7', low: '#8b95a5',
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function mount(params = []) {
  const view = document.querySelector('[data-view="projects"]')
  if (!view) return

  const projectId = params[0]

  if (projectId) {
    await mountDetail(view, projectId)
  } else {
    await mountList(view)
  }

  return () => { view.innerHTML = '' }
}

// ══════════════════════════════════════════════════════════════════════════
// PROJECT LIST
// ══════════════════════════════════════════════════════════════════════════

async function mountList(view) {
  view.innerHTML = `
    <div class="page-header">
      <div>
        <p class="eyebrow">PROJECTS</p>
        <h1>Проекты</h1>
      </div>
      <button class="btn btn-primary" id="newProjectBtn">＋ Проект</button>
    </div>
    <div class="filter-bar" id="projectFilters">
      <button class="filter-chip active" data-filter="">Все</button>
      <button class="filter-chip" data-filter="active">Активные</button>
      <button class="filter-chip" data-filter="planned">Запланированные</button>
      <button class="filter-chip" data-filter="completed">Завершённые</button>
    </div>
    <div id="projectsGrid" class="projects-grid">
      ${skeletonCards(6)}
    </div>
    <div id="projectFormModal" class="modal-overlay" style="display:none">
      <div class="modal-box">
        <div class="modal-head">
          <div><p class="eyebrow">NEW PROJECT</p><h2>Новый проект</h2></div>
          <button class="icon-btn" id="closeProjectForm">×</button>
        </div>
        <form id="projectForm">
          <label class="field-label">Название *
            <input class="field-input" id="pName" required maxlength="120" placeholder="Название проекта">
          </label>
          <label class="field-label">Код
            <input class="field-input" id="pCode" maxlength="20" placeholder="PRJ-01">
          </label>
          <label class="field-label">Описание
            <textarea class="field-textarea" id="pDesc" rows="3" maxlength="1000"></textarea>
          </label>
          <div class="form-row">
            <label class="field-label">Статус
              <select class="field-input" id="pStatus">
                <option value="planned">Запланирован</option>
                <option value="active">Активный</option>
                <option value="on_hold">На паузе</option>
              </select>
            </label>
            <label class="field-label">Дата начала
              <input class="field-input" id="pStart" type="date">
            </label>
            <label class="field-label">Дата окончания
              <input class="field-input" id="pEnd" type="date">
            </label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" id="cancelProjectForm">Отмена</button>
            <button type="submit" class="btn btn-primary">Создать</button>
          </div>
        </form>
      </div>
    </div>
  `

  let projects = []
  let filterStatus = ''

  async function loadProjects() {
    try {
      const data = await apiGet('/api/v1/projects')
      projects = data.projects || []
      renderList()
    } catch (e) {
      document.getElementById('projectsGrid').innerHTML =
        `<p class="empty-copy">Ошибка загрузки: ${esc(e.message)}</p>`
    }
  }

  function renderList() {
    const grid = document.getElementById('projectsGrid')
    const filtered = filterStatus ? projects.filter(p => p.status === filterStatus) : projects
    if (!filtered.length) {
      grid.innerHTML = '<p class="empty-copy">Нет проектов.</p>'
      return
    }
    grid.innerHTML = filtered.map(p => projectCard(p)).join('')
    grid.querySelectorAll('[data-project-id]').forEach(card => {
      card.addEventListener('click', () => {
        location.hash = '#projects/' + card.dataset.projectId
      })
    })
  }

  // Filters
  view.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      view.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      filterStatus = btn.dataset.filter
      renderList()
    })
  })

  // New project modal
  document.getElementById('newProjectBtn')?.addEventListener('click', () => {
    document.getElementById('projectFormModal').style.display = 'flex'
  })
  document.getElementById('closeProjectForm')?.addEventListener('click', closeForm)
  document.getElementById('cancelProjectForm')?.addEventListener('click', closeForm)
  document.getElementById('projectFormModal')?.addEventListener('click', e => {
    if (e.target.id === 'projectFormModal') closeForm()
  })
  function closeForm() {
    document.getElementById('projectFormModal').style.display = 'none'
    document.getElementById('projectForm').reset()
  }

  document.getElementById('projectForm')?.addEventListener('submit', async e => {
    e.preventDefault()
    const btn = e.target.querySelector('[type="submit"]')
    btn.disabled = true; btn.textContent = 'Создаю…'
    try {
      await apiPost('/api/v1/projects', {
        name: document.getElementById('pName').value.trim(),
        code: document.getElementById('pCode').value.trim() || undefined,
        description: document.getElementById('pDesc').value.trim(),
        status: document.getElementById('pStatus').value,
        startDate: document.getElementById('pStart').value || undefined,
        endDate: document.getElementById('pEnd').value || undefined,
      })
      closeForm()
      await loadProjects()
      window.toast?.('Проект создан', 'success')
    } catch (err) {
      window.toast?.('Ошибка: ' + err.message, 'error')
    } finally {
      btn.disabled = false; btn.textContent = 'Создать'
    }
  })

  await loadProjects()
}

function projectCard(p) {
  const wis = p.workItems || []
  const done = wis.filter(w => w.status === 'done').length
  const total = wis.length
  const pct = total ? Math.round(done / total * 100) : (p.progress || 0)
  const overdue = wis.filter(w => w.status !== 'done' && w.dueDate && w.dueDate < new Date().toISOString().slice(0, 10)).length
  const statusCfg = {
    active: { label: 'Активный', cls: 'badge--green' },
    planned: { label: 'Запланирован', cls: 'badge--blue' },
    on_hold: { label: 'На паузе', cls: 'badge--amber' },
    completed: { label: 'Завершён', cls: 'badge--gray' },
    cancelled: { label: 'Отменён', cls: 'badge--red' },
  }
  const sc = statusCfg[p.status] || { label: p.status, cls: 'badge--gray' }
  return `
    <div class="project-card" data-project-id="${esc(p.id)}">
      <div class="project-card-head">
        <div>
          ${p.code ? `<span class="eyebrow">${esc(p.code)}</span>` : ''}
          <h3 class="project-card-title">${esc(p.name)}</h3>
        </div>
        <span class="badge ${sc.cls}">${sc.label}</span>
      </div>
      ${p.description ? `<p class="project-card-desc">${esc(p.description)}</p>` : ''}
      <div class="project-card-meta">
        ${p.endDate ? `<span class="meta-chip">📅 ${p.endDate}</span>` : ''}
        ${overdue ? `<span class="meta-chip meta-chip--red">⚠ ${overdue} просрочено</span>` : ''}
        ${total ? `<span class="meta-chip">${done}/${total} задач</span>` : ''}
      </div>
      ${total ? `
        <div class="progress" style="margin-top:10px">
          <div class="progress-fill" style="width:${pct}%;background:${pct >= 80 ? 'var(--green)' : pct >= 40 ? 'var(--blue)' : 'var(--amber)'}"></div>
        </div>
        <small style="color:var(--text-3);font-size:11px;margin-top:4px;display:block">${pct}% выполнено</small>
      ` : ''}
    </div>
  `
}

// ══════════════════════════════════════════════════════════════════════════
// PROJECT DETAIL + KANBAN
// ══════════════════════════════════════════════════════════════════════════

async function mountDetail(view, projectId) {
  view.innerHTML = `
    <div class="page-header" style="padding-bottom:0">
      <div>
        <a href="#projects" class="back-link">← Проекты</a>
        <div id="projectTitle" class="skeleton" style="width:240px;height:28px;margin-top:6px;border-radius:6px"></div>
      </div>
      <div id="projectActions" style="display:flex;gap:8px"></div>
    </div>
    <div class="tab-bar" id="projectTabs">
      <button class="tab-btn active" data-tab="kanban">Kanban</button>
      <button class="tab-btn" data-tab="list">Список</button>
      <button class="tab-btn" data-tab="milestones">Вехи</button>
      <button class="tab-btn" data-tab="risks">Риски</button>
      <button class="tab-btn" data-tab="activity">Активность</button>
    </div>
    <div id="projectTabContent" style="min-height:300px">
      ${skeletonCards(3)}
    </div>
  `

  let project = null
  let workItems = []
  let activeTab = 'kanban'

  // Load project data
  try {
    const [pData, wiData] = await Promise.all([
      apiGet(`/api/v1/projects/${projectId}`),
      apiGet(`/api/v1/projects/${projectId}/work-items`).catch(() => ({ workItems: [] })),
    ])
    project = pData.project || pData
    workItems = wiData.workItems || wiData.work_items || []

    // Update breadcrumb
    const titleEl = document.getElementById('projectTitle')
    if (titleEl) {
      titleEl.className = ''
      titleEl.innerHTML = `
        ${project.code ? `<span class="eyebrow">${esc(project.code)}</span>` : ''}
        <h1>${esc(project.name)}</h1>
      `
    }

    // Update topbar breadcrumb
    const bc = document.getElementById('topbarBreadcrumb')
    if (bc) bc.innerHTML = `<a href="#projects">Projects</a> <span style="opacity:.4">/</span> <span>${esc(project.name)}</span>`

    // Action buttons
    document.getElementById('projectActions').innerHTML = `
      <button class="btn btn-ghost" id="addWiBtn">＋ Задача</button>
      <button class="btn btn-ghost" id="aiWiBtn">✦ AI задачи</button>
    `

    setupDetailListeners(project, workItems)
    renderTab(activeTab)
  } catch (e) {
    document.getElementById('projectTabContent').innerHTML =
      `<p class="empty-copy">Ошибка загрузки проекта: ${esc(e.message)}</p>`
  }

  function setupDetailListeners(proj, wis) {
    // Tab switching
    view.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        view.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        activeTab = btn.dataset.tab
        renderTab(activeTab)
      })
    })

    // Add work item
    document.getElementById('addWiBtn')?.addEventListener('click', () => openWiForm(proj))

    // AI generate work items
    document.getElementById('aiWiBtn')?.addEventListener('click', async () => {
      const text = prompt('Опишите задачи проекта. AI создаст 3-7 задач автоматически:')
      if (!text?.trim()) return
      const btn = document.getElementById('aiWiBtn')
      btn.disabled = true; btn.textContent = '✦ Генерирую…'
      try {
        const data = await apiPost(`/api/v1/projects/${proj.id}/work-items/ai-generate`, { text })
        window.toast?.(`✦ AI создал ${data.created} задач`, 'success')
        await reloadWi(proj.id)
      } catch (e) {
        window.toast?.('Ошибка: ' + e.message, 'error')
      } finally {
        btn.disabled = false; btn.textContent = '✦ AI задачи'
      }
    })
  }

  async function reloadWi(pid) {
    try {
      const data = await apiGet(`/api/v1/projects/${pid}/work-items`)
      workItems = data.workItems || data.work_items || []
      renderTab(activeTab)
    } catch {}
  }

  function renderTab(tab) {
    const content = document.getElementById('projectTabContent')
    if (!content) return
    if (tab === 'kanban') renderKanban(content)
    else if (tab === 'list') renderList(content)
    else if (tab === 'milestones') renderMilestones(content)
    else if (tab === 'risks') renderRisksTab(content)
    else if (tab === 'activity') renderActivity(content)
  }

  // ── KANBAN ──────────────────────────────────────────────────────────────

  function renderKanban(container) {
    const isMobile = window.innerWidth < 768

    if (isMobile) {
      // Mobile: stacked columns (accordion-style or flat list grouped by status)
      renderMobileKanban(container)
    } else {
      renderDesktopKanban(container)
    }
  }

  function renderDesktopKanban(container) {
    container.innerHTML = `
      <div class="kanban-board" id="kanbanBoard">
        ${STATUSES.map(col => {
          const cards = workItems.filter(wi => wi.status === col.id)
          return `
            <div class="kanban-col" data-col="${col.id}" id="kcol-${col.id}">
              <div class="kanban-col-head">
                <div style="display:flex;align-items:center;gap:6px">
                  <span class="kanban-dot" style="background:${col.color}"></span>
                  <span class="kanban-col-label">${col.label}</span>
                </div>
                <span class="kanban-count">${cards.length}</span>
              </div>
              <div class="kanban-cards" id="kcards-${col.id}" data-status="${col.id}">
                ${cards.map(wi => wiCard(wi)).join('')}
                <div class="kanban-drop-zone" data-status="${col.id}"></div>
              </div>
              <button class="kanban-add-btn" data-status="${col.id}">＋</button>
            </div>
          `
        }).join('')}
      </div>
    `

    setupKanbanDragDrop()
    setupCardActions()

    // Quick add buttons
    container.querySelectorAll('.kanban-add-btn').forEach(btn => {
      btn.addEventListener('click', () => openWiForm(project, btn.dataset.status))
    })
  }

  function renderMobileKanban(container) {
    // On mobile: grouped list with collapsible sections
    container.innerHTML = `
      <div class="kanban-mobile">
        ${STATUSES.map(col => {
          const cards = workItems.filter(wi => wi.status === col.id)
          if (!cards.length && col.id === 'ideas') return ''
          return `
            <div class="kanban-mobile-group">
              <div class="kanban-mobile-head" data-toggle="${col.id}">
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="width:8px;height:8px;border-radius:50%;background:${col.color};flex-shrink:0"></span>
                  <strong>${col.label}</strong>
                  <span class="kanban-count">${cards.length}</span>
                </div>
                <span class="chevron">${cards.length ? '▾' : '▸'}</span>
              </div>
              <div class="kanban-mobile-cards" id="mcards-${col.id}" ${cards.length ? '' : 'style="display:none"'}>
                ${cards.map(wi => wiCardMobile(wi)).join('')}
                <button class="kanban-add-mobile" data-status="${col.id}">＋ Добавить задачу</button>
              </div>
            </div>
          `
        }).join('')}
      </div>
    `

    // Collapsible groups
    container.querySelectorAll('[data-toggle]').forEach(head => {
      head.addEventListener('click', () => {
        const id = head.dataset.toggle
        const cards = document.getElementById(`mcards-${id}`)
        const chevron = head.querySelector('.chevron')
        if (cards) {
          const hidden = cards.style.display === 'none'
          cards.style.display = hidden ? '' : 'none'
          if (chevron) chevron.textContent = hidden ? '▾' : '▸'
        }
      })
    })

    // Quick add
    container.querySelectorAll('.kanban-add-mobile').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation()
        openWiForm(project, btn.dataset.status)
      })
    })

    // Card tap → detail/status change
    container.querySelectorAll('[data-wi-id]').forEach(card => {
      card.addEventListener('click', () => {
        const wi = workItems.find(w => w.id === card.dataset.wiId)
        if (wi) openWiDetail(wi)
      })
    })
  }

  function setupKanbanDragDrop() {
    const board = document.getElementById('kanbanBoard')
    if (!board) return
    let dragging = null

    board.querySelectorAll('.kanban-card').forEach(card => {
      card.draggable = true
      card.addEventListener('dragstart', e => {
        dragging = card
        card.classList.add('dragging')
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', card.dataset.wiId)
      })
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging')
        board.querySelectorAll('.kanban-cards').forEach(c => c.classList.remove('drag-over'))
        dragging = null
      })
      card.addEventListener('click', () => {
        const wi = workItems.find(w => w.id === card.dataset.wiId)
        if (wi) openWiDetail(wi)
      })
    })

    board.querySelectorAll('.kanban-cards').forEach(col => {
      col.addEventListener('dragover', e => {
        e.preventDefault()
        col.classList.add('drag-over')
      })
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'))
      col.addEventListener('drop', async e => {
        e.preventDefault()
        col.classList.remove('drag-over')
        const wiId = e.dataTransfer.getData('text/plain')
        const newStatus = col.dataset.status
        const wi = workItems.find(w => w.id === wiId)
        if (!wi || wi.status === newStatus) return
        await updateWiStatus(wi, newStatus)
      })
    })
  }

  function setupCardActions() {
    document.querySelectorAll('.wi-status-select').forEach(sel => {
      sel.addEventListener('change', async e => {
        e.stopPropagation()
        const wiId = sel.closest('[data-wi-id]')?.dataset.wiId
        const wi = workItems.find(w => w.id === wiId)
        if (wi) await updateWiStatus(wi, sel.value)
      })
    })
  }

  async function updateWiStatus(wi, newStatus) {
    const oldStatus = wi.status
    wi.status = newStatus // optimistic
    renderTab(activeTab)
    try {
      await apiPost(`/api/v1/projects/${project.id}/work-items/${wi.id}`, { status: newStatus, version: wi.version })
      wi.version = (wi.version || 1) + 1
      window.toast?.(`${wi.title} → ${STATUS_MAP[newStatus]?.label || newStatus}`, 'info')
    } catch (err) {
      wi.status = oldStatus // rollback
      renderTab(activeTab)
      window.toast?.('Ошибка: ' + err.message, 'error')
    }
  }

  // ── LIST VIEW ────────────────────────────────────────────────────────────

  function renderList(container) {
    if (!workItems.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:40px 0">
          <p class="empty-copy">Нет задач. <button class="btn btn-primary" id="addFirstWi">＋ Добавить</button></p>
        </div>`
      document.getElementById('addFirstWi')?.addEventListener('click', () => openWiForm(project))
      return
    }
    container.innerHTML = `
      <div class="wi-list">
        <div class="wi-list-head">
          <span class="wi-col-title">Задача</span>
          <span class="wi-col-status">Статус</span>
          <span class="wi-col-priority">Приоритет</span>
          <span class="wi-col-due">Срок</span>
        </div>
        ${workItems.map(wi => {
          const s = STATUS_MAP[wi.status] || STATUS_MAP.backlog
          const overdue = wi.status !== 'done' && wi.dueDate && wi.dueDate < new Date().toISOString().slice(0, 10)
          return `
            <div class="wi-row" data-wi-id="${esc(wi.id)}">
              <div class="wi-col-title">
                ${wi.code ? `<span class="wi-code">${esc(wi.code)}</span>` : ''}
                <span class="wi-title">${esc(wi.title)}</span>
              </div>
              <span class="wi-col-status">
                <select class="wi-status-sel" data-wi-id="${esc(wi.id)}">
                  ${STATUSES.map(s2 => `<option value="${s2.id}" ${wi.status === s2.id ? 'selected' : ''}>${s2.label}</option>`).join('')}
                </select>
              </span>
              <span class="wi-col-priority">
                <span class="wi-priority" style="color:${PRIORITY_COLOR[wi.priority] || '#8b95a5'}">${wi.priority || 'medium'}</span>
              </span>
              <span class="wi-col-due" style="${overdue ? 'color:var(--red)' : ''}">
                ${wi.dueDate || '—'}${overdue ? ' ⚠' : ''}
              </span>
            </div>
          `
        }).join('')}
      </div>
    `
    container.querySelectorAll('.wi-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.tagName === 'SELECT') return
        const wi = workItems.find(w => w.id === row.dataset.wiId)
        if (wi) openWiDetail(wi)
      })
    })
    container.querySelectorAll('.wi-status-sel').forEach(sel => {
      sel.addEventListener('change', async () => {
        const wi = workItems.find(w => w.id === sel.dataset.wiId)
        if (wi) await updateWiStatus(wi, sel.value)
      })
    })
  }

  // ── MILESTONES ───────────────────────────────────────────────────────────

  async function renderMilestones(container) {
    container.innerHTML = skeletonCards(3)
    try {
      const data = await apiGet(`/api/v1/projects/${projectId}/milestones`).catch(() => ({ milestones: [] }))
      const milestones = data.milestones || []
      if (!milestones.length) {
        container.innerHTML = '<p class="empty-copy">Нет вех.</p>'
        return
      }
      const now = new Date().toISOString().slice(0, 10)
      container.innerHTML = `
        <div class="milestones-list">
          ${milestones.map(m => {
            const overdue = m.status !== 'complete' && m.dueDate && m.dueDate < now
            return `
              <div class="milestone-item ${m.status === 'complete' ? 'milestone--done' : ''}">
                <div class="milestone-dot ${m.status === 'complete' ? 'dot--done' : overdue ? 'dot--overdue' : ''}"></div>
                <div class="milestone-body">
                  <strong>${esc(m.name)}</strong>
                  ${m.dueDate ? `<span class="milestone-date ${overdue ? 'date--overdue' : ''}">${m.dueDate}</span>` : ''}
                  ${m.description ? `<p class="milestone-desc">${esc(m.description)}</p>` : ''}
                </div>
                <span class="badge ${m.status === 'complete' ? 'badge--green' : overdue ? 'badge--red' : 'badge--blue'}">
                  ${m.status === 'complete' ? 'Готово' : overdue ? 'Просрочено' : 'В работе'}
                </span>
              </div>
            `
          }).join('')}
        </div>
      `
    } catch (e) {
      container.innerHTML = `<p class="empty-copy">Ошибка: ${esc(e.message)}</p>`
    }
  }

  // ── RISKS ────────────────────────────────────────────────────────────────

  async function renderRisksTab(container) {
    container.innerHTML = skeletonCards(2)
    try {
      const data = await apiGet(`/api/v1/projects/${projectId}/risks`).catch(() => ({ risks: [] }))
      const risks = data.risks || []
      if (!risks.length) {
        container.innerHTML = '<p class="empty-copy">Нет рисков.</p>'
        return
      }
      const IMPACT_COLOR = { critical: '#f25757', high: '#f5a623', medium: '#4f7ef7', low: '#2bcba0' }
      container.innerHTML = `
        <div class="risks-grid">
          ${risks.map(r => `
            <div class="risk-card">
              <div class="risk-head">
                <strong>${esc(r.title)}</strong>
                <span class="badge" style="background:${IMPACT_COLOR[r.impact] || '#556'}22;color:${IMPACT_COLOR[r.impact] || '#8b95a5'}">${r.impact || 'medium'}</span>
              </div>
              ${r.description ? `<p class="risk-desc">${esc(r.description)}</p>` : ''}
              ${r.mitigation ? `<div class="risk-mitigation"><span class="eyebrow">Митигация</span> ${esc(r.mitigation)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `
    } catch (e) {
      container.innerHTML = `<p class="empty-copy">Ошибка: ${esc(e.message)}</p>`
    }
  }

  // ── ACTIVITY ─────────────────────────────────────────────────────────────

  async function renderActivity(container) {
    container.innerHTML = skeletonCards(5)
    try {
      const data = await apiGet(`/api/v1/projects/${projectId}/activity`).catch(() => ({ entries: [] }))
      const entries = data.entries || data.activity || []
      if (!entries.length) {
        container.innerHTML = '<p class="empty-copy">Нет активности.</p>'
        return
      }
      container.innerHTML = `
        <div class="activity-feed">
          ${entries.map(e => `
            <div class="activity-item">
              <div class="activity-dot"></div>
              <div class="activity-body">
                <div class="activity-text">${esc(e.description || e.text || '')}</div>
                <time class="activity-time">${relTime(e.createdAt || e.created_at)}</time>
              </div>
            </div>
          `).join('')}
        </div>
      `
    } catch (e) {
      container.innerHTML = `<p class="empty-copy">Ошибка: ${esc(e.message)}</p>`
    }
  }
}

// ── Work item form (create/edit) ─────────────────────────────────────────

function openWiForm(project, defaultStatus = 'backlog') {
  const existing = document.getElementById('wiFormModal')
  if (existing) existing.remove()

  const modal = document.createElement('div')
  modal.id = 'wiFormModal'
  modal.className = 'modal-overlay'
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <div><p class="eyebrow">WORK ITEM</p><h2>Новая задача</h2></div>
        <button class="icon-btn" id="closeWiForm">×</button>
      </div>
      <form id="wiForm">
        <label class="field-label">Название *
          <input class="field-input" id="wiTitle" required maxlength="200" placeholder="Что нужно сделать">
        </label>
        <label class="field-label">Описание
          <textarea class="field-textarea" id="wiDesc" rows="3" maxlength="2000"></textarea>
        </label>
        <div class="form-row">
          <label class="field-label">Статус
            <select class="field-input" id="wiStatus">
              ${STATUSES.map(s => `<option value="${s.id}" ${s.id === defaultStatus ? 'selected' : ''}>${s.label}</option>`).join('')}
            </select>
          </label>
          <label class="field-label">Приоритет
            <select class="field-input" id="wiPriority">
              <option value="low">Low</option>
              <option value="medium" selected>Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
        </div>
        <div class="form-row">
          <label class="field-label">Начало
            <input class="field-input" id="wiStart" type="date">
          </label>
          <label class="field-label">Срок
            <input class="field-input" id="wiDue" type="date">
          </label>
          <label class="field-label">Оценка (ч)
            <input class="field-input" id="wiEst" type="number" min="0" step="0.5" placeholder="0">
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelWiForm">Отмена</button>
          <button type="submit" class="btn btn-primary">Создать</button>
        </div>
      </form>
    </div>
  `
  document.body.appendChild(modal)

  const close = () => modal.remove()
  document.getElementById('closeWiForm')?.addEventListener('click', close)
  document.getElementById('cancelWiForm')?.addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('wiForm')?.addEventListener('submit', async e => {
    e.preventDefault()
    const btn = e.target.querySelector('[type="submit"]')
    btn.disabled = true; btn.textContent = 'Создаю…'
    try {
      const est = parseFloat(document.getElementById('wiEst').value)
      await apiPost(`/api/v1/projects/${project.id}/work-items`, {
        title: document.getElementById('wiTitle').value.trim(),
        description: document.getElementById('wiDesc').value.trim(),
        status: document.getElementById('wiStatus').value,
        priority: document.getElementById('wiPriority').value,
        startDate: document.getElementById('wiStart').value || undefined,
        dueDate: document.getElementById('wiDue').value || undefined,
        estimatedMinutes: est ? Math.round(est * 60) : undefined,
      })
      close()
      // Reload work items in parent scope
      window.toast?.('Задача создана', 'success')
      // Re-trigger route to reload
      const ev = new CustomEvent('rp:reload-wi', { detail: { projectId: project.id } })
      window.dispatchEvent(ev)
    } catch (err) {
      window.toast?.('Ошибка: ' + err.message, 'error')
      btn.disabled = false; btn.textContent = 'Создать'
    }
  })
}

// ── Work item detail modal ───────────────────────────────────────────────

function openWiDetail(wi) {
  const existing = document.getElementById('wiDetailModal')
  if (existing) existing.remove()

  const s = STATUS_MAP[wi.status] || STATUS_MAP.backlog
  const modal = document.createElement('div')
  modal.id = 'wiDetailModal'
  modal.className = 'modal-overlay'
  modal.innerHTML = `
    <div class="modal-box modal-box--wide">
      <div class="modal-head">
        <div>
          ${wi.code ? `<p class="eyebrow">${esc(wi.code)}</p>` : ''}
          <h2>${esc(wi.title)}</h2>
        </div>
        <button class="icon-btn" id="closeWiDetail">×</button>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        <span class="badge" style="background:${s.color}22;color:${s.color}">${s.label}</span>
        <span class="badge badge--gray">
          <span style="color:${PRIORITY_COLOR[wi.priority] || '#8b95a5'}">⬤</span> ${wi.priority || 'medium'}
        </span>
        ${wi.dueDate ? `<span class="badge badge--gray">📅 ${wi.dueDate}</span>` : ''}
        ${wi.assigneeName ? `<span class="badge badge--gray">👤 ${esc(wi.assigneeName)}</span>` : ''}
      </div>
      ${wi.description ? `<p style="color:var(--text-2);line-height:1.6;margin-bottom:16px">${esc(wi.description)}</p>` : ''}
      <div class="wi-detail-actions">
        <label class="field-label" style="flex:1">Изменить статус
          <select class="field-input" id="wiDetailStatus">
            ${STATUSES.map(s2 => `<option value="${s2.id}" ${wi.status === s2.id ? 'selected' : ''}>${s2.label}</option>`).join('')}
          </select>
        </label>
        <button class="btn btn-primary" id="saveWiStatus">Сохранить</button>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  const close = () => modal.remove()
  document.getElementById('closeWiDetail')?.addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('saveWiStatus')?.addEventListener('click', async () => {
    const newStatus = document.getElementById('wiDetailStatus').value
    if (newStatus === wi.status) { close(); return }
    try {
      await apiPost(`/api/v1/projects/${wi.projectId || ''}/work-items/${wi.id}`, {
        status: newStatus, version: wi.version
      })
      wi.status = newStatus
      window.toast?.(`Статус обновлён → ${STATUS_MAP[newStatus]?.label}`, 'success')
      window.dispatchEvent(new CustomEvent('rp:reload-wi', { detail: {} }))
      close()
    } catch (e) {
      window.toast?.('Ошибка: ' + e.message, 'error')
    }
  })
}

// ── Card templates ──────────────────────────────────────────────────────

function wiCard(wi) {
  const s = STATUS_MAP[wi.status] || STATUS_MAP.backlog
  const overdue = wi.status !== 'done' && wi.dueDate && wi.dueDate < new Date().toISOString().slice(0, 10)
  return `
    <div class="kanban-card" draggable="true" data-wi-id="${esc(wi.id)}">
      ${wi.code ? `<span class="wi-code">${esc(wi.code)}</span>` : ''}
      <p class="kanban-card-title">${esc(wi.title)}</p>
      <div class="kanban-card-meta">
        ${wi.priority && wi.priority !== 'medium' ? `<span style="color:${PRIORITY_COLOR[wi.priority]};font-size:10px;font-weight:700">${wi.priority.toUpperCase()}</span>` : ''}
        ${wi.dueDate ? `<span style="color:${overdue ? 'var(--red)' : 'var(--text-3)'};font-size:10px">📅 ${wi.dueDate}</span>` : ''}
        ${wi.assigneeName ? `<span style="font-size:10px;color:var(--text-3)">👤 ${esc(wi.assigneeName)}</span>` : ''}
        ${overdue ? `<span style="color:var(--red);font-size:10px;font-weight:700">⚠ просрочено</span>` : ''}
      </div>
    </div>
  `
}

function wiCardMobile(wi) {
  const s = STATUS_MAP[wi.status] || STATUS_MAP.backlog
  const overdue = wi.status !== 'done' && wi.dueDate && wi.dueDate < new Date().toISOString().slice(0, 10)
  return `
    <div class="wo-item" data-wi-id="${esc(wi.id)}" style="cursor:pointer">
      <div class="wo-header">
        <div>
          ${wi.code ? `<span class="eyebrow">${esc(wi.code)}</span>` : ''}
          <strong>${esc(wi.title)}</strong>
        </div>
        <span class="badge" style="background:${s.color}22;color:${s.color};flex-shrink:0">${s.label}</span>
      </div>
      <div class="wo-meta">
        ${wi.priority ? `<span style="color:${PRIORITY_COLOR[wi.priority]}">⬤ ${wi.priority}</span>` : ''}
        ${wi.dueDate ? `<span style="${overdue ? 'color:var(--red)' : ''}">📅 ${wi.dueDate}</span>` : ''}
        ${overdue ? '<span style="color:var(--red)">⚠</span>' : ''}
      </div>
    </div>
  `
}

// ── Utilities ────────────────────────────────────────────────────────────

function skeletonCards(n) {
  return Array.from({ length: n }, () =>
    `<div class="skeleton" style="height:80px;border-radius:10px;margin-bottom:10px"></div>`
  ).join('')
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function relTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return 'только что'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}м назад`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}ч назад`
  return `${Math.floor(diff / 86400000)}д назад`
}
