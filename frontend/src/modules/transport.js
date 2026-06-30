/**
 * Transport module — company vehicle fleet management.
 * Tracks vehicles, driver assignments, service history, and onboard inventory.
 */

import { apiJSON, apiPost } from '../core/api.js'
import { esc } from '../components/ui.js'

// ── State ──────────────────────────────────────────────────────────────────

let _el = null
let _vehicles = []
let _activeVehicle = null
let _tab = 'info' // info | service | inventory | assignments

// ── Public API ─────────────────────────────────────────────────────────────

export function mount() {
  _el = document.querySelector('[data-view="transport"]')
  if (!_el) return unmount
  _el.innerHTML = `<div class="tr-shell"><div class="tr-loading"><i class="ti ti-loader-2 spin"></i> Загрузка…</div></div>`
  loadVehicles()
  return unmount
}

export function unmount() {
  if (_el) _el.innerHTML = ''
  _el = null
  _vehicles = []
  _activeVehicle = null
}

// ── Data ───────────────────────────────────────────────────────────────────

async function loadVehicles() {
  try {
    const d = await apiJSON('/api/v1/transport/vehicles')
    _vehicles = (d.vehicles || []).map(norm)
  } catch {
    _vehicles = []
  }
  render()
}

async function loadVehicleDetail(v) {
  _activeVehicle = v
  renderDetail(v)
  // Load sub-data in parallel
  const [svc, inv, asgn] = await Promise.all([
    apiJSON(`/api/v1/transport/vehicles/${v.id}/service`).catch(() => ({ records: [] })),
    apiJSON(`/api/v1/transport/vehicles/${v.id}/inventory`).catch(() => ({ stock: [] })),
    apiJSON(`/api/v1/transport/vehicles/${v.id}/assignments`).catch(() => ({ assignments: [] })),
  ])
  _activeVehicle = { ...v, service: svc.records || [], stock: inv.stock || [], assignments: asgn.assignments || [] }
  renderDetail(_activeVehicle)
}

// ── Normalization ──────────────────────────────────────────────────────────

function norm(v) {
  return {
    ...v,
    fuelType:   v.fuelType   ?? v.fuel_type   ?? 'gasoline',
    warehouseId: v.warehouseId ?? v.warehouse_id,
    createdAt:  v.createdAt  ?? v.created_at  ?? '',
    updatedAt:  v.updatedAt  ?? v.updated_at  ?? '',
  }
}

function normService(r) {
  return {
    ...r,
    serviceType: r.serviceType ?? r.service_type ?? 'maintenance',
    serviceDate: r.serviceDate ?? r.service_date ?? '',
    performedBy: r.performedBy ?? r.performed_by ?? '',
    createdAt:   r.createdAt   ?? r.created_at  ?? '',
  }
}

function normAssign(r) {
  return {
    ...r,
    assigneeName: r.assigneeName ?? r.assignee_name ?? '',
    startedAt:    r.startedAt    ?? r.started_at    ?? '',
    endedAt:      r.endedAt      ?? r.ended_at,
  }
}

function normStock(r) {
  return {
    ...r,
    skuCode: r.skuCode ?? r.sku_code ?? '',
    skuName: r.skuName ?? r.sku_name ?? '',
  }
}

// ── Render: list ───────────────────────────────────────────────────────────

function render() {
  if (!_el) return
  _el.innerHTML = `
    <div class="tr-shell">
      <div class="tr-topbar">
        <h2 class="tr-title"><i class="ti ti-truck"></i> Транспорт</h2>
        <button class="btn btn--primary btn--sm" id="tr-add-btn">
          <i class="ti ti-plus"></i> Добавить машину
        </button>
      </div>

      <div class="tr-kpi-row" id="tr-kpis">
        ${renderKpis()}
      </div>

      <div class="tr-grid" id="tr-grid">
        ${_vehicles.length
          ? _vehicles.map(renderCard).join('')
          : `<div class="tr-empty"><i class="ti ti-truck-off"></i><p>Нет автомобилей</p><button class="btn btn--primary" id="tr-add-empty">Добавить первый</button></div>`
        }
      </div>
    </div>`

  _el.querySelector('#tr-add-btn')?.addEventListener('click', openAddModal)
  _el.querySelector('#tr-add-empty')?.addEventListener('click', openAddModal)
  _el.querySelectorAll('.tr-card').forEach(card => {
    card.addEventListener('click', () => {
      const v = _vehicles.find(x => x.id === card.dataset.id)
      if (v) loadVehicleDetail(v)
    })
  })
}

