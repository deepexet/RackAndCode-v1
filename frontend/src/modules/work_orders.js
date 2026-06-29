/**
 * Work Orders module — maintenance/repair tasks linked to assets or inventory.
 * Backend: GET/POST /api/v1/work-orders, POST /api/v1/work-orders/:id/update
 */

import { apiJSON, apiPost } from '../core/api.js'
import { esc } from '../components/ui.js'

// ── State ─────────────────────────────────────────────────────────────────

let _el = null
let _orders = []
let _assets = []
let _filterStatus = 'all'
let _filterPriority = 'all'
let _searchQ = ''
let _loading = true

// ── Data ──────────────────────────────────────────────────────────────────

async function loadOrders() {
  try {
    const [ordersData, assetsData] = await Promise.all([
      apiJSON('/api/v1/work-orders').catch(() => ({ workOrders: [] })),
      apiJSON('/api/v1/tracked-assets').catch(() => ({ assets: [] })),
    ])
    _orders = ordersData.workOrders || []
    _assets = assetsData.assets || []
  } catch {
    _orders = []
  }
  _loading = false
}

async function createOrder(payload) {
  const d = await apiJSON('/api/v1/work-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  await loadOrders()
  return d.workOrder
}

async function updateOrder(id, payload) {
  await apiPost(`/api/v1/work-orders/${id}/update`, payload)
  await loadOrders()
}

async function loadDetail(id) {
  const d = await apiJSON(`/api/v1/work-orders/${id}`)
  return d.workOrder
}

async function createTask(woId, title) {
  const d = await apiJSON(`/api/v1/work-orders/${woId}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  return d.task
}

async function toggleTask(woId, task) {
  const d = await apiJSON(`/api/v1/work-orders/${woId}/tasks/${task.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed: task.completed ? 0 : 1 }),
  })
  return d.task
}

async function deleteTask(woId, taskId) {
  await apiPost(`/api/v1/work-orders/${woId}/tasks/${taskId}/delete`, {})
}

