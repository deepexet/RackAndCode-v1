import { apiJSON, apiPost } from '../core/api.js'
import { createStore } from '../core/store.js'

const state = createStore({
  loading: true,
  warehouses: [],
  skus: [],
  stock: [],
  movements: [],
  alerts: [],
  assets: [],
  tab: 'stock',
  warehouseFilter: null,
  categoryFilter: null,
  searchQ: '',
})

let _el = null

export async function mount() {
  _el = document.querySelector('[data-view="inventory"]')
  if (!_el) return unmount
  renderSkeleton(_el)
  await loadData()
  render()
  return unmount
}

// snake_case → camelCase for stock/sku/movement rows from API
function normStock(r) {
  return {
    ...r,
    skuId: r.skuId ?? r.sku_id ?? '',
    skuCode: r.skuCode ?? r.sku_code ?? '',
    skuName: r.skuName ?? r.sku_name ?? '',
    warehouseId: r.warehouseId ?? r.warehouse_id ?? '',
    warehouseName: r.warehouseName ?? r.warehouse_name ?? '',
    minQuantity: r.minQuantity ?? r.min_quantity ?? 0,
    locationBin: r.locationBin ?? r.location_bin ?? '',
  }
}
function normSku(r) {
  return {
    ...r,
    skuCode: r.skuCode ?? r.sku_code ?? '',
    unitCost: r.unitCost ?? r.unit_cost ?? null,
    reorderPoint: r.reorderPoint ?? r.reorder_point ?? 0,
  }
}
function normMovement(r) {
  return {
    ...r,
    skuCode: r.skuCode ?? r.sku_code ?? '',
    skuName: r.skuName ?? r.sku_name ?? '',
    warehouseName: r.warehouseName ?? r.warehouse_name ?? '',
    movementType: r.movementType ?? r.movement_type ?? '',
    createdAt: r.createdAt ?? r.created_at ?? '',
  }
}

async function loadData() {
  try {
    const [whData, stockData, alertsData] = await Promise.all([
      apiJSON('/api/v1/inventory/warehouses').catch(() => ({ warehouses: [] })),
      apiJSON('/api/v1/inventory/stock').catch(() => ({ stock: [] })),
      apiJSON('/api/v1/inventory/alerts').catch(() => ({ alerts: [] })),
    ])
    state.set({
      loading: false,
      warehouses: whData.warehouses || [],
      stock: (stockData.stock || []).map(normStock),
      alerts: alertsData.alerts || [],
    })
  } catch {
    state.set({ loading: false })
  }
}

async function loadSkus(category) {
  const url = category
    ? `/api/v1/inventory/skus?category=${encodeURIComponent(category)}`
    : '/api/v1/inventory/skus'
  const d = await apiJSON(url).catch(() => ({ skus: [] }))
  state.set({ skus: (d.skus || []).map(normSku) })
}

async function loadMovements(warehouseId) {
  const url = warehouseId
    ? `/api/v1/inventory/movements?warehouseId=${encodeURIComponent(warehouseId)}&limit=100`
    : '/api/v1/inventory/movements?limit=100'
  const d = await apiJSON(url).catch(() => ({ movements: [] }))
  state.set({ movements: (d.movements || []).map(normMovement) })
}

async function loadAssets() {
  const d = await apiJSON('/api/v1/tracked-assets').catch(() => ({ assets: [] }))
  state.set({ assets: d.assets || [] })
}