function renderKpis() {
  const total  = _vehicles.length
  const active = _vehicles.filter(v => v.status === 'active').length
  const repair = _vehicles.filter(v => v.status === 'repair').length
  const off    = _vehicles.filter(v => v.status === 'inactive').length
  return `
    <div class="tr-kpi"><span class="tr-kpi-val">${total}</span><span class="tr-kpi-lbl">Всего</span></div>
    <div class="tr-kpi tr-kpi--ok"><span class="tr-kpi-val">${active}</span><span class="tr-kpi-lbl">Активных</span></div>
    <div class="tr-kpi tr-kpi--warn"><span class="tr-kpi-val">${repair}</span><span class="tr-kpi-lbl">В ремонте</span></div>
    <div class="tr-kpi tr-kpi--off"><span class="tr-kpi-val">${off}</span><span class="tr-kpi-lbl">Не активных</span></div>`
}

function renderCard(v) {
  const statusLabel = { active: 'Активен', repair: 'В ремонте', inactive: 'Не активен' }
  const statusClass = { active: 'status--active', repair: 'status--repair', inactive: 'status--inactive' }
  const fuelIcon = { gasoline: 'ti-gas-station', diesel: 'ti-gas-station', electric: 'ti-bolt', hybrid: 'ti-refresh', lpg: 'ti-gas-station' }
  return `
    <div class="tr-card" data-id="${esc(v.id)}">
      <div class="tr-card-head">
        <div class="tr-card-icon"><i class="ti ti-car"></i></div>
        <div class="tr-card-title">
          <span class="tr-plate">${esc(v.plate)}</span>
          <span class="tr-status ${statusClass[v.status] || ''}">${statusLabel[v.status] || v.status}</span>
        </div>
      </div>
      <div class="tr-card-name">${esc(v.make)} ${esc(v.model)} ${v.year ? `<span class="tr-year">${v.year}</span>` : ''}</div>
      <div class="tr-card-meta">
        ${v.color ? `<span><i class="ti ti-palette"></i> ${esc(v.color)}</span>` : ''}
        <span><i class="ti ${fuelIcon[v.fuelType] || 'ti-gas-station'}"></i> ${fuelLabel(v.fuelType)}</span>
        ${v.mileage ? `<span><i class="ti ti-road"></i> ${Number(v.mileage).toLocaleString('ru')} км</span>` : ''}
      </div>
    </div>`
}

function fuelLabel(ft) {
  return { gasoline: 'Бензин', diesel: 'Дизель', electric: 'Электро', hybrid: 'Гибрид', lpg: 'Газ' }[ft] || ft
}

// ── Render: detail panel ───────────────────────────────────────────────────

