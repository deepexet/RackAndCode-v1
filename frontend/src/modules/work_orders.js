/**
 * Work Orders module — maintenance/repair tasks linked to assets or inventory.
 * Backend: GET/POST /api/v1/work-orders, POST /api/v1/work-orders/:id/update
 */

import { apiJSON, apiPost } from '../core/api.js'
import { esc } from '../components/ui.js'

// ── State ─────────────────────────────────────────────────────────────────

let _el = null
let _orders = []
let _filterStatus = 'all'
let _filterPriority = 'all'
let _searchQ = ''
let _loading = true

// ── Data ──────────────────────────────────────────────────────────────────

async function loadOrders() {
  try {
    const d = await apiJSON('/api/v1/work-orders')
    _orders = d.workOrders || []
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
        const id = card.dataset.id
        const order = _orders.find(o => o.id === id)
        if (order) openModal(order)
      }
    })
  })
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