async function addComment(woId, body) {
  const d = await apiJSON(`/api/v1/work-orders/${woId}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  return d.comment
}

// ── Filters ───────────────────────────────────────────────────────────────

function filteredOrders() {
  return _orders.filter(o => {
    if (_filterStatus !== 'all' && o.status !== _filterStatus) return false
    if (_filterPriority !== 'all' && o.priority !== _filterPriority) return false
    if (_searchQ) {
      const q = _searchQ.toLowerCase()
      if (
        !o.title?.toLowerCase().includes(q) &&
        !o.description?.toLowerCase().includes(q) &&
        !o.assigned_to?.toLowerCase().includes(q)
      ) return false
    }
    return true
  })
}

// ── Labels/colours ────────────────────────────────────────────────────────

const STATUS_LABEL = { open: 'Открыт', in_progress: 'В работе', done: 'Готово', cancelled: 'Отменён' }
const STATUS_COLOR = { open: 'wo-s-open', in_progress: 'wo-s-inprog', done: 'wo-s-done', cancelled: 'wo-s-cancel' }

const PRIORITY_LABEL = { low: 'Низкий', medium: 'Средний', high: 'Высокий', critical: 'Критичный' }
const PRIORITY_COLOR = { low: 'wo-p-low', medium: 'wo-p-med', high: 'wo-p-high', critical: 'wo-p-crit' }

const STATUS_ICON = { open: 'ti-circle', in_progress: 'ti-progress', done: 'ti-circle-check-filled', cancelled: 'ti-circle-x' }

function fmtDate(s) {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d)) return s
  const now = new Date()
  const diff = Math.floor((d - now) / 86400000)
  const fmt = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  if (diff < 0) return `<span class="wo-overdue">${fmt}</span>`
  if (diff === 0) return `<span class="wo-today">Сегодня</span>`
  if (diff === 1) return `<span class="wo-soon">Завтра</span>`
  if (diff <= 7) return `<span class="wo-soon">${fmt}</span>`
  return `<span>${fmt}</span>`
}

// ── Render ────────────────────────────────────────────────────────────────

function render() {
  if (!_el) return
  const orders = filteredOrders()

  const counts = { all: _orders.length }
  for (const o of _orders) counts[o.status] = (counts[o.status] || 0) + 1

  const statusTabs = ['all', 'open', 'in_progress', 'done', 'cancelled']
  const tabLabels = { all: 'Все', ...STATUS_LABEL }

  _el.innerHTML = `
    <div class="wo-shell">
      <div class="wo-header">
        <div class="wo-header-top">
          <div>
            <h1 class="wo-title"><i class="ti ti-clipboard-list"></i> Наряды</h1>
            <p class="wo-sub">Обслуживание, ремонт и полевые задачи</p>
          </div>
          <button class="wo-new-btn" id="wo-new">
            <i class="ti ti-plus"></i> Новый наряд
          </button>
        </div>

        <div class="wo-filters">
          <div class="wo-status-tabs">
            ${statusTabs.map(s => `
              <button class="wo-tab ${_filterStatus === s ? 'active' : ''}" data-status="${s}">
                ${tabLabels[s]}
                ${counts[s] ? `<span class="wo-tab-count">${counts[s]}</span>` : ''}
              </button>`).join('')}
          </div>
          <div class="wo-filter-row">
            <input class="wo-search" type="search" placeholder="Поиск…" value="${esc(_searchQ)}">
            <select class="wo-priority-select" id="wo-priority-filter">
              <option value="all" ${_filterPriority === 'all' ? 'selected' : ''}>Все приоритеты</option>
              ${Object.entries(PRIORITY_LABEL).map(([v, l]) =>
                `<option value="${v}" ${_filterPriority === v ? 'selected' : ''}>${l}</option>`
              ).join('')}
            </select>
          </div>
        </div>
      </div>

      <div class="wo-body">
        ${_loading ? '<div class="wo-loading"><i class="ti ti-loader-2"></i></div>' : renderCards(orders)}
      </div>
    </div>
  `

  bindEvents()
}

function renderCards(orders) {
  if (!orders.length) return `
    <div class="wo-empty">
      <i class="ti ti-clipboard-list"></i>
      <p>${_filterStatus !== 'all' || _searchQ ? 'Нарядов не найдено' : 'Нарядов нет. Создайте первый!'}</p>
    </div>`

  return `<div class="wo-list">${orders.map(o => renderCard(o)).join('')}</div>`
}

function renderCard(o) {
  const overdue = o.due_date && o.status !== 'done' && o.status !== 'cancelled' &&
    new Date(o.due_date) < new Date()

  return `
    <div class="wo-card ${overdue ? 'wo-card--overdue' : ''}" data-id="${esc(o.id)}">
      <div class="wo-card-accent ${PRIORITY_COLOR[o.priority] || ''}"></div>
      <div class="wo-card-body">
        <div class="wo-card-top">
          <span class="wo-badge ${STATUS_COLOR[o.status] || ''} wo-status-badge">
            <i class="ti ${STATUS_ICON[o.status] || 'ti-circle'}"></i>
            ${STATUS_LABEL[o.status] || o.status}
          </span>
          <span class="wo-badge ${PRIORITY_COLOR[o.priority] || ''}">
            ${PRIORITY_LABEL[o.priority] || o.priority}
          </span>
        </div>
        <div class="wo-card-title">${esc(o.title)}</div>
        ${o.description ? `<div class="wo-card-desc">${esc(o.description.slice(0, 120))}${o.description.length > 120 ? '…' : ''}</div>` : ''}
        <div class="wo-card-meta">
          ${o.assigned_to ? `<span><i class="ti ti-user"></i> ${esc(o.assigned_to)}</span>` : ''}
          ${o.due_date ? `<span><i class="ti ti-calendar"></i> ${fmtDate(o.due_date)}</span>` : ''}
          ${o.notes ? `<span class="wo-has-notes"><i class="ti ti-notes"></i></span>` : ''}
        </div>
      </div>
      <button class="wo-card-open" data-id="${esc(o.id)}"><i class="ti ti-chevron-right"></i></button>
    </div>`
}

// ── Modal ─────────────────────────────────────────────────────────────────

function openModal(order = null) {
  const isNew = !order
  const modal = document.createElement('div')
  modal.className = 'wo-modal-overlay'
  modal.innerHTML = `
    <div class="wo-modal">
      <div class="wo-modal-header">
        <h2 class="wo-modal-title">${isNew ? 'Новый наряд' : 'Наряд'}</h2>
        <button class="wo-modal-close"><i class="ti ti-x"></i></button>
      </div>
      <div class="wo-modal-body">
        <div class="wo-form-group">
          <label class="wo-label">Название *</label>
          <input class="wo-input" id="wof-title" placeholder="Краткое описание задачи" value="${esc(order?.title || '')}">
        </div>
        <div class="wo-form-group">
          <label class="wo-label">Описание</label>
          <textarea class="wo-textarea" id="wof-desc" rows="3" placeholder="Подробности…">${esc(order?.description || '')}</textarea>
        </div>
        <div class="wo-form-row">
          <div class="wo-form-group wo-form-group--half">
            <label class="wo-label">Статус</label>
            <select class="wo-select" id="wof-status">
              ${Object.entries(STATUS_LABEL).map(([v, l]) =>
                `<option value="${v}" ${(order?.status || 'open') === v ? 'selected' : ''}>${l}</option>`
              ).join('')}
            </select>
          </div>
          <div class="wo-form-group wo-form-group--half">
            <label class="wo-label">Приоритет</label>
            <select class="wo-select" id="wof-priority">
              ${Object.entries(PRIORITY_LABEL).map(([v, l]) =>
                `<option value="${v}" ${(order?.priority || 'medium') === v ? 'selected' : ''}>${l}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <div class="wo-form-row">
          <div class="wo-form-group wo-form-group--half">
            <label class="wo-label">Исполнитель</label>
            <input class="wo-input" id="wof-assigned" placeholder="Имя или email" value="${esc(order?.assigned_to || '')}">
          </div>
          <div class="wo-form-group wo-form-group--half">
            <label class="wo-label">Срок</label>
            <input class="wo-input" id="wof-due" type="date" value="${esc(order?.due_date?.slice(0, 10) || '')}">
          </div>
        </div>
        ${_assets.length ? `
        <div class="wo-form-group">
          <label class="wo-label">Актив / оборудование</label>
          <select class="wo-select" id="wof-asset">
            <option value="">— не указан —</option>
            ${_assets.map(a => `<option value="${esc(a.id)}" ${order?.asset_id === a.id ? 'selected' : ''}>${esc(a.name)}${a.asset_tag ? ' (' + esc(a.asset_tag) + ')' : ''}</option>`).join('')}
          </select>
        </div>` : ''}
        <div class="wo-form-group">
          <label class="wo-label">Заметки</label>
          <textarea class="wo-textarea" id="wof-notes" rows="2" placeholder="Доп. информация, история…">${esc(order?.notes || '')}</textarea>
        </div>
        ${!isNew ? `
        <div class="wo-quick-status">
          <span class="wo-label">Быстрый переход:</span>
          ${Object.entries(STATUS_LABEL).map(([v, l]) => `
            <button class="wo-quick-btn ${order.status === v ? 'active' : ''}" data-qs="${v}">
              <i class="ti ${STATUS_ICON[v]}"></i> ${l}
            </button>`).join('')}
        </div>` : ''}
      </div>
      <div class="wo-modal-footer">
        ${!isNew ? `<button class="wo-del-btn" id="wof-delete"><i class="ti ti-trash"></i> Удалить</button>` : '<span></span>'}
        <div class="wo-modal-actions">
          <button class="wo-cancel-btn" id="wof-cancel">Отмена</button>
          <button class="wo-save-btn" id="wof-save">
            ${isNew ? '<i class="ti ti-plus"></i> Создать' : '<i class="ti ti-check"></i> Сохранить'}
          </button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  const close = () => modal.remove()
  modal.querySelector('.wo-modal-close').addEventListener('click', close)
  modal.querySelector('#wof-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  // Quick status buttons
  modal.querySelectorAll('[data-qs]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = btn.dataset.qs
      modal.querySelectorAll('[data-qs]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      modal.querySelector('#wof-status').value = status
    })
  })

  // Delete
  modal.querySelector('#wof-delete')?.addEventListener('click', async () => {
    if (!confirm(`Удалить наряд "${order.title}"?`)) return
    await updateOrder(order.id, { ...order, status: 'cancelled' })
    close()
    render()
  })

  // Save
  modal.querySelector('#wof-save').addEventListener('click', async () => {
    const title = modal.querySelector('#wof-title').value.trim()
    if (!title) { modal.querySelector('#wof-title').focus(); return }

    const payload = {
      title,
      description: modal.querySelector('#wof-desc').value.trim(),
      status: modal.querySelector('#wof-status').value,
      priority: modal.querySelector('#wof-priority').value,
      assigned_to: modal.querySelector('#wof-assigned').value.trim(),
      due_date: modal.querySelector('#wof-due').value || null,
      notes: modal.querySelector('#wof-notes').value.trim(),
      asset_id: modal.querySelector('#wof-asset')?.value || null,
    }

    const btn = modal.querySelector('#wof-save')
    btn.disabled = true
    btn.innerHTML = '<i class="ti ti-loader-2"></i>'
    try {
      if (isNew) {
        await createOrder(payload)
        window.toast?.('Наряд создан', 'success')
      } else {
        await updateOrder(order.id, payload)
        window.toast?.('Сохранено', 'success')
      }
      close()
      render()
    } catch (err) {
      window.toast?.(err.message || 'Ошибка', 'error')
      btn.disabled = false
      btn.innerHTML = isNew ? '<i class="ti ti-plus"></i> Создать' : '<i class="ti ti-check"></i> Сохранить'
    }
  })
}

// ── Bind events ───────────────────────────────────────────────────────────

function bindEvents() {
  _el.querySelector('#wo-new')?.addEventListener('click', () => openModal())

  _el.querySelectorAll('.wo-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _filterStatus = btn.dataset.status
      render()
    })
  })

  _el.querySelector('.wo-search')?.addEventListener('input', e => {
    _searchQ = e.target.value
    render()
  })

  _el.querySelector('#wo-priority-filter')?.addEventListener('change', e => {
    _filterPriority = e.target.value
    render()
  })

  _el.querySelectorAll('.wo-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.wo-card-open') || e.target.closest('.wo-card')) {
        openDetail(card.dataset.id)
      }
    })
  })
}

// ── Detail view ───────────────────────────────────────────────────────────

function fmtTime(s) {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d)) return s
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

async function openDetail(id) {
  if (!_el) return
  _el.innerHTML = `<div class="wo-shell"><div class="wo-detail-loading"><i class="ti ti-loader-2"></i> Загрузка…</div></div>`
  let wo
  try { wo = await loadDetail(id) } catch {
    _el.innerHTML = `<div class="wo-shell"><div class="wo-detail-loading">Ошибка загрузки</div></div>`
    return
  }
  renderDetail(wo)
}

function renderDetail(wo) {
  if (!_el) return
  const tasks = wo.tasks || []
  const comments = wo.comments || []
  const done = tasks.filter(t => t.completed).length
  const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0
  const overdue = wo.due_date && wo.status !== 'done' && wo.status !== 'cancelled' && new Date(wo.due_date) < new Date()

  _el.innerHTML = `
    <div class="wo-shell">
      <div class="wo-detail">
        <div class="wo-detail-nav">
          <button class="wo-back-btn" id="wd-back"><i class="ti ti-arrow-left"></i> Наряды</button>
          <button class="wo-edit-btn" id="wd-edit"><i class="ti ti-pencil"></i> Редактировать</button>
        </div>

        <div class="wo-detail-header">
          <div class="wo-detail-badges">
            <span class="wo-badge ${PRIORITY_COLOR[wo.priority] || ''}">${PRIORITY_LABEL[wo.priority] || wo.priority}</span>
            ${overdue ? '<span class="wo-badge wo-badge--overdue">Просрочен</span>' : ''}
          </div>
          <h1 class="wo-detail-title">${esc(wo.title)}</h1>
          <div class="wo-detail-meta">
            ${wo.assigned_to ? `<span><i class="ti ti-user"></i> ${esc(wo.assigned_to)}</span>` : ''}
            ${wo.due_date ? `<span><i class="ti ti-calendar"></i> ${fmtDate(wo.due_date)}</span>` : ''}
            <span><i class="ti ti-clock"></i> Создан ${fmtTime(wo.created_at)}</span>
          </div>
          ${wo.asset ? `
          <div class="wo-asset-chip">
            <i class="ti ti-cpu"></i>
            <span>${esc(wo.asset.name)}</span>
            ${wo.asset.asset_tag ? `<span class="wo-asset-tag">${esc(wo.asset.asset_tag)}</span>` : ''}
            <span class="wo-asset-status wo-asset-status--${wo.asset.status}">${esc(wo.asset.status)}</span>
          </div>` : ''}
          ${wo.description ? `<p class="wo-detail-desc">${esc(wo.description)}</p>` : ''}
          <div class="wo-status-bar">
            ${Object.entries(STATUS_LABEL).map(([v, l]) => `
              <button class="wo-status-btn ${wo.status === v ? 'active ' + STATUS_COLOR[v] : ''}" data-status="${v}">
                <i class="ti ${STATUS_ICON[v]}"></i> ${l}
              </button>`).join('')}
            <button class="wo-detail-delete" id="wd-delete" title="Удалить наряд">
              <i class="ti ti-trash"></i>
            </button>
          </div>
        </div>

        <div class="wo-detail-body">
          <!-- Checklist -->
          <div class="wo-section">
            <div class="wo-section-head">
              <h3 class="wo-section-title"><i class="ti ti-checklist"></i> Чеклист</h3>
              ${tasks.length ? `<span class="wo-progress-label">${done}/${tasks.length}</span>` : ''}
            </div>
            ${tasks.length ? `
            <div class="wo-progress-bar"><div class="wo-progress-fill" style="width:${pct}%"></div></div>
            ` : ''}
            <ul class="wo-tasklist" id="wd-tasklist">
              ${tasks.map(t => renderTaskItem(t, wo.id)).join('')}
            </ul>
            <div class="wo-task-add">
              <input class="wo-input wo-task-input" id="wd-task-input" placeholder="Добавить пункт…">
              <button class="wo-task-add-btn" id="wd-task-add"><i class="ti ti-plus"></i></button>
            </div>
          </div>

          <!-- Comments -->
          <div class="wo-section">
            <div class="wo-section-head">
              <h3 class="wo-section-title"><i class="ti ti-message"></i> Комментарии</h3>
            </div>
            <div class="wo-comments" id="wd-comments">
              ${comments.length
                ? comments.map(c => renderComment(c)).join('')
                : '<div class="wo-no-comments">Комментариев пока нет</div>'}
            </div>
            <div class="wo-comment-add">
              <textarea class="wo-textarea wo-comment-input" id="wd-comment-input" rows="2" placeholder="Написать комментарий…"></textarea>
              <button class="wo-comment-send" id="wd-comment-send"><i class="ti ti-send"></i> Отправить</button>
            </div>
          </div>

          ${wo.notes ? `
          <div class="wo-section">
            <div class="wo-section-head">
              <h3 class="wo-section-title"><i class="ti ti-notes"></i> Заметки</h3>
            </div>
            <p class="wo-detail-notes">${esc(wo.notes)}</p>
          </div>` : ''}
        </div>
      </div>
    </div>`

  bindDetailEvents(wo)
}

function renderTaskItem(t, woId) {
  return `
    <li class="wo-task-item ${t.completed ? 'wo-task-done' : ''}" data-task-id="${esc(t.id)}">
      <button class="wo-task-check" data-action="toggle"><i class="ti ${t.completed ? 'ti-circle-check-filled' : 'ti-circle'}"></i></button>
      <span class="wo-task-title">${esc(t.title)}</span>
      <button class="wo-task-del" data-action="delete" title="Удалить"><i class="ti ti-x"></i></button>
    </li>`
}

function renderComment(c) {
  return `
    <div class="wo-comment">
      <div class="wo-comment-meta">
        <span class="wo-comment-author"><i class="ti ti-user-circle"></i> ${esc(c.author || 'Аноним')}</span>
        <span class="wo-comment-time">${fmtTime(c.created_at)}</span>
      </div>
      <div class="wo-comment-body">${esc(c.body)}</div>
    </div>`
}

function bindDetailEvents(wo) {
  _el.querySelector('#wd-back').addEventListener('click', () => {
    render()
  })

  _el.querySelector('#wd-edit').addEventListener('click', () => {
    const order = _orders.find(o => o.id === wo.id) || wo
    openModal(order)
  })

  // Quick status buttons
  const statusBar = _el.querySelector('.wo-status-bar')
  statusBar.addEventListener('click', async e => {
    const btn = e.target.closest('[data-status]')
    if (!btn) return
    const newStatus = btn.dataset.status
    if (newStatus === wo.status) return
    btn.style.opacity = '0.5'
    try {
      await updateOrder(wo.id, { ...wo, status: newStatus })
      wo.status = newStatus
      statusBar.querySelectorAll('[data-status]').forEach(b => {
        b.className = `wo-status-btn${b.dataset.status === newStatus ? ' active ' + STATUS_COLOR[newStatus] : ''}`
      })
    } catch (err) {
      window.toast?.(err.message || 'Ошибка', 'error')
    }
    btn.style.opacity = ''
  })

  // Delete WO
  const deleteBtn = _el.querySelector('#wd-delete')
  const backBtn = _el.querySelector('#wd-back')
  deleteBtn.addEventListener('click', async () => {
    if (deleteBtn.dataset.confirm !== '1') {
      deleteBtn.dataset.confirm = '1'
      deleteBtn.innerHTML = '<i class="ti ti-trash"></i> Удалить?'
      deleteBtn.classList.add('wo-detail-delete--confirm')
      setTimeout(() => {
        deleteBtn.dataset.confirm = ''
        deleteBtn.innerHTML = '<i class="ti ti-trash"></i>'
        deleteBtn.classList.remove('wo-detail-delete--confirm')
      }, 3000)
      return
    }
    deleteBtn.disabled = true
    try {
      await updateOrder(wo.id, { ...wo, status: 'cancelled' })
      window.toast?.('Наряд отменён', 'success')
      render()
    } catch (err) {
      window.toast?.(err.message || 'Ошибка', 'error')
      deleteBtn.disabled = false
    }
  })

  // Toggle/delete tasks — capture taskList ref before awaits
  const taskListEl = _el.querySelector('#wd-tasklist')
  taskListEl.addEventListener('click', async e => {
    const item = e.target.closest('.wo-task-item')
    if (!item) return
    const taskId = item.dataset.taskId
    const action = e.target.closest('[data-action]')?.dataset.action
    if (!action) return
    const task = (wo.tasks || []).find(t => t.id === taskId)
    if (!task) return
    if (action === 'toggle') {
      item.style.opacity = '0.5'
      try {
        const updated = await toggleTask(wo.id, task)
        task.completed = updated.completed
        item.className = `wo-task-item ${task.completed ? 'wo-task-done' : ''}`
        item.querySelector('.wo-task-check i').className = `ti ${task.completed ? 'ti-circle-check-filled' : 'ti-circle'}`
        item.style.opacity = ''
        _updateProgress(wo)
      } catch { item.style.opacity = '' }
    } else if (action === 'delete') {
      item.style.opacity = '0.4'
      try {
        await deleteTask(wo.id, taskId)
        wo.tasks = (wo.tasks || []).filter(t => t.id !== taskId)
        item.remove()
        _updateProgress(wo)
      } catch { item.style.opacity = '' }
    }
  })

  // Add task — capture DOM refs before any awaits to survive HMR _el resets
  const taskInput = _el.querySelector('#wd-task-input')
  const taskList = _el.querySelector('#wd-tasklist')
  const addTask = async () => {
    const title = taskInput.value.trim()
    if (!title) return
    taskInput.value = ''
    const task = await createTask(wo.id, title)
    wo.tasks = [...(wo.tasks || []), task]
    taskList.insertAdjacentHTML('beforeend', renderTaskItem(task, wo.id))
    _updateProgress(wo)
  }
  _el.querySelector('#wd-task-add').addEventListener('click', addTask)
  taskInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTask() })

  // Add comment — capture DOM refs before awaits
  const commentInput = _el.querySelector('#wd-comment-input')
  const commentSend = _el.querySelector('#wd-comment-send')
  const commentsEl = _el.querySelector('#wd-comments')
  commentSend.addEventListener('click', async () => {
    const body = commentInput.value.trim()
    if (!body) return
    commentSend.disabled = true
    try {
      const c = await addComment(wo.id, body)
      wo.comments = [...(wo.comments || []), c]
      commentInput.value = ''
      commentsEl.querySelector('.wo-no-comments')?.remove()
      commentsEl.insertAdjacentHTML('beforeend', renderComment(c))
    } catch (err) {
      window.toast?.(err.message || 'Ошибка', 'error')
    }
    commentSend.disabled = false
  })
}

function _updateProgress(wo) {
  const tasks = wo.tasks || []
  const done = tasks.filter(t => t.completed).length
  const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0
  const bar = document.querySelector('.wo-progress-fill')
  const label = document.querySelector('.wo-progress-label')
  if (bar) bar.style.width = pct + '%'
  if (label) label.textContent = `${done}/${tasks.length}`
}

// ── Mount/unmount ─────────────────────────────────────────────────────────

export async function mount() {
  _el = document.querySelector('[data-view="work-orders"]')
  if (!_el) return unmount
  _loading = true
  render()
  await loadOrders()
  render()
  return unmount
}

function unmount() {
  _el = null
}