function renderDetail(v) {
  if (!_el) return
  const statusLabel = { active: 'Активен', repair: 'В ремонте', inactive: 'Не активен' }
  const statusClass = { active: 'status--active', repair: 'status--repair', inactive: 'status--inactive' }
  const currentAssignee = (v.assignments || []).map(normAssign).find(a => !a.endedAt)

  _el.innerHTML = `
    <div class="tr-shell tr-detail-mode">
      <div class="tr-topbar">
        <button class="btn btn--ghost btn--sm" id="tr-back"><i class="ti ti-arrow-left"></i> Транспорт</button>
        <div style="display:flex;gap:8px">
          <button class="btn btn--ghost btn--sm" id="tr-edit-btn"><i class="ti ti-pencil"></i> Изменить</button>
        </div>
      </div>

      <div class="tr-detail-header">
        <div class="tr-detail-icon"><i class="ti ti-car"></i></div>
        <div>
          <div class="tr-detail-plate">${esc(v.plate)}</div>
          <div class="tr-detail-name">${esc(v.make)} ${esc(v.model)}${v.year ? ` · ${v.year}` : ''}</div>
          <span class="tr-status ${statusClass[v.status] || ''}">${statusLabel[v.status] || v.status}</span>
        </div>
        <div class="tr-detail-stats">
          ${v.mileage ? `<div class="tr-stat"><span class="tr-stat-val">${Number(v.mileage).toLocaleString('ru')}</span><span class="tr-stat-lbl">км</span></div>` : ''}
          <div class="tr-stat"><span class="tr-stat-val">${(v.service || []).length}</span><span class="tr-stat-lbl">записей ТО</span></div>
          <div class="tr-stat"><span class="tr-stat-val">${(v.stock || []).length}</span><span class="tr-stat-lbl">позиций</span></div>
        </div>
      </div>

      ${currentAssignee ? `
      <div class="tr-assignee-banner">
        <i class="ti ti-user-check"></i>
        <span>Закреплён за: <strong>${esc(currentAssignee.assigneeName)}</strong></span>
        <span class="tr-assignee-since">с ${fmtDate(currentAssignee.startedAt)}</span>
        <button class="btn btn--ghost btn--xs" id="tr-unassign-btn">Снять</button>
      </div>` : `
      <div class="tr-assignee-banner tr-assignee-banner--empty">
        <i class="ti ti-user-question"></i>
        <span>Не закреплён</span>
        <button class="btn btn--ghost btn--xs" id="tr-assign-btn">Закрепить</button>
      </div>`}

      <div class="tr-tabs">
        <button class="tr-tab ${_tab === 'info' ? 'tr-tab--active' : ''}" data-tab="info"><i class="ti ti-info-circle"></i> Инфо</button>
        <button class="tr-tab ${_tab === 'service' ? 'tr-tab--active' : ''}" data-tab="service"><i class="ti ti-tool"></i> ТО и ремонты <span class="tr-tab-count">${(v.service || []).length}</span></button>
        <button class="tr-tab ${_tab === 'inventory' ? 'tr-tab--active' : ''}" data-tab="inventory"><i class="ti ti-package"></i> Инвентарь <span class="tr-tab-count">${(v.stock || []).length}</span></button>
        <button class="tr-tab ${_tab === 'assignments' ? 'tr-tab--active' : ''}" data-tab="assignments"><i class="ti ti-users"></i> Назначения</button>
      </div>

      <div class="tr-tab-content" id="tr-tab-content">
        ${renderTabContent(v)}
      </div>
    </div>`

  _el.querySelector('#tr-back')?.addEventListener('click', () => { _activeVehicle = null; _tab = 'info'; render() })
  _el.querySelector('#tr-edit-btn')?.addEventListener('click', () => openEditModal(v))
  _el.querySelector('#tr-assign-btn')?.addEventListener('click', () => openAssignModal(v))
  _el.querySelector('#tr-unassign-btn')?.addEventListener('click', () => confirmUnassign(v, currentAssignee))
  _el.querySelector('#tr-svc-add')?.addEventListener('click', () => openServiceModal(v))

  _el.querySelectorAll('.tr-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _tab = tab.dataset.tab
      _el.querySelectorAll('.tr-tab').forEach(t => t.classList.toggle('tr-tab--active', t.dataset.tab === _tab))
      _el.querySelector('#tr-tab-content').innerHTML = renderTabContent(_activeVehicle || v)
      bindTabEvents(v)
    })
  })

  bindTabEvents(v)
}

function renderTabContent(v) {
  if (_tab === 'info') return renderInfoTab(v)
  if (_tab === 'service') return renderServiceTab(v)
  if (_tab === 'inventory') return renderInventoryTab(v)
  if (_tab === 'assignments') return renderAssignmentsTab(v)
  return ''
}

function renderInfoTab(v) {
  const rows = [
    ['Гос. номер', v.plate],
    ['Марка',      v.make],
    ['Модель',     v.model],
    ['Год',        v.year],
    ['Цвет',       v.color],
    ['VIN',        v.vin],
    ['Тип топлива', fuelLabel(v.fuelType)],
    ['Пробег',     v.mileage ? `${Number(v.mileage).toLocaleString('ru')} км` : null],
    ['Заметки',    v.notes],
  ].filter(([, val]) => val)

  return `
    <div class="tr-info-grid">
      ${rows.map(([label, val]) => `
        <div class="tr-info-row">
          <span class="tr-info-label">${esc(label)}</span>
          <span class="tr-info-val">${esc(String(val))}</span>
        </div>`).join('')}
    </div>`
}

