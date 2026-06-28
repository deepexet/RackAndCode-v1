/**
 * Logs module — project activity log + security audit log.
 */

import { apiJSON } from '../core/api.js'
import {
  esc, fmtDate, timeAgo, badge, loadingSpinner, emptyState,
  toolbar, tabBar, table, filterBar,
} from '../components/ui.js'

let _el = null
let _tab = 'activity'
let _filters = { q: '', source: 'all', entityType: 'all' }
let _audit_filters = { q: '', action: 'all' }
let _data = {}

const TABS = [
  { id: 'activity', label: 'Активность', icon: 'ti-activity' },
  { id: 'security', label: 'Безопасность', icon: 'ti-shield-lock' },
]

// ── Data ─────────────────────────────────────────────────────────────────

async function loadActivity() {
  if (_data.activity) return _data.activity
  const d = await apiJSON('/api/v1/logs', { limit: 200 })
  _data.activity = d
  return d
}

async function loadSecurity() {
  if (_data.security) return _data.security
  const d = await apiJSON('/api/v1/admin/audit-log')
  _data.security = d
  return d
}

// ── Entity icons & colors ─────────────────────────────────────────────────

const ENTITY_ICON = {
  unit_progress: 'ti-progress', work_item: 'ti-clipboard-list',
  project: 'ti-briefcase', building: 'ti-building',
  location: 'ti-map-pin', inventory: 'ti-packages',
  asset: 'ti-tool', document: 'ti-file',
}
const ENTITY_COLOR = {
  unit_progress: 'var(--green)', work_item: 'var(--blue)',
  project: 'var(--purple)', building: 'var(--amber)',
}

const ACTION_ICON = {
  dev_login: 'ti-bolt', login: 'ti-login', logout: 'ti-logout',
  mfa_verify: 'ti-device-mobile', failed_login: 'ti-alert-triangle',
  create: 'ti-plus', update: 'ti-edit', delete: 'ti-trash', updated: 'ti-edit',
}
const ACTION_BADGE = {
  failed_login: 'red', logout: 'dim', login: 'green',
  dev_login: 'amber', mfa_verify: 'blue',
}

// ── Activity tab ──────────────────────────────────────────────────────────

function filterActivity(logs) {
  let rows = logs
  const q = _filters.q.toLowerCase()
  if (q) rows = rows.filter(r =>
    (r.message || '').toLowerCase().includes(q) ||
    (r.projectName || '').toLowerCase().includes(q) ||
    (r.entityType || '').toLowerCase().includes(q)
  )
  if (_filters.source !== 'all') rows = rows.filter(r => r.source === _filters.source)
  if (_filters.entityType !== 'all') rows = rows.filter(r => r.entityType === _filters.entityType)
  return rows
}

function renderActivity(d) {
  const logs = d.logs || []
  const entityTypes = [...new Set(logs.map(l => l.entityType).filter(Boolean))]
  const sources = [...new Set(logs.map(l => l.source).filter(Boolean))]
  const rows = filterActivity(logs)

  return `
    ${filterBar({
      placeholder: 'Поиск по действию, проекту…',
      value: _filters.q,
      selects: [
        { key: 'source', value: _filters.source,
          options: [{ value: 'all', label: 'Все источники' }, ...sources.map(s => ({ value: s, label: s }))] },
        { key: 'entityType', value: _filters.entityType,
          options: [{ value: 'all', label: 'Все типы' }, ...entityTypes.map(s => ({ value: s, label: s }))] },
      ],
    })}
    <div class="logs-count">${rows.length} из ${logs.length} записей</div>
    ${table({
      columns: [
        { label: '', width: '40px', render: r => {
            const icon = ENTITY_ICON[r.entityType] || 'ti-dot'
            const color = ENTITY_COLOR[r.entityType] || 'var(--text-4)'
            return `<i class="ti ${icon}" style="color:${color};font-size:16px"></i>`
          }},
        { label: 'Тип',       render: r => `<span class="ui-mono ui-dim">${esc(r.entityType || '—')}</span>` },
        { label: 'Действие',  render: r => esc(r.message || r.action || '—') },
        { label: 'Проект',    render: r => r.projectName
            ? `<span class="logs-project-badge">${esc(r.projectCode || '')} ${esc(r.projectName)}</span>` : '—' },
        { label: 'Время',     render: r =>
            `<span class="ui-dim" title="${esc(r.createdAt || r.created_at || '')}">${timeAgo(r.createdAt || r.created_at)}</span>` },
      ],
      rows,
      emptyText: 'Нет записей',
      emptyIcon: 'ti-activity-off',
    })}`
}

// ── Security tab ──────────────────────────────────────────────────────────