export function unmount() { _el = null }

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  if (!_el) return
  const s = state.get()
  const alertCount = s.alerts.length

  _el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Inventory</div>
        <div class="page-sub">${s.warehouses.length} warehouses · ${s.stock.length} SKUs tracked${alertCount ? ` · <span style="color:var(--amber)">${alertCount} alerts</span>` : ''}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn--ghost" id="inv-receive"><i class="ti ti-package-import"></i> Receive</button>
        <button class="btn btn--primary" id="inv-add-sku"><i class="ti ti-plus"></i> Add SKU</button>
      </div>
    </div>

    ${alertCount ? alertsBanner(s.alerts) : ''}

    <div class="tab-bar" style="margin-bottom:16px">
      ${['stock','skus','movements','warehouses','assets'].map(t => `
        <button class="tab-btn${s.tab === t ? ' tab-btn--active' : ''}" data-tab="${t}">
          ${tabLabel(t)}
        </button>`).join('')}
    </div>

    <div id="inv-content"></div>
  `

  bindTabBar()
  renderTab(s)

  _el.querySelector('#inv-receive')?.addEventListener('click', () => openReceiveModal())
  _el.querySelector('#inv-add-sku')?.addEventListener('click', () => openSkuModal())
  _el.querySelector('#inv-add-asset')?.addEventListener('click', () => openAssetModal())
}

function tabLabel(t) {
  return { stock: 'Stock', skus: 'SKUs', movements: 'Movements', warehouses: 'Warehouses', assets: 'Активы' }[t] || t
}

function bindTabBar() {
  _el.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.tab
      state.set({ tab })
      _el.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('tab-btn--active', b.dataset.tab === tab))
      if (tab === 'skus' && !state.get().skus.length) await loadSkus()
      if (tab === 'movements' && !state.get().movements.length) await loadMovements()
      if (tab === 'assets') await loadAssets()
      renderTab(state.get())
    })
  })
}

function renderTab(s) {
  const content = _el?.querySelector('#inv-content')
  if (!content) return
  switch (s.tab) {
    case 'stock':       content.innerHTML = renderStock(s); break
    case 'skus':        content.innerHTML = renderSkus(s); break
    case 'movements':   content.innerHTML = renderMovements(s); break
    case 'warehouses':  content.innerHTML = renderWarehouses(s); break
    case 'assets':      content.innerHTML = renderAssets(s); bindAssetsTab(s); return
  }
  bindTabContent(s)
}

// ── Stock tab ─────────────────────────────────────────────────────────────────

function renderStock(s) {
  const whs = [{ id: null, name: 'All warehouses' }, ...s.warehouses]
  const filtered = s.stock.filter(item => {
    if (s.warehouseFilter && item.warehouseId !== s.warehouseFilter) return false
    if (s.searchQ) {
      const q = s.searchQ.toLowerCase()
      return (item.skuName || '').toLowerCase().includes(q) || (item.skuCode || '').toLowerCase().includes(q)
    }
    return true
  })

  if (!s.stock.length) return emptyState('ti-packages', 'No stock recorded yet', 'Receive your first shipment to get started.')

  return `
    <div class="filter-bar" style="margin-bottom:12px">
      <input class="field-input" id="inv-search" type="search" placeholder="Search SKU…" value="${esc(s.searchQ)}" style="max-width:220px">
      <select class="field-input" id="inv-wh-filter" style="max-width:200px">
        ${whs.map(w => `<option value="${w.id || ''}"${s.warehouseFilter === w.id ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select>
    </div>
    <div class="card" style="overflow:hidden">
      <table class="data-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Name</th>
            <th>Warehouse</th>
            <th style="text-align:right">Qty</th>
            <th style="text-align:right">Reserved</th>
            <th style="text-align:right">Available</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.length
            ? filtered.map(item => stockRow(item)).join('')
            : `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-4)">No results</td></tr>`}
        </tbody>
      </table>
    </div>
    <div style="margin-top:8px;font-size:12px;color:var(--text-4)">${filtered.length} items</div>
  `
}

function stockRow(item) {
  const avail = (item.quantity || 0) - (item.reserved || 0)
  const statusCls = item.quantity <= 0 ? 'badge--red' : item.quantity <= (item.reorderPoint || 5) ? 'badge--amber' : 'badge--green'
  const statusLabel = item.quantity <= 0 ? 'Out of stock' : item.quantity <= (item.reorderPoint || 5) ? 'Low stock' : 'In stock'
  return `
    <tr class="data-row" data-sku-id="${esc(item.skuId)}">
      <td><code style="font-size:11px">${esc(item.skuCode || '—')}</code></td>
      <td style="font-weight:500">${esc(item.skuName || '—')}</td>
      <td style="color:var(--text-3)">${esc(item.warehouseName || '—')}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${fmt(item.quantity)} ${esc(item.unit || '')}</td>
      <td style="text-align:right;color:var(--text-4)">${fmt(item.reserved)}</td>
      <td style="text-align:right;font-weight:500;color:${avail <= 0 ? 'var(--red)' : 'var(--text-2)'}">${fmt(avail)}</td>
      <td><span class="badge ${statusCls}">${statusLabel}</span></td>
    </tr>`
}

// ── SKUs tab ──────────────────────────────────────────────────────────────────

function renderSkus(s) {
  const categories = [...new Set(s.skus.map(sk => sk.category).filter(Boolean))]
  const filtered = s.skus.filter(sk => {
    if (s.categoryFilter && sk.category !== s.categoryFilter) return false
    if (s.searchQ) {
      const q = s.searchQ.toLowerCase()
      return (sk.name || '').toLowerCase().includes(q) || (sk.skuCode || '').toLowerCase().includes(q)
    }
    return true
  })

  if (!s.skus.length) return emptyState('ti-barcode', 'No SKUs yet', 'Add your first SKU to start tracking inventory.')

  return `
    <div class="filter-bar" style="margin-bottom:12px">
      <input class="field-input" id="inv-search" type="search" placeholder="Search…" value="${esc(s.searchQ)}" style="max-width:220px">
      <select class="field-input" id="inv-cat-filter" style="max-width:180px">
        <option value="">All categories</option>
        ${categories.map(c => `<option value="${esc(c)}"${s.categoryFilter === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div class="card" style="overflow:hidden">
      <table class="data-table">
        <thead>
          <tr><th>Code</th><th>Name</th><th>Category</th><th>Unit</th><th style="text-align:right">Cost</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${filtered.length
            ? filtered.map(sk => skuRow(sk)).join('')
            : `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-4)">No results</td></tr>`}
        </tbody>
      </table>
    </div>`
}

function skuRow(sk) {
  return `
    <tr class="data-row">
      <td><code style="font-size:11px">${esc(sk.skuCode || '—')}</code></td>
      <td style="font-weight:500">${esc(sk.name)}</td>
      <td>${esc(sk.category || '—')}</td>
      <td style="color:var(--text-3)">${esc(sk.unit || '—')}</td>
      <td style="text-align:right">${sk.unitCost != null ? '₽' + fmtNum(sk.unitCost) : '—'}</td>
      <td>
        <button class="btn btn--ghost btn--sm" data-edit-sku="${esc(sk.id)}">Edit</button>
      </td>
    </tr>`
}

// ── Movements tab ─────────────────────────────────────────────────────────────

function renderMovements(s) {
  if (!s.movements.length) return emptyState('ti-transfer', 'No movements yet', 'Receive or issue stock to see movements here.')
  return `
    <div class="card" style="overflow:hidden">
      <table class="data-table">
        <thead>
          <tr><th>Date</th><th>Type</th><th>SKU</th><th>Warehouse</th><th style="text-align:right">Qty</th><th>Reference</th></tr>
        </thead>
        <tbody>
          ${s.movements.map(m => `
            <tr class="data-row">
              <td style="color:var(--text-4);font-size:12px">${fmtDate(m.movedAt || m.createdAt)}</td>
              <td>${movTypeBadge(m.movementType)}</td>
              <td>${esc(m.skuName || m.skuCode || m.skuId || '—')}</td>
              <td style="color:var(--text-3)">${esc(m.warehouseName || '—')}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${m.movementType === 'issue' || m.movementType === 'loss' ? '−' : '+'}${fmt(m.quantity)}</td>
              <td style="color:var(--text-4);font-size:12px">${esc(m.reference || '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`
}

function movTypeBadge(t) {
  const map = {
    receive: ['badge--green', 'Receive'],
    issue:   ['badge--blue',  'Issue'],
    transfer:['badge--purple','Transfer'],
    adjust:  ['badge--gray',  'Adjust'],
    loss:    ['badge--red',   'Loss'],
  }
  const [cls, label] = map[t] || ['badge--gray', t]
  return `<span class="badge ${cls}">${label}</span>`
}

// ── Warehouses tab ─────────────────────────────────────────────────────────────

function renderWarehouses(s) {
  if (!s.warehouses.length) return `
    ${emptyState('ti-building-warehouse', 'No warehouses yet', 'Create your first warehouse to start receiving stock.')}
    <div style="text-align:center;margin-top:12px">
      <button class="btn btn--primary" id="inv-add-wh"><i class="ti ti-plus"></i> Add warehouse</button>
    </div>`
  return `
    <div class="inv-wh-grid">
      ${s.warehouses.map(wh => `
        <div class="card" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
            <div>
              <div style="font-weight:600;font-size:14px">${esc(wh.name)}</div>
              ${wh.location ? `<div style="font-size:12px;color:var(--text-4)">${esc(wh.location)}</div>` : ''}
            </div>
            <i class="ti ti-building-warehouse" style="font-size:20px;color:var(--text-4)"></i>
          </div>
          ${wh.description ? `<div style="font-size:12px;color:var(--text-4)">${esc(wh.description)}</div>` : ''}
        </div>`).join('')}
    </div>
    <button class="btn btn--ghost" id="inv-add-wh" style="margin-top:12px"><i class="ti ti-plus"></i> Add warehouse</button>
  `
}

// ── Alerts banner ─────────────────────────────────────────────────────────────

function alertsBanner(alerts) {
  const critical = alerts.filter(a => a.severity === 'critical' || a.level === 'out')
  const warn = alerts.filter(a => a.severity !== 'critical' && a.level !== 'out')
  return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      ${critical.length ? `<div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--red-bg);border:1px solid var(--red);border-radius:8px;font-size:13px;color:var(--red)"><i class="ti ti-alert-circle"></i> ${critical.length} out of stock</div>` : ''}
      ${warn.length ? `<div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--amber-bg);border:1px solid var(--amber);border-radius:8px;font-size:13px;color:var(--amber)"><i class="ti ti-alert-triangle"></i> ${warn.length} low stock</div>` : ''}
    </div>`
}

// ── Modals ────────────────────────────────────────────────────────────────────

function openReceiveModal() {
  const s = state.get()
  const modal = createModal('Receive Stock', `
    <div class="field-group">
      <label class="field-label">Warehouse *</label>
      <select class="field-input" id="rm-wh">
        <option value="">Select warehouse…</option>
        ${s.warehouses.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field-group">
      <label class="field-label">SKU Code *</label>
      <input class="field-input" id="rm-sku" placeholder="SKU-001" list="sku-dl">
      <datalist id="sku-dl">${s.skus.map(sk => `<option value="${esc(sk.skuCode)}">${esc(sk.name)}</option>`).join('')}</datalist>
    </div>
    <div class="field-group">
      <label class="field-label">Quantity *</label>
      <input class="field-input" id="rm-qty" type="number" min="0.001" step="0.001" placeholder="0">
    </div>
    <div class="field-group">
      <label class="field-label">Reference</label>
      <input class="field-input" id="rm-ref" placeholder="PO-123">
    </div>
    <div class="field-group">
      <label class="field-label">Note</label>
      <input class="field-input" id="rm-note" placeholder="Optional note">
    </div>
  `, async () => {
    const warehouseId = document.getElementById('rm-wh')?.value
    const skuCode = document.getElementById('rm-sku')?.value?.trim()
    const quantity = parseFloat(document.getElementById('rm-qty')?.value || '0')
    if (!warehouseId || !skuCode || !quantity) throw new Error('Warehouse, SKU, and quantity are required')
    const cur = state.get()
    let skuId = cur.skus.find(sk => sk.skuCode === skuCode)?.id
                 || cur.stock.find(st => st.skuCode === skuCode)?.skuId
    if (!skuId) throw new Error(`SKU "${skuCode}" not found — add it first in the SKUs tab`)
    await apiPost('/api/v1/inventory/movements', {
      movementType: 'receive',
      warehouseId,
      skuId,
      quantity,
      reference: document.getElementById('rm-ref')?.value?.trim(),
      note: document.getElementById('rm-note')?.value?.trim(),
    })
    await Promise.all([loadData(), loadMovements()])
    render()
    window.toast?.('Stock received', 'success')
  })
  document.body.appendChild(modal)
}

function openSkuModal(sku = null) {
  const isEdit = !!sku
  const modal = createModal(isEdit ? 'Edit SKU' : 'New SKU', `
    <div class="field-group">
      <label class="field-label">SKU Code *</label>
      <input class="field-input" id="sm-code" placeholder="SKU-001" value="${esc(sku?.skuCode || '')}">
    </div>
    <div class="field-group">
      <label class="field-label">Name *</label>
      <input class="field-input" id="sm-name" placeholder="Item name" value="${esc(sku?.name || '')}">
    </div>
    <div class="field-group">
      <label class="field-label">Category</label>
      <input class="field-input" id="sm-cat" placeholder="Cables, Tools…" value="${esc(sku?.category || '')}">
    </div>
    <div class="field-group">
      <label class="field-label">Unit</label>
      <input class="field-input" id="sm-unit" placeholder="pcs, m, kg…" value="${esc(sku?.unit || 'pcs')}">
    </div>
    <div class="field-group">
      <label class="field-label">Unit cost (₽)</label>
      <input class="field-input" id="sm-cost" type="number" min="0" step="0.01" placeholder="0.00" value="${sku?.unitCost ?? ''}">
    </div>
    <div class="field-group">
      <label class="field-label">Reorder point</label>
      <input class="field-input" id="sm-reorder" type="number" min="0" placeholder="5" value="${sku?.reorderPoint ?? ''}">
    </div>
  `, async () => {
    const code = document.getElementById('sm-code')?.value?.trim()
    const name = document.getElementById('sm-name')?.value?.trim()
    if (!code || !name) throw new Error('Code and name are required')
    const payload = {
      skuCode: code,
      name,
      category: document.getElementById('sm-cat')?.value?.trim() || '',
      unit: document.getElementById('sm-unit')?.value?.trim() || 'pcs',
      unitCost: parseFloat(document.getElementById('sm-cost')?.value || '0') || null,
      reorderPoint: parseInt(document.getElementById('sm-reorder')?.value || '0') || null,
    }
    const url = isEdit ? `/api/v1/inventory/skus/${sku.id}/update` : '/api/v1/inventory/skus'
    await apiPost(url, payload)
    await loadSkus(state.get().categoryFilter)
    renderTab(state.get())
    window.toast?.(isEdit ? 'SKU updated' : 'SKU created', 'success')
  })
  document.body.appendChild(modal)
}

function openWarehouseModal() {
  const modal = createModal('New Warehouse', `
    <div class="field-group">
      <label class="field-label">Name *</label>
      <input class="field-input" id="wm-name" placeholder="Main warehouse">
    </div>
    <div class="field-group">
      <label class="field-label">Location</label>
      <input class="field-input" id="wm-loc" placeholder="City, address…">
    </div>
    <div class="field-group">
      <label class="field-label">Description</label>
      <input class="field-input" id="wm-desc" placeholder="Optional description">
    </div>
  `, async () => {
    const name = document.getElementById('wm-name')?.value?.trim()
    if (!name) throw new Error('Name is required')
    await apiPost('/api/v1/inventory/warehouses', {
      name,
      location: document.getElementById('wm-loc')?.value?.trim() || '',
      description: document.getElementById('wm-desc')?.value?.trim() || '',
    })
    await loadData()
    render()
    window.toast?.('Warehouse created', 'success')
  })
  document.body.appendChild(modal)
}

function createModal(title, bodyHtml, onSubmit) {
  const el = document.createElement('div')
  el.className = 'modal-overlay'
  el.style.display = 'flex'
  el.innerHTML = `
    <div class="modal-box" style="max-width:460px;width:100%">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="font-size:16px;font-weight:600">${esc(title)}</div>
        <button class="icon-btn" id="mc-close"><i class="ti ti-x"></i></button>
      </div>
      ${bodyHtml}
      <div id="mc-err" class="field-error" style="display:none;margin-top:8px"></div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button class="btn btn--ghost" id="mc-cancel">Cancel</button>
        <button class="btn btn--primary" id="mc-submit">Save</button>
      </div>
    </div>`

  const close = () => el.remove()
  el.querySelector('#mc-close')?.addEventListener('click', close)
  el.querySelector('#mc-cancel')?.addEventListener('click', close)
  el.addEventListener('click', e => { if (e.target === el) close() })

  el.querySelector('#mc-submit')?.addEventListener('click', async () => {
    const btn = el.querySelector('#mc-submit')
    const errEl = el.querySelector('#mc-err')
    btn.disabled = true
    btn.textContent = 'Saving…'
    errEl.style.display = 'none'
    try {
      await onSubmit()
      close()
    } catch (err) {
      errEl.textContent = err.message
      errEl.style.display = 'block'
      btn.disabled = false
      btn.textContent = 'Save'
    }
  })
  return el
}

// ── Bind tab content ──────────────────────────────────────────────────────────

function bindTabContent() {
  const content = _el?.querySelector('#inv-content')
  if (!content) return

  content.querySelector('#inv-search')?.addEventListener('input', e => {
    state.set({ searchQ: e.target.value })
    renderTab(state.get())
  })
  content.querySelector('#inv-wh-filter')?.addEventListener('change', e => {
    state.set({ warehouseFilter: e.target.value || null })
    renderTab(state.get())
  })
  content.querySelector('#inv-cat-filter')?.addEventListener('change', async e => {
    const cat = e.target.value || null
    state.set({ categoryFilter: cat })
    await loadSkus(cat)
    renderTab(state.get())
  })
  content.querySelectorAll('[data-edit-sku]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.editSku
      const sku = state.get().skus.find(sk => sk.id === id)
      if (sku) openSkuModal(sku)
    })
  })
  content.querySelector('#inv-add-wh')?.addEventListener('click', () => openWarehouseModal())
}

// ── Skeleton & empty state ────────────────────────────────────────────────────

function renderSkeleton(el) {
  el.innerHTML = `
    <div class="page-header">
      <div class="skeleton" style="width:120px;height:24px;border-radius:6px"></div>
    </div>
    <div style="margin-top:20px">
      ${[0,1,2,3,4].map(() => `<div class="skeleton" style="height:40px;margin-bottom:10px;border-radius:6px"></div>`).join('')}
    </div>`
}

function emptyState(icon, title, sub) {
  return `<div class="card" style="padding:48px;text-align:center">
    <i class="ti ${icon}" style="font-size:36px;color:var(--text-4);display:block;margin-bottom:12px"></i>
    <div style="font-size:15px;font-weight:500;color:var(--text-2);margin-bottom:6px">${title}</div>
    <div style="font-size:13px;color:var(--text-4)">${sub}</div>
  </div>`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function fmt(n) {
  return n == null ? '0' : String(Math.round((n) * 1000) / 1000)
}

function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString('ru-RU')
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))
}

// ── Assets tab ────────────────────────────────────────────────────────────────

const ASSET_STATUS_LABEL = { active: 'Активен', maintenance: 'Обслуживание', retired: 'Выведен', lost: 'Утерян' }
const ASSET_STATUS_CLS   = { active: 'badge--green', maintenance: 'badge--amber', retired: 'badge--gray', lost: 'badge--red' }

function renderAssets(s) {
  const q = (s.searchQ || '').toLowerCase()
  const filtered = s.assets.filter(a =>
    !q || a.name?.toLowerCase().includes(q) ||
    a.asset_tag?.toLowerCase().includes(q) ||
    a.model?.toLowerCase().includes(q) ||
    a.serial_number?.toLowerCase().includes(q)
  )
  const categories = [...new Set(s.assets.map(a => a.category).filter(Boolean))]

  return `
    <div class="filter-bar" style="margin-bottom:12px">
      <input class="field-input" id="asset-search" type="search" placeholder="Поиск…" value="${esc(s.searchQ)}" style="max-width:220px">
      <button class="btn btn--primary" id="inv-add-asset" style="margin-left:auto"><i class="ti ti-plus"></i> Добавить актив</button>
    </div>
    ${!s.assets.length
      ? emptyState('ti-cpu', 'Нет активов', 'Добавьте первый объект оборудования.')
      : `<div class="card" style="overflow:hidden">
      <table class="data-table">
        <thead>
          <tr>
            <th>Тег</th><th>Название</th><th>Модель</th><th>С/Н</th><th>Категория</th><th>Статус</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${filtered.length
            ? filtered.map(a => `
              <tr class="data-row">
                <td><code style="font-size:11px">${esc(a.asset_tag || '—')}</code></td>
                <td style="font-weight:500">${esc(a.name)}</td>
                <td style="color:var(--text-3)">${esc([a.manufacturer, a.model].filter(Boolean).join(' ') || '—')}</td>
                <td style="color:var(--text-4);font-size:11px">${esc(a.serial_number || '—')}</td>
                <td style="color:var(--text-3)">${esc(a.category || '—')}</td>
                <td><span class="badge ${ASSET_STATUS_CLS[a.status] || 'badge--gray'}">${ASSET_STATUS_LABEL[a.status] || a.status}</span></td>
                <td style="text-align:right">
                  <button class="btn btn--ghost btn--sm" data-edit-asset="${esc(a.id)}" style="padding:3px 8px">
                    <i class="ti ti-pencil"></i>
                  </button>
                </td>
              </tr>`).join('')
            : `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-4)">Нет результатов</td></tr>`}
        </tbody>
      </table>
    </div>
    <div style="margin-top:8px;font-size:12px;color:var(--text-4)">${filtered.length} активов</div>`}
  `
}

function bindAssetsTab(s) {
  const content = _el?.querySelector('#inv-content')
  if (!content) return
  content.querySelector('#asset-search')?.addEventListener('input', e => {
    state.set({ searchQ: e.target.value })
    content.innerHTML = renderAssets(state.get())
    bindAssetsTab(state.get())
  })
  content.querySelector('#inv-add-asset')?.addEventListener('click', () => openAssetModal())
  content.querySelectorAll('[data-edit-asset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = s.assets.find(x => x.id === btn.dataset.editAsset)
      if (a) openAssetModal(a)
    })
  })
}

async function openAssetModal(asset = null) {
  const isNew = !asset
  const modal = document.createElement('div')
  modal.className = 'modal-overlay'
  modal.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <div class="modal-title">${isNew ? 'Новый актив' : 'Редактировать актив'}</div>
        <button class="modal-close" id="am-close"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;gap:12px">
          <div class="form-group" style="flex:2">
            <label class="form-label">Название *</label>
            <input class="field-input" id="am-name" placeholder="Считыватель входа" value="${esc(asset?.name || '')}">
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">Тег</label>
            <input class="field-input" id="am-tag" placeholder="AST-001" value="${esc(asset?.asset_tag || '')}">
          </div>
        </div>
        <div style="display:flex;gap:12px">
          <div class="form-group" style="flex:1">
            <label class="form-label">Производитель</label>
            <input class="field-input" id="am-mfr" placeholder="ICT, HID, ASSA…" value="${esc(asset?.manufacturer || '')}">
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">Модель</label>
            <input class="field-input" id="am-model" placeholder="Protege WX" value="${esc(asset?.model || '')}">
          </div>
        </div>
        <div style="display:flex;gap:12px">
          <div class="form-group" style="flex:1">
            <label class="form-label">Серийный номер</label>
            <input class="field-input" id="am-sn" placeholder="SN123456" value="${esc(asset?.serial_number || '')}">
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">Категория</label>
            <input class="field-input" id="am-cat" placeholder="Считыватели, Замки…" value="${esc(asset?.category || '')}">
          </div>
        </div>
        <div style="display:flex;gap:12px">
          <div class="form-group" style="flex:1">
            <label class="form-label">Статус</label>
            <select class="field-input" id="am-status">
              ${Object.entries(ASSET_STATUS_LABEL).map(([v,l]) =>
                `<option value="${v}" ${(asset?.status||'active')===v?'selected':''}>${l}</option>`
              ).join('')}
            </select>
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">Установлен</label>
            <input class="field-input" id="am-installed" type="date" value="${esc(asset?.installed_at?.slice(0,10)||'')}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Гарантия до</label>
          <input class="field-input" id="am-warranty" type="date" value="${esc(asset?.warranty_until?.slice(0,10)||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Заметки</label>
          <textarea class="field-input" id="am-notes" rows="2" style="resize:vertical">${esc(asset?.notes||'')}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn--ghost" id="am-cancel">Отмена</button>
        <button class="btn btn--primary" id="am-save">${isNew ? 'Создать' : 'Сохранить'}</button>
      </div>
    </div>`
  document.body.appendChild(modal)

  const close = () => modal.remove()
  modal.querySelector('#am-close').addEventListener('click', close)
  modal.querySelector('#am-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  modal.querySelector('#am-save').addEventListener('click', async () => {
    const name = modal.querySelector('#am-name').value.trim()
    if (!name) { modal.querySelector('#am-name').focus(); return }
    const payload = {
      name,
      asset_tag:      modal.querySelector('#am-tag').value.trim(),
      manufacturer:   modal.querySelector('#am-mfr').value.trim(),
      model:          modal.querySelector('#am-model').value.trim(),
      serial_number:  modal.querySelector('#am-sn').value.trim(),
      category:       modal.querySelector('#am-cat').value.trim(),
      status:         modal.querySelector('#am-status').value,
      installed_at:   modal.querySelector('#am-installed').value || null,
      warranty_until: modal.querySelector('#am-warranty').value || null,
      notes:          modal.querySelector('#am-notes').value.trim(),
    }
    const btn = modal.querySelector('#am-save')
    btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i>'
    try {
      if (isNew) {
        await apiJSON('/api/v1/tracked-assets', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
        window.toast?.('Актив создан', 'success')
      } else {
        await apiJSON(`/api/v1/tracked-assets/${asset.id}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
        window.toast?.('Сохранено', 'success')
      }
      close()
      await loadAssets()
      renderTab(state.get())
    } catch (err) {
      window.toast?.(err.message || 'Ошибка', 'error')
      btn.disabled = false; btn.textContent = isNew ? 'Создать' : 'Сохранить'
    }
  })
}