function renderServiceTab(v) {
  const records = (v.service || []).map(normService)
  const typeLabel = { maintenance: 'ТО', repair: 'Ремонт', inspection: 'Осмотр', fuel: 'Заправка', wash: 'Мойка', other: 'Прочее' }
  const typeClass  = { maintenance: 'svc--maint', repair: 'svc--repair', inspection: 'svc--insp', fuel: 'svc--fuel', wash: 'svc--wash', other: 'svc--other' }
  return `
    <div class="tr-section-head">
      <span>${records.length} записей</span>
      <button class="btn btn--primary btn--sm" id="tr-svc-add"><i class="ti ti-plus"></i> Добавить</button>
    </div>
    ${records.length ? `
    <div class="tr-svc-list">
      ${records.map(r => `
        <div class="tr-svc-item">
          <span class="tr-svc-badge ${typeClass[r.serviceType] || ''}">${typeLabel[r.serviceType] || r.serviceType}</span>
          <div class="tr-svc-main">
            <div class="tr-svc-title">${esc(r.title)}</div>
            ${r.description ? `<div class="tr-svc-desc">${esc(r.description)}</div>` : ''}
          </div>
          <div class="tr-svc-meta">
            ${r.serviceDate ? `<span>${fmtDate(r.serviceDate)}</span>` : ''}
            ${r.mileage ? `<span>${Number(r.mileage).toLocaleString('ru')} км</span>` : ''}
            ${r.cost ? `<span>${Number(r.cost).toLocaleString('ru', {style:'currency',currency:'RUB',maximumFractionDigits:0})}</span>` : ''}
            ${r.performedBy ? `<span><i class="ti ti-user"></i> ${esc(r.performedBy)}</span>` : ''}
          </div>
        </div>`).join('')}
    </div>` : `<div class="tr-empty-inline"><i class="ti ti-tool"></i> Нет записей ТО</div>`}`
}