function filterSecurity(entries) {
  let rows = entries
  const q = _audit_filters.q.toLowerCase()
  if (q) rows = rows.filter(r =>
    (r.action || '').toLowerCase().includes(q) ||
    (r.actor_id || '').toLowerCase().includes(q) ||
    (r.ip || '').includes(q)
  )
  if (_audit_filters.action !== 'all') rows = rows.filter(r => r.action === _audit_filters.action)
  return rows
}

function renderSecurity(d) {
  const entries = d.entries || []
  const actions = [...new Set(entries.map(e => e.action).filter(Boolean))]
  const rows = filterSecurity(entries)

  return `
    ${filterBar({
      placeholder: 'Поиск по действию, IP, актору…',
      value: _audit_filters.q,
      selects: [
        { key: 'action', value: _audit_filters.action,
          options: [{ value: 'all', label: 'Все действия' }, ...actions.map(a => ({ value: a, label: a }))] },
      ],
    })}
    <div class="logs-count">${rows.length} из ${entries.length} записей</div>
    ${table({
      columns: [
        { label: '', width: '40px', render: r =>
            `<i class="ti ${ACTION_ICON[r.action] || 'ti-activity'} logs-audit-ico logs-ico--${ACTION_BADGE[r.action] || 'dim'}"></i>` },
        { label: 'Действие',  render: r => `<span class="ui-mono">${esc(r.action)}</span>` },
        { label: 'Актор',     render: r => esc(r.actor_id || '—') },
        { label: 'Роль',      render: r => badge(r.actor_role || '—') },
        { label: 'Объект',    render: r => r.target_type
            ? `<span class="ui-mono ui-dim">${esc(r.target_type)}</span>` : '—' },
        { label: 'Результат', render: r => badge(r.outcome || '—') },
        { label: 'IP',        render: r => `<span class="ui-mono ui-dim">${esc(r.ip || '—')}</span>` },
        { label: 'Время',     render: r =>
            `<span class="ui-dim" title="${esc(r.created_at)}">${timeAgo(r.created_at)}</span>` },
      ],
      rows,
      emptyText: 'Нет записей', emptyIcon: 'ti-shield-off',
    })}`
}

// ── Render & navigation ───────────────────────────────────────────────────

function render() {
  if (!_el) return
  _el.innerHTML = `
    ${toolbar({ title: 'Logs' })}
    ${tabBar(TABS, _tab)}
    <div id="logs-body" class="logs-body">${loadingSpinner()}</div>`

  _el.querySelectorAll('[data-tab]').forEach(btn =>
    btn.addEventListener('click', () => { _tab = btn.dataset.tab; switchTab() })
  )
  switchTab()
}

async function switchTab() {
  const body = document.getElementById('logs-body')
  if (!body) return
  _el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === _tab))
  body.innerHTML = loadingSpinner()
  try {
    let html = ''
    if (_tab === 'activity') {
      const d = await loadActivity()
      html = renderActivity(d)
    } else {
      const d = await loadSecurity()
      html = renderSecurity(d)
    }
    body.innerHTML = html
    bindFilters(body)
  } catch (err) {
    body.innerHTML = emptyState({ icon: 'ti-alert-circle', title: 'Ошибка', message: err.message })
  }
}

function bindFilters(body) {
  // Search input with debounce
  let debounce
  body.querySelector('[data-filter="q"]')?.addEventListener('input', e => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      if (_tab === 'activity') _filters.q = e.target.value
      else _audit_filters.q = e.target.value
      rerenderTable(body)
    }, 200)
  })

  // Selects
  body.querySelectorAll('[data-filter]').forEach(el => {
    if (el.tagName !== 'SELECT') return
    el.addEventListener('change', () => {
      const key = el.dataset.filter
      if (_tab === 'activity') _filters[key] = el.value
      else _audit_filters[key] = el.value
      rerenderTable(body)
    })
  })
}

async function rerenderTable(body) {
  const tableWrap = body.querySelector('.ui-table-wrap, .ui-empty')
  const countEl = body.querySelector('.logs-count')
  try {
    let d, html
    if (_tab === 'activity') {
      d = await loadActivity()
      const rows = filterActivity(d.logs || [])
      if (countEl) countEl.textContent = `${rows.length} из ${(d.logs || []).length} записей`
    } else {
      d = await loadSecurity()
      const rows = filterSecurity(d.entries || [])
      if (countEl) countEl.textContent = `${rows.length} из ${(d.entries || []).length} записей`
    }
    // Full re-render for simplicity
    await switchTab()
  } catch {}
}

// ── Mount / Unmount ───────────────────────────────────────────────────────

export async function mount() {
  _el = document.querySelector('[data-view="logs"]')
  if (!_el) return unmount
  _data = {}
  _filters = { q: '', source: 'all', entityType: 'all' }
  _audit_filters = { q: '', action: 'all' }
  render()
  return unmount
}

export function unmount() { _el = null }