function renderInventoryTab(v) {
  const stock = (v.stock || []).map(normStock)
  return `
    <div class="tr-section-head">
      <span>${stock.length} позиций на борту</span>
    </div>
    ${stock.length ? `
    <table class="tr-inv-table">
      <thead><tr><th>SKU</th><th>Наименование</th><th>Кол-во</th><th>Ед.</th></tr></thead>
      <tbody>
        ${stock.map(s => `
          <tr>
            <td><code>${esc(s.skuCode)}</code></td>
            <td>${esc(s.skuName)}</td>
            <td>${s.quantity}</td>
            <td>${esc(s.unit || '—')}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : `<div class="tr-empty-inline"><i class="ti ti-package-off"></i> Инвентарь в машине не зарегистрирован</div>`}`
}

function renderAssignmentsTab(v) {
  const asgns = (v.assignments || []).map(normAssign)
  return `
    <div class="tr-section-head">
      <span>История закреплений</span>
      <button class="btn btn--primary btn--sm" id="tr-assign-tab-btn"><i class="ti ti-user-plus"></i> Закрепить</button>
    </div>
    ${asgns.length ? `
    <div class="tr-asgn-list">
      ${asgns.map(a => `
        <div class="tr-asgn-item ${!a.endedAt ? 'tr-asgn--active' : ''}">
          <div class="tr-asgn-avatar">${esc((a.assigneeName || '?')[0].toUpperCase())}</div>
          <div class="tr-asgn-info">
            <div class="tr-asgn-name">${esc(a.assigneeName)}</div>
            <div class="tr-asgn-dates">${fmtDate(a.startedAt)} — ${a.endedAt ? fmtDate(a.endedAt) : '<strong>сейчас</strong>'}</div>
            ${a.notes ? `<div class="tr-asgn-notes">${esc(a.notes)}</div>` : ''}
          </div>
          ${!a.endedAt ? `<span class="tr-asgn-badge">Текущий</span>` : ''}
        </div>`).join('')}
    </div>` : `<div class="tr-empty-inline"><i class="ti ti-users"></i> Нет истории закреплений</div>`}`
}

function bindTabEvents(v) {
  _el.querySelector('#tr-svc-add')?.addEventListener('click', () => openServiceModal(v))
  _el.querySelector('#tr-assign-tab-btn')?.addEventListener('click', () => openAssignModal(v))
}

// ── Modals ─────────────────────────────────────────────────────────────────

function openAddModal() { openVehicleModal(null) }
function openEditModal(v) { openVehicleModal(v) }

function openVehicleModal(v) {
  const isEdit = !!v
  const m = document.createElement('div')
  m.className = 'modal-overlay'
  m.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-header">
        <h3>${isEdit ? 'Изменить автомобиль' : 'Новый автомобиль'}</h3>
        <button class="modal-close" id="vm-close"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body" style="display:grid;gap:12px">
        <div class="form-group">
          <label>Гос. номер *</label>
          <input class="form-control" id="vm-plate" value="${esc(v?.plate || '')}" placeholder="А001АА777">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label>Марка *</label>
            <input class="form-control" id="vm-make" value="${esc(v?.make || '')}" placeholder="Toyota">
          </div>
          <div class="form-group">
            <label>Модель *</label>
            <input class="form-control" id="vm-model" value="${esc(v?.model || '')}" placeholder="Hilux">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div class="form-group">
            <label>Год</label>
            <input class="form-control" id="vm-year" type="number" value="${v?.year || ''}" placeholder="2022">
          </div>
          <div class="form-group">
            <label>Цвет</label>
            <input class="form-control" id="vm-color" value="${esc(v?.color || '')}" placeholder="Белый">
          </div>
          <div class="form-group">
            <label>Пробег (км)</label>
            <input class="form-control" id="vm-mileage" type="number" value="${v?.mileage || ''}" placeholder="0">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label>Тип топлива</label>
            <select class="form-control" id="vm-fuel">
              ${['gasoline','diesel','electric','hybrid','lpg'].map(f =>
                `<option value="${f}" ${(v?.fuelType || 'gasoline') === f ? 'selected' : ''}>${fuelLabel(f)}</option>`
              ).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Статус</label>
            <select class="form-control" id="vm-status">
              <option value="active" ${(v?.status || 'active') === 'active' ? 'selected' : ''}>Активен</option>
              <option value="repair" ${v?.status === 'repair' ? 'selected' : ''}>В ремонте</option>
              <option value="inactive" ${v?.status === 'inactive' ? 'selected' : ''}>Не активен</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>VIN</label>
          <input class="form-control" id="vm-vin" value="${esc(v?.vin || '')}" placeholder="XTA...">
        </div>
        <div class="form-group">
          <label>Заметки</label>
          <textarea class="form-control" id="vm-notes" rows="2">${esc(v?.notes || '')}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn--ghost" id="vm-cancel">Отмена</button>
        <button class="btn btn--primary" id="vm-save">${isEdit ? 'Сохранить' : 'Добавить'}</button>
      </div>
    </div>`
  document.body.appendChild(m)
  const close = () => m.remove()
  m.querySelector('#vm-close').addEventListener('click', close)
  m.querySelector('#vm-cancel').addEventListener('click', close)
  m.addEventListener('click', e => { if (e.target === m) close() })
  m.querySelector('#vm-save').addEventListener('click', async () => {
    const payload = {
      plate:    m.querySelector('#vm-plate').value.trim().toUpperCase(),
      make:     m.querySelector('#vm-make').value.trim(),
      model:    m.querySelector('#vm-model').value.trim(),
      year:     parseInt(m.querySelector('#vm-year').value) || null,
      color:    m.querySelector('#vm-color').value.trim() || null,
      mileage:  parseInt(m.querySelector('#vm-mileage').value) || 0,
      fuelType: m.querySelector('#vm-fuel').value,
      status:   m.querySelector('#vm-status').value,
      vin:      m.querySelector('#vm-vin').value.trim() || null,
      notes:    m.querySelector('#vm-notes').value.trim() || null,
    }
    if (!payload.plate || !payload.make || !payload.model) {
      alert('Заполните гос.номер, марку и модель')
      return
    }
    const btn = m.querySelector('#vm-save')
    btn.disabled = true
    btn.textContent = 'Сохранение…'
    try {
      if (isEdit) {
        await apiPost(`/api/v1/transport/vehicles/${v.id}/update`, payload)
      } else {
        await apiPost('/api/v1/transport/vehicles', payload)
      }
      close()
      await loadVehicles()
    } catch (err) {
      btn.disabled = false
      btn.textContent = isEdit ? 'Сохранить' : 'Добавить'
      alert('Ошибка: ' + (err.message || err))
    }
  })
}

function openAssignModal(v) {
  const m = document.createElement('div')
  m.className = 'modal-overlay'
  const today = new Date().toISOString().slice(0, 10)
  m.innerHTML = `
    <div class="modal" style="max-width:400px">
      <div class="modal-header">
        <h3>Закрепить водителя</h3>
        <button class="modal-close" id="am-close"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body" style="display:grid;gap:12px">
        <div class="form-group">
          <label>ФИО водителя *</label>
          <input class="form-control" id="am-name" placeholder="Иванов Иван Иванович">
        </div>
        <div class="form-group">
          <label>Дата начала</label>
          <input class="form-control" id="am-date" type="date" value="${today}">
        </div>
        <div class="form-group">
          <label>Заметки</label>
          <input class="form-control" id="am-notes" placeholder="Необязательно">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn--ghost" id="am-cancel">Отмена</button>
        <button class="btn btn--primary" id="am-save">Закрепить</button>
      </div>
    </div>`
  document.body.appendChild(m)
  const close = () => m.remove()
  m.querySelector('#am-close').addEventListener('click', close)
  m.querySelector('#am-cancel').addEventListener('click', close)
  m.addEventListener('click', e => { if (e.target === m) close() })
  m.querySelector('#am-save').addEventListener('click', async () => {
    const name = m.querySelector('#am-name').value.trim()
    if (!name) { alert('Укажите ФИО'); return }
    const btn = m.querySelector('#am-save')
    btn.disabled = true
    try {
      await apiPost(`/api/v1/transport/vehicles/${v.id}/assign`, {
        assigneeName: name,
        startedAt: m.querySelector('#am-date').value || today,
        notes: m.querySelector('#am-notes').value.trim() || null,
      })
      close()
      loadVehicleDetail(v)
    } catch (err) {
      btn.disabled = false
      alert('Ошибка: ' + (err.message || err))
    }
  })
}

async function confirmUnassign(v, assignee) {
  if (!confirm(`Снять ${assignee.assigneeName} с машины ${v.plate}?`)) return
  try {
    await apiPost(`/api/v1/transport/vehicles/${v.id}/unassign`, { endedAt: new Date().toISOString() })
    loadVehicleDetail(v)
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

function openServiceModal(v) {
  const m = document.createElement('div')
  m.className = 'modal-overlay'
  const today = new Date().toISOString().slice(0, 10)
  m.innerHTML = `
    <div class="modal" style="max-width:440px">
      <div class="modal-header">
        <h3>Запись ТО / ремонт</h3>
        <button class="modal-close" id="sm-close"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body" style="display:grid;gap:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label>Тип *</label>
            <select class="form-control" id="sm-type">
              <option value="maintenance">ТО</option>
              <option value="repair">Ремонт</option>
              <option value="inspection">Осмотр</option>
              <option value="fuel">Заправка</option>
              <option value="wash">Мойка</option>
              <option value="other">Прочее</option>
            </select>
          </div>
          <div class="form-group">
            <label>Статус</label>
            <select class="form-control" id="sm-status">
              <option value="done">Выполнено</option>
              <option value="planned">Запланировано</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Название *</label>
          <input class="form-control" id="sm-title" placeholder="Замена масла, колодки…">
        </div>
        <div class="form-group">
          <label>Описание</label>
          <textarea class="form-control" id="sm-desc" rows="2" placeholder="Подробности…"></textarea>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div class="form-group">
            <label>Дата</label>
            <input class="form-control" id="sm-date" type="date" value="${today}">
          </div>
          <div class="form-group">
            <label>Пробег (км)</label>
            <input class="form-control" id="sm-mileage" type="number" placeholder="${v.mileage || ''}">
          </div>
          <div class="form-group">
            <label>Стоимость (₽)</label>
            <input class="form-control" id="sm-cost" type="number" step="100" placeholder="0">
          </div>
        </div>
        <div class="form-group">
          <label>Исполнитель</label>
          <input class="form-control" id="sm-by" placeholder="Сервис / ФИО">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn--ghost" id="sm-cancel">Отмена</button>
        <button class="btn btn--primary" id="sm-save">Сохранить</button>
      </div>
    </div>`
  document.body.appendChild(m)
  const close = () => m.remove()
  m.querySelector('#sm-close').addEventListener('click', close)
  m.querySelector('#sm-cancel').addEventListener('click', close)
  m.addEventListener('click', e => { if (e.target === m) close() })
  m.querySelector('#sm-save').addEventListener('click', async () => {
    const title = m.querySelector('#sm-title').value.trim()
    if (!title) { alert('Укажите название'); return }
    const btn = m.querySelector('#sm-save')
    btn.disabled = true
    try {
      await apiPost(`/api/v1/transport/vehicles/${v.id}/service`, {
        serviceType: m.querySelector('#sm-type').value,
        title,
        description: m.querySelector('#sm-desc').value.trim() || null,
        serviceDate:  m.querySelector('#sm-date').value || null,
        mileage:  parseInt(m.querySelector('#sm-mileage').value) || null,
        cost:     parseFloat(m.querySelector('#sm-cost').value) || null,
        performedBy: m.querySelector('#sm-by').value.trim() || null,
        status:   m.querySelector('#sm-status').value,
      })
      close()
      _tab = 'service'
      loadVehicleDetail(v)
    } catch (err) {
      btn.disabled = false
      alert('Ошибка: ' + err.message)
    }
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return iso }
}
